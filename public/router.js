const VIEW_TITLES = {
  members: 'Capital Records',
  queue: 'Insignia Queue — Capital Records',
  loot: 'Guild Dungeon Loot — Capital Records',
  'loot-session': 'Loot Details — Capital Records',
  caves: 'Cave Attendance — Capital Records',
  'cave-session': 'Cave Details — Capital Records',
  'cave-report': 'Cave Attendance Report — Capital Records',
  items: 'Item Report — Capital Records',
  bosses: 'Boss Timers — Capital Records',
};
const VALID_VIEWS = ['members', 'queue', 'loot', 'loot-session', 'caves', 'cave-session', 'cave-report', 'items', 'bosses'];

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  const el = document.getElementById(`view-${name}`);
  if (el) el.classList.remove('hidden');

  document.querySelectorAll('.nav-link').forEach((a) => a.classList.remove('active'));
  const link = document.querySelector(`.nav-link[data-view="${name}"]`);
  if (link) link.classList.add('active');
}

function parseRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [view, param] = hash.split('/');
  const activeView = VALID_VIEWS.includes(view) ? view : 'members';

  showView(activeView);
  document.title = VIEW_TITLES[activeView] || 'Capital Records';

  if (activeView === 'members') loadMembersData().catch((err) => toast(err.message));
  if (activeView === 'queue') loadQueueData().catch((err) => toast(err.message));
  if (activeView === 'loot') loadLootData().catch((err) => toast(err.message));
  if (activeView === 'loot-session') loadSessionData(param);
  if (activeView === 'caves') loadCaveData().catch((err) => toast(err.message));
  if (activeView === 'cave-session') loadCaveSessionData(param);
  if (activeView === 'cave-report') loadCaveReportData().catch((err) => toast(err.message));
  if (activeView === 'items') loadItemReportData().catch((err) => toast(err.message));
  if (activeView === 'bosses') {
    loadBossTimerData().catch((err) => toast(err.message));
    loadBossHistoryData().catch((err) => toast(err.message));
  }
}

window.addEventListener('hashchange', parseRoute);
// Waits for the role check (see common.js) so the very first render already
// knows whether to show admin controls, instead of showing them and then
// yanking them away once the session check resolves a moment later.
sessionReady.then(parseRoute);
