// World Dungeon Schedule — a fixed weekly cadence (every Thursday and
// Sunday), two fixed bosses (Hisharat, Chantarat). An admin manually assigns
// which guild is taking on each boss per date, browsed month by month like
// Cave Schedule's calendar. Guild picklist is shared with Cave Schedule's
// server list (see the comment in lib/db.js) rather than a second duplicate
// list.

const worldDungeonState = {
  month: null,
  guilds: [], // [{id, name}] -- shared cave_schedule_servers list
  entries: {}, // { 'YYYY-MM-DD': { Hisharat: 'GuildName', Chantarat: 'GuildName' } }
};

const WORLD_DUNGEON_NAMES = ['Hisharat', 'Chantarat'];
const WORLD_DUNGEON_WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function loadWorldDungeonScheduleData() {
  const monthInput = document.getElementById('worldDungeonMonthInput');
  if (!worldDungeonState.month) worldDungeonState.month = currentMonthValue();
  monthInput.value = worldDungeonState.month;

  const [guilds, entries] = await Promise.all([
    api('/api/cave-schedule-servers'),
    api(`/api/world-dungeon-schedule?month=${worldDungeonState.month}`),
  ]);
  worldDungeonState.guilds = guilds;
  worldDungeonState.entries = {};
  entries.forEach((e) => {
    const key = String(e.date).slice(0, 10);
    if (!worldDungeonState.entries[key]) worldDungeonState.entries[key] = {};
    worldDungeonState.entries[key][e.dungeon] = e.guildName;
  });
  renderWorldDungeonCalendar();
}

function renderWorldDungeonCalendar() {
  document.getElementById('worldDungeonNoGuildsState').classList.toggle('hidden', worldDungeonState.guilds.length !== 0);
  document.getElementById('worldDungeonMonthHeading').textContent = formatMonthYear(worldDungeonState.month);
  document.getElementById('worldDungeonWeekdayRow').innerHTML = WORLD_DUNGEON_WEEKDAY_LABELS.map((d) => `<div class="schedule-weekday">${d}</div>`).join('');

  const [year, month] = worldDungeonState.month.split('-').map(Number);
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div class="schedule-day schedule-day-empty"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${worldDungeonState.month}-${String(day).padStart(2, '0')}`;
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const applicable = dow === 4 || dow === 0; // Thursday or Sunday

    if (!applicable) {
      cells.push(`<div class="schedule-day world-dungeon-day-inactive"><div class="schedule-day-number">${day}</div></div>`);
      continue;
    }

    const assigned = worldDungeonState.entries[date] || {};
    const rows = WORLD_DUNGEON_NAMES.map((dungeon) => {
      const current = assigned[dungeon] || '';
      const options = worldDungeonState.guilds
        .map((g) => `<option value="${escapeHtml(g.name)}" ${g.name === current ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
        .join('');
      return `
        <div class="world-dungeon-day-row">
          <span class="world-dungeon-day-label" title="${escapeHtml(dungeon)}">${escapeHtml(dungeon.slice(0, 1))}</span>
          <select class="world-dungeon-select admin-disable" data-date="${date}" data-dungeon="${dungeon}"><option value="">—</option>${options}</select>
        </div>`;
    }).join('');
    cells.push(`
      <div class="schedule-day world-dungeon-day">
        <div class="schedule-day-number">${day}</div>
        ${rows}
      </div>`);
  }

  const grid = document.getElementById('worldDungeonCalendarGrid');
  grid.innerHTML = cells.join('');

  grid.querySelectorAll('.world-dungeon-select').forEach((sel) => {
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

document.getElementById('worldDungeonMonthInput').addEventListener('change', (e) => {
  worldDungeonState.month = e.target.value;
  loadWorldDungeonScheduleData().catch((err) => toast(err.message));
});

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
        renderWorldDungeonCalendar();
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
    renderWorldDungeonCalendar();
    e.target.reset();
    toast(`${guild.name} added`);
  } catch (err) {
    toast(err.message);
  }
});
