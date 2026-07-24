const sessionState = { id: null, session: null, members: [] };

function raffleRecordOptionsHtml(unassignedRecords) {
  if (!unassignedRecords.length) {
    return '<option value="">No unassigned loot</option>';
  }
  return unassignedRecords
    .map((r) => `<option value="${r.id}">${escapeHtml(r.item)} (x${r.quantity})</option>`)
    .join('');
}

function getPresentMembers(session, sortedMembers) {
  return sortedMembers.filter((m) => !session.absentees.includes(m.id));
}

// Present members who haven't already won a raffle item this session — each
// member can only win once, so a Kurashi who already won Necklace of Honor
// won't be eligible for other items' draws too.
function getEligibleRaffleMembers(session, sortedMembers) {
  const alreadyWonIds = new Set(
    session.records.filter((r) => r.viaRaffle && r.recipientId).map((r) => r.recipientId)
  );
  return getPresentMembers(session, sortedMembers).filter((m) => !alreadyWonIds.has(m.id));
}

function raffleLogItemsHtml(session) {
  const entries = session.raffleLog.slice().reverse(); // newest first
  if (!entries.length) {
    return '<p style="color:var(--text-muted); font-size:13px;">No raffle activity yet.</p>';
  }
  return entries
    .map(
      (e) => `
    <div class="raffle-log-entry">
      <span class="raffle-log-time">${new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span>${escapeHtml(e.message)}</span>
    </div>`
    )
    .join('');
}

function raffleWinnersRowsHtml(session) {
  const winnerRecords = session.records.filter((r) => r.viaRaffle);
  if (!winnerRecords.length) {
    return '<tr><td colspan="3" style="color:var(--text-muted)">No raffle winners yet.</td></tr>';
  }

  // Same person winning the same item across separate draws is grouped into
  // one row with a combined quantity, instead of showing duplicate entries.
  const grouped = new Map();
  winnerRecords.forEach((r) => {
    const key = `${r.item.toLowerCase()}|${r.recipientId}`;
    if (!grouped.has(key)) {
      grouped.set(key, { item: r.item, recipientName: r.recipientName, quantity: 0, recordIds: [] });
    }
    const g = grouped.get(key);
    g.quantity += r.quantity;
    g.recordIds.push(r.id);
  });

  const rows = Array.from(grouped.values()).sort((a, b) => a.item.localeCompare(b.item));

  return rows
    .map(
      (g) => `
    <tr>
      <td style="font-weight:600;">${itemLabel(g.item)} (x${g.quantity})</td>
      <td>${escapeHtml(g.recipientName)}</td>
      <td class="no-print"><button class="icon-btn" data-remove-raffle-winner="${g.recordIds.join(',')}" title="Remove winner">✕</button></td>
    </tr>`
    )
    .join('');
}

// Wires a text input + filterable dropdown for picking a known item, reused by
// both the Add Loot form and the Raffle item picker.
function wireItemDropdown({ inputId, menuId, iconId, iconSize }) {
  const input = document.getElementById(inputId);
  const menu = document.getElementById(menuId);
  const iconEl = iconId ? document.getElementById(iconId) : null;

  function updateIcon() {
    if (!iconEl) return;
    const category = itemCategoriesState.list.find((c) => c.name.toLowerCase() === input.value.trim().toLowerCase());
    iconEl.innerHTML = category ? itemIconImg(category.iconUrl, category.name, iconSize || 32) : '';
  }

  function renderMenu() {
    const query = input.value.trim().toLowerCase();
    const matches = itemCategoriesState.list
      .filter((c) => !query || c.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!matches.length) {
      menu.classList.add('hidden');
      return;
    }

    menu.innerHTML = matches
      .map(
        (c) => `
        <div class="icon-select-option" data-name="${escapeHtml(c.name)}">
          ${itemIconImg(c.iconUrl, c.name, 28)}
          <span>${escapeHtml(c.name)}</span>
        </div>`
      )
      .join('');
    menu.classList.remove('hidden');

    menu.querySelectorAll('.icon-select-option').forEach((el) => {
      el.addEventListener('click', () => {
        input.value = el.getAttribute('data-name');
        menu.classList.add('hidden');
        updateIcon();
      });
    });
  }

  input.addEventListener('input', () => {
    updateIcon();
    renderMenu();
  });
  input.addEventListener('focus', renderMenu);
  updateIcon();
}

function itemLabel(itemName) {
  const category = itemCategoriesState.list.find((c) => c.name.toLowerCase() === itemName.toLowerCase());
  const icon = itemIconImg(category ? category.iconUrl : null, itemName, 48);
  return `<span style="display:inline-flex; align-items:center; gap:6px;">${icon}${escapeHtml(itemName)}</span>`;
}

// Splits an unassigned record across multiple members, each with their own quantity.
// Uses the existing loot-records API: one POST per member, then either shrinks the
// original record to whatever's left over or deletes it if fully allocated.
function openMultiAssignModal(sessionId, record, members) {
  const modal = document.getElementById('multiAssignModal');
  const list = document.getElementById('multiAssignMembersList');
  const info = document.getElementById('multiAssignItemInfo');
  const totalEl = document.getElementById('multiAssignTotal');
  const confirmBtn = document.getElementById('multiAssignConfirmBtn');

  info.innerHTML = `${itemLabel(record.item)} — ${record.quantity} available`;

  list.innerHTML = members
    .map(
      (m) => `
      <label style="display:flex; flex-direction:row; align-items:center; gap:8px;">
        <input type="checkbox" class="multi-assign-check" data-member-id="${m.id}">
        <span style="flex:1;">${escapeHtml(m.name)}</span>
        <input type="number" class="multi-assign-qty" data-member-id="${m.id}" min="1" step="1" value="1" style="width:80px; display:none;">
      </label>`
    )
    .join('');

  function updateTotals() {
    let total = 0;
    let anyChecked = false;
    list.querySelectorAll('.multi-assign-check').forEach((cb) => {
      if (!cb.checked) return;
      anyChecked = true;
      const qtyInput = list.querySelector(`.multi-assign-qty[data-member-id="${cb.getAttribute('data-member-id')}"]`);
      total += Number(qtyInput.value) || 0;
    });
    totalEl.textContent = `${total} / ${record.quantity} allocated`;
    totalEl.style.color = total > record.quantity ? 'var(--bad)' : 'var(--text-secondary)';
    confirmBtn.disabled = !anyChecked || total <= 0 || total > record.quantity;
  }

  list.querySelectorAll('.multi-assign-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const qtyInput = list.querySelector(`.multi-assign-qty[data-member-id="${cb.getAttribute('data-member-id')}"]`);
      qtyInput.style.display = cb.checked ? '' : 'none';
      updateTotals();
    });
  });
  list.querySelectorAll('.multi-assign-qty').forEach((input) => {
    input.addEventListener('input', updateTotals);
  });

  updateTotals();
  modal.classList.remove('hidden');

  // Assigned via property (not addEventListener) so repeated opens don't stack handlers.
  confirmBtn.onclick = async () => {
    const allocations = [];
    list.querySelectorAll('.multi-assign-check:checked').forEach((cb) => {
      const memberId = cb.getAttribute('data-member-id');
      const qty = Number(list.querySelector(`.multi-assign-qty[data-member-id="${memberId}"]`).value);
      if (qty > 0) allocations.push({ memberId, qty });
    });
    const total = allocations.reduce((sum, a) => sum + a.qty, 0);
    if (!allocations.length || total > record.quantity) return;

    confirmBtn.disabled = true;
    try {
      for (const a of allocations) {
        const newRecord = await api(`/api/loot/${sessionId}/records`, {
          method: 'POST',
          body: JSON.stringify({
            recipientId: a.memberId,
            item: record.item,
            quantity: a.qty,
          }),
        });
        sessionState.session.records.push(newRecord);
      }

      const remaining = record.quantity - total;
      if (remaining > 0) {
        const updated = await api(`/api/loot/${sessionId}/records/${record.id}`, {
          method: 'PUT',
          body: JSON.stringify({ quantity: remaining }),
        });
        Object.assign(record, updated);
      } else {
        await api(`/api/loot/${sessionId}/records/${record.id}`, { method: 'DELETE' });
        sessionState.session.records = sessionState.session.records.filter((r) => r.id !== record.id);
      }

      modal.classList.add('hidden');
      renderSessionContent();
      toast(`Assigned to ${allocations.length} member${allocations.length === 1 ? '' : 's'}`);
    } catch (err) {
      toast(err.message);
      confirmBtn.disabled = false;
    }
  };
}

async function loadSessionData(id) {
  sessionState.id = id;
  const content = document.getElementById('sessionContent');
  if (!id) {
    content.innerHTML = '<p class="empty-state">No date specified.</p>';
    return;
  }
  content.innerHTML = 'Loading…';
  try {
    const [session, members] = await Promise.all([api(`/api/loot/${id}`), api('/api/members')]);
    sessionState.session = session;
    sessionState.members = members;
    renderSessionContent();
  } catch (err) {
    content.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }
}

function renderSessionContent() {
  const session = sessionState.session;
  const content = document.getElementById('sessionContent');

  const sortedMembers = sessionState.members.slice().sort((a, b) => a.name.localeCompare(b.name));
  const memberOptions = sortedMembers
    .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
    .join('');

  const allRecords = session.records.slice().reverse();
  const unassignedRecords = allRecords.filter((r) => !r.recipientId);
  const raffleEligibleRecords = unassignedRecords.filter((r) => !r.excludedFromRaffle);

  // Raffle-drawn items float to the top of Loot Records so it's easy to see
  // what's already been won vs. what's still up for grabs at a glance.
  const displayRecords = allRecords.slice().sort((a, b) => (b.viaRaffle ? 1 : 0) - (a.viaRaffle ? 1 : 0));

  const lootRecordsRows = displayRecords
    .map((r) => {
      if (r.recipientId) {
        return `
        <tr class="loot-status-done">
          <td style="font-weight:600;">${itemLabel(r.item)}</td>
          <td class="col-right"><input type="number" class="qty-input" data-record-id="${r.id}" value="${r.quantity}" min="1" step="1" style="width:100px; text-align:right;"></td>
          <td>${escapeHtml(r.recipientName)}</td>
          <td>
            <button class="icon-btn" data-unassign="${r.id}" title="Unassign">↩</button>
            <button class="icon-btn" data-del-record="${r.id}" title="Delete record">✕</button>
          </td>
        </tr>`;
      }
      const inProgress = session.records.some(
        (other) => other.recipientId && other.item.toLowerCase() === r.item.toLowerCase()
      );
      const excludedBadge = r.excludedFromRaffle
        ? '<span style="color:var(--text-muted); font-size:11px; margin-left:6px;">(excluded from raffle)</span>'
        : '';
      return `
      <tr class="${inProgress ? 'loot-status-progress' : ''}">
        <td style="font-weight:600;">${itemLabel(r.item)}${excludedBadge}</td>
        <td class="col-right"><input type="number" class="qty-input" data-record-id="${r.id}" value="${r.quantity}" min="1" step="1" style="width:100px; text-align:right;"></td>
        <td>
          <button type="button" class="btn small" data-multi-assign="${r.id}">Assign to…</button>
        </td>
        <td>
          <button class="icon-btn" data-toggle-raffle-exclude="${r.id}" title="${r.excludedFromRaffle ? 'Include in raffle' : 'Exclude from raffle'}">${r.excludedFromRaffle ? '🎲' : '🚫'}</button>
          <button class="icon-btn" data-del-record="${r.id}" title="Delete record">✕</button>
        </td>
      </tr>`;
    })
    .join('');

  content.innerHTML = `
    <div class="member-header">
      <div>
        <h2>${escapeHtml(session.date)}${session.run ? ` — ${escapeHtml(session.run)}` : ''}</h2>
        <div class="member-meta">${session.records.length} record${session.records.length === 1 ? '' : 's'} · ${totalQty(session)} total qty</div>
      </div>
    </div>

    <form id="editSessionForm" style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; margin-bottom:20px;">
      <label style="flex:1; min-width:140px;">Date<input type="date" name="date" value="${session.date}" required></label>
      <label style="flex:1; min-width:160px;">Run<input type="text" name="run" value="${escapeHtml(session.run || 'Guild Dungeon')}"></label>
      <button type="submit" class="btn small">Save Changes</button>
      <button type="button" class="btn small danger" id="deleteSessionBtn">Delete Date</button>
    </form>

    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
      <h3 style="margin-bottom:6px;">
        Guild Dungeon Attendance
        <span id="attendanceCount" style="color:var(--text-muted); font-weight:400; font-size:13px;">(${sortedMembers.length - session.absentees.length} / ${sortedMembers.length} present)</span>
      </h3>
      <button type="button" class="btn small" id="copyPresentBtn">Copy Present Names</button>
    </div>
    <p style="color:var(--text-muted); font-size:13px; margin:-4px 0 8px;">Everyone is assumed present — check anyone who was absent.</p>
    <div id="attendanceList" class="attendance-grid">
      ${
        sortedMembers
          .map(
            (m) => `
        <label class="attendance-item" title="${escapeHtml(m.name)}">
          <input type="checkbox" class="absence-check" data-member-id="${m.id}" ${session.absentees.includes(m.id) ? 'checked' : ''}>
          <span>${escapeHtml(m.name)}</span>
        </label>`
          )
          .join('') || '<p style="color:var(--text-muted); grid-column:1/-1;">No members yet.</p>'
      }
    </div>

    <h3 style="margin-bottom:6px;">🎲 Raffle</h3>
    <p style="color:var(--text-muted); font-size:13px; margin:-4px 0 8px;">Picks a random present member. Raffle a smaller quantity at a time to give more people a chance to win.</p>
    <div class="growth-form-row" style="margin-top:0; margin-bottom:20px;">
      <label style="flex:1.5;">Unassigned Loot
        <select id="raffleRecordSelect">${raffleRecordOptionsHtml(raffleEligibleRecords)}</select>
      </label>
      <label style="max-width:120px;">Qty
        <input type="number" id="raffleQtyInput" min="1" step="1" value="1" max="${raffleEligibleRecords[0] ? raffleEligibleRecords[0].quantity : 1}">
      </label>
      <button type="button" class="btn primary small" id="raffleDrawBtn" ${raffleEligibleRecords.length ? '' : 'disabled'}>Draw</button>
    </div>

    <div id="rafflePrintSection">
      <h2 class="print-only">${escapeHtml(session.date)}${session.run ? ` — ${escapeHtml(session.run)}` : ''} — Raffle Results</h2>

      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <h3 class="print-heading-winners" style="margin-bottom:6px;">🏆 Raffle Winners</h3>
        <div class="no-print" style="display:flex; gap:8px;">
          <button type="button" class="btn small" id="printRaffleBtn" style="margin-bottom:6px;">🖨️ Print</button>
          ${
            session.records.some((r) => r.viaRaffle)
              ? '<button type="button" class="btn small danger" id="clearAllWinnersBtn" style="margin-bottom:6px;">Clear All Winners</button>'
              : ''
          }
        </div>
      </div>
      <div class="table-scroll" style="margin-bottom:20px;">
        <table class="growth-table">
          <thead><tr><th>Item</th><th>Winner</th><th class="no-print"></th></tr></thead>
          <tbody id="raffleWinnersBody">${raffleWinnersRowsHtml(session)}</tbody>
        </table>
      </div>

      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <h3 class="print-heading-log" style="margin-bottom:6px;">📜 Raffle Activity Log</h3>
        ${
          session.raffleLog.length
            ? '<button type="button" class="btn small no-print" id="clearRaffleLogBtn" style="margin-bottom:6px;">Clear Log</button>'
            : ''
        }
      </div>
      <div id="raffleLogList" class="raffle-log-list">${raffleLogItemsHtml(session)}</div>
    </div>

    <h3 style="margin-bottom:6px;">Add Loot</h3>

    <form id="addRecordForm" class="growth-form-row">
      <label style="flex:1.5;">Item
        <div class="icon-select" id="addRecordItemDropdown" style="display:block; width:100%;">
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="text" name="item" id="addRecordItemInput" autocomplete="off" required placeholder="e.g. Morion" style="flex:1;">
            <span id="addRecordItemIcon"></span>
          </div>
          <div class="icon-select-menu hidden" id="addRecordItemMenu"></div>
        </div>
      </label>
      <label><span>Recipient <span style="color:var(--text-muted); font-weight:400;">(optional)</span></span>
        <select name="recipientId">
          <option value="" selected>Unassigned</option>
          ${memberOptions}
        </select>
      </label>
      <label style="max-width:120px;">Qty<input type="number" name="quantity" min="1" step="1" value="1"></label>
      <button type="submit" class="btn primary small">Add</button>
    </form>

    <h3>Loot Records</h3>
    <div class="table-scroll">
      <table class="growth-table">
        <thead><tr><th>Item</th><th class="col-right">Qty</th><th>Recipient</th><th></th></tr></thead>
        <tbody>${lootRecordsRows || '<tr><td colspan="4" style="color:var(--text-muted)">No loot logged yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  document.title = `${session.date}${session.run ? ` — ${session.run}` : ''} — Capital Records`;

  content.querySelector('#editSessionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const updated = await api(`/api/loot/${session.id}`, {
        method: 'PUT',
        body: JSON.stringify({ date: fd.get('date'), run: fd.get('run') }),
      });
      Object.assign(session, updated);
      renderSessionContent();
      toast('Date updated');
    } catch (err) {
      toast(err.message);
    }
  });

  content.querySelector('#deleteSessionBtn').addEventListener('click', async () => {
    if (!confirm(`Delete ${session.date} and all its loot records?`)) return;
    await api(`/api/loot/${session.id}`, { method: 'DELETE' });
    window.location.hash = '#/loot';
  });

  content.querySelector('#printRaffleBtn').addEventListener('click', () => {
    document.body.classList.add('printing-raffle');
    window.print();
  });

  content.querySelector('#copyPresentBtn').addEventListener('click', async () => {
    const presentNames = getPresentMembers(session, sortedMembers).map((m) => m.name);
    const text = presentNames.map((name, i) => `${i + 1}. ${name}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${presentNames.length} present name${presentNames.length === 1 ? '' : 's'}`);
    } catch (err) {
      toast('Could not copy — clipboard access denied');
    }
  });

  content.querySelector('#raffleRecordSelect').addEventListener('change', (e) => {
    const record = session.records.find((r) => r.id === e.target.value);
    const qtyInput = document.getElementById('raffleQtyInput');
    const max = record ? record.quantity : 1;
    qtyInput.max = max;
    if (Number(qtyInput.value) > max) qtyInput.value = max;
  });

  content.querySelector('#raffleDrawBtn').addEventListener('click', async () => {
    const recordId = document.getElementById('raffleRecordSelect').value;
    const record = session.records.find((r) => r.id === recordId);
    if (!record) {
      toast('Pick an unassigned loot record to raffle');
      return;
    }
    const qty = Number(document.getElementById('raffleQtyInput').value);
    if (!Number.isFinite(qty) || qty < 1 || qty > record.quantity) {
      toast(`Quantity must be between 1 and ${record.quantity}`);
      return;
    }
    const eligible = getEligibleRaffleMembers(session, sortedMembers);
    if (!eligible.length) {
      toast('No eligible present members left — everyone present has already won something');
      return;
    }
    const winner = eligible[Math.floor(Math.random() * eligible.length)];
    try {
      if (qty === record.quantity) {
        const updated = await api(`/api/loot/${session.id}/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ recipientId: winner.id, viaRaffle: true }),
        });
        Object.assign(record, updated);
      } else {
        const newRecord = await api(`/api/loot/${session.id}/records`, {
          method: 'POST',
          body: JSON.stringify({ recipientId: winner.id, item: record.item, quantity: qty, viaRaffle: true }),
        });
        session.records.push(newRecord);
        const updated = await api(`/api/loot/${session.id}/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ quantity: record.quantity - qty }),
        });
        Object.assign(record, updated);
      }
      try {
        const logEntry = await api(`/api/loot/${session.id}/raffle-log`, {
          method: 'POST',
          body: JSON.stringify({ message: `🏆 ${winner.name} won ${record.item} (x${qty})` }),
        });
        session.raffleLog.push(logEntry);
      } catch (logErr) {
        // non-fatal — the draw itself already succeeded
      }
      renderSessionContent();
      toast(`🏆 ${winner.name} wins ${record.item} (x${qty})!`);
    } catch (err) {
      toast(err.message);
    }
  });

  content.querySelectorAll('[data-remove-raffle-winner]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const recordIds = btn.getAttribute('data-remove-raffle-winner').split(',');
      const records = recordIds.map((id) => session.records.find((r) => r.id === id)).filter(Boolean);
      if (!records.length) return;
      const removedItem = records[0].item;
      const removedQty = records.reduce((sum, r) => sum + Number(r.quantity), 0);
      const removedName = records[0].recipientName;
      for (const record of records) {
        const updated = await api(`/api/loot/${session.id}/records/${record.id}`, {
          method: 'PUT',
          body: JSON.stringify({ recipientId: '' }),
        });
        Object.assign(record, updated);
      }
      try {
        const logEntry = await api(`/api/loot/${session.id}/raffle-log`, {
          method: 'POST',
          body: JSON.stringify({ message: `↩ Removed ${removedName} from ${removedItem} (x${removedQty})` }),
        });
        session.raffleLog.push(logEntry);
      } catch (logErr) {
        // non-fatal
      }
      renderSessionContent();
      toast('Removed from raffle winners — loot is unassigned again');
    });
  });

  const clearAllWinnersBtn = content.querySelector('#clearAllWinnersBtn');
  if (clearAllWinnersBtn) {
    clearAllWinnersBtn.addEventListener('click', async () => {
      const winnerRecords = session.records.filter((r) => r.viaRaffle);
      if (!winnerRecords.length) return;
      if (!confirm(`Clear all ${winnerRecords.length} raffle winner(s)? Their loot will go back to unassigned.`)) return;
      for (const record of winnerRecords) {
        const updated = await api(`/api/loot/${session.id}/records/${record.id}`, {
          method: 'PUT',
          body: JSON.stringify({ recipientId: '' }),
        });
        Object.assign(record, updated);
      }
      try {
        const logEntry = await api(`/api/loot/${session.id}/raffle-log`, {
          method: 'POST',
          body: JSON.stringify({ message: `🧹 Cleared all raffle winners (${winnerRecords.length} item${winnerRecords.length === 1 ? '' : 's'})` }),
        });
        session.raffleLog.push(logEntry);
      } catch (logErr) {
        // non-fatal
      }
      renderSessionContent();
      toast('All raffle winners cleared — loot is unassigned again');
    });
  }

  const clearRaffleLogBtn = content.querySelector('#clearRaffleLogBtn');
  if (clearRaffleLogBtn) {
    clearRaffleLogBtn.addEventListener('click', async () => {
      try {
        await api(`/api/loot/${session.id}/raffle-log`, { method: 'DELETE' });
        session.raffleLog = [];
        renderSessionContent();
        toast('Raffle activity log cleared');
      } catch (err) {
        toast(err.message);
      }
    });
  }

  content.querySelectorAll('.absence-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const memberId = cb.getAttribute('data-member-id');
      const absenteeSet = new Set(session.absentees);
      if (cb.checked) absenteeSet.add(memberId);
      else absenteeSet.delete(memberId);
      const nextAbsentees = Array.from(absenteeSet);
      try {
        const updated = await api(`/api/loot/${session.id}`, {
          method: 'PUT',
          body: JSON.stringify({ absentees: nextAbsentees }),
        });
        session.absentees = updated.absentees;
        document.getElementById('attendanceCount').textContent = `(${sortedMembers.length - session.absentees.length} / ${sortedMembers.length} present)`;
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      }
    });
  });

  wireItemDropdown({ inputId: 'addRecordItemInput', menuId: 'addRecordItemMenu', iconId: 'addRecordItemIcon', iconSize: 32 });

  content.querySelector('#addRecordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const record = await api(`/api/loot/${session.id}/records`, {
        method: 'POST',
        body: JSON.stringify({
          recipientId: fd.get('recipientId'),
          item: fd.get('item'),
          quantity: Number(fd.get('quantity')) || 1,
        }),
      });
      session.records.push(record);
      renderSessionContent();
    } catch (err) {
      toast(err.message);
    }
  });

  content.querySelectorAll('[data-del-record]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const recordId = btn.getAttribute('data-del-record');
      await api(`/api/loot/${session.id}/records/${recordId}`, { method: 'DELETE' });
      session.records = session.records.filter((r) => r.id !== recordId);
      renderSessionContent();
    });
  });

  content.querySelectorAll('[data-toggle-raffle-exclude]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const recordId = btn.getAttribute('data-toggle-raffle-exclude');
      const record = session.records.find((r) => r.id === recordId);
      if (!record) return;
      try {
        const updated = await api(`/api/loot/${session.id}/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ excludedFromRaffle: !record.excludedFromRaffle }),
        });
        Object.assign(record, updated);
        renderSessionContent();
        toast(record.excludedFromRaffle ? 'Excluded from raffle' : 'Included in raffle again');
      } catch (err) {
        toast(err.message);
      }
    });
  });

  content.querySelectorAll('.qty-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const recordId = input.getAttribute('data-record-id');
      const qty = Number(input.value);
      if (!Number.isFinite(qty) || qty < 1) {
        toast('Quantity must be a positive number');
        renderSessionContent();
        return;
      }
      try {
        const updated = await api(`/api/loot/${session.id}/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ quantity: qty }),
        });
        const record = session.records.find((r) => r.id === recordId);
        Object.assign(record, updated);
        renderSessionContent();
        toast('Quantity updated');
      } catch (err) {
        toast(err.message);
        renderSessionContent();
      }
    });
  });

  content.querySelectorAll('[data-multi-assign]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const recordId = btn.getAttribute('data-multi-assign');
      const record = session.records.find((r) => r.id === recordId);
      openMultiAssignModal(session.id, record, sortedMembers);
    });
  });

  content.querySelectorAll('[data-unassign]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const recordId = btn.getAttribute('data-unassign');
      const updated = await api(`/api/loot/${session.id}/records/${recordId}`, {
        method: 'PUT',
        body: JSON.stringify({ recipientId: '' }),
      });
      const record = session.records.find((r) => r.id === recordId);
      Object.assign(record, updated);
      renderSessionContent();
    });
  });
}

// Bound once at script load (not per-render) since the dropdown's DOM is
// rebuilt every time renderSessionContent() runs.
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('addRecordItemDropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    document.getElementById('addRecordItemMenu').classList.add('hidden');
  }
});

window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing-raffle');
});
