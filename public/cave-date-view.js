const caveDateState = { date: null, sessions: [] };

async function loadCaveDateData(date) {
  caveDateState.date = date;
  const body = document.getElementById('caveDateBody');
  if (!date) {
    body.innerHTML = '';
    document.getElementById('caveDateHeading').textContent = 'No date specified';
    return;
  }
  document.getElementById('caveDateHeading').textContent = formatLongDate(date);
  body.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted)">Loading…</td></tr>';
  const [caves, bosses] = await Promise.all([api('/api/caves'), api('/api/boss-timers')]);
  caveDateState.sessions = caves.filter((s) => s.date === date);
  caveState.bosses = bosses;
  renderCaveDateView();
}

function renderCaveDateView() {
  const body = document.getElementById('caveDateBody');
  const sessions = caveDateState.sessions;
  document.getElementById('caveDateEmptyState').classList.toggle('hidden', sessions.length !== 0);

  body.innerHTML = '';
  sessions.forEach((sess) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;">${sess.run ? `<span class="class-badge">${escapeHtml(sess.run)}</span>` : '(No boss)'}</td>
      <td>${sess.attendees.length}</td>
      <td>${sess.records.length}</td>
      <td>${totalQty(sess)}</td>
      <td><button class="icon-btn admin-only" data-delete="${sess.id}" title="Delete boss log">✕</button></td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete]')) return;
      window.location.hash = `#/cave-session/${sess.id}`;
    });
    tr.querySelector('[data-delete]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${sess.run || 'this boss log'} and all its loot records?`)) return;
      await api(`/api/caves/${sess.id}`, { method: 'DELETE' });
      caveDateState.sessions = caveDateState.sessions.filter((s) => s.id !== sess.id);
      renderCaveDateView();
      toast('Boss log removed');
    });
    body.appendChild(tr);
  });
}

const addCaveBossModal = document.getElementById('addCaveBossModal');
const addCaveBossForm = document.getElementById('addCaveBossForm');

document.getElementById('addCaveBossBtn').addEventListener('click', () => {
  addCaveBossForm.reset();
  addCaveBossForm.run.innerHTML = bossNameSelectOptionsHtml();
  document.getElementById('addCaveBossDateLabel').textContent = formatLongDate(caveDateState.date);
  addCaveBossModal.classList.remove('hidden');
});

addCaveBossForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(addCaveBossForm);
  try {
    const session = await api('/api/caves', {
      method: 'POST',
      body: JSON.stringify({
        date: caveDateState.date,
        run: fd.get('run'),
      }),
    });
    addCaveBossModal.classList.add('hidden');
    window.location.hash = `#/cave-session/${session.id}`;
  } catch (err) {
    toast(err.message);
  }
});
