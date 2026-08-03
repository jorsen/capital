const itemReportState = {
  loot: [],
  categories: [],
  selectedItem: '',
  expandedDates: new Set(),
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
      itemReportState.expandedDates.clear();
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

// One group per date the selected item was given out, so the report can
// show "08/03 — 3 members" and expand on click to the individual recipients
// instead of one long flat list mixing every date together.
function getItemReportGroups() {
  const item = itemReportState.selectedItem.toLowerCase();
  const groupsByDate = new Map();
  itemReportState.loot.forEach((session) => {
    session.records.forEach((record) => {
      if (record.item.toLowerCase() !== item) return;
      if (!groupsByDate.has(session.date)) {
        groupsByDate.set(session.date, { date: session.date, sessionId: session.id, entries: [], totalQty: 0 });
      }
      const group = groupsByDate.get(session.date);
      group.entries.push({ member: record.recipientName || '(unassigned)', quantity: record.quantity });
      group.totalQty += Number(record.quantity) || 0;
    });
  });
  return Array.from(groupsByDate.values()).sort((a, b) => b.date.localeCompare(a.date));
}

function renderItemReportView() {
  const groups = getItemReportGroups();
  const body = document.getElementById('itemReportBody');

  body.innerHTML = groups
    .map((g) => {
      const expanded = itemReportState.expandedDates.has(g.date);
      const headerRow = `
        <tr class="item-report-date-row" data-date="${g.date}">
          <td colspan="2">
            <span class="item-report-caret">${expanded ? '▾' : '▸'}</span>
            <strong>${formatShortDate(g.date)}</strong>
            <span class="item-report-summary">${g.entries.length} member${g.entries.length === 1 ? '' : 's'} · ${g.totalQty} total</span>
          </td>
        </tr>`;
      const memberRows = expanded
        ? g.entries
            .map(
              (e) => `
        <tr class="item-report-member-row" data-session-id="${g.sessionId}">
          <td>${escapeHtml(e.member)}</td>
          <td>${e.quantity}</td>
        </tr>`
            )
            .join('')
        : '';
      return headerRow + memberRows;
    })
    .join('');

  body.querySelectorAll('.item-report-date-row').forEach((tr) => {
    tr.addEventListener('click', () => {
      const date = tr.getAttribute('data-date');
      if (itemReportState.expandedDates.has(date)) itemReportState.expandedDates.delete(date);
      else itemReportState.expandedDates.add(date);
      renderItemReportView();
    });
  });
  body.querySelectorAll('.item-report-member-row').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.hash = `#/loot-session/${tr.getAttribute('data-session-id')}`;
    });
  });

  document.getElementById('itemReportEmptyState').classList.toggle('hidden', groups.length !== 0);
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
