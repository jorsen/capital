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
        if (!s.records.length) {
          rows.push({ boss: s.run, attendees: s.attendees.length, item: null });
          return;
        }
        s.records.forEach((r) => {
          rows.push({ sessionId: s.id, recordId: r.id, boss: s.run, attendees: s.attendees.length, item: r.item, quantity: r.quantity, price: r.soldPrice, buyer: r.buyer });
        });
      });

      const totalDias = rows.reduce((sum, r) => sum + (r.item ? r.quantity * r.price : 0), 0);

      return rows
        .map((r, i) => {
          const dateCell = i === 0 ? `<td rowspan="${rows.length}" style="font-weight:600;">${escapeHtml(formatCaveReportDate(group.date))}</td>` : '';
          const totalDiasCell = i === 0 ? `<td rowspan="${rows.length}" style="font-weight:600;">${caveLootListFormatMoney(totalDias)}</td>` : '';
          if (!r.item) {
            return `<tr>${dateCell}<td>${escapeHtml(r.boss || '(No boss)')}</td><td>${r.attendees}</td><td colspan="5" style="color:var(--text-muted)">No loot logged</td>${totalDiasCell}</tr>`;
          }
          return `
        <tr>
          ${dateCell}
          <td>${escapeHtml(r.boss || '(No boss)')}</td>
          <td>${r.attendees}</td>
          <td>${itemLabel(r.item)}</td>
          <td><input type="number" class="cave-loot-list-qty admin-disable" data-session-id="${r.sessionId}" data-record-id="${r.recordId}" value="${r.quantity}" min="1" step="1" style="width:90px;"></td>
          <td><input type="number" class="cave-loot-list-price admin-disable" data-session-id="${r.sessionId}" data-record-id="${r.recordId}" value="${r.price}" min="0" step="0.01" style="width:110px;"></td>
          <td>${caveLootListFormatMoney(r.quantity * r.price)}</td>
          <td><input type="text" class="cave-loot-list-buyer admin-disable" data-session-id="${r.sessionId}" data-record-id="${r.recordId}" value="${escapeHtml(r.buyer || '')}" placeholder="(optional)" style="width:130px;"></td>
          ${totalDiasCell}
        </tr>`;
        })
        .join('');
    })
    .join('');

  wireCaveLootListInputs();
}

function wireCaveLootListInputs() {
  const body = document.getElementById('caveLootListBody');

  async function saveField(input, field, parse) {
    const sessionId = input.getAttribute('data-session-id');
    const recordId = input.getAttribute('data-record-id');
    const value = parse(input.value);
    if (value === undefined) {
      toast(`${field} is invalid`);
      renderCaveLootList();
      return;
    }
    try {
      await api(`/api/caves/${sessionId}/records/${recordId}`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: value }),
      });
      const session = caveLootListState.sessions.find((s) => s.id === sessionId);
      const record = session?.records.find((r) => r.id === recordId);
      if (record) record[field] = value;
      renderCaveLootList();
    } catch (err) {
      toast(err.message);
      renderCaveLootList();
    }
  }

  body.querySelectorAll('.cave-loot-list-qty').forEach((input) => {
    input.addEventListener('change', () => {
      saveField(input, 'quantity', (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 ? n : undefined;
      });
    });
  });

  body.querySelectorAll('.cave-loot-list-price').forEach((input) => {
    input.addEventListener('change', () => {
      saveField(input, 'soldPrice', (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      });
    });
  });

  body.querySelectorAll('.cave-loot-list-buyer').forEach((input) => {
    input.addEventListener('change', () => {
      saveField(input, 'buyer', (v) => v);
    });
  });
}

document.getElementById('caveLootListMonthInput').addEventListener('change', (e) => {
  caveLootListState.month = e.target.value;
  renderCaveLootList();
});
