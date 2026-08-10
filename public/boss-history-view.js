const BOSS_HISTORY_PAGE_SIZE = 15;
const bossHistoryState = { entries: [], page: 1 };

async function loadBossHistoryData() {
  const history = await api('/api/boss-history');
  bossHistoryState.entries = history;
  bossHistoryState.page = 1;
  renderBossHistory();
}

function formatHistoryTimestamp(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderBossHistory() {
  const { entries } = bossHistoryState;
  const pageCount = Math.max(1, Math.ceil(entries.length / BOSS_HISTORY_PAGE_SIZE));
  bossHistoryState.page = Math.min(Math.max(1, bossHistoryState.page), pageCount);
  const start = (bossHistoryState.page - 1) * BOSS_HISTORY_PAGE_SIZE;
  const pageEntries = entries.slice(start, start + BOSS_HISTORY_PAGE_SIZE);

  const body = document.getElementById('bossHistoryBody');
  body.innerHTML = pageEntries
    .map(
      (h) => `
    <tr>
      <td>${escapeHtml(h.bossName)}</td>
      <td>${formatHistoryTimestamp(h.killedAt)}</td>
      <td>${h.source === 'discord' ? 'Discord' : 'Manual'}</td>
      <td>${h.discordAuthor ? escapeHtml(h.discordAuthor) : '—'}</td>
      <td class="col-right"><button type="button" class="icon-btn admin-only" data-delete-history="${h.id}" title="Delete entry">×</button></td>
    </tr>`
    )
    .join('');

  document.getElementById('bossHistoryEmptyState').classList.toggle('hidden', entries.length !== 0);
  renderBossHistoryPagination(pageCount);

  body.querySelectorAll('[data-delete-history]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const result = await api(`/api/boss-history/${btn.getAttribute('data-delete-history')}`, { method: 'DELETE' });
        loadBossHistoryData();
        if (result.revertedBossId) {
          // This was the kill currently driving the boss's live countdown —
          // the server already rolled last_killed_at back; refresh the grid
          // now instead of waiting on its next 5s poll tick.
          if (typeof pollBossTimers === 'function') pollBossTimers();
          toast(result.revertedTo ? `Entry deleted — timer reverted to previous kill` : `Entry deleted — timer cleared (no kills left logged)`);
        } else {
          toast('Entry deleted');
        }
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

function renderBossHistoryPagination(pageCount) {
  const el = document.getElementById('bossHistoryPagination');
  if (pageCount <= 1) {
    el.innerHTML = '';
    return;
  }
  const { page } = bossHistoryState;
  el.innerHTML = `
    <button type="button" class="btn small" id="bossHistoryPrevBtn" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
    <span class="pagination-status">Page ${page} of ${pageCount}</span>
    <button type="button" class="btn small" id="bossHistoryNextBtn" ${page >= pageCount ? 'disabled' : ''}>Next ›</button>
  `;
  const prevBtn = document.getElementById('bossHistoryPrevBtn');
  const nextBtn = document.getElementById('bossHistoryNextBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => { bossHistoryState.page -= 1; renderBossHistory(); });
  if (nextBtn) nextBtn.addEventListener('click', () => { bossHistoryState.page += 1; renderBossHistory(); });
}
