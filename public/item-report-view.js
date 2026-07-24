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

  const names = categories.map((c) => c.name);
  if (!itemReportState.selectedItem || !names.includes(itemReportState.selectedItem)) {
    itemReportState.selectedItem = names.find((n) => n.toLowerCase() === 'morion') || names[0] || '';
  }

  renderItemReportMenu();
  renderItemReportTrigger();
  renderItemReportView();
}

function renderItemReportMenu() {
  const menu = document.getElementById('itemReportMenu');
  const sorted = itemReportState.categories.slice().sort((a, b) => a.name.localeCompare(b.name));
  menu.innerHTML = sorted
    .map(
      (c) => `
      <div class="icon-select-option${c.name === itemReportState.selectedItem ? ' active' : ''}" data-name="${escapeHtml(c.name)}">
        ${itemIconImg(c.iconUrl, c.name, 28)}
        <span>${escapeHtml(c.name)}</span>
      </div>`
    )
    .join('');

  menu.querySelectorAll('.icon-select-option').forEach((el) => {
    el.addEventListener('click', () => {
      itemReportState.selectedItem = el.getAttribute('data-name');
      menu.classList.add('hidden');
      renderItemReportMenu();
      renderItemReportTrigger();
      renderItemReportView();
    });
  });
}

function renderItemReportTrigger() {
  const category = itemReportState.categories.find((c) => c.name === itemReportState.selectedItem);
  document.getElementById('itemReportTriggerIcon').innerHTML = category ? itemIconImg(category.iconUrl, category.name, 24) : '';
  document.getElementById('itemReportTriggerLabel').textContent = itemReportState.selectedItem || 'Select item';
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

document.getElementById('itemReportTrigger').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('itemReportMenu').classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('itemReportDropdown');
  if (!dropdown.contains(e.target)) {
    document.getElementById('itemReportMenu').classList.add('hidden');
  }
});
