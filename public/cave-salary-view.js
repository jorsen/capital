// expandedLootKey: which This Month's Loot item row is open, kept outside the
// render so editing inside its breakdown doesn't collapse it.
const caveSalaryState = { month: null, sessions: [], members: [], fees: [], paidMemberIds: [], expandedLootKey: null };

// Tier breakpoints matched against each member's latest growth rate —
// highest qualifying tier wins. Below the lowest named breakpoint falls
// through to the base 0.8 multiplier.
const CAVE_SALARY_TIERS = [
  { min: 700000, multiplier: 3.5 },
  { min: 650000, multiplier: 3 },
  { min: 600000, multiplier: 2.5 },
  { min: 550000, multiplier: 2 },
  { min: 500000, multiplier: 1.6 },
  { min: 450000, multiplier: 1.3 },
  { min: 400000, multiplier: 1 },
];

function caveSalaryMultiplier(member) {
  const rate = latestGrowth(member)?.rate ?? 0;
  const tier = CAVE_SALARY_TIERS.find((t) => rate >= t.min);
  return tier ? tier.multiplier : 0.8;
}

function caveSalaryFormatMoney(amount) {
  return `${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 💎`;
}

async function loadCaveSalaryData() {
  const monthInput = document.getElementById('caveSalaryMonthInput');
  if (!caveSalaryState.month) caveSalaryState.month = currentMonthValue();
  monthInput.value = caveSalaryState.month;

  const [sessions, members] = await Promise.all([api('/api/caves'), api('/api/members')]);
  caveSalaryState.sessions = sessions;
  caveSalaryState.members = members;
  await loadCaveSalaryMonthData();
}

async function loadCaveSalaryMonthData() {
  const [fees, paidMemberIds] = await Promise.all([
    api(`/api/salary-fees?month=${encodeURIComponent(caveSalaryState.month)}`),
    api(`/api/salary-paid?month=${encodeURIComponent(caveSalaryState.month)}`),
  ]);
  caveSalaryState.fees = fees;
  caveSalaryState.paidMemberIds = paidMemberIds;
  renderCaveSalary();
}

function sessionsForMonth() {
  return caveSalaryState.sessions.filter((s) => s.date.slice(0, 7) === caveSalaryState.month);
}

function computeCaveSalary() {
  const sessions = sessionsForMonth();
  const members = caveSalaryState.members;

  const attendanceByMember = new Map(members.map((m) => [m.id, 0]));
  sessions.forEach((s) => {
    s.attendees.forEach((id) => {
      if (attendanceByMember.has(id)) attendanceByMember.set(id, attendanceByMember.get(id) + 1);
    });
  });
  const totalAttendance = Array.from(attendanceByMember.values()).reduce((sum, n) => sum + n, 0);

  const rawPool = sessions.reduce(
    (sum, s) => sum + s.records.reduce((rSum, r) => rSum + (Number(r.quantity) || 0) * (Number(r.soldPrice) || 0), 0),
    0
  );
  const totalFeeAmount = caveSalaryState.fees.reduce((sum, f) => sum + (f.percent / 100) * rawPool, 0);
  const finalPool = rawPool - totalFeeAmount;

  const feeAmountByMemberId = new Map();
  caveSalaryState.fees.forEach((f) => {
    if (!f.memberId) return;
    const amount = (f.percent / 100) * rawPool;
    feeAmountByMemberId.set(f.memberId, (feeAmountByMemberId.get(f.memberId) || 0) + amount);
  });

  const rows = members.map((m) => {
    const attendance = attendanceByMember.get(m.id) || 0;
    const growthRate = latestGrowth(m)?.rate ?? null;
    const multiplier = caveSalaryMultiplier(m);
    // Base Share = this member's attendance as a fraction of everyone's combined attendance.
    const baseShare = totalAttendance > 0 ? attendance / totalAttendance : 0;
    const baseWithMultiplier = baseShare * multiplier;
    return { member: m, attendance, growthRate, multiplier, baseShare, baseWithMultiplier };
  });
  const sumBaseWithMultiplier = rows.reduce((sum, r) => sum + r.baseWithMultiplier, 0);

  rows.forEach((r) => {
    r.normalizedShare = sumBaseWithMultiplier > 0 ? r.baseWithMultiplier / sumBaseWithMultiplier : 0;
    r.initialComputation = r.normalizedShare * finalPool;
    r.finalSalary = r.initialComputation + (feeAmountByMemberId.get(r.member.id) || 0);
  });

  rows.sort((a, b) => (b.growthRate ?? -Infinity) - (a.growthRate ?? -Infinity));

  return { rows, rawPool, totalFeeAmount, finalPool };
}

function renderCaveSalary() {
  const { rows, rawPool, totalFeeAmount, finalPool } = computeCaveSalary();

  document.getElementById('caveSalaryPoolValue').textContent = caveSalaryFormatMoney(rawPool);
  document.getElementById('caveSalaryFeesValue').textContent = caveSalaryFormatMoney(totalFeeAmount);
  document.getElementById('caveSalaryFinalPoolValue').textContent = caveSalaryFormatMoney(finalPool);

  renderCaveSalaryLoot();

  const feesBody = document.getElementById('caveSalaryFeesBody');
  feesBody.innerHTML = caveSalaryState.fees
    .map(
      (f) => `
    <tr>
      <td>${escapeHtml(f.name)}</td>
      <td>${f.percent}%</td>
      <td class="admin-only"><button class="icon-btn" data-delete-fee="${f.id}" title="Remove fee">✕</button></td>
    </tr>`
    )
    .join('') || '<tr><td colspan="3" style="color:var(--text-muted)">No accounting fees for this month.</td></tr>';

  feesBody.querySelectorAll('[data-delete-fee]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-fee');
      await api(`/api/salary-fees/${id}`, { method: 'DELETE' });
      caveSalaryState.fees = caveSalaryState.fees.filter((f) => f.id !== id);
      renderCaveSalary();
      toast('Fee removed');
    });
  });

  const memberSelect = document.getElementById('caveSalaryFeeMemberSelect');
  const sortedMembers = caveSalaryState.members.slice().sort((a, b) => a.name.localeCompare(b.name));
  memberSelect.innerHTML =
    '<option value="">— none (use custom name) —</option>' +
    sortedMembers.map((m) => `<option value="${m.id}">${escapeHtml(memberDisplayName(m))}</option>`).join('');

  const body = document.getElementById('caveSalaryBody');
  const empty = document.getElementById('caveSalaryEmptyState');
  empty.classList.toggle('hidden', sessionsForMonth().length !== 0);

  const paidSet = new Set(caveSalaryState.paidMemberIds);

  body.innerHTML = rows
    .map((r) => {
      const sent = paidSet.has(r.member.id);
      return `
    <tr class="${sent ? 'row-sent' : ''}">
      <td style="font-weight:600;">${escapeHtml(memberDisplayName(r.member))}</td>
      <td>${r.growthRate === null ? '–' : r.growthRate.toLocaleString()}</td>
      <td>${r.attendance}</td>
      <td>${r.multiplier}×</td>
      <td>${(r.baseShare * 100).toFixed(2)}%</td>
      <td>${r.baseWithMultiplier.toFixed(4)}</td>
      <td>${(r.normalizedShare * 100).toFixed(2)}%</td>
      <td>${caveSalaryFormatMoney(r.initialComputation)}</td>
      <td style="font-weight:600;">${caveSalaryFormatMoney(r.finalSalary)}</td>
      <td><input type="checkbox" class="cave-salary-sent-check admin-disable" data-member-id="${r.member.id}" ${sent ? 'checked' : ''}></td>
    </tr>`;
    })
    .join('');

  body.querySelectorAll('.cave-salary-sent-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const memberId = cb.getAttribute('data-member-id');
      const row = cb.closest('tr');
      try {
        if (cb.checked) {
          await api('/api/salary-paid', { method: 'POST', body: JSON.stringify({ month: caveSalaryState.month, memberId }) });
          caveSalaryState.paidMemberIds.push(memberId);
          row.classList.add('row-sent');
        } else {
          await api(`/api/salary-paid?month=${encodeURIComponent(caveSalaryState.month)}&memberId=${encodeURIComponent(memberId)}`, { method: 'DELETE' });
          caveSalaryState.paidMemberIds = caveSalaryState.paidMemberIds.filter((id) => id !== memberId);
          row.classList.remove('row-sent');
        }
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      }
    });
  });
}

// This month's loot grouped by item name (case/spacing-insensitive), same
// layout as Sovereign's World Boss "This Month's Loot". A record counts as
// sold once it has a sold price; Diamonds is what the sold ones brought in,
// so the Total row matches the Salary Pool.
function renderCaveSalaryLoot() {
  const byItem = new Map();
  sessionsForMonth().forEach((s) => {
    s.records.forEach((r) => {
      const name = (r.item || '').trim().replace(/\s+/g, ' ');
      const quantity = Number(r.quantity) || 0;
      const price = Number(r.soldPrice) || 0;
      if (!name || !quantity) return;
      const key = name.toLowerCase();
      if (!byItem.has(key)) byItem.set(key, { key, item: name, quantity: 0, soldQuantity: 0, diamonds: null, sources: [] });
      const g = byItem.get(key);
      g.quantity += quantity;
      g.sources.push({ sessionId: s.id, recordId: r.id, date: s.date, time: s.killedAt || s.createdAt, boss: s.run, quantity, price });
      if (price > 0) {
        g.soldQuantity += quantity;
        g.diamonds = (g.diamonds || 0) + quantity * price;
      }
    });
  });
  const rows = Array.from(byItem.values()).sort((a, b) => b.quantity - a.quantity || a.item.localeCompare(b.item));

  document.getElementById('caveSalaryLootMonthLabel').textContent = formatMonthYear(caveSalaryState.month);

  const search = document.getElementById('caveSalaryLootSearchInput').value.trim().toLowerCase();
  const sortMode = document.getElementById('caveSalaryLootSortSelect').value;
  let displayRows = rows.filter((r) => !search || r.item.toLowerCase().includes(search));
  if (sortMode === 'unsold') displayRows = displayRows.slice().sort((a, b) => caveSalaryLootSoldRank(a) - caveSalaryLootSoldRank(b));
  if (sortMode === 'sold') displayRows = displayRows.slice().sort((a, b) => caveSalaryLootSoldRank(b) - caveSalaryLootSoldRank(a));

  document.getElementById('caveSalaryLootEmptyState').classList.toggle('hidden', rows.length !== 0);
  document.getElementById('caveSalaryLootNoMatchState').classList.toggle('hidden', rows.length === 0 || displayRows.length !== 0);

  const lootBody = document.getElementById('caveSalaryLootBody');
  lootBody.innerHTML = displayRows
    .map((r) => {
      const isExpanded = r.key === caveSalaryState.expandedLootKey;
      return `
    <tr class="cave-loot-clickable-row ${isExpanded ? 'is-expanded' : ''}" data-loot-key="${escapeHtml(r.key)}" title="Click to see each drop">
      <td><span class="cave-loot-chevron">${isExpanded ? '▾' : '▸'}</span><span class="cave-loot-item-badge">${caveLootListItemIcon(r.item)}${escapeHtml(r.item)}</span></td>
      <td class="cave-loot-num">${r.quantity.toLocaleString()}</td>
      <td class="cave-loot-num">${r.diamonds === null ? '<span class="cave-loot-dash">—</span>' : `<span class="cave-loot-currency diamonds">💎 ${caveSalaryFormatAmount(r.diamonds)}</span>`}</td>
      <td class="cave-loot-num"><span class="cave-loot-sold-ratio ${['is-unsold', 'is-partially-sold', 'is-fully-sold'][caveSalaryLootSoldRank(r)]}">${r.soldQuantity.toLocaleString()} / ${r.quantity.toLocaleString()}</span></td>
    </tr>${isExpanded ? caveSalaryLootBreakdownHtml(r) : ''}`;
    })
    .join('');

  lootBody.querySelectorAll('tr[data-loot-key]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const key = tr.getAttribute('data-loot-key');
      caveSalaryState.expandedLootKey = caveSalaryState.expandedLootKey === key ? null : key;
      renderCaveSalaryLoot();
    });
  });
  wireCaveSalaryLootBreakdownInputs(lootBody);

  const totalQuantity = rows.reduce((sum, r) => sum + r.quantity, 0);
  const totalDiamonds = rows.reduce((sum, r) => sum + (r.diamonds || 0), 0);
  const totalsRow = document.getElementById('caveSalaryLootTotals');
  totalsRow.classList.toggle('hidden', rows.length === 0);
  totalsRow.innerHTML = rows.length
    ? `
    <td class="cave-loot-total-label">${escapeHtml(t('caveSalary.soldItemsTotal'))}</td>
    <td class="cave-loot-num cave-loot-total-value">${totalQuantity.toLocaleString()}</td>
    <td class="cave-loot-num cave-loot-total-value"><span class="cave-loot-currency diamonds">💎 ${caveSalaryFormatAmount(totalDiamonds)}</span></td>
    <td></td>`
    : '';

  document.getElementById('caveSalaryLootChips').innerHTML = rows.length
    ? `
    <span class="cave-loot-chip">${rows.length} ${escapeHtml(t('caveSalary.lootItemsChip'))}</span>
    <span class="cave-loot-chip diamonds">💎 ${caveSalaryFormatAmount(totalDiamonds)}</span>`
    : '';
}

// Every individual drop that rolled up into one item row, oldest first --
// same columns as Sovereign's World Boss loot breakdown. Quantity and price
// are editable in place for admins; Status follows the price (a drop counts
// as sold once it has one).
function caveSalaryLootBreakdownHtml(r) {
  const sources = r.sources.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)));
  return `
    <tr class="cave-loot-breakdown-row">
      <td colspan="4">
        <div class="cave-loot-breakdown">
          <table class="cave-loot-breakdown-table">
            <thead>
              <tr>
                <th>${escapeHtml(t('common.boss'))}</th>
                <th>${escapeHtml(t('common.date'))}</th>
                <th>${escapeHtml(t('caveSalary.lootThQuantity'))}</th>
                <th>${escapeHtml(t('caveLootList.thPrice'))}</th>
                <th>${escapeHtml(t('caveSalary.lootThDiamonds'))}</th>
                <th>${escapeHtml(t('caveSalary.lootThStatus'))}</th>
              </tr>
            </thead>
            <tbody>
              ${sources
                .map(
                  (s) => `
              <tr>
                <td class="cave-loot-boss">⚔️ ${escapeHtml(s.boss || '(No boss)')}</td>
                <td class="cave-loot-date"><a href="#/cave-date/${s.date}" class="cave-date-link">${escapeHtml(formatLongDate(s.date))}</a>${s.time ? `, ${escapeHtml(formatTimeOfDay(s.time))}` : ''}</td>
                <td class="cave-loot-num"><input type="number" class="admin-disable" data-loot-field="quantity" data-session-id="${s.sessionId}" data-record-id="${s.recordId}" value="${s.quantity}" min="1" step="1"></td>
                <td class="cave-loot-num">💎 <input type="number" class="admin-disable" data-loot-field="soldPrice" data-session-id="${s.sessionId}" data-record-id="${s.recordId}" value="${s.price || ''}" min="0" step="0.01" placeholder="—"></td>
                <td class="cave-loot-num">${s.price > 0 ? `<span class="cave-loot-currency diamonds">💎 ${caveSalaryFormatAmount(s.quantity * s.price)}</span>` : '<span class="cave-loot-dash">—</span>'}</td>
                <td class="cave-loot-status-cell"><span class="cave-loot-status ${s.price > 0 ? 'is-sold' : 'is-unsold'}">${s.price > 0 ? `✅ ${escapeHtml(t('caveSalary.lootStatusSold'))}` : `⭕ ${escapeHtml(t('caveSalary.lootStatusNotSold'))}`}</span></td>
              </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </td>
    </tr>`;
}

// Saves one breakdown field, then re-renders the whole page -- a price or
// quantity change moves the Salary Pool and everyone's salary with it.
function wireCaveSalaryLootBreakdownInputs(root) {
  const parsers = {
    quantity: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 ? n : undefined;
    },
    soldPrice: (v) => {
      const n = Number(v || 0);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    },
  };
  root.querySelectorAll('.cave-loot-breakdown-table input[data-loot-field]').forEach((input) => {
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', async () => {
      const field = input.getAttribute('data-loot-field');
      const sessionId = input.getAttribute('data-session-id');
      const recordId = input.getAttribute('data-record-id');
      const value = parsers[field](input.value);
      if (value === undefined) {
        toast(`${field} is invalid`);
        renderCaveSalary();
        return;
      }
      try {
        await api(`/api/caves/${sessionId}/records/${recordId}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) });
        const session = caveSalaryState.sessions.find((s) => s.id === sessionId);
        const record = session?.records.find((r) => r.id === recordId);
        if (record) record[field] = value;
      } catch (err) {
        toast(err.message);
      }
      renderCaveSalary();
    });
  });
}

// 0 = nothing sold yet, 1 = partially sold, 2 = fully sold.
function caveSalaryLootSoldRank(r) {
  if (r.soldQuantity <= 0) return 0;
  return r.soldQuantity >= r.quantity ? 2 : 1;
}

function caveSalaryFormatAmount(amount) {
  return (amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

document.getElementById('caveSalaryLootSearchInput').addEventListener('input', renderCaveSalaryLoot);
document.getElementById('caveSalaryLootSortSelect').addEventListener('change', renderCaveSalaryLoot);

document.getElementById('caveSalaryMonthInput').addEventListener('change', async (e) => {
  caveSalaryState.month = e.target.value;
  try {
    await loadCaveSalaryMonthData();
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('addCaveSalaryFeeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const memberId = fd.get('memberId');
  const customName = fd.get('customName').trim();
  const member = memberId ? caveSalaryState.members.find((m) => m.id === memberId) : null;
  const name = member ? member.name : customName;
  if (!name) {
    toast('Pick a member or enter a custom name');
    return;
  }
  try {
    const fee = await api('/api/salary-fees', {
      method: 'POST',
      body: JSON.stringify({
        month: caveSalaryState.month,
        name,
        memberId: memberId || null,
        percent: Number(fd.get('percent')),
      }),
    });
    caveSalaryState.fees.push(fee);
    e.target.reset();
    renderCaveSalary();
    toast('Fee added');
  } catch (err) {
    toast(err.message);
  }
});
