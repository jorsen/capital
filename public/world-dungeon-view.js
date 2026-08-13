// World Dungeon Schedule — every Thursday and Sunday, every single week
// (no skipping), two fixed bosses (Hisharat, Chantarat). An admin manually
// assigns which guild is taking on each boss per date. Styled as a plain
// white "announcement" table (spreadsheet look, not the app's usual dark
// theme) since it's meant to be screenshotted/shared with the guild, with
// each guild's cells shaded a consistent pastel color. Guild picklist is
// shared with Cave Schedule's server list (see the comment in lib/db.js)
// rather than a second duplicate list.

const worldDungeonState = {
  guilds: [], // [{id, name}] -- shared cave_schedule_servers list
  entries: {}, // { 'YYYY-MM-DD': { Hisharat: 'GuildName', Chantarat: 'GuildName' } }
};

const WORLD_DUNGEON_NAMES = ['Hisharat', 'Chantarat'];
// This week's pair plus next week's (two Thursday+Sunday pairs) -- once the
// first passes, the anchor in worldDungeonUpcomingDates() naturally moves
// forward, so the table always shows the current week plus the next one,
// not a long rolling list of future weeks.
const WORLD_DUNGEON_UPCOMING_PAIRS = 2;

// Light pastel fills, one per guild (assigned by list order, same pattern as
// Cave Schedule's SCHEDULE_COLORS) -- dark text stays readable on all of them.
const WORLD_DUNGEON_PASTELS = ['#d7f5df', '#d6e9fb', '#fdf0d5', '#fbdada', '#e6d9f7', '#d3f3f3', '#fbdcea', '#e8f3cf'];

function worldDungeonGuildColor(name) {
  if (!name) return null;
  const idx = worldDungeonState.guilds.findIndex((g) => g.name === name);
  return idx === -1 ? null : WORLD_DUNGEON_PASTELS[idx % WORLD_DUNGEON_PASTELS.length];
}

// The next upcoming Thursday (today counts if today is one) anchors "pair
// 1" -- its Sunday is 3 days later, then each following pair's Thursday is
// 7 days after the previous one's (every week, no skipping). Walked in UTC
// day-math so a DST shift can't skip or duplicate a date.
function worldDungeonUpcomingDates(pairCount) {
  const now = new Date();
  let anchorThursday = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  while (anchorThursday.getUTCDay() !== 4) {
    anchorThursday = new Date(anchorThursday.getTime() + 86400000);
  }

  const dates = [];
  for (let i = 0; i < pairCount; i++) {
    const thursday = new Date(anchorThursday.getTime() + i * 7 * 86400000);
    const sunday = new Date(thursday.getTime() + 3 * 86400000);
    dates.push(thursday.toISOString().slice(0, 10), sunday.toISOString().slice(0, 10));
  }
  return dates;
}

// "August 13th" -- no year, ordinal day, matching a guild-announcement style
// rather than the app's usual full formatLongDate().
function worldDungeonOrdinalDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDate();
  const month = d.toLocaleDateString(undefined, { month: 'long' });
  const v = day % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] || 'th';
  return `${month} ${day}${suffix}`;
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

  const dates = worldDungeonUpcomingDates(WORLD_DUNGEON_UPCOMING_PAIRS);
  const body = document.getElementById('worldDungeonScheduleBody');
  body.innerHTML = dates
    .map((date) => {
      const assigned = worldDungeonState.entries[date] || {};
      const cells = WORLD_DUNGEON_NAMES.map((dungeon) => {
        const current = assigned[dungeon] || '';
        const color = worldDungeonGuildColor(current);
        const options = worldDungeonState.guilds
          .map((g) => `<option value="${escapeHtml(g.name)}" ${g.name === current ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
          .join('');
        return `<td style="${color ? `background:${color};` : ''}"><select class="world-dungeon-select admin-disable" data-date="${date}" data-dungeon="${dungeon}"><option value="">—</option>${options}</select></td>`;
      }).join('');
      return `<tr><td>${worldDungeonOrdinalDate(date)}</td>${cells}</tr>`;
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
        renderWorldDungeonSchedule(); // re-render so the cell's pastel fill updates immediately
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
      (g, i) => `
      <li style="display:flex; gap:8px; align-items:center;" data-guild-id="${g.id}">
        <span class="schedule-dot" style="background:${WORLD_DUNGEON_PASTELS[i % WORLD_DUNGEON_PASTELS.length]}"></span>
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

// worldDungeonUpcomingDates() always computes from "now", so if someone
// leaves this page open across the date rolling into the next set, it would
// otherwise keep showing the stale set until they manually reload. Re-check
// hourly (only while this view is actually the visible one) so it rolls
// over on its own.
setInterval(() => {
  const view = document.getElementById('view-world-dungeon');
  if (view && !view.classList.contains('hidden')) {
    loadWorldDungeonScheduleData().catch((err) => toast(err.message));
  }
}, 60 * 60 * 1000);
