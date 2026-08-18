const discordSyncModal = document.getElementById('discordSyncModal');
const discordSyncForm = document.getElementById('discordSyncForm');

document.getElementById('discordSyncBtn').addEventListener('click', () => {
  discordSyncForm.reset();
  discordSyncForm.month.value = currentMonthValue();
  document.getElementById('discordSyncResults').innerHTML = '';
  discordSyncModal.classList.remove('hidden');
});

discordSyncForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(discordSyncForm);
  const month = fd.get('month');
  const resultsEl = document.getElementById('discordSyncResults');
  const submitBtn = discordSyncForm.querySelector('button[type=submit]');

  submitBtn.disabled = true;
  resultsEl.innerHTML = '<p style="color:var(--text-muted);">Scanning #cave-attendance… this can take a moment.</p>';
  try {
    const result = await api('/api/cave-attendance-sync', {
      method: 'POST',
      body: JSON.stringify({ month }),
    });
    renderDiscordSyncResults(result);
    if (typeof loadCaveData === 'function' && !document.getElementById('view-caves').classList.contains('hidden')) {
      loadCaveData().catch(() => {});
    }
  } catch (err) {
    resultsEl.innerHTML = `<p style="color:var(--bad);">${escapeHtml(err.message)}</p>`;
  } finally {
    submitBtn.disabled = false;
  }
});

function renderDiscordSyncResults(result) {
  const resultsEl = document.getElementById('discordSyncResults');
  const applied = result.results.filter((r) => !r.skipped);
  const skipped = result.results.filter((r) => r.skipped);

  resultsEl.innerHTML = `
    <p style="font-weight:600;">Scanned ${result.scanned} message${result.scanned === 1 ? '' : 's'} — logged ${applied.length}, skipped ${skipped.length}.</p>
    <div class="table-scroll">
      <table class="growth-table">
        <thead><tr><th>Boss</th><th>Date</th><th>Attendees</th><th>Matched</th><th>Not recognized</th><th></th></tr></thead>
        <tbody>
          ${
            applied
              .map(
                (r) => `
          <tr>
            <td>${escapeHtml(r.boss)}</td>
            <td>${escapeHtml(r.date)}</td>
            <td>${r.matchedNames.length}</td>
            <td>${r.matchedNames.map((n) => `<div>${escapeHtml(n)}</div>`).join('')}</td>
            <td style="color:${r.unmatched.length ? 'var(--gold)' : 'var(--text-muted)'};">${r.unmatched.length ? r.unmatched.map((t) => `<div>${escapeHtml(t)}</div>`).join('') : '—'}</td>
            <td><a href="#/cave-session/${r.sessionId}" class="cave-date-link" data-close-sync-modal>Open</a></td>
          </tr>`
              )
              .join('') || ''
          }
          ${
            skipped
              .map(
                (r) => `
          <tr>
            <td colspan="6" style="color:var(--text-muted);">
              Skipped${r.boss ? ` (${escapeHtml(r.boss)}${r.date ? ` ${escapeHtml(r.date)}` : ''})` : ''}: ${escapeHtml(r.reason)}
              ${
                r.attempted && r.attempted.length
                  ? `<div style="margin-top:2px;">Found but didn't match anyone: ${r.attempted.map((t) => escapeHtml(t)).join(', ')}</div>`
                  : ''
              }
            </td>
          </tr>`
              )
              .join('')
          }
        </tbody>
      </table>
    </div>
  `;

  resultsEl.querySelectorAll('[data-close-sync-modal]').forEach((link) => {
    link.addEventListener('click', () => discordSyncModal.classList.add('hidden'));
  });
}

// ---------- One-time cleanup: split attendance merged before per-message
// session tracking existed (see /api/cave-attendance-unmerge) ----------

const unmergeAttendanceModal = document.getElementById('unmergeAttendanceModal');
const unmergePreviewBtn = document.getElementById('unmergePreviewBtn');
const unmergeApplyBtn = document.getElementById('unmergeApplyBtn');

document.getElementById('unmergeAttendanceBtn').addEventListener('click', () => {
  unmergeApplyBtn.classList.add('hidden');
  document.getElementById('unmergeResults').innerHTML = '';
  unmergeAttendanceModal.classList.remove('hidden');
});

// Guild operates on Philippines time (UTC+8, no DST) -- matches the
// server's own BOSS_CHAT_TIMEZONE_OFFSET_MINUTES convention.
function formatPhTimeOfDay(isoString) {
  const d = new Date(new Date(isoString).getTime() + 8 * 60 * 60000);
  let hour = d.getUTCHours();
  const minute = String(d.getUTCMinutes()).padStart(2, '0');
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix}`;
}

function renderUnmergePlan(result, { applied }) {
  const resultsEl = document.getElementById('unmergeResults');
  if (result.message) {
    resultsEl.innerHTML = `<p style="color:var(--text-muted);">${escapeHtml(result.message)}</p>`;
    return;
  }

  const groupRows = result.groups
    .map(
      (g) => `
    <tr>
      <td>${escapeHtml(g.boss)}</td>
      <td>${escapeHtml(g.date)}</td>
      <td>${g.splitInto.length}</td>
      <td>${g.splitInto
        .map((s) => `<div>${s.killedAt ? escapeHtml(formatPhTimeOfDay(s.killedAt)) : 'no time stated'} — ${s.attendeeCount} attendee${s.attendeeCount === 1 ? '' : 's'}</div>`)
        .join('')}</td>
    </tr>`
    )
    .join('');
  const errorRows = (result.reconstructedErrors || [])
    .map((r) => `<tr><td colspan="4" style="color:var(--gold);">Message ${escapeHtml(r.messageId)}: ${escapeHtml(r.error)}</td></tr>`)
    .join('');

  resultsEl.innerHTML = `
    <p style="font-weight:600;">${applied ? 'Applied' : 'Preview'} — ${result.groups.length} record${result.groups.length === 1 ? '' : 's'} to split${result.reconstructedErrors && result.reconstructedErrors.length ? `, ${result.reconstructedErrors.length} message(s) couldn't be re-checked` : ''}.</p>
    ${
      result.groups.length
        ? `<div class="table-scroll">
            <table class="growth-table">
              <thead><tr><th>Boss</th><th>Date</th><th># of kills found</th><th>Split into</th></tr></thead>
              <tbody>${groupRows}${errorRows}</tbody>
            </table>
          </div>`
        : errorRows
          ? `<div class="table-scroll"><table class="growth-table"><tbody>${errorRows}</tbody></table></div>`
          : ''
    }
  `;
}

unmergePreviewBtn.addEventListener('click', async () => {
  const resultsEl = document.getElementById('unmergeResults');
  unmergePreviewBtn.disabled = true;
  unmergeApplyBtn.classList.add('hidden');
  resultsEl.innerHTML = '<p style="color:var(--text-muted);">Checking for merged records… this can take a moment.</p>';
  try {
    const result = await api('/api/cave-attendance-unmerge', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
    renderUnmergePlan(result, { applied: false });
    if (result.groups && result.groups.length) unmergeApplyBtn.classList.remove('hidden');
  } catch (err) {
    resultsEl.innerHTML = `<p style="color:var(--bad);">${escapeHtml(err.message)}</p>`;
  } finally {
    unmergePreviewBtn.disabled = false;
  }
});

unmergeApplyBtn.addEventListener('click', async () => {
  if (!confirm('Split these merged attendance records for real? This deletes the old combined records after moving their loot onto the earliest kill in each group.')) return;
  const resultsEl = document.getElementById('unmergeResults');
  unmergeApplyBtn.disabled = true;
  resultsEl.innerHTML = '<p style="color:var(--text-muted);">Applying…</p>';
  try {
    const result = await api('/api/cave-attendance-unmerge', { method: 'POST', body: JSON.stringify({ dryRun: false }) });
    renderUnmergePlan(result, { applied: true });
    unmergeApplyBtn.classList.add('hidden');
    if (typeof loadCaveData === 'function' && !document.getElementById('view-caves').classList.contains('hidden')) {
      loadCaveData().catch(() => {});
    }
  } catch (err) {
    resultsEl.innerHTML = `<p style="color:var(--bad);">${escapeHtml(err.message)}</p>`;
  } finally {
    unmergeApplyBtn.disabled = false;
  }
});
