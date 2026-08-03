const VIEW_TITLES = {
  members: 'Capital Records',
  queue: 'Insignia Queue — Capital Records',
  loot: 'Guild Dungeon Loot — Capital Records',
  'loot-session': 'Loot Details — Capital Records',
  items: 'Item Report — Capital Records',
};
const VALID_VIEWS = ['members', 'queue', 'loot', 'loot-session', 'items'];

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
  if (activeView === 'items') loadItemReportData().catch((err) => toast(err.message));
}

window.addEventListener('hashchange', parseRoute);
parseRoute();
