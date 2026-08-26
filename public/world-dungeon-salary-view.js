// World Dungeon Salary — same Base Share × Multiplier → Normalized Share →
// Final Salary math as Cave Salary (see cave-salary-view.js), but the
// multiplier is a flat number an admin types in per member (not a growth-rate
// tier lookup), and it isn't month-scoped — it's a standing weight that
// carries over every month until changed.
const worldDungeonSalaryState = {
  month: null,
  sessions: [],
  members: [],
  multipliers: new Map(), // memberId -> multiplier
  pvpDates: [], // [{id, date}], standing (not month-scoped) like multipliers
  pvpAttendance: new Map(), // `${pvpDateId}:${memberId}` -> attended (boolean)
  fees: [],
  paidMemberIds: [],
  expandedSessionId: null,
};

function worldDungeonSalaryFormatMoney(amount) {
  return `${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 🐦‍⬛`;
}

function worldDungeonSalaryFormatDiamonds(amount) {
  return `${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 💎`;
}

function worldDungeonSalaryMultiplier(memberId) {
  return worldDungeonSalaryState.multipliers.get(memberId) ?? 1;
}

// No PVP dates tracked at all means the bonus is a no-op (100%) rather than
// zeroing everyone's multiplier out just because nothing's been logged yet.
function worldDungeonPvpAttendanceFraction(memberId) {
  const dates = worldDungeonSalaryState.pvpDates;
  if (!dates.length) return 1;
  const attended = dates.filter((d) => worldDungeonSalaryState.pvpAttendance.get(`${d.id}:${memberId}`)).length;
  return attended / dates.length;
}

async function loadWorldDungeonSalaryData() {
  const monthInput = document.getElementById('worldDungeonSalaryMonthInput');
  if (!worldDungeonSalaryState.month) worldDungeonSalaryState.month = currentMonthValue();
  monthInput.value = worldDungeonSalaryState.month;

  const [sessions, members, multipliers, pvpDates, pvpAttendance] = await Promise.all([
    api('/api/world-dungeon-sessions'),
    api('/api/members'),
    api('/api/world-dungeon-multipliers'),
    api('/api/world-dungeon-pvp-dates'),
    api('/api/world-dungeon-pvp-attendance'),
  ]);
  worldDungeonSalaryState.sessions = sessions;
  worldDungeonSalaryState.members = members;
  worldDungeonSalaryState.multipliers = new Map(multipliers.map((m) => [m.memberId, m.multiplier]));
  worldDungeonSalaryState.pvpDates = pvpDates;
  worldDungeonSalaryState.pvpAttendance = new Map(pvpAttendance.map((a) => [`${a.pvpDateId}:${a.memberId}`, a.attended]));
  await loadWorldDungeonSalaryMonthData();
}

async function loadWorldDungeonSalaryMonthData() {
  const [fees, paidMemberIds] = await Promise.all([
    api(`/api/world-dungeon-salary-fees?month=${encodeURIComponent(worldDungeonSalaryState.month)}`),
    api(`/api/world-dungeon-salary-paid?month=${encodeURIComponent(worldDungeonSalaryState.month)}`),
  ]);
  worldDungeonSalaryState.fees = fees;
  worldDungeonSalaryState.paidMemberIds = paidMemberIds;
  renderWorldDungeonSalary();
}

function worldDungeonSessionsForMonth() {
  return worldDungeonSalaryState.sessions.filter((s) => s.date.slice(0, 7) === worldDungeonSalaryState.month);
}

function computeWorldDungeonSalary() {
  const sessions = worldDungeonSessionsForMonth();
  const members = worldDungeonSalaryState.members;

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
  const totalFeeAmount = worldDungeonSalaryState.fees.reduce((sum, f) => sum + (f.percent / 100) * rawPool, 0);
  const finalPool = rawPool - totalFeeAmount;

  const feeAmountByMemberId = new Map();
  worldDungeonSalaryState.fees.forEach((f) => {
    if (!f.memberId) return;
    const amount = (f.percent / 100) * rawPool;
    feeAmountByMemberId.set(f.memberId, (feeAmountByMemberId.get(f.memberId) || 0) + amount);
  });

  // Diamonds a run drops directly -- a separate pool from the loot-sold
  // crows above, run through the exact same accounting-fee percentages, but
  // never mixed with the crow pool since they're different currencies.
  const diamondRawPool = sessions.reduce((sum, s) => sum + (Number(s.diamondReward) || 0), 0);
  const totalFeeAmountDiamonds = worldDungeonSalaryState.fees.reduce((sum, f) => sum + (f.percent / 100) * diamondRawPool, 0);
  const finalDiamondPool = diamondRawPool - totalFeeAmountDiamonds;

  const feeAmountByMemberIdDiamonds = new Map();
  worldDungeonSalaryState.fees.forEach((f) => {
    if (!f.memberId) return;
    const amount = (f.percent / 100) * diamondRawPool;
    feeAmountByMemberIdDiamonds.set(f.memberId, (feeAmountByMemberIdDiamonds.get(f.memberId) || 0) + amount);
  });

  const rows = members.map((m) => {
    const attendance = attendanceByMember.get(m.id) || 0;
    const growthRate = latestGrowth(m)?.rate ?? null;
    const multiplier = worldDungeonSalaryMultiplier(m.id);
    const pvpFraction = worldDungeonPvpAttendanceFraction(m.id);
    const effectiveMultiplier = multiplier * pvpFraction;
    // Base Share = this member's attendance as a fraction of everyone's combined attendance.
    const baseShare = totalAttendance > 0 ? attendance / totalAttendance : 0;
    const baseWithMultiplier = baseShare * effectiveMultiplier;
    return { member: m, attendance, growthRate, multiplier, pvpFraction, effectiveMultiplier, baseShare, baseWithMultiplier };
  });
  const sumBaseWithMultiplier = rows.reduce((sum, r) => sum + r.baseWithMultiplier, 0);

  rows.forEach((r) => {
    r.normalizedShare = sumBaseWithMultiplier > 0 ? r.baseWithMultiplier / sumBaseWithMultiplier : 0;
    r.initialComputation = r.normalizedShare * finalPool;
    r.finalSalary = r.initialComputation + (feeAmountByMemberId.get(r.member.id) || 0);
    r.initialComputationDiamonds = r.normalizedShare * finalDiamondPool;
    r.finalSalaryDiamonds = r.initialComputationDiamonds + (feeAmountByMemberIdDiamonds.get(r.member.id) || 0);
  });

  rows.sort((a, b) => (b.growthRate ?? -Infinity) - (a.growthRate ?? -Infinity));

  return { rows, rawPool, totalFeeAmount, finalPool, diamondRawPool, totalFeeAmountDiamonds, finalDiamondPool };
}

function renderWorldDungeonSalary() {
  const { rows, rawPool, totalFeeAmount, finalPool, diamondRawPool, totalFeeAmountDiamonds, finalDiamondPool } = computeWorldDungeonSalary();

  document.getElementById('worldDungeonSalaryPoolValue').textContent = worldDungeonSalaryFormatMoney(rawPool);
  document.getElementById('worldDungeonSalaryFeesValue').textContent = worldDungeonSalaryFormatMoney(totalFeeAmount);
  document.getElementById('worldDungeonSalaryFinalPoolValue').textContent = worldDungeonSalaryFormatMoney(finalPool);
  document.getElementById('worldDungeonSalaryDiamondPoolValue').textContent = worldDungeonSalaryFormatDiamonds(diamondRawPool);
  document.getElementById('worldDungeonSalaryDiamondFeesValue').textContent = worldDungeonSalaryFormatDiamonds(totalFeeAmountDiamonds);
  document.getElementById('worldDungeonSalaryFinalDiamondPoolValue').textContent = worldDungeonSalaryFormatDiamonds(finalDiamondPool);

  renderWorldDungeonSalaryFees();
  renderWorldDungeonSalarySessions();
  renderWorldDungeonSalaryBreakdown(rows);
}

// ---------- Accounting fees (identical pattern to Cave Salary) ----------

function renderWorldDungeonSalaryFees() {
  const feesBody = document.getElementById('worldDungeonSalaryFeesBody');
  feesBody.innerHTML = worldDungeonSalaryState.fees
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
      await api(`/api/world-dungeon-salary-fees/${id}`, { method: 'DELETE' });
      worldDungeonSalaryState.fees = worldDungeonSalaryState.fees.filter((f) => f.id !== id);
      renderWorldDungeonSalary();
      toast('Fee removed');
    });
  });

  const memberSelect = document.getElementById('worldDungeonSalaryFeeMemberSelect');
  const sortedMembers = worldDungeonSalaryState.members.slice().sort((a, b) => a.name.localeCompare(b.name));
  memberSelect.innerHTML =
    '<option value="">— none (use custom name) —</option>' +
    sortedMembers.map((m) => `<option value="${m.id}">${escapeHtml(memberDisplayName(m))}</option>`).join('');
}

document.getElementById('worldDungeonSalaryMonthInput').addEventListener('change', async (e) => {
  worldDungeonSalaryState.month = e.target.value;
  try {
    await loadWorldDungeonSalaryMonthData();
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('addWorldDungeonSalaryFeeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const memberId = fd.get('memberId');
  const customName = fd.get('customName').trim();
  const member = memberId ? worldDungeonSalaryState.members.find((m) => m.id === memberId) : null;
  const name = member ? member.name : customName;
  if (!name) {
    toast('Pick a member or enter a custom name');
    return;
  }
  try {
    const fee = await api('/api/world-dungeon-salary-fees', {
      method: 'POST',
      body: JSON.stringify({
        month: worldDungeonSalaryState.month,
        name,
        memberId: memberId || null,
        percent: Number(fd.get('percent')),
      }),
    });
    worldDungeonSalaryState.fees.push(fee);
    e.target.reset();
    renderWorldDungeonSalary();
    toast('Fee added');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Runs (log a date, mark attendees, log sold loot) ----------

document.getElementById('addWorldDungeonSalarySessionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const session = await api('/api/world-dungeon-sessions', {
      method: 'POST',
      body: JSON.stringify({ date: fd.get('date'), run: fd.get('run'), diamondReward: fd.get('diamondReward') }),
    });
    worldDungeonSalaryState.sessions.push(session);
    worldDungeonSalaryState.expandedSessionId = session.id;
    e.target.reset();
    renderWorldDungeonSalary();
    toast('Run logged');
  } catch (err) {
    toast(err.message);
  }
});

function renderWorldDungeonSalarySessions() {
  const sessions = worldDungeonSessionsForMonth();
  const body = document.getElementById('worldDungeonSalarySessionsBody');
  const empty = document.getElementById('worldDungeonSalarySessionsEmptyState');
  empty.classList.toggle('hidden', sessions.length !== 0);

  body.innerHTML = sessions
    .map((s) => {
      const totalQty = s.records.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
      const totalPool = s.records.reduce((sum, r) => sum + (Number(r.quantity) || 0) * (Number(r.soldPrice) || 0), 0);
      const expanded = worldDungeonSalaryState.expandedSessionId === s.id;
      const rows = [
        `<tr class="world-dungeon-salary-session-row" data-session-id="${s.id}" style="cursor:pointer;">
          <td>${escapeHtml(s.date)}</td>
          <td>${escapeHtml(s.run || '—')}</td>
          <td>${s.attendees.length}</td>
          <td>${s.records.length}</td>
          <td>${totalQty}</td>
          <td>${worldDungeonSalaryFormatMoney(totalPool)}</td>
          <td><input type="number" class="world-dungeon-salary-diamond-input admin-disable" data-session-id="${s.id}" value="${s.diamondReward}" min="0" step="1" style="width:80px;" onclick="event.stopPropagation()"></td>
          <td class="admin-only"><button class="icon-btn" data-delete-session="${s.id}" title="Delete run">✕</button></td>
        </tr>`,
      ];
      if (expanded) rows.push(worldDungeonSalarySessionDetailRow(s));
      return rows.join('');
    })
    .join('');

  body.querySelectorAll('.world-dungeon-salary-session-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-session], .world-dungeon-salary-diamond-input')) return;
      const id = row.getAttribute('data-session-id');
      worldDungeonSalaryState.expandedSessionId = worldDungeonSalaryState.expandedSessionId === id ? null : id;
      renderWorldDungeonSalarySessions();
    });
  });

  body.querySelectorAll('.world-dungeon-salary-diamond-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const sessionId = input.getAttribute('data-session-id');
      const session = worldDungeonSalaryState.sessions.find((s) => s.id === sessionId);
      const prev = session.diamondReward;
      const value = Number(input.value);
      if (Number.isNaN(value) || value < 0) {
        toast('Diamond Reward must be zero or a positive number');
        input.value = prev;
        return;
      }
      try {
        const updated = await api(`/api/world-dungeon-sessions/${sessionId}`, { method: 'PUT', body: JSON.stringify({ diamondReward: value }) });
        Object.assign(session, updated);
        renderWorldDungeonSalary();
      } catch (err) {
        input.value = prev;
        toast(err.message);
      }
    });
  });

  body.querySelectorAll('[data-delete-session]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-session');
      if (!confirm('Delete this run and all its loot records?')) return;
      try {
        await api(`/api/world-dungeon-sessions/${id}`, { method: 'DELETE' });
        worldDungeonSalaryState.sessions = worldDungeonSalaryState.sessions.filter((s) => s.id !== id);
        if (worldDungeonSalaryState.expandedSessionId === id) worldDungeonSalaryState.expandedSessionId = null;
        renderWorldDungeonSalary();
        toast('Run deleted');
      } catch (err) {
        toast(err.message);
      }
    });
  });

  attachWorldDungeonSalarySessionDetailHandlers();
}

function worldDungeonSalarySessionDetailRow(s) {
  const memberChecks = worldDungeonSalaryState.members
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (m) => `
      <label class="world-dungeon-salary-attendee-label">
        <input type="checkbox" class="world-dungeon-salary-attendee-check admin-disable" data-session-id="${s.id}" data-member-id="${m.id}" ${s.attendees.includes(m.id) ? 'checked' : ''}>
        <span>${escapeHtml(memberDisplayName(m))}</span>
      </label>`
    )
    .join('');

  const recordRows = s.records
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.item)}</td>
      <td>${r.quantity}</td>
      <td>${worldDungeonSalaryFormatMoney(r.soldPrice)}</td>
      <td>${worldDungeonSalaryFormatMoney(r.quantity * r.soldPrice)}</td>
      <td>${escapeHtml(r.buyer || '—')}</td>
      <td class="admin-only"><button class="icon-btn" data-delete-record="${r.id}" data-session-id="${s.id}" title="Remove loot">✕</button></td>
    </tr>`
    )
    .join('');

  const attendeeCount = s.attendees.length;
  const memberCount = worldDungeonSalaryState.members.length;

  return `
  <tr class="world-dungeon-salary-session-detail" data-session-id="${s.id}">
    <td colspan="7">
      <div class="world-dungeon-salary-detail-panel">
        <div class="world-dungeon-salary-detail-header">
          <span class="world-dungeon-salary-detail-title">Attendees</span>
          <span class="world-dungeon-salary-attendee-count">${attendeeCount} / ${memberCount}</span>
          <div class="admin-only world-dungeon-salary-attendee-actions">
            <button type="button" class="btn small" data-select-all-attendees="${s.id}">Select All</button>
            <button type="button" class="btn small" data-clear-all-attendees="${s.id}">Clear All</button>
          </div>
        </div>
        <div class="world-dungeon-salary-attendee-grid admin-only">${memberChecks}</div>

        <div class="world-dungeon-salary-detail-title" style="margin-top:18px;">Loot Sold</div>
        <table class="growth-table world-dungeon-salary-loot-table">
          <thead><tr><th>Item</th><th>Qty</th><th>Sold Price</th><th>Total</th><th>Buyer</th><th></th></tr></thead>
          <tbody>${recordRows || '<tr><td colspan="6" style="color:var(--text-muted)">No loot logged for this run.</td></tr>'}</tbody>
        </table>
        <form class="world-dungeon-salary-add-record-form admin-only growth-form-row" data-session-id="${s.id}">
          <label style="flex:2;"><span>Item</span><input type="text" name="item" required></label>
          <label style="max-width:90px;"><span>Qty</span><input type="number" name="quantity" min="1" step="1" value="1" required></label>
          <label style="max-width:130px;"><span>Sold Price</span><input type="number" name="soldPrice" min="0" step="0.01" value="0" required></label>
          <label style="max-width:130px;"><span>Buyer</span><input type="text" name="buyer"></label>
          <button type="submit" class="btn primary small">Add Loot</button>
        </form>
      </div>
    </td>
  </tr>`;
}

async function worldDungeonSalarySetAttendees(sessionId, nextAttendees) {
  const session = worldDungeonSalaryState.sessions.find((s) => s.id === sessionId);
  try {
    const updated = await api(`/api/world-dungeon-sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ attendees: nextAttendees }),
    });
    Object.assign(session, updated);
    renderWorldDungeonSalary();
  } catch (err) {
    toast(err.message);
  }
}

function attachWorldDungeonSalarySessionDetailHandlers() {
  document.querySelectorAll('[data-select-all-attendees]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await worldDungeonSalarySetAttendees(btn.getAttribute('data-select-all-attendees'), worldDungeonSalaryState.members.map((m) => m.id));
    });
  });

  document.querySelectorAll('[data-clear-all-attendees]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await worldDungeonSalarySetAttendees(btn.getAttribute('data-clear-all-attendees'), []);
    });
  });

  document.querySelectorAll('.world-dungeon-salary-attendee-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const sessionId = cb.getAttribute('data-session-id');
      const memberId = cb.getAttribute('data-member-id');
      const session = worldDungeonSalaryState.sessions.find((s) => s.id === sessionId);
      const nextAttendees = cb.checked
        ? [...session.attendees, memberId]
        : session.attendees.filter((id) => id !== memberId);
      try {
        const updated = await api(`/api/world-dungeon-sessions/${sessionId}`, {
          method: 'PUT',
          body: JSON.stringify({ attendees: nextAttendees }),
        });
        Object.assign(session, updated);
        renderWorldDungeonSalaryBreakdown(computeWorldDungeonSalary().rows);
        document.getElementById('worldDungeonSalaryPoolValue').textContent = worldDungeonSalaryFormatMoney(computeWorldDungeonSalary().rawPool);
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      }
    });
  });

  document.querySelectorAll('.world-dungeon-salary-add-record-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sessionId = form.getAttribute('data-session-id');
      const fd = new FormData(form);
      try {
        const record = await api(`/api/world-dungeon-sessions/${sessionId}/records`, {
          method: 'POST',
          body: JSON.stringify({
            item: fd.get('item'),
            quantity: fd.get('quantity'),
            soldPrice: fd.get('soldPrice'),
            buyer: fd.get('buyer'),
          }),
        });
        const session = worldDungeonSalaryState.sessions.find((s) => s.id === sessionId);
        session.records.push(record);
        renderWorldDungeonSalary();
        toast('Loot added');
      } catch (err) {
        toast(err.message);
      }
    });
  });

  document.querySelectorAll('[data-delete-record]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sessionId = btn.getAttribute('data-session-id');
      const recordId = btn.getAttribute('data-delete-record');
      try {
        await api(`/api/world-dungeon-sessions/${sessionId}/records/${recordId}`, { method: 'DELETE' });
        const session = worldDungeonSalaryState.sessions.find((s) => s.id === sessionId);
        session.records = session.records.filter((r) => r.id !== recordId);
        renderWorldDungeonSalary();
        toast('Loot removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

// ---------- PVP Attendance Bonus (standing, not month-scoped) ----------

document.getElementById('addWorldDungeonPvpDateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const pvpDate = await api('/api/world-dungeon-pvp-dates', { method: 'POST', body: JSON.stringify({ date: fd.get('date') }) });
    worldDungeonSalaryState.pvpDates.push(pvpDate);
    worldDungeonSalaryState.pvpDates.sort((a, b) => a.date.localeCompare(b.date));
    e.target.reset();
    renderWorldDungeonSalary();
    toast('PVP date added');
  } catch (err) {
    toast(err.message);
  }
});

// "2026-07-19T00:00:00.000Z" (a DATE column comes back JSON-serialized as a
// full ISO timestamp) -> "Jul 19" -- short on purpose, this table is a wide
// grid of one column per PVP date so a compact header matters more than a
// fully spelled-out one.
function worldDungeonPvpShortDate(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Deleting a PVP date drops its column and everyone's recorded attendance
// for it -- attached fresh each time the header is (re)built, same as the
// checkbox handlers in renderWorldDungeonSalaryBreakdown below.
function attachWorldDungeonPvpDateDeleteHandlers() {
  document.querySelectorAll('[data-delete-pvp-date]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-pvp-date');
      if (!confirm("Remove this PVP date and everyone's attendance for it?")) return;
      try {
        await api(`/api/world-dungeon-pvp-dates/${id}`, { method: 'DELETE' });
        worldDungeonSalaryState.pvpDates = worldDungeonSalaryState.pvpDates.filter((d) => d.id !== id);
        worldDungeonSalaryState.pvpAttendance.forEach((_, key) => {
          if (key.startsWith(`${id}:`)) worldDungeonSalaryState.pvpAttendance.delete(key);
        });
        renderWorldDungeonSalary();
        toast('PVP date removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

// One shared header row for both the Salary Breakdown columns and the PVP
// attendance date columns -- the date columns are spliced in right after
// "PVP Bonus" so a member's whole story (rank, PVP record, payout) reads as
// one row instead of two separate tables that have to be cross-referenced
// by name.
function renderWorldDungeonSalaryHeaderRow() {
  const dates = worldDungeonSalaryState.pvpDates;
  const dateHeaders = dates
    .map(
      (d) => `
    <th class="world-dungeon-pvp-date-th">
      <span>${worldDungeonPvpShortDate(d.date)}</span>
      <button type="button" class="icon-btn admin-only" data-delete-pvp-date="${d.id}" title="Remove this date">✕</button>
    </th>`
    )
    .join('');

  document.getElementById('worldDungeonSalaryHeaderRow').innerHTML = `
    <th>#</th>
    <th>IGN</th>
    <th>Growth Rate</th>
    <th>Attendance</th>
    <th title="Flat value set per member"><span>Multiplier</span><br><span class="th-formula">set per member</span></th>
    <th title="PVP Bonus = PVP dates attended ÷ PVP dates tracked"><span>PVP Bonus</span><br><span class="th-formula">attended ÷ tracked</span></th>
    ${dateHeaders}
    <th title="Base Share = Attendance ÷ Total Attendance"><span>Base Share</span><br><span class="th-formula">Attendance ÷ Σ Attendance</span></th>
    <th title="Base + Multiplier = Base Share × Multiplier"><span>Base + Multiplier</span><br><span class="th-formula">Base Share × Multiplier</span></th>
    <th title="Normalized Share = (Base + Multiplier) ÷ Σ(Base + Multiplier)"><span>Normalized Share</span><br><span class="th-formula">(Base+Mult) ÷ Σ(Base+Mult)</span></th>
    <th title="Initial Computation = Normalized Share × Final Salary Pool"><span>Initial Computation (🐦‍⬛)</span><br><span class="th-formula">Norm. Share × Final Pool</span></th>
    <th title="Final Salary = Initial Computation + Accounting Fee (if applicable)"><span>Final Salary (🐦‍⬛)</span><br><span class="th-formula">Initial Comp. + Fee</span></th>
    <th title="Same Normalized Share applied to the separate Final Diamond Pool"><span>Initial Computation (💎)</span><br><span class="th-formula">Norm. Share × Final Diamond Pool</span></th>
    <th title="Final Diamond Salary = Initial Computation (💎) + Accounting Fee (if applicable)"><span>Final Salary (💎)</span><br><span class="th-formula">Initial Comp. + Fee</span></th>
    <th>Sent</th>`;

  attachWorldDungeonPvpDateDeleteHandlers();
}

// ---------- Salary breakdown (multiplier + PVP attendance are editable here) ----------

function renderWorldDungeonSalaryBreakdown(rows) {
  renderWorldDungeonSalaryHeaderRow();

  const body = document.getElementById('worldDungeonSalaryBody');
  const empty = document.getElementById('worldDungeonSalaryEmptyState');
  empty.classList.toggle('hidden', worldDungeonSessionsForMonth().length !== 0);

  const paidSet = new Set(worldDungeonSalaryState.paidMemberIds);
  const dates = worldDungeonSalaryState.pvpDates;

  body.innerHTML = rows
    .map((r, i) => {
      const sent = paidSet.has(r.member.id);
      const dateCells = dates
        .map((d) => {
          const attended = !!worldDungeonSalaryState.pvpAttendance.get(`${d.id}:${r.member.id}`);
          return `<td class="${attended ? 'world-dungeon-pvp-attended' : 'world-dungeon-pvp-absent'}"><input type="checkbox" class="world-dungeon-pvp-attendance-check admin-disable" data-pvp-date-id="${d.id}" data-member-id="${r.member.id}" ${attended ? 'checked' : ''}></td>`;
        })
        .join('');
      return `
    <tr class="${sent ? 'row-sent' : ''}">
      <td>${i + 1}</td>
      <td style="font-weight:600;">${escapeHtml(memberDisplayName(r.member))}</td>
      <td>${r.growthRate === null ? '–' : r.growthRate.toLocaleString()}</td>
      <td>${r.attendance}</td>
      <td><input type="number" class="world-dungeon-salary-multiplier-input admin-disable" data-member-id="${r.member.id}" value="${r.multiplier}" min="0" step="0.1" style="width:70px;"></td>
      <td>${(r.pvpFraction * 100).toFixed(0)}%</td>
      ${dateCells}
      <td>${(r.baseShare * 100).toFixed(2)}%</td>
      <td>${r.baseWithMultiplier.toFixed(4)}</td>
      <td>${(r.normalizedShare * 100).toFixed(2)}%</td>
      <td>${worldDungeonSalaryFormatMoney(r.initialComputation)}</td>
      <td style="font-weight:600;">${worldDungeonSalaryFormatMoney(r.finalSalary)}</td>
      <td>${worldDungeonSalaryFormatDiamonds(r.initialComputationDiamonds)}</td>
      <td style="font-weight:600;">${worldDungeonSalaryFormatDiamonds(r.finalSalaryDiamonds)}</td>
      <td><input type="checkbox" class="world-dungeon-salary-sent-check admin-disable" data-member-id="${r.member.id}" ${sent ? 'checked' : ''}></td>
    </tr>`;
    })
    .join('');

  const totalMultiplier = rows.reduce((sum, r) => sum + r.multiplier, 0);
  const blankDateCells = dates.map(() => '<td></td>').join('');
  body.innerHTML += `
    <tr class="table-total-row">
      <td></td>
      <td>Total</td>
      <td></td>
      <td></td>
      <td>${totalMultiplier.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
      <td></td>
      ${blankDateCells}
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
    </tr>`;

  body.querySelectorAll('.world-dungeon-pvp-attendance-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const pvpDateId = cb.getAttribute('data-pvp-date-id');
      const memberId = cb.getAttribute('data-member-id');
      const key = `${pvpDateId}:${memberId}`;
      const attended = cb.checked;
      try {
        await api('/api/world-dungeon-pvp-attendance', { method: 'PUT', body: JSON.stringify({ pvpDateId, memberId, attended }) });
        worldDungeonSalaryState.pvpAttendance.set(key, attended);
        renderWorldDungeonSalaryBreakdown(computeWorldDungeonSalary().rows);
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      }
    });
  });

  body.querySelectorAll('.world-dungeon-salary-multiplier-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const memberId = input.getAttribute('data-member-id');
      const prev = worldDungeonSalaryMultiplier(memberId);
      const value = Number(input.value);
      if (Number.isNaN(value) || value < 0) {
        toast('Multiplier must be zero or a positive number');
        input.value = prev;
        return;
      }
      try {
        await api(`/api/world-dungeon-multipliers/${memberId}`, { method: 'PUT', body: JSON.stringify({ multiplier: value }) });
        worldDungeonSalaryState.multipliers.set(memberId, value);
        renderWorldDungeonSalaryBreakdown(computeWorldDungeonSalary().rows);
      } catch (err) {
        input.value = prev;
        toast(err.message);
      }
    });
  });

  body.querySelectorAll('.world-dungeon-salary-sent-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const memberId = cb.getAttribute('data-member-id');
      const row = cb.closest('tr');
      try {
        if (cb.checked) {
          await api('/api/world-dungeon-salary-paid', { method: 'POST', body: JSON.stringify({ month: worldDungeonSalaryState.month, memberId }) });
          worldDungeonSalaryState.paidMemberIds.push(memberId);
          row.classList.add('row-sent');
        } else {
          await api(`/api/world-dungeon-salary-paid?month=${encodeURIComponent(worldDungeonSalaryState.month)}&memberId=${encodeURIComponent(memberId)}`, { method: 'DELETE' });
          worldDungeonSalaryState.paidMemberIds = worldDungeonSalaryState.paidMemberIds.filter((id) => id !== memberId);
          row.classList.remove('row-sent');
        }
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      }
    });
  });
}
