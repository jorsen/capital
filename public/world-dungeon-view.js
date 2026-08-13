// World Dungeon Schedule — a fixed weekly cadence (every Thursday and
// Sunday), two fixed bosses (Hisharat, Chantarat). An admin manually assigns
// which guild is taking on each boss per date. Guild picklist is shared with
// Cave Schedule's server list (see the comment in lib/db.js) rather than a
// second duplicate list.

const worldDungeonState = {
  guilds: [], // [{id, name}] -- shared cave_schedule_servers list
  entries: {}, // { 'YYYY-MM-DD': { Hisharat: 'GuildName', Chantarat: 'GuildName' } }
};

const WORLD_DUNGEON_NAMES = ['Hisharat', 'Chantarat'];
const WORLD_DUNGEON_UPCOMING_COUNT = 12; // ~6 weeks of Thursday+Sunday pairs

// Every Thursday (4) and Sunday (0) starting today, walked in UTC day-math
// so a DST shift can't skip or duplicate a date.
function worldDungeonUpcomingDates(count) {
  const dates = [];
  const now = new Date();
  let cursor = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  while (dates.length < count) {
    const dow = cursor.getUTCDay();
    if (dow === 4 || dow === 0) dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return dates;
}

async function loadWorldDungeonScheduleData() {
  const fromDate = worldDungeonUpcomingDates(1)[0];
  const [guilds, entries] = await Promise.all([
    api('/api/cave-schedule-servers'),
    api(`/api/world-dungeon-schedule?from=${fromDate}`),
  ]);
  worldDungeonState.guilds = guilds;
  worldDungeonState.entries = {};
  entries.forEach((e) => {
    const key = String(e.date).slice(0, 10);
    if (!worldDungeonState.entries[key]) worldDungeonState.entries[key] = {};
    worldDungeonState.entries[key][e.dungeon] = e.guildName;
  });
  renderWorldDungeonSchedule();
}

function renderWorldDungeonSchedule() {
  document.getElementById('worldDungeonNoGuildsState').classList.toggle('hidden', worldDungeonState.guilds.length !== 0);

  const dates = worldDungeonUpcomingDates(WORLD_DUNGEON_UPCOMING_COUNT);
  const body = document.getElementById('worldDungeonScheduleBody');
  body.innerHTML = dates
    .map((date) => {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      const dayLabel = dow === 4 ? 'Thursday' : 'Sunday';
      const assigned = worldDungeonState.entries[date] || {};
      const cells = WORLD_DUNGEON_NAMES.map((dungeon) => {
        const current = assigned[dungeon] || '';
        const options = worldDungeonState.guilds
          .map((g) => `<option value="${escapeHtml(g.name)}" ${g.name === current ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
          .join('');
        return `<td><select class="world-dungeon-select admin-disable" data-date="${date}" data-dungeon="${dungeon}"><option value="">—</option>${options}</select></td>`;
      }).join('');
      return `
      <tr>
        <td style="font-weight:600; white-space:nowrap;">${formatLongDate(date)}<div style="color:var(--text-muted); font-size:12px; font-weight:400;">${dayLabel}</div></td>
        ${cells}
      </tr>`;
    })
    .join('');

  body.querySelectorAll('.world-dungeon-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const date = sel.getAttribute('data-date');
      const dungeon = sel.getAttribute('data-dungeon');
      const prevValue = worldDungeonState.entries[date]?.[dungeon] || '';
      try {
        await api(`/api/world-dungeon-schedule/${date}/${dungeon}`, { method: 'PUT', body: JSON.stringify({ guildName: sel.value }) });
        if (!worldDungeonState.entries[date]) worldDungeonState.entries[date] = {};
        if (sel.value) worldDungeonState.entries[date][dungeon] = sel.value;
        else delete worldDungeonState.entries[date][dungeon];
        toast('Saved');
      } catch (err) {
        toast(err.message);
        sel.value = prevValue;
      }
    });
  });
}

// ---------- Manage Guilds modal (shares cave_schedule_servers with Cave Schedule) ----------

function renderWorldDungeonGuildList() {
  const list = document.getElementById('worldDungeonGuildList');
  list.innerHTML = worldDungeonState.guilds
    .map(
      (g) => `
      <li style="display:flex; gap:8px; align-items:center;" data-guild-id="${g.id}">
        <span style="flex:1;">${escapeHtml(g.name)}</span>
        <button type="button" class="icon-btn" data-delete-guild="${g.id}" title="Delete guild">✕</button>
      </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-guild]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-guild');
      const guild = worldDungeonState.guilds.find((g) => g.id === id);
      if (!confirm(`Remove "${guild?.name}"? This also removes it from Cave Schedule's server list.`)) return;
      try {
        await api(`/api/cave-schedule-servers/${id}`, { method: 'DELETE' });
        worldDungeonState.guilds = worldDungeonState.guilds.filter((g) => g.id !== id);
        renderWorldDungeonGuildList();
        renderWorldDungeonSchedule();
        toast('Guild removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('manageWorldDungeonGuildsBtn').addEventListener('click', () => {
  renderWorldDungeonGuildList();
  document.getElementById('manageWorldDungeonGuildsModal').classList.remove('hidden');
});

document.getElementById('addWorldDungeonGuildForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const guild = await api('/api/cave-schedule-servers', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
    worldDungeonState.guilds.push(guild);
    renderWorldDungeonGuildList();
    renderWorldDungeonSchedule();
    e.target.reset();
    toast(`${guild.name} added`);
  } catch (err) {
    toast(err.message);
  }
});
