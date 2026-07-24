const lootState = {
  loot: [],
  members: [],
  search: '',
  sortKey: 'date',
  sortDir: -1,
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
    if ((s.notes || '').toLowerCase().includes(q)) return true;
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
  const body = document.getElementById('sessionsBody');
  body.innerHTML = '';
  document.getElementById('lootEmptyState').classList.toggle('hidden', lootState.loot.length !== 0);

  list.forEach((sess) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;">${escapeHtml(sess.date)}</td>
      <td>${sess.run ? `<span class="class-badge">${escapeHtml(sess.run)}</span>` : ''}</td>
      <td class="col-right">${sess.records.length}</td>
      <td class="col-right">${totalQty(sess)}</td>
      <td style="color:var(--text-muted); font-size:13px;">${escapeHtml(sess.notes)}</td>
      <td class="col-right"><button class="icon-btn" data-delete="${sess.id}" title="Delete date">✕</button></td>
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
        notes: fd.get('notes'),
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
    renderLootView();
  });
});
