const itemReportState = {
  loot: [],
  categories: [],
  selectedItem: '',
  expandedDates: new Set(),
  members: [],
  sentMemberIds: [],
};

function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

async function loadItemReportData() {
  const [loot, categories, members] = await Promise.all([api('/api/loot'), api('/api/item-categories'), api('/api/members')]);
  itemReportState.loot = loot;
  itemReportState.members = members;
  // Only Morion/Frozen Tear/Orb of Winds get a report right now -- everything
  // else stays in the catalog (for the loot picker and historical records)
  // but is left out of this selector via the same hidden flag Manage Items
  // exposes, rather than a separate report-specific list to maintain.
  itemReportState.categories = categories.filter((c) => !c.hidden);

  const names = itemReportState.categories.map((c) => c.name);
  if (!itemReportState.selectedItem || !names.includes(itemReportState.selectedItem)) {
    itemReportState.selectedItem = names.find((n) => n.toLowerCase() === 'morion') || names[0] || '';
  }

  renderItemReportMenu();
  renderItemReportTrigger();
  renderItemReportView();
  await loadSentStatusForSelectedItem();
}

// The top 20 by Growth Rate are the only members these three items are meant
// for, and it's the same ranking World Dungeon Salary already uses (latest
// recorded growth_entries rate, nulls sorted last since an ungraded member
// isn't "low", they're just not measured yet).
function getTop20MembersByGrowth() {
  return itemReportState.members
    .map((m) => ({ member: m, growthRate: latestGrowth(m)?.rate ?? null }))
    .sort((a, b) => {
      if (a.growthRate === null && b.growthRate === null) return 0;
      if (a.growthRate === null) return 1;
      if (b.growthRate === null) return -1;
      return b.growthRate - a.growthRate;
    })
    .slice(0, 20);
}

async function loadSentStatusForSelectedItem() {
  if (!itemReportState.selectedItem) {
    itemReportState.sentMemberIds = [];
    renderItemReportTop20();
    return;
  }
  itemReportState.sentMemberIds = await api(`/api/item-send-status?itemName=${encodeURIComponent(itemReportState.selectedItem)}`);
  renderItemReportTop20();
}

function renderItemReportTop20() {
  const body = document.getElementById('itemReportTop20Body');
  if (!body) return;
  const ranked = getTop20MembersByGrowth();

  body.innerHTML = ranked
    .map(({ member, growthRate }, i) => {
      const sent = itemReportState.sentMemberIds.includes(member.id);
      return `
      <tr class="${sent ? 'row-sent' : ''}" data-member-id="${member.id}">
        <td>${i + 1}</td>
        <td>${escapeHtml(member.alias ? `${member.name} (${member.alias})` : member.name)}</td>
        <td>${growthRate === null ? '–' : growthRate.toLocaleString()}</td>
        <td class="col-right"><input type="checkbox" class="item-report-sent-check admin-disable" data-member-id="${member.id}" ${sent ? 'checked' : ''}></td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('.item-report-sent-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const memberId = cb.getAttribute('data-member-id');
      const row = cb.closest('tr');
      const itemName = itemReportState.selectedItem;
      const wasSent = itemReportState.sentMemberIds.includes(memberId);
      if (cb.checked) {
        itemReportState.sentMemberIds.push(memberId);
        row.classList.add('row-sent');
      } else {
        itemReportState.sentMemberIds = itemReportState.sentMemberIds.filter((id) => id !== memberId);
        row.classList.remove('row-sent');
      }
      try {
        if (cb.checked) {
          await api('/api/item-send-status', { method: 'POST', body: JSON.stringify({ itemName, memberId }) });
        } else {
          await api(`/api/item-send-status?itemName=${encodeURIComponent(itemName)}&memberId=${encodeURIComponent(memberId)}`, { method: 'DELETE' });
        }
      } catch (err) {
        cb.checked = !cb.checked;
        if (wasSent) {
          itemReportState.sentMemberIds.push(memberId);
          row.classList.add('row-sent');
        } else {
          itemReportState.sentMemberIds = itemReportState.sentMemberIds.filter((id) => id !== memberId);
          row.classList.remove('row-sent');
        }
        toast(err.message);
      }
    });
  });
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
      loadSentStatusForSelectedItem().catch((err) => toast(err.message));
    });
  });
}

function renderItemReportTrigger() {
  const category = itemReportState.categories.find((c) => c.name === itemReportState.selectedItem);
  document.getElementById('itemReportTriggerIcon').innerHTML = category ? itemIconImg(category.iconUrl, category.name, 24) : '';
  document.getElementById('itemReportTriggerLabel').textContent = itemReportState.selectedItem || t('items.selectItem');
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
          <td>
            <span class="item-report-caret">${expanded ? '▾' : '▸'}</span>
            <strong>${formatShortDate(g.date)}</strong>
            <span class="item-report-summary">${g.entries.length} member${g.entries.length === 1 ? '' : 's'} · ${g.totalQty} total</span>
          </td>
          <td class="col-right"><button type="button" class="icon-btn" data-copy-date="${g.date}" title="Copy member names">📋</button></td>
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
  body.querySelectorAll('[data-copy-date]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const date = btn.getAttribute('data-copy-date');
      const group = groups.find((g) => g.date === date);
      if (!group) return;
      const text = group.entries.map((entry, i) => `${i + 1}. ${entry.member}`).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast(`Copied ${group.entries.length} name${group.entries.length === 1 ? '' : 's'}`);
      } catch (err) {
        toast('Could not copy — clipboard access denied');
      }
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
