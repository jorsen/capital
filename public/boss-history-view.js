async function loadBossHistoryData() {
  const history = await api('/api/boss-history');
  renderBossHistory(history);
}

function formatHistoryTimestamp(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderBossHistory(history) {
  const body = document.getElementById('bossHistoryBody');
  body.innerHTML = history
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

  document.getElementById('bossHistoryEmptyState').classList.toggle('hidden', history.length !== 0);

  body.querySelectorAll('[data-delete-history]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/boss-history/${btn.getAttribute('data-delete-history')}`, { method: 'DELETE' });
        loadBossHistoryData();
      } catch (err) {
        toast(err.message);
      }
    });
  });
}
