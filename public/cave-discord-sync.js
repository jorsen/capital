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
