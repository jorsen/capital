const LOOT_PAGE_SIZE = 15;
const lootState = {
  loot: [],
  members: [],
  search: '',
  sortKey: 'date',
  sortDir: -1,
  page: 1,
};

async function loadLootData() {
  const [loot, members] = await Promise.all([api('/api/loot'), api('/api/members')]);
  lootState.loot = loot;
  lootState.members = members;
  renderLootView();
}

// ---------- Sessions table ----------

function getFilteredSortedLoot() {
  const q = lootState.search.toLowerCase();
  let list = lootState.loot.filter((s) => {
    if (!q) return true;
    if (s.date.toLowerCase().includes(q)) return true;
    if ((s.run || '').toLowerCase().includes(q)) return true;
    return s.records.some(
      (r) => r.item.toLowerCase().includes(q) || r.recipientName.toLowerCase().includes(q)
    );
  });
  list = list.slice().sort((a, b) => {
    let av = (a[lootState.sortKey] || '').toString().toLowerCase();
    let bv = (b[lootState.sortKey] || '').toString().toLowerCase();
    if (av < bv) return -1 * lootState.sortDir;
    if (av > bv) return 1 * lootState.sortDir;
    return 0;
  });
  return list;
}

function renderLootView() {
  const list = getFilteredSortedLoot();
  const pageCount = Math.max(1, Math.ceil(list.length / LOOT_PAGE_SIZE));
  lootState.page = Math.min(Math.max(1, lootState.page), pageCount);
  const start = (lootState.page - 1) * LOOT_PAGE_SIZE;
  const pageList = list.slice(start, start + LOOT_PAGE_SIZE);

  const body = document.getElementById('sessionsBody');
  body.innerHTML = '';
  document.getElementById('lootEmptyState').classList.toggle('hidden', lootState.loot.length !== 0);
  renderLootPagination(pageCount);

  pageList.forEach((sess) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;">${escapeHtml(sess.date)}</td>
      <td>${sess.run ? `<span class="class-badge">${escapeHtml(sess.run)}</span>` : ''}</td>
      <td class="col-right">${sess.records.length}</td>
      <td class="col-right">${totalQty(sess)}</td>
      <td class="col-right"><button class="icon-btn admin-only" data-delete="${sess.id}" title="Delete date">✕</button></td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete]')) return;
      window.location.hash = `#/loot-session/${sess.id}`;
    });
    tr.querySelector('[data-delete]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${sess.date}${sess.run ? ` (${sess.run})` : ''} and all its loot records?`)) return;
      await api(`/api/loot/${sess.id}`, { method: 'DELETE' });
      lootState.loot = lootState.loot.filter((s) => s.id !== sess.id);
      renderLootView();
      toast('Date removed');
    });
    body.appendChild(tr);
  });
}

function renderLootPagination(pageCount) {
  const el = document.getElementById('lootPagination');
  if (pageCount <= 1) {
    el.innerHTML = '';
    return;
  }
  const { page } = lootState;
  el.innerHTML = `
    <button type="button" class="btn small" id="lootPrevBtn" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <span class="pagination-status">Page ${page} of ${pageCount}</span>
    <button type="button" class="btn small" id="lootNextBtn" ${page >= pageCount ? 'disabled' : ''}>Next ›</button>
  `;
  const prevBtn = document.getElementById('lootPrevBtn');
  const nextBtn = document.getElementById('lootNextBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => { lootState.page -= 1; renderLootView(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { lootState.page += 1; renderLootView(); });
}

// ---------- Add session ----------

const addSessionModal = document.getElementById('addSessionModal');
const addSessionForm = document.getElementById('addSessionForm');

document.getElementById('addSessionBtn').addEventListener('click', () => {
  addSessionForm.reset();
  addSessionForm.date.value = new Date().toISOString().slice(0, 10);
  addSessionForm.run.value = 'Guild Dungeon';
  addSessionModal.classList.remove('hidden');
});

addSessionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(addSessionForm);
  try {
    const session = await api('/api/loot', {
      method: 'POST',
      body: JSON.stringify({
        date: fd.get('date'),
        run: fd.get('run'),
      }),
    });
    addSessionModal.classList.add('hidden');
    window.location.hash = `#/loot-session/${session.id}`;
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Toolbar wiring ----------

document.getElementById('lootSearchInput').addEventListener('input', (e) => {
  lootState.search = e.target.value;
  lootState.page = 1;
  renderLootView();
});

document.querySelectorAll('#view-loot th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.getAttribute('data-sort');
    if (lootState.sortKey === key) {
      lootState.sortDir *= -1;
    } else {
      lootState.sortKey = key;
      lootState.sortDir = 1;
    }
    lootState.page = 1;
    renderLootView();
  });
});
