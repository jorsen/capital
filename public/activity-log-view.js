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
// Each field is its own "chip" so a long list of small changes reads as
// distinct scannable pieces instead of one run-on paragraph.
function renderEntryChanges(entry) {
  const before = entry.before;
  const after = entry.after;

  if (before && after) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const chips = [];
    keys.forEach((key) => {
      const a = before[key];
      const b = after[key];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        chips.push(`
          <div class="change-chip">
            <span class="change-field">${escapeHtml(humanizeFieldName(key))}</span>
            <span class="change-old">${formatChangeValue(a)}</span>
            <span class="change-arrow">→</span>
            <span class="change-new">${formatChangeValue(b)}</span>
          </div>`);
      }
    });
    if (!chips.length) return `<span class="change-none">${escapeHtml(t('activityLog.noChanges'))}</span>`;
    return chips.join('');
  }

  const snapshot = after || before;
  if (!snapshot) return '<span class="change-none">—</span>';
  return Object.keys(snapshot)
    .map(
      (key) => `
          <div class="change-chip">
            <span class="change-field">${escapeHtml(humanizeFieldName(key))}</span>
            <span class="change-new">${formatChangeValue(snapshot[key])}</span>
          </div>`
    )
    .join('');
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
      <td class="col-changes"><div class="change-list">${renderEntryChanges(e)}</div></td>
    </tr>`
    )
    .join('');
}
