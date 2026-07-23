const sessionState = { id: null, session: null, members: [] };

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
  const assignedRecords = allRecords.filter((r) => r.recipientId);

  const unassignedRows = unassignedRecords
    .map((r) => {
      const recipientOptions = sortedMembers
        .map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`)
        .join('');
      return `
      <tr>
        <td style="font-weight:600;">${escapeHtml(r.item)}</td>
        <td class="col-right">${r.quantity}</td>
        <td style="color:var(--text-muted); font-size:13px;">${escapeHtml(r.notes)}</td>
        <td>
          <select class="recipient-select" data-record-id="${r.id}" style="width:100%;">
            <option value="" selected>Assign to…</option>
            ${recipientOptions}
          </select>
        </td>
        <td><button class="icon-btn" data-del-record="${r.id}" title="Delete record">✕</button></td>
      </tr>`;
    })
    .join('');

  const assignedRows = assignedRecords
    .map(
      (r) => `
      <tr>
        <td style="font-weight:600;">${escapeHtml(r.item)}</td>
        <td class="col-right">${r.quantity}</td>
        <td>${escapeHtml(r.recipientName)}</td>
        <td>
          <button class="icon-btn" data-unassign="${r.id}" title="Unassign">↩</button>
          <button class="icon-btn" data-del-record="${r.id}" title="Delete record">✕</button>
        </td>
      </tr>`
    )
    .join('');

  content.innerHTML = `
    <div class="member-header">
      <div>
        <h2>${escapeHtml(session.date)}${session.run ? ` — ${escapeHtml(session.run)}` : ''}</h2>
        <div class="member-meta">${session.records.length} record${session.records.length === 1 ? '' : 's'} · ${totalQty(session)} total qty</div>
      </div>
    </div>

    <form id="editSessionForm" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px;">
      <label style="flex:1; min-width:140px;">Date<input type="date" name="date" value="${session.date}" required></label>
      <label style="flex:1; min-width:160px;">Run<input type="text" name="run" value="${escapeHtml(session.run)}"></label>
      <label style="flex-basis:100%;">Notes<textarea name="notes" rows="2">${escapeHtml(session.notes)}</textarea></label>
      <button type="submit" class="btn small">Save Changes</button>
      <button type="button" class="btn small danger" id="deleteSessionBtn">Delete Date</button>
    </form>

    <h3 style="margin-bottom:6px;">Add Loot</h3>

    <form id="addRecordForm" class="growth-form-row">
      <label style="flex:1.5;">Item<input type="text" name="item" list="itemCategoriesList" required placeholder="e.g. Morion"></label>
      <label>Recipient <span style="color:var(--text-muted); font-weight:400;">(optional)</span>
        <select name="recipientId">
          <option value="" selected>Unassigned</option>
          ${memberOptions}
        </select>
      </label>
      <label style="max-width:80px;">Qty<input type="number" name="quantity" min="1" step="1" value="1"></label>
      <label>Note<input type="text" name="notes" placeholder="optional"></label>
      <button type="submit" class="btn primary small">Add</button>
    </form>

    <div class="loot-columns">
      <div class="loot-column">
        <h3>Loot Records</h3>
        <table class="growth-table">
          <thead><tr><th>Item</th><th class="col-right">Qty</th><th>Note</th><th>Assign to</th><th></th></tr></thead>
          <tbody>${unassignedRows || '<tr><td colspan="5" style="color:var(--text-muted)">No unassigned loot.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="loot-column">
        <h3>Assigned Loot</h3>
        <table class="growth-table">
          <thead><tr><th>Item</th><th class="col-right">Qty</th><th>Recipient</th><th></th></tr></thead>
          <tbody>${assignedRows || '<tr><td colspan="4" style="color:var(--text-muted)">Nothing assigned yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;

  document.title = `${session.date}${session.run ? ` — ${session.run}` : ''} — Capital Records`;

  content.querySelector('#editSessionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const updated = await api(`/api/loot/${session.id}`, {
        method: 'PUT',
        body: JSON.stringify({ date: fd.get('date'), run: fd.get('run'), notes: fd.get('notes') }),
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
          notes: fd.get('notes'),
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

  content.querySelectorAll('.recipient-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const recordId = sel.getAttribute('data-record-id');
      try {
        const updated = await api(`/api/loot/${session.id}/records/${recordId}`, {
          method: 'PUT',
          body: JSON.stringify({ recipientId: sel.value }),
        });
        const record = session.records.find((r) => r.id === recordId);
        Object.assign(record, updated);
        toast(`Assigned to ${updated.recipientName}`);
        renderSessionContent();
      } catch (err) {
        toast(err.message);
        renderSessionContent();
      }
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
