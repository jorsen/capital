const caveState = {
  caves: [],
  members: [],
  bosses: [],
  month: null, // "YYYY-MM" -- the calendar shows one month at a time
  selectedDate: null, // "YYYY-MM-DD" whose boss logs show beside the calendar
};

async function loadCaveData() {
  const [caves, members, bosses] = await Promise.all([api('/api/caves'), api('/api/members'), api('/api/boss-timers')]);
  caveState.caves = caves;
  caveState.members = members;
  caveState.bosses = bosses;
  if (!caveState.month) caveState.month = currentMonthValue();
  renderCaveView();
}

function bossNameSelectOptionsHtml() {
  const options = caveState.bosses
    .map((b) => `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`)
    .join('');
  return `<option value="" selected>Select a boss…</option>${options}`;
}

// ---------- Attendance Log calendar ----------

// This month's boss logs, grouped by day, each day earliest kill first.
function caveSessionsByDate() {
  const byDate = new Map();
  caveState.caves.forEach((s) => {
    if (s.date.slice(0, 7) !== caveState.month) return;
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  });
  byDate.forEach((list) => list.sort((a, b) => String(a.killedAt || a.createdAt).localeCompare(String(b.killedAt || b.createdAt))));
  return byDate;
}

function todayDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderCaveView() {
  const byDate = caveSessionsByDate();
  document.getElementById('caveEmptyState').classList.toggle('hidden', caveState.caves.length !== 0);
  document.getElementById('caveMonthLabel').textContent = formatMonthYear(caveState.month);

  // Nothing picked (or the pick was in another month): open today if it has
  // logs, otherwise the latest logged day of the month.
  if (!caveState.selectedDate || !byDate.has(caveState.selectedDate)) {
    const days = Array.from(byDate.keys()).sort();
    caveState.selectedDate = byDate.has(todayDateKey()) ? todayDateKey() : days[days.length - 1] || null;
  }

  renderCaveCalendarGrid(byDate);
  renderCaveDayDetail(byDate);
}

function renderCaveCalendarGrid(byDate) {
  const [year, month] = caveState.month.split('-').map(Number);
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month, 0).getDate();
  const todayKey = todayDateKey();
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push('<div class="cave-calendar-cell is-empty"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${caveState.month}-${String(day).padStart(2, '0')}`;
    const daySessions = byDate.get(dateKey);
    const classes = ['cave-calendar-cell'];
    if (daySessions) classes.push('has-events');
    if (dateKey === todayKey) classes.push('is-today');
    if (dateKey === caveState.selectedDate) classes.push('is-selected');
    cells.push(`
      <div class="${classes.join(' ')}" ${daySessions ? `data-calendar-date="${dateKey}"` : ''}>
        <span class="cave-calendar-daynum">${day}</span>
        ${daySessions ? `<span class="cave-calendar-badge">${daySessions.length} boss${daySessions.length === 1 ? '' : 'es'}</span>` : ''}
      </div>`);
  }
  while (cells.length % 7 !== 0) cells.push('<div class="cave-calendar-cell is-empty"></div>');

  const grid = document.getElementById('caveCalendarGrid');
  grid.innerHTML = weekdayLabels.map((w) => `<div class="cave-calendar-weekday">${w}</div>`).join('') + cells.join('');
  grid.querySelectorAll('[data-calendar-date]').forEach((cell) => {
    cell.addEventListener('click', () => {
      caveState.selectedDate = cell.getAttribute('data-calendar-date');
      renderCaveView();
    });
  });
}

function caveAttendeeNames(session) {
  const byId = new Map(caveState.members.map((m) => [m.id, m.name]));
  return session.attendees.map((id) => byId.get(id)).filter(Boolean);
}

// The drops card under an opened boss: item ×qty, plus its diamonds once sold.
function caveLootCardHtml(records) {
  if (!records.length) return '';
  const rows = records
    .map((r) => {
      const price = Number(r.soldPrice) || 0;
      return `
      <div class="cave-loot-highlight-row">
        <span class="cave-loot-highlight-item">${escapeHtml(r.item)} ×${r.quantity}</span>
        ${price > 0 ? `<span class="cave-loot-currency diamonds">💎 ${(price * r.quantity).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>` : ''}
      </div>`;
    })
    .join('');
  return `
    <div class="cave-loot-highlight-card">
      <div class="cave-loot-highlight-heading">🎁 Loot</div>
      ${rows}
    </div>`;
}

function renderCaveDayDetail(byDate) {
  const detail = document.getElementById('caveCalendarDayDetail');
  const date = caveState.selectedDate;
  if (!date || !byDate.has(date)) {
    detail.innerHTML = caveState.caves.length ? `<p class="empty-state">No dates logged in ${escapeHtml(formatMonthYear(caveState.month))}.</p>` : '';
    return;
  }

  const daySessions = byDate.get(date);
  const uniqueAttendees = new Set(daySessions.flatMap((s) => s.attendees)).size;
  const bossRows = daySessions
    .map((s) => {
      const time = formatTimeOfDay(s.killedAt || s.createdAt);
      return `
    <div class="cave-day-row">
      <div class="cave-day-row-header" data-toggle-cave-session="${s.id}">
        <span style="font-weight:600;">${escapeHtml(s.run || '(No boss)')}</span>
        ${time ? `<span style="color:var(--text-muted); font-size:12px;">${escapeHtml(time)}</span>` : ''}
        <span style="color:var(--text-muted);">${s.attendees.length} attended</span>
        <div style="display:flex; gap:6px; margin-left:auto;">
          <button type="button" class="icon-btn" data-copy-cave-attendees="${s.id}" title="Copy attendee list">📋</button>
          <button type="button" class="icon-btn" data-open-cave-session="${s.id}" title="Edit">✎</button>
          <button type="button" class="icon-btn admin-only" data-delete-cave-session="${s.id}" title="Remove">✕</button>
        </div>
      </div>
      <div class="hidden" id="caveDayRowBody-${s.id}">
        <div style="padding:8px 0 4px; display:flex; flex-wrap:wrap; gap:8px;">
          ${caveAttendeeNames(s).map((n) => `<span class="cave-attendee-badge">${escapeHtml(n)}</span>`).join('') || '<span style="color:var(--text-muted); font-size:12px;">No attendees</span>'}
        </div>
        ${caveLootCardHtml(s.records)}
      </div>
    </div>`;
    })
    .join('');

  detail.innerHTML = `
    <div class="cave-day-card">
      <h3>${escapeHtml(formatLongDate(date))} <span style="color:var(--text-muted); font-weight:400;">(${daySessions.length} boss${daySessions.length === 1 ? '' : 'es'}, ${uniqueAttendees} unique attendee${uniqueAttendees === 1 ? '' : 's'})</span></h3>
      ${bossRows}
    </div>`;

  detail.querySelectorAll('[data-toggle-cave-session]').forEach((header) => {
    header.addEventListener('click', () => {
      document.getElementById(`caveDayRowBody-${header.getAttribute('data-toggle-cave-session')}`).classList.toggle('hidden');
    });
  });

  detail.querySelectorAll('[data-copy-cave-attendees]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const s = daySessions.find((x) => x.id === btn.getAttribute('data-copy-cave-attendees'));
      const names = caveAttendeeNames(s);
      const time = formatTimeOfDay(s.killedAt || s.createdAt);
      const text = `${s.run || '(No boss)'} — ${formatLongDate(s.date)}${time ? `, ${time}` : ''}\nAttendees (${names.length}):\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
      try {
        await navigator.clipboard.writeText(text);
        toast('Attendee list copied');
      } catch (err) {
        toast('Could not copy — clipboard access blocked');
      }
    });
  });

  detail.querySelectorAll('[data-open-cave-session]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.hash = `#/cave-session/${btn.getAttribute('data-open-cave-session')}`;
    });
  });

  detail.querySelectorAll('[data-delete-cave-session]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-cave-session');
      const s = daySessions.find((x) => x.id === id);
      if (!confirm(`Delete ${s.run || 'this boss log'} and all its loot records?`)) return;
      try {
        await api(`/api/caves/${id}`, { method: 'DELETE' });
        caveState.caves = caveState.caves.filter((x) => x.id !== id);
        renderCaveView();
        toast('Boss log removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Changing months drops the day selection; renderCaveView re-picks one.
function setCaveMonth(month) {
  caveState.month = month;
  caveState.selectedDate = null;
  renderCaveView();
}

document.getElementById('cavePrevMonthBtn').addEventListener('click', () => setCaveMonth(shiftMonth(caveState.month, -1)));
document.getElementById('caveNextMonthBtn').addEventListener('click', () => setCaveMonth(shiftMonth(caveState.month, 1)));
document.getElementById('caveTodayBtn').addEventListener('click', () => setCaveMonth(currentMonthValue()));

// ---------- Add cave date ----------

const addCaveModal = document.getElementById('addCaveModal');
const addCaveForm = document.getElementById('addCaveForm');

function openAddCaveModal() {
  addCaveForm.reset();
  addCaveForm.date.value = new Date().toISOString().slice(0, 10);
  addCaveForm.run.innerHTML = bossNameSelectOptionsHtml();
  addCaveModal.classList.remove('hidden');
}

document.getElementById('addCaveBtn').addEventListener('click', openAddCaveModal);
document.getElementById('addCaveBtnFromSession').addEventListener('click', openAddCaveModal);
document.getElementById('addCaveBtnFromDate').addEventListener('click', openAddCaveModal);
document.getElementById('addCaveBtnFromReport').addEventListener('click', openAddCaveModal);
document.getElementById('addCaveBtnFromLootList').addEventListener('click', openAddCaveModal);
document.getElementById('addCaveBtnFromSalary').addEventListener('click', openAddCaveModal);

addCaveForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(addCaveForm);
  try {
    const session = await api('/api/caves', {
      method: 'POST',
      body: JSON.stringify({
        date: fd.get('date'),
        run: fd.get('run'),
      }),
    });
    addCaveModal.classList.add('hidden');
    window.location.hash = `#/cave-date/${session.date}`;
  } catch (err) {
    toast(err.message);
  }
});
