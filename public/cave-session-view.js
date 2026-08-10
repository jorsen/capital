const caveSessionState = { id: null, session: null, members: [], bosses: [] };

function getPresentCaveMembers(session, sortedMembers) {
  return sortedMembers.filter((m) => session.attendees.includes(m.id));
}

function caveSessionFormatMoney(amount) {
  return `₱${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bossNameOptionsHtml(bosses, selectedName) {
  const options = bosses
    .map((b) => `<option value="${escapeHtml(b.name)}" ${b.name === selectedName ? 'selected' : ''}>${escapeHtml(b.name)}</option>`)
    .join('');
  const noMatch = selectedName && !bosses.some((b) => b.name === selectedName)
    ? `<option value="${escapeHtml(selectedName)}" selected>${escapeHtml(selectedName)}</option>`
    : '';
  return `<option value="" ${selectedName ? '' : 'selected'}>Select a boss…</option>${noMatch}${options}`;
}

async function loadCaveSessionData(id) {
  caveSessionState.id = id;
  const content = document.getElementById('caveSessionContent');
  if (!id) {
    content.innerHTML = '<p class="empty-state">No date specified.</p>';
    return;
  }
  content.innerHTML = 'Loading…';
  try {
    const [session, members, bosses] = await Promise.all([
      api(`/api/caves/${id}`),
      api('/api/members'),
      api('/api/boss-timers'),
    ]);
    caveSessionState.session = session;
    caveSessionState.members = members;
    caveSessionState.bosses = bosses;
    renderCaveSessionContent();
  } catch (err) {
    content.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }
}

function renderCaveSessionContent() {
  const session = caveSessionState.session;
  const content = document.getElementById('caveSessionContent');

  // Highest growth rate first in the Attendance checklist — same metric and
  // ordering as the Members table's default sort.
  const sortedMembers = caveSessionState.members.slice().sort((a, b) => {
    const av = latestGrowth(a)?.rate ?? -Infinity;
    const bv = latestGrowth(b)?.rate ?? -Infinity;
    return bv - av;
  });

  const records = session.records.slice().reverse();
  const lootRecordsRows = records
    .map(
      (r) => `
    <tr>
      <td style="font-weight:600;">${itemLabel(r.item)}</td>
      <td class="col-right"><input type="number" class="qty-input admin-disable" data-record-id="${r.id}" value="${r.quantity}" min="1" step="1" style="width:100px; text-align:right;"></td>
      <td class="col-right"><input type="number" class="sold-price-input admin-disable" data-record-id="${r.id}" value="${r.soldPrice}" min="0" step="0.01" style="width:110px; text-align:right;"></td>
      <td class="col-right">${caveSessionFormatMoney(r.quantity * r.soldPrice)}</td>
      <td><input type="text" class="buyer-input admin-disable" data-record-id="${r.id}" value="${escapeHtml(r.buyer || '')}" placeholder="(optional)" style="width:130px;"></td>
      <td class="admin-only">
        <button class="icon-btn" data-del-record="${r.id}" title="Delete record">✕</button>
      </td>
    </tr>`
    )
    .join('');

  const backLink = document.getElementById('caveSessionBackLink');
  backLink.href = `#/cave-date/${session.date}`;
  backLink.textContent = `← Back to ${session.date}`;

  content.innerHTML = `
    <div class="member-header">
      <div>
        <h2>${escapeHtml(session.date)}${session.run ? ` — ${escapeHtml(session.run)}` : ''}</h2>
        <div class="member-meta">${session.records.length} record${session.records.length === 1 ? '' : 's'} · ${totalQty(session)} total qty</div>
      </div>
    </div>

    <form id="editCaveSessionForm" style="display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; margin-bottom:20px;">
      <label style="flex:1; min-width:140px;">Date<input type="date" name="date" value="${session.date}" required></label>
      <label style="flex:1; min-width:160px;">Boss Name<select name="run">${bossNameOptionsHtml(caveSessionState.bosses, session.run)}</select></label>
      <button type="submit" class="btn small admin-only">Save Changes</button>
      <button type="button" class="btn small danger admin-only" id="deleteCaveSessionBtn">Delete Boss Log</button>
    </form>

    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
      <h3 style="margin-bottom:6px;">
        Cave Attendance
        <span id="caveAttendanceCount" style="color:var(--text-muted); font-weight:400; font-size:13px;">(${session.attendees.length} / ${sortedMembers.length} present)</span>
      </h3>
      <button type="button" class="btn small" id="copyCavePresentBtn">Copy Present Names</button>
    </div>
    <p style="color:var(--text-muted); font-size:13px; margin:-4px 0 8px;">Everyone is assumed absent — check anyone who attended.</p>
    <div id="caveAttendanceList" class="attendance-grid">
      ${
        sortedMembers
          .map(
            (m) => `
        <label class="attendance-item" title="${escapeHtml(memberDisplayName(m))}">
          <input type="checkbox" class="attendance-check admin-disable" data-member-id="${m.id}" ${session.attendees.includes(m.id) ? 'checked' : ''}>
          <span>${escapeHtml(memberDisplayName(m))}</span>
        </label>`
          )
          .join('') || '<p style="color:var(--text-muted); grid-column:1/-1;">No members yet.</p>'
      }
    </div>

    <h3 style="margin:20px 0 6px;">Add Loot</h3>

    <form id="addCaveRecordForm" class="growth-form-row admin-only">
      <label style="flex:1.5;">Item
        <div class="icon-select" id="addCaveRecordItemDropdown" style="display:block; width:100%;">
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="text" name="item" id="addCaveRecordItemInput" autocomplete="off" required placeholder="e.g. Morion" style="flex:1;">
            <span id="addCaveRecordItemIcon"></span>
          </div>
          <div class="icon-select-menu hidden" id="addCaveRecordItemMenu"></div>
        </div>
      </label>
      <label style="max-width:120px;">Qty<input type="number" name="quantity" min="1" step="1" value="1"></label>
      <button type="submit" class="btn primary small">Add</button>
    </form>

    <h3>Loot Records</h3>
    <p style="color:var(--text-muted); font-size:13px; margin:-4px 0 8px;">Price × Qty feeds the Loot List and Salary tabs' monthly totals — fill it in once an item actually sells.</p>
    <div id="caveLootRecordsTableWrap" class="table-scroll">
      <table class="growth-table">
        <thead><tr><th>Item</th><th class="col-right">Qty</th><th class="col-right">Price</th><th class="col-right">Total</th><th>Buyer</th><th></th></tr></thead>
        <tbody>${lootRecordsRows || '<tr><td colspan="6" style="color:var(--text-muted)">No loot logged yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  document.title = `${session.date}${session.run ? ` — ${session.run}` : ''} — Capital Records`;

  content.querySelector('#editCaveSessionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const updated = await api(`/api/caves/${session.id}`, {
        method: 'PUT',
        body: JSON.stringify({ date: fd.get('date'), run: fd.get('run') }),
      });
      Object.assign(session, updated);
      renderCaveSessionContent();
      toast('Date updated');
    } catch (err) {
      toast(err.message);
    }
  });

  content.querySelector('#deleteCaveSessionBtn').addEventListener('click', async () => {
    if (!confirm(`Delete ${session.run || 'this boss log'} (${session.date}) and all its loot records?`)) return;
    await api(`/api/caves/${session.id}`, { method: 'DELETE' });
    window.location.hash = `#/cave-date/${session.date}`;
  });

  content.querySelector('#copyCavePresentBtn').addEventListener('click', async () => {
    const presentNames = getPresentCaveMembers(session, sortedMembers).map((m) => memberDisplayName(m));
    const dateLine = `${session.date}${session.run ? ` — ${session.run}` : ''}`;
    const text = [dateLine, ...presentNames.map((name, i) => `${i + 1}. ${name}`)].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${presentNames.length} present name${presentNames.length === 1 ? '' : 's'}`);
    } catch (err) {
      toast('Could not copy — clipboard access denied');
    }
  });

  content.querySelectorAll('.attendance-check').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const memberId = cb.getAttribute('data-member-id');
      const attendeeSet = new Set(session.attendees);
      if (cb.checked) attendeeSet.add(memberId);
      else attendeeSet.delete(memberId);
      const nextAttendees = Array.from(attendeeSet);
      try {
        const updated = await api(`/api/caves/${session.id}`, {
          method: 'PUT',
          body: JSON.stringify({ attendees: nextAttendees }),
        });
        session.attendees = updated.attendees;
        document.getElementById('caveAttendanceCount').textContent = `(${session.attendees.length} / ${sortedMembers.length} present)`;
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      }
    });
  });

  wireItemDropdown({ inputId: 'addCaveRecordItemInput', menuId: 'addCaveRecordItemMenu', iconId: 'addCaveRecordItemIcon', iconSize: 32 });

  content.querySelector('#addCaveRecordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const record = await api(`/api/caves/${session.id}/records`, {
        method: 'POST',
        body: JSON.stringify({
          item: fd.get('item'),
          quantity: Number(fd.get('quantity')) || 1,
        }),
      });
      session.records.push(record);
      renderCaveSessionContent();
    } catch (err) {
      toast(err.message);
    }
  });

  content.querySelectorAll('[data-del-record]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const recordId = btn.getAttribute('data-del-record');
      await api(`/api/caves/${session.id}/records/${recordId}`, { method: 'DELETE' });
      session.records = session.records.filter((r) => r.id !== recordId);
      renderCaveSessionContent();
    });
  });

  content.querySelectorAll('.qty-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const recordId = input.getAttribute('data-record-id');
      const qty = Number(input.value);
      if (!Number.isFinite(qty) || qty < 1) {
        toast('Quantity must be a positive number');
        renderCaveSessionContent();
        return;
      }
      try {
        const updated = await api(`/api/caves/${session.id}/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ quantity: qty }),
        });
        const record = session.records.find((r) => r.id === recordId);
        Object.assign(record, updated);
        renderCaveSessionContent();
        toast('Quantity updated');
      } catch (err) {
        toast(err.message);
        renderCaveSessionContent();
      }
    });
  });

  content.querySelectorAll('.sold-price-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const recordId = input.getAttribute('data-record-id');
      const price = Number(input.value);
      if (!Number.isFinite(price) || price < 0) {
        toast('Sold price must be zero or a positive number');
        renderCaveSessionContent();
        return;
      }
      try {
        const updated = await api(`/api/caves/${session.id}/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ soldPrice: price }),
        });
        const record = session.records.find((r) => r.id === recordId);
        Object.assign(record, updated);
        renderCaveSessionContent();
        toast('Sold price updated');
      } catch (err) {
        toast(err.message);
        renderCaveSessionContent();
      }
    });
  });

  content.querySelectorAll('.buyer-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const recordId = input.getAttribute('data-record-id');
      try {
        const updated = await api(`/api/caves/${session.id}/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ buyer: input.value }),
        });
        const record = session.records.find((r) => r.id === recordId);
        Object.assign(record, updated);
      } catch (err) {
        toast(err.message);
        renderCaveSessionContent();
      }
    });
  });
}

// Bound once at script load (not per-render) since the dropdown's DOM is
// rebuilt every time renderCaveSessionContent() runs.
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('addCaveRecordItemDropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    document.getElementById('addCaveRecordItemMenu').classList.add('hidden');
  }
});
