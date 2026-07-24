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

  renderItemReportIcon();
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
          sessionId: session.id,
        });
      }
    });
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function renderItemReportIcon() {
  const category = itemReportState.categories.find((c) => c.name === itemReportState.selectedItem);
  document.getElementById('itemReportIcon').innerHTML = category
    ? itemIconImg(category.iconUrl, category.name, 44)
    : '';
}

function renderItemReportView() {
  const rows = getItemReportRows();
  const body = document.getElementById('itemReportBody');
  document.getElementById('itemReportColumnLabel').textContent = itemReportState.selectedItem
    ? `${itemReportState.selectedItem} Given:`
    : 'Given:';

  body.innerHTML = '';
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.member)}</td>
      <td>${row.quantity} - ${formatShortDate(row.date)}</td>
    `;
    tr.addEventListener('click', () => {
      window.location.hash = `#/loot-session/${row.sessionId}`;
    });
    body.appendChild(tr);
  });

  document.getElementById('itemReportEmptyState').classList.toggle('hidden', rows.length !== 0);
}

document.getElementById('itemReportSelect').addEventListener('change', (e) => {
  itemReportState.selectedItem = e.target.value;
  renderItemReportIcon();
  renderItemReportView();
});
