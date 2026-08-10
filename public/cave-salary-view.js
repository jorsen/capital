const caveSalaryState = { month: null, sessions: [], members: [], fees: [], paidMemberIds: [] };

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
