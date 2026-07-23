const itemReportState = {
  loot: [],
  categories: [],
  selectedItem: '',
};

function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

async function loadItemReportData() {
  const [loot, categories] = await Promise.all([api('/api/loot'), api('/api/item-categories')]);
  itemReportState.loot = loot;
  itemReportState.categories = categories;

  const select = document.getElementById('itemReportSelect');
  const names = categories.map((c) => c.name);
  select.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');

  if (!itemReportState.selectedItem || !names.includes(itemReportState.selectedItem)) {
    itemReportState.selectedItem = names.find((n) => n.toLowerCase() === 'morion') || names[0] || '';
  }
  select.value = itemReportState.selectedItem;

  renderItemReportView();
}

function getItemReportRows() {
  const item = itemReportState.selectedItem.toLowerCase();
  const rows = [];
  itemReportState.loot.forEach((session) => {
    session.records.forEach((record) => {
      if (record.item.toLowerCase() === item) {
        rows.push({
          member: record.recipientName || '(unassigned)',
          quantity: record.quantity,
          date: session.date,
        });
      }
    });
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function renderItemReportView() {
  const rows = getItemReportRows();
  const body = document.getElementById('itemReportBody');
  document.getElementById('itemReportColumnLabel').textContent = itemReportState.selectedItem
    ? `${itemReportState.selectedItem} Given:`
    : 'Given:';

  body.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.member)}</td>
        <td>${row.quantity} - ${formatShortDate(row.date)}</td>
      </tr>`
    )
    .join('');

  document.getElementById('itemReportEmptyState').classList.toggle('hidden', rows.length !== 0);
}

document.getElementById('itemReportSelect').addEventListener('change', (e) => {
  itemReportState.selectedItem = e.target.value;
  renderItemReportView();
});
