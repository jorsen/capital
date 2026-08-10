async function loadActivityLogData() {
  const entries = await api('/api/activity-log?limit=300');
  renderActivityLog(entries);
}

// camelCase field name -> readable label, e.g. "className" -> "Class Name".
function humanizeFieldName(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function formatChangeValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? escapeHtml(value.join(', ')) : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return escapeHtml(String(value));
}

// Renders what actually changed for one activity log entry:
// - create: lists the fields the new record was created with
// - delete: lists the fields the removed record had
// - update: lists only the fields whose value actually changed, as old → new
function renderEntryChanges(entry) {
  const before = entry.before;
  const after = entry.after;

  if (before && after) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const lines = [];
    keys.forEach((key) => {
      const a = before[key];
      const b = after[key];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        lines.push(`<div><strong>${escapeHtml(humanizeFieldName(key))}:</strong> ${formatChangeValue(a)} → ${formatChangeValue(b)}</div>`);
      }
    });
    if (!lines.length) return `<span style="color:var(--text-muted);">${escapeHtml(t('activityLog.noChanges'))}</span>`;
    return lines.join('');
  }

  const snapshot = after || before;
  if (!snapshot) return '';
  return Object.keys(snapshot)
    .map((key) => `<div><strong>${escapeHtml(humanizeFieldName(key))}:</strong> ${formatChangeValue(snapshot[key])}</div>`)
    .join('');
}

function renderActivityLog(entries) {
  const body = document.getElementById('activityLogBody');
  document.getElementById('activityLogEmptyState').classList.toggle('hidden', entries.length !== 0);

  // Changes get their own full-width row below the main one instead of a
  // fifth narrow column — a long attendee-list diff has room to actually
  // read instead of wrapping awkwardly in a squeezed cell.
  body.innerHTML = entries
    .map((e) => {
      const changesHtml = renderEntryChanges(e);
      const mainRow = `
    <tr>
      <td style="white-space:nowrap;">${new Date(e.createdAt).toLocaleString()}</td>
      <td>${escapeHtml(e.username)} <span style="color:var(--text-muted); font-size:12px;">(${escapeHtml(e.role)})</span></td>
      <td><span class="class-badge">${escapeHtml(e.action)}</span></td>
      <td>${escapeHtml(e.description)}</td>
    </tr>`;
      const changesRow = changesHtml
        ? `
    <tr class="activity-log-changes-row">
      <td colspan="4">
        <span style="color:var(--text-muted); font-size:12px;">${escapeHtml(t('activityLog.thChanges'))}:</span>
        <div style="font-size:12px; margin-top:2px;">${changesHtml}</div>
      </td>
    </tr>`
        : '';
      return mainRow + changesRow;
    })
    .join('');
}
