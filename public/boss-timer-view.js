const bossTimerState = {
  bosses: [],
  tickHandle: null,
  refreshHandle: null,
  pollHandle: null,
};

// Daily bosses spawn at a fixed time of day (entered in the viewer's own
// local time, to sidestep needing to know/convert the game server's
// timezone). Interval bosses respawn a fixed duration after they were last
// killed, tracked via lastKilledAt.
//
// Interval respawn times are estimated from chat history, not confirmed
// in-game data, and per-boss intervals get recalibrated directly from
// in-game reports as drift is spotted. On top of that, a fixed early margin
// is subtracted here: showing up a few minutes before the estimated spawn
// costs a short wait, but showing up late risks losing the boss to a rival
// guild who got there first — so the bias is deliberately early, not late.
const EARLY_MARGIN_MS = 3 * 60 * 1000;

function nextSpawnMs(boss, now) {
  if (boss.type === 'daily') {
    if (!boss.spawnTime) return null;
    const [hh, mm] = boss.spawnTime.split(':').map(Number);
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  if (!boss.lastKilledAt || !boss.intervalMinutes) return null;
  return new Date(boss.lastKilledAt).getTime() + boss.intervalMinutes * 60000 - EARLY_MARGIN_MS;
}

function formatCountdown(ms) {
  if (ms === null) return 'Not started';
  if (ms <= 0) return 'Spawned!';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function urgencyClass(ms) {
  if (ms === null) return 'boss-timer-unset';
  if (ms <= 0) return 'boss-timer-spawned';
  if (ms <= 5 * 60000) return 'boss-timer-urgent';
  if (ms <= 30 * 60000) return 'boss-timer-soon';
  return 'boss-timer-normal';
}

async function loadBossTimerData() {
  bossTimerState.bosses = await api('/api/boss-timers');
  renderBossTimerGrid();

  clearInterval(bossTimerState.tickHandle);
  clearInterval(bossTimerState.refreshHandle);
  clearInterval(bossTimerState.pollHandle);
  // Cheap per-second update of just the countdown text/urgency class.
  bossTimerState.tickHandle = setInterval(tickBossTimers, 1000);
  // Full re-render every 30s so the sort order and daily-boss day-rollover
  // stay correct without reflowing the whole grid every second.
  bossTimerState.refreshHandle = setInterval(renderBossTimerGrid, 30000);
  // Re-fetches from the server every few seconds so a kill logged from
  // another tab/device — or confirmed via the Discord button — shows up here
  // without a manual reload. There's no server push (Vercel serverless has
  // no shared state across function instances to push from), so polling is
  // the pragmatic stand-in.
  bossTimerState.pollHandle = setInterval(pollBossTimers, 5000);
}

// Called from the router whenever the active view changes away from
// 'bosses' -- otherwise these intervals (especially the 5s server poll)
// keep running for as long as the tab stays open, no matter what page is
// actually showing, continuously hitting the database in the background.
function stopBossTimerPolling() {
  clearInterval(bossTimerState.tickHandle);
  clearInterval(bossTimerState.refreshHandle);
  clearInterval(bossTimerState.pollHandle);
}

async function pollBossTimers() {
  try {
    const bosses = await api('/api/boss-timers');
    if (JSON.stringify(bosses) !== JSON.stringify(bossTimerState.bosses)) {
      bossTimerState.bosses = bosses;
      renderBossTimerGrid();
    }
  } catch (err) {
    // Transient network hiccup — the next poll will retry.
  }
}

function renderBossTimerGrid() {
  const grid = document.getElementById('bossTimerGrid');
  const now = Date.now();

  const sorted = bossTimerState.bosses.slice().sort((a, b) => {
    const na = nextSpawnMs(a, now);
    const nb = nextSpawnMs(b, now);
    if (na === null && nb === null) return 0;
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  });

  grid.innerHTML = sorted
    .map((b) => {
      const next = nextSpawnMs(b, now);
      const ms = next === null ? null : next - now;
      const meta =
        b.type === 'daily'
          ? `Spawns daily at ${b.spawnTime}`
          : b.lastKilledAt
          ? `Every ${b.intervalMinutes}m — last killed ${new Date(b.lastKilledAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
          : `Every ${b.intervalMinutes}m — mark it killed to start the timer`;
      return `
      <div class="boss-timer-card ${urgencyClass(ms)}" data-boss-id="${b.id}">
        <div class="boss-timer-header">
          <span class="boss-timer-name">${escapeHtml(b.name)}</span>
          <span class="boss-timer-type-badge">${b.type === 'daily' ? 'Daily' : 'Interval'}</span>
        </div>
        ${b.notes ? `<p class="boss-timer-notes">${escapeHtml(b.notes)}</p>` : ''}
        <div class="boss-timer-countdown" data-countdown>${formatCountdown(ms)}</div>
        <p class="boss-timer-meta">${meta}</p>
        <div class="boss-timer-actions admin-only">
          ${
            b.type === 'interval'
              ? `<button type="button" class="btn small primary" data-kill="${b.id}">Killed Now</button>
                 <button type="button" class="icon-btn" data-set-kill-time="${b.id}" title="Set a custom kill time">🕒</button>
                 <button type="button" class="icon-btn" data-set-spawn-time="${b.id}" title="Set an exact spawn time">⏰</button>`
              : ''
          }
          <button type="button" class="icon-btn" data-edit="${b.id}" title="Edit">✎</button>
          <button type="button" class="icon-btn" data-delete="${b.id}" title="Delete">✕</button>
        </div>
      </div>`;
    })
    .join('');

  document.getElementById('bossTimerEmptyState').classList.toggle('hidden', sorted.length !== 0);

  grid.querySelectorAll('[data-kill]').forEach((btn) => {
    btn.addEventListener('click', () => killBoss(btn.getAttribute('data-kill')));
  });
  grid.querySelectorAll('[data-set-kill-time]').forEach((btn) => {
    btn.addEventListener('click', () => openKillTimeModal(btn.getAttribute('data-set-kill-time')));
  });
  grid.querySelectorAll('[data-set-spawn-time]').forEach((btn) => {
    btn.addEventListener('click', () => openSpawnTimeModal(btn.getAttribute('data-set-spawn-time')));
  });
  grid.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const boss = bossTimerState.bosses.find((b) => b.id === btn.getAttribute('data-edit'));
      if (boss) openBossModal(boss);
    });
  });
  grid.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteBoss(btn.getAttribute('data-delete')));
  });
}

// Runs every second: only touches the countdown text + urgency class per
// card, instead of rebuilding the whole grid (which would lose hover/focus
// state and reflow the page needlessly).
function tickBossTimers() {
  const now = Date.now();
  document.querySelectorAll('.boss-timer-card').forEach((card) => {
    const boss = bossTimerState.bosses.find((b) => b.id === card.getAttribute('data-boss-id'));
    if (!boss) return;
    const next = nextSpawnMs(boss, now);
    const ms = next === null ? null : next - now;
    const countdownEl = card.querySelector('[data-countdown]');
    if (countdownEl) countdownEl.textContent = formatCountdown(ms);
    card.className = `boss-timer-card ${urgencyClass(ms)}`;
  });
}

async function killBoss(id) {
  try {
    const updated = await api(`/api/boss-timers/${id}/kill`, { method: 'POST' });
    const idx = bossTimerState.bosses.findIndex((b) => b.id === id);
    if (idx !== -1) bossTimerState.bosses[idx] = updated;
    renderBossTimerGrid();
    toast(`${updated.name} marked as killed — timer started`);
  } catch (err) {
    toast(err.message);
  }
}

// Lets an admin correct a boss's kill time directly (e.g. a wrong time that
// got parsed from Discord chat) instead of only ever being able to set it to
// "right now" via Killed Now.
function openKillTimeModal(id) {
  const boss = bossTimerState.bosses.find((b) => b.id === id);
  if (!boss) return;

  const modal = document.getElementById('killTimeModal');
  const form = document.getElementById('killTimeForm');
  const input = form.querySelector('[name="killedAt"]');

  const base = boss.lastKilledAt ? new Date(boss.lastKilledAt) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  input.value = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;

  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const updated = await api(`/api/boss-timers/${id}/kill`, {
        method: 'POST',
        body: JSON.stringify({ killedAt: new Date(input.value).toISOString() }),
      });
      const idx = bossTimerState.bosses.findIndex((b) => b.id === id);
      if (idx !== -1) bossTimerState.bosses[idx] = updated;
      renderBossTimerGrid();
      if (typeof loadBossHistoryData === 'function') loadBossHistoryData();
      modal.classList.add('hidden');
      toast(`${updated.name}'s kill time updated`);
    } catch (err) {
      toast(err.message);
    }
  };

  modal.classList.remove('hidden');
}

// Lets an admin say "I saw it spawn at 5:22am" directly, instead of having
// to mentally subtract the Respawn Interval to work out what killedAt that
// implies. Solves nextSpawnMs's own formula backward for lastKilledAt so
// the resulting countdown lands exactly on the spawn time they entered,
// then saves it through the same kill endpoint Kill Time already uses --
// no separate field or backend change needed, this boss's "kill time" is
// just a means to the spawn-time end here.
function openSpawnTimeModal(id) {
  const boss = bossTimerState.bosses.find((b) => b.id === id);
  if (!boss) return;

  const modal = document.getElementById('spawnTimeModal');
  const form = document.getElementById('spawnTimeForm');
  const input = form.querySelector('[name="spawnAt"]');

  const base = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  input.value = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const spawnAtMs = new Date(input.value).getTime();
    const equivalentKilledAtMs = spawnAtMs - boss.intervalMinutes * 60000 + EARLY_MARGIN_MS;
    try {
      const updated = await api(`/api/boss-timers/${id}/kill`, {
        method: 'POST',
        body: JSON.stringify({ killedAt: new Date(equivalentKilledAtMs).toISOString() }),
      });
      const idx = bossTimerState.bosses.findIndex((b) => b.id === id);
      if (idx !== -1) bossTimerState.bosses[idx] = updated;
      renderBossTimerGrid();
      if (typeof loadBossHistoryData === 'function') loadBossHistoryData();
      modal.classList.add('hidden');
      toast(`${updated.name}'s spawn time set`);
    } catch (err) {
      toast(err.message);
    }
  };

  modal.classList.remove('hidden');
}

async function deleteBoss(id) {
  const boss = bossTimerState.bosses.find((b) => b.id === id);
  if (!boss || !confirm(`Delete "${boss.name}"?`)) return;
  try {
    await api(`/api/boss-timers/${id}`, { method: 'DELETE' });
    bossTimerState.bosses = bossTimerState.bosses.filter((b) => b.id !== id);
    renderBossTimerGrid();
    toast('Boss deleted');
  } catch (err) {
    toast(err.message);
  }
}

function openBossModal(boss) {
  const modal = document.getElementById('bossModal');
  const content = document.getElementById('bossModalContent');
  const isEdit = !!boss;

  content.innerHTML = `
    <h2>${isEdit ? 'Edit Boss' : 'Add Boss'}</h2>
    <form id="bossForm" style="display:flex; flex-direction:column; gap:12px; margin-top:10px;">
      <label>Name
        <input type="text" name="name" required maxlength="60" value="${isEdit ? escapeHtml(boss.name) : ''}" placeholder="e.g. Dergio">
      </label>
      <label>Type
        <select name="type" id="bossTypeSelect">
          <option value="daily" ${!isEdit || boss.type === 'daily' ? 'selected' : ''}>Daily (fixed time)</option>
          <option value="interval" ${isEdit && boss.type === 'interval' ? 'selected' : ''}>Interval (respawns after kill)</option>
        </select>
      </label>
      <label id="bossDailyField" class="${isEdit && boss.type === 'interval' ? 'hidden' : ''}">
        Spawn Time <span style="color:var(--text-muted); font-weight:400;">(your local time)</span>
        <input type="time" name="spawnTime" value="${isEdit && boss.spawnTime ? boss.spawnTime : '11:00'}">
      </label>
      <label id="bossIntervalField" class="${!isEdit || boss.type === 'daily' ? 'hidden' : ''}">
        Respawn Interval <span style="color:var(--text-muted); font-weight:400;">(minutes)</span>
        <input type="number" name="intervalMinutes" min="1" step="1" value="${isEdit && boss.intervalMinutes ? boss.intervalMinutes : 60}">
      </label>
      <label id="bossNotifyLeadField" class="${!isEdit || boss.type === 'daily' ? 'hidden' : ''}">
        Discord Notify Lead Time <span style="color:var(--text-muted); font-weight:400;">(minutes before spawn)</span>
        <input type="number" name="notifyLeadMinutes" min="1" step="1" value="${isEdit && boss.notifyLeadMinutes ? boss.notifyLeadMinutes : 5}">
      </label>
      <label>Notes / Location <span style="color:var(--text-muted); font-weight:400;">(optional)</span>
        <input type="text" name="notes" maxlength="80" value="${isEdit ? escapeHtml(boss.notes || '') : ''}" placeholder="e.g. Auber Volcanic Field">
      </label>
      <div style="display:flex; gap:8px;">
        <button type="submit" class="btn primary" style="flex:1;">${isEdit ? 'Save Changes' : 'Add Boss'}</button>
      </div>
    </form>
  `;
  modal.classList.remove('hidden');

  const typeSelect = content.querySelector('#bossTypeSelect');
  typeSelect.addEventListener('change', () => {
    content.querySelector('#bossDailyField').classList.toggle('hidden', typeSelect.value !== 'daily');
    content.querySelector('#bossIntervalField').classList.toggle('hidden', typeSelect.value !== 'interval');
    content.querySelector('#bossNotifyLeadField').classList.toggle('hidden', typeSelect.value !== 'interval');
  });

  content.querySelector('#bossForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = {
      name: fd.get('name'),
      type: fd.get('type'),
      spawnTime: fd.get('spawnTime'),
      intervalMinutes: Number(fd.get('intervalMinutes')),
      notifyLeadMinutes: Number(fd.get('notifyLeadMinutes')),
      notes: fd.get('notes'),
    };
    try {
      if (isEdit) {
        const updated = await api(`/api/boss-timers/${boss.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        const idx = bossTimerState.bosses.findIndex((b) => b.id === boss.id);
        bossTimerState.bosses[idx] = updated;
        toast('Boss updated');
      } else {
        const created = await api('/api/boss-timers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        bossTimerState.bosses.push(created);
        toast('Boss added');
      }
      modal.classList.add('hidden');
      renderBossTimerGrid();
    } catch (err) {
      toast(err.message);
    }
  });
}

document.getElementById('addBossBtn').addEventListener('click', () => openBossModal(null));
