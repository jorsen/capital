const VIEW_TITLES = {
  members: 'Capital Records',
  queue: 'Insignia Queue — Capital Records',
  loot: 'Guild Dungeon Loot — Capital Records',
  'loot-session': 'Loot Details — Capital Records',
  caves: 'Cave Attendance — Capital Records',
  'cave-date': 'Cave Date — Capital Records',
  'cave-session': 'Cave Details — Capital Records',
  'cave-report': 'Cave Attendance Report — Capital Records',
  'cave-loot-list': 'Cave Loot List — Capital Records',
  'cave-salary': 'Cave Salary — Capital Records',
  'cave-schedule': 'Cave Schedule — Capital Records',
  items: 'Item Report — Capital Records',
  bosses: 'Boss Timers — Capital Records',
  'world-dungeon': 'World Dungeon Schedule — Capital Records',
  users: 'Users — Capital Records',
  'activity-log': 'Activity Log — Capital Records',
};
const VALID_VIEWS = ['members', 'queue', 'loot', 'loot-session', 'caves', 'cave-date', 'cave-session', 'cave-report', 'cave-loot-list', 'cave-salary', 'cave-schedule', 'items', 'bosses', 'world-dungeon', 'users', 'activity-log'];
const ADMIN_ONLY_VIEWS = ['users', 'activity-log'];

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
  let activeView = VALID_VIEWS.includes(view) ? view : 'members';
  if (ADMIN_ONLY_VIEWS.includes(activeView) && !isAdmin()) {
    window.location.hash = '#/members';
    return;
  }

  showView(activeView);
  document.title = VIEW_TITLES[activeView] || 'Capital Records';

  // Boss Timers polls the server every 5s while its view is open; stop that
  // the moment we navigate anywhere else, or it keeps hitting the database
  // in the background for as long as the tab stays open.
  if (activeView !== 'bosses' && typeof stopBossTimerPolling === 'function') stopBossTimerPolling();

  if (activeView === 'members') loadMembersData().catch((err) => toast(err.message));
  if (activeView === 'queue') loadQueueData().catch((err) => toast(err.message));
  if (activeView === 'loot') loadLootData().catch((err) => toast(err.message));
  if (activeView === 'loot-session') loadSessionData(param);
  if (activeView === 'caves') loadCaveData().catch((err) => toast(err.message));
  if (activeView === 'cave-date') loadCaveDateData(param).catch((err) => toast(err.message));
  if (activeView === 'cave-session') loadCaveSessionData(param);
  if (activeView === 'cave-report') loadCaveReportData().catch((err) => toast(err.message));
  if (activeView === 'cave-loot-list') loadCaveLootListData().catch((err) => toast(err.message));
  if (activeView === 'cave-salary') loadCaveSalaryData().catch((err) => toast(err.message));
  if (activeView === 'cave-schedule') loadCaveScheduleData().catch((err) => toast(err.message));
  if (activeView === 'items') loadItemReportData().catch((err) => toast(err.message));
  if (activeView === 'bosses') {
    loadBossTimerData().catch((err) => toast(err.message));
    loadBossHistoryData().catch((err) => toast(err.message));
  }
  if (activeView === 'world-dungeon') loadWorldDungeonScheduleData().catch((err) => toast(err.message));
  if (activeView === 'users') loadUsersData().catch((err) => toast(err.message));
  if (activeView === 'activity-log') loadActivityLogData().catch((err) => toast(err.message));
}

window.addEventListener('hashchange', parseRoute);
// Waits for the role check (see common.js) so the very first render already
// knows whether to show admin controls, instead of showing them and then
// yanking them away once the session check resolves a moment later.
sessionReady.then(parseRoute);
