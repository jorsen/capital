const caveReportState = { sessions: [], members: [] };

async function loadCaveReportData() {
  const [sessions, members] = await Promise.all([api('/api/caves'), api('/api/members')]);
  caveReportState.sessions = sessions;
  caveReportState.members = members;
  renderCaveReport();
}

function caveReportTotal(session, memberId) {
  return session.attendees.includes(memberId);
}

function renderCaveReport() {
  const head = document.getElementById('caveReportHead');
  const body = document.getElementById('caveReportBody');
  const table = document.getElementById('caveReportTable');
  const empty = document.getElementById('caveReportEmptyState');

  const sessions = caveReportState.sessions
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || new Date(a.createdAt) - new Date(b.createdAt));

  empty.classList.toggle('hidden', sessions.length !== 0);
  table.classList.toggle('hidden', sessions.length === 0);
  if (!sessions.length) {
    head.innerHTML = '';
    body.innerHTML = '';
    return;
  }

  // Groups consecutive same-date sessions so the date can span a colspan
  // header row above each session's own cave-name column, mirroring a
  // spreadsheet-style attendance sheet.
  const dateGroups = [];
  sessions.forEach((s) => {
    const last = dateGroups[dateGroups.length - 1];
    if (last && last.date === s.date) last.sessions.push(s);
    else dateGroups.push({ date: s.date, sessions: [s] });
  });

  head.innerHTML = `
    <tr>
      <th class="cave-report-name-col" rowspan="2">IGN</th>
      <th class="cave-report-total-col" rowspan="2">Total Attendance</th>
      ${dateGroups
        .map((g) => `<th colspan="${g.sessions.length}">${escapeHtml(formatCaveReportDate(g.date))}</th>`)
        .join('')}
    </tr>
    <tr>
      ${sessions.map((s) => `<th title="${escapeHtml(s.run || 'Cave')}">${escapeHtml(s.run || 'Cave')}</th>`).join('')}
    </tr>
  `;

  const members = caveReportState.members
    .map((m) => ({ member: m, total: sessions.filter((s) => caveReportTotal(s, m.id)).length }))
    .sort((a, b) => b.total - a.total || a.member.name.localeCompare(b.member.name));

  body.innerHTML = members
    .map(
      ({ member, total }) => `
    <tr data-member-id="${member.id}">
      <td class="cave-report-name-col">${escapeHtml(member.name)}</td>
      <td class="cave-report-total-col" data-total-cell>${total}</td>
      ${sessions
        .map(
          (s) => `
        <td>
          <input type="checkbox" class="cave-report-check admin-disable" data-session-id="${s.id}" data-member-id="${member.id}" ${s.attendees.includes(member.id) ? 'checked' : ''}>
        </td>`
        )
        .join('')}
    </tr>`
    )
    .join('');

  body.querySelectorAll('.cave-report-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const sessionId = cb.getAttribute('data-session-id');
      const memberId = cb.getAttribute('data-member-id');
      const session = caveReportState.sessions.find((s) => s.id === sessionId);
      if (!session) return;

      const attendeeSet = new Set(session.attendees);
      if (cb.checked) attendeeSet.add(memberId);
      else attendeeSet.delete(memberId);

      try {
        const updated = await api(`/api/caves/${sessionId}`, {
          method: 'PUT',
          body: JSON.stringify({ attendees: Array.from(attendeeSet) }),
        });
        session.attendees = updated.attendees;
        const row = body.querySelector(`tr[data-member-id="${memberId}"]`);
        if (row) {
          const total = caveReportState.sessions.filter((s) => s.attendees.includes(memberId)).length;
          row.querySelector('[data-total-cell]').textContent = total;
        }
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      }
    });
  });
}

function formatCaveReportDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' });
}
