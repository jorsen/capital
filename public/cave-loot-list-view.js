const caveLootListState = { month: null, sessions: [] };

function caveLootListFormatMoney(amount) {
  return (amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function loadCaveLootListData() {
  const monthInput = document.getElementById('caveLootListMonthInput');
  if (!caveLootListState.month) caveLootListState.month = currentMonthValue();
  monthInput.value = caveLootListState.month;

  caveLootListState.sessions = await api('/api/caves');
  renderCaveLootList();
}

function renderCaveLootList() {
  const body = document.getElementById('caveLootListBody');
  const empty = document.getElementById('caveLootListEmptyState');

  // One group per calendar date — a single day can have several cave
  // sessions (different bosses), so all of that day's loot rows are grouped
  // under one Date/Total Dias cell pair.
  const sessionsInMonth = caveLootListState.sessions
    .filter((s) => s.date.slice(0, 7) === caveLootListState.month)
    .sort((a, b) => a.date.localeCompare(b.date) || new Date(a.createdAt) - new Date(b.createdAt));

  const dateGroups = [];
  sessionsInMonth.forEach((s) => {
    const last = dateGroups[dateGroups.length - 1];
    if (last && last.date === s.date) last.sessions.push(s);
    else dateGroups.push({ date: s.date, sessions: [s] });
  });

  empty.classList.toggle('hidden', dateGroups.length !== 0);

  body.innerHTML = dateGroups
    .map((group) => {
      const rows = [];
      group.sessions.forEach((s) => {
        s.records.forEach((r) => {
          rows.push({ boss: s.run, item: r.item, quantity: r.quantity, price: r.soldPrice, buyer: r.buyer });
        });
      });
      if (!rows.length) rows.push({ boss: group.sessions.map((s) => s.run || '(No boss)').join(', '), item: null });

      const totalDias = rows.reduce((sum, r) => sum + (r.item ? r.quantity * r.price : 0), 0);

      return rows
        .map((r, i) => {
          const dateCell = i === 0 ? `<td rowspan="${rows.length}" style="font-weight:600; vertical-align:top;">${escapeHtml(formatCaveReportDate(group.date))}</td>` : '';
          const totalDiasCell = i === 0 ? `<td rowspan="${rows.length}" class="col-right" style="font-weight:600; vertical-align:top;">${caveLootListFormatMoney(totalDias)}</td>` : '';
          if (!r.item) {
            return `<tr>${dateCell}<td>${escapeHtml(r.boss || '(No boss)')}</td><td colspan="5" style="color:var(--text-muted)">No loot logged</td>${totalDiasCell}</tr>`;
          }
          return `
        <tr>
          ${dateCell}
          <td>${escapeHtml(r.boss || '(No boss)')}</td>
          <td>${itemLabel(r.item)}</td>
          <td class="col-right">${r.quantity}</td>
          <td class="col-right">${caveLootListFormatMoney(r.price)}</td>
          <td class="col-right">${caveLootListFormatMoney(r.quantity * r.price)}</td>
          <td>${escapeHtml(r.buyer || '')}</td>
          ${totalDiasCell}
        </tr>`;
        })
        .join('');
    })
    .join('');
}

document.getElementById('caveLootListMonthInput').addEventListener('change', (e) => {
  caveLootListState.month = e.target.value;
  renderCaveLootList();
});
