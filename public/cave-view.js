const caveState = {
  caves: [],
  members: [],
  search: '',
  sortKey: 'date',
  sortDir: -1,
};

async function loadCaveData() {
  const [caves, members] = await Promise.all([api('/api/caves'), api('/api/members')]);
  caveState.caves = caves;
  caveState.members = members;
  renderCaveView();
}

// ---------- Sessions table ----------

function getFilteredSortedCaves() {
  const q = caveState.search.toLowerCase();
  let list = caveState.caves.filter((s) => {
    if (!q) return true;
    if (s.date.toLowerCase().includes(q)) return true;
    if ((s.run || '').toLowerCase().includes(q)) return true;
    return s.records.some(
      (r) => r.item.toLowerCase().includes(q) || r.recipientName.toLowerCase().includes(q)
    );
  });
  list = list.slice().sort((a, b) => {
    let av = (a[caveState.sortKey] || '').toString().toLowerCase();
    let bv = (b[caveState.sortKey] || '').toString().toLowerCase();
    if (av < bv) return -1 * caveState.sortDir;
    if (av > bv) return 1 * caveState.sortDir;
    return 0;
  });
  return list;
}

function renderCaveView() {
  const list = getFilteredSortedCaves();
  const body = document.getElementById('caveSessionsBody');
  body.innerHTML = '';
  document.getElementById('caveEmptyState').classList.toggle('hidden', caveState.caves.length !== 0);

  list.forEach((sess) => {
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
      window.location.hash = `#/cave-session/${sess.id}`;
    });
    tr.querySelector('[data-delete]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${sess.date}${sess.run ? ` (${sess.run})` : ''} and all its loot records?`)) return;
      await api(`/api/caves/${sess.id}`, { method: 'DELETE' });
      caveState.caves = caveState.caves.filter((s) => s.id !== sess.id);
      renderCaveView();
      toast('Date removed');
    });
    body.appendChild(tr);
  });
}

// ---------- Add cave date ----------

const addCaveModal = document.getElementById('addCaveModal');
const addCaveForm = document.getElementById('addCaveForm');

document.getElementById('addCaveBtn').addEventListener('click', () => {
  addCaveForm.reset();
  addCaveForm.date.value = new Date().toISOString().slice(0, 10);
  addCaveModal.classList.remove('hidden');
});

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
    window.location.hash = `#/cave-session/${session.id}`;
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Toolbar wiring ----------

document.getElementById('caveSearchInput').addEventListener('input', (e) => {
  caveState.search = e.target.value;
  renderCaveView();
});

document.querySelectorAll('#view-caves th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.getAttribute('data-sort');
    if (caveState.sortKey === key) {
      caveState.sortDir *= -1;
    } else {
      caveState.sortKey = key;
      caveState.sortDir = 1;
    }
    renderCaveView();
  });
});
