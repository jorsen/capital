async function loadActivityLogData() {
  const entries = await api('/api/activity-log?limit=300');
  renderActivityLog(entries);
}

function renderActivityLog(entries) {
  const body = document.getElementById('activityLogBody');
  document.getElementById('activityLogEmptyState').classList.toggle('hidden', entries.length !== 0);

  body.innerHTML = entries
    .map(
      (e) => `
    <tr>
      <td style="white-space:nowrap;">${new Date(e.createdAt).toLocaleString()}</td>
      <td>${escapeHtml(e.username)} <span style="color:var(--text-muted); font-size:12px;">(${escapeHtml(e.role)})</span></td>
      <td><span class="class-badge">${escapeHtml(e.action)}</span></td>
      <td>${escapeHtml(e.description)}</td>
    </tr>`
    )
    .join('');
}
