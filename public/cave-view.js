const CAVE_PAGE_SIZE = 15;
const caveState = {
  caves: [],
  members: [],
  bosses: [],
  search: '',
  sortDir: -1,
  page: 1,
};

async function loadCaveData() {
  const [caves, members, bosses] = await Promise.all([api('/api/caves'), api('/api/members'), api('/api/boss-timers')]);
  caveState.caves = caves;
  caveState.members = members;
  caveState.bosses = bosses;
  renderCaveView();
}

function bossNameSelectOptionsHtml() {
  const options = caveState.bosses
    .map((b) => `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`)
    .join('');
  return `<option value="" selected>Select a boss…</option>${options}`;
}

// ---------- Dates table ----------

function getCaveDateGroups() {
  const q = caveState.search.toLowerCase();
  const byDate = new Map();
  caveState.caves.forEach((s) => {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  });

  let groups = Array.from(byDate.entries()).map(([date, sessions]) => ({
    date,
    sessions,
    attendees: sessions.reduce((sum, s) => sum + s.attendees.length, 0),
    records: sessions.reduce((sum, s) => sum + s.records.length, 0),
    totalQty: sessions.reduce((sum, s) => sum + totalQty(s), 0),
  }));

  if (q) {
    groups = groups.filter((g) => {
      if (g.date.toLowerCase().includes(q)) return true;
      return g.sessions.some(
        (s) => (s.run || '').toLowerCase().includes(q) || s.records.some((r) => r.item.toLowerCase().includes(q))
      );
    });
  }

  groups.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * caveState.sortDir);
  return groups;
}

function renderCaveView() {
  const groups = getCaveDateGroups();
  const pageCount = Math.max(1, Math.ceil(groups.length / CAVE_PAGE_SIZE));
  caveState.page = Math.min(Math.max(1, caveState.page), pageCount);
  const start = (caveState.page - 1) * CAVE_PAGE_SIZE;
  const pageGroups = groups.slice(start, start + CAVE_PAGE_SIZE);

  const body = document.getElementById('caveSessionsBody');
  body.innerHTML = '';
  document.getElementById('caveEmptyState').classList.toggle('hidden', caveState.caves.length !== 0);
  renderCavePagination(pageCount);

  pageGroups.forEach((g) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;">${escapeHtml(formatLongDate(g.date))}</td>
      <td>${g.sessions.length}</td>
      <td>${g.attendees}</td>
      <td>${g.records}</td>
      <td>${g.totalQty}</td>
      <td><button class="icon-btn admin-only" data-delete="${g.date}" title="Delete date">✕</button></td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete]')) return;
      window.location.hash = `#/cave-date/${g.date}`;
    });
    tr.querySelector('[data-delete]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const count = g.sessions.length;
      if (!confirm(`Delete ${g.date} and all ${count} boss log${count === 1 ? '' : 's'} (and their loot records)?`)) return;
      await Promise.all(g.sessions.map((s) => api(`/api/caves/${s.id}`, { method: 'DELETE' })));
      caveState.caves = caveState.caves.filter((s) => s.date !== g.date);
      renderCaveView();
      toast('Date removed');
    });
    body.appendChild(tr);
  });
}

function renderCavePagination(pageCount) {
  const el = document.getElementById('cavePagination');
  if (pageCount <= 1) {
    el.innerHTML = '';
    return;
  }
  const { page } = caveState;
  el.innerHTML = `
    <button type="button" class="btn small" id="cavePrevBtn" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <span class="pagination-status">Page ${page} of ${pageCount}</span>
    <button type="button" class="btn small" id="caveNextBtn" ${page >= pageCount ? 'disabled' : ''}>Next ›</button>
  `;
  const prevBtn = document.getElementById('cavePrevBtn');
  const nextBtn = document.getElementById('caveNextBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => { caveState.page -= 1; renderCaveView(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { caveState.page += 1; renderCaveView(); });
}

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

// ---------- Toolbar wiring ----------

document.getElementById('caveSearchInput').addEventListener('input', (e) => {
  caveState.search = e.target.value;
  caveState.page = 1;
  renderCaveView();
});

document.querySelectorAll('#view-caves th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    caveState.sortDir *= -1;
    caveState.page = 1;
    renderCaveView();
  });
});
