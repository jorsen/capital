const itemReportState = {
  loot: [],
  categories: [],
  selectedItem: '',
  expandedDates: new Set(),
  members: [],
  sentByItem: new Map(), // itemName -> Map(memberId -> sentAt)
};

// Fixed display order + the amount each of the top 20 gets per item, rather
// than whatever order Manage Items happens to list them in.
const ITEM_REPORT_ORDER = ['morion', 'frozen tear', 'orb of winds'];
const ITEM_REPORT_QUANTITY = { morion: 100, 'frozen tear': 10, 'orb of winds': 20 };
// Only these items get a Top 20 checklist column -- everything else still
// shows up in the item selector. Matched by substring since the exact item
// name in Manage Items may vary ("Frozen Tear" vs "Frozen Tears", etc).
function isTop20Item(name) {
  const lower = name.toLowerCase();
  return ITEM_REPORT_ORDER.some((term) => lower.includes(term));
}

function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function formatSentDate(sentAt) {
  if (!sentAt) return '';
  const d = new Date(sentAt);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

async function loadItemReportData() {
  const [loot, categories, members] = await Promise.all([api('/api/loot'), api('/api/item-categories'), api('/api/members')]);
  itemReportState.loot = loot;
  itemReportState.members = members;
  // Only Morion/Frozen Tear/Orb of Winds get a report right now -- everything
  // else stays in the catalog (for the loot picker and historical records)
  // but is left out of this selector via the same hidden flag Manage Items
  // exposes, rather than a separate report-specific list to maintain.
  itemReportState.categories = categories
    .filter((c) => !c.hidden)
    .slice()
    .sort((a, b) => {
      const ai = ITEM_REPORT_ORDER.indexOf(a.name.toLowerCase());
      const bi = ITEM_REPORT_ORDER.indexOf(b.name.toLowerCase());
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

  const names = itemReportState.categories.map((c) => c.name);
  if (!itemReportState.selectedItem || !names.includes(itemReportState.selectedItem)) {
    itemReportState.selectedItem = names.find((n) => n.toLowerCase() === 'morion') || names[0] || '';
  }

  renderItemReportMenu();
  renderItemReportTrigger();
  renderItemReportView();
  await loadAllSentStatus();
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

async function loadAllSentStatus() {
  const rows = await api('/api/item-send-status');
  const byItem = new Map();
  rows.forEach(({ itemName, memberId, sentAt }) => {
    if (!byItem.has(itemName)) byItem.set(itemName, new Map());
    byItem.get(itemName).set(memberId, sentAt);
  });
  itemReportState.sentByItem = byItem;
  renderItemReportTop20();
}

function renderItemReportTop20() {
  const head = document.getElementById('itemReportTop20Head');
  const body = document.getElementById('itemReportTop20Body');
  if (!head || !body) return;
  const ranked = getTop20MembersByGrowth();
  const columns = itemReportState.categories.filter((c) => isTop20Item(c.name));

  head.innerHTML = `
    <th>#</th>
    <th>Member</th>
    <th>Growth Rate</th>
    ${columns
      .map((c) => {
        const qty = ITEM_REPORT_QUANTITY[c.name.toLowerCase()];
        return `<th class="col-right">${escapeHtml(c.name)}${qty !== undefined ? ` (${qty} each)` : ''}</th>`;
      })
      .join('')}
  `;

  body.innerHTML = ranked
    .map(({ member, growthRate }, i) => {
      const cells = columns
        .map((c) => {
          const sentMap = itemReportState.sentByItem.get(c.name);
          const sent = sentMap?.has(member.id) || false;
          const dateText = sent ? formatSentDate(sentMap.get(member.id)) : '';
          return `<td class="col-right ${sent ? 'row-sent' : ''}"><span class="item-report-sent-date">${dateText}</span> <input type="checkbox" class="item-report-sent-check admin-disable" data-member-id="${member.id}" data-item-name="${escapeHtml(c.name)}" ${sent ? 'checked' : ''}></td>`;
        })
        .join('');
      return `
      <tr data-member-id="${member.id}">
        <td>${i + 1}</td>
        <td class="item-report-top20-name" data-copy-name="${escapeHtml(member.name)}" title="Click to copy IGN">${escapeHtml(member.alias ? `${member.name} (${member.alias})` : member.name)}</td>
        <td>${growthRate === null ? '–' : growthRate.toLocaleString()}</td>
        ${cells}
      </tr>`;
    })
    .join('');

  body.querySelectorAll('.item-report-top20-name').forEach((td) => {
    td.addEventListener('click', async () => {
      const name = td.getAttribute('data-copy-name');
      try {
        await navigator.clipboard.writeText(name);
        toast(`Copied "${name}"`);
      } catch (err) {
        toast('Could not copy — clipboard access denied');
      }
    });
  });

  body.querySelectorAll('.item-report-sent-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const memberId = cb.getAttribute('data-member-id');
      const itemName = cb.getAttribute('data-item-name');
      const cell = cb.closest('td');
      const dateEl = cell.querySelector('.item-report-sent-date');
      const sentMap = itemReportState.sentByItem.get(itemName) || new Map();
      itemReportState.sentByItem.set(itemName, sentMap);
      const wasSent = sentMap.has(memberId);
      const prevSentAt = sentMap.get(memberId);
      const apply = (sent, sentAt) => {
        cb.checked = sent;
        cell.classList.toggle('row-sent', sent);
        if (sent) sentMap.set(memberId, sentAt);
        else sentMap.delete(memberId);
        dateEl.textContent = sent ? formatSentDate(sentAt) : '';
      };
      // Show the date right away so the click registers immediately, then
      // swap in the server's timestamp once the save lands.
      apply(cb.checked, new Date().toISOString());
      try {
        if (cb.checked) {
          const res = await api('/api/item-send-status', { method: 'POST', body: JSON.stringify({ itemName, memberId }) });
          if (res?.sentAt) apply(true, res.sentAt);
        } else {
          await api(`/api/item-send-status?itemName=${encodeURIComponent(itemName)}&memberId=${encodeURIComponent(memberId)}`, { method: 'DELETE' });
        }
      } catch (err) {
        apply(wasSent, prevSentAt);
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
