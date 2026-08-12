const sovereignCrusadeState = { crusadeId: null, crusade: null, participants: [], guilds: [] };

function crusadeDetailGuildColor(guildName) {
  const guild = sovereignCrusadeState.guilds.find((g) => g.name === guildName);
  return guild ? guild.color : null;
}

function crusadeGuildBadge(guildName) {
  if (!guildName) return '–';
  const color = crusadeDetailGuildColor(guildName) || 'var(--text-muted)';
  return `<span class="crusade-guild-badge" style="color:${color}; border-color:${color};">${escapeHtml(guildName)}</span>`;
}

async function loadSovereignCrusadeData(id) {
  if (!id) {
    window.location.hash = '#/sovereign-crusades';
    return;
  }
  sovereignCrusadeState.crusadeId = id;
  const [crusade, guilds] = await Promise.all([api(`/api/crusades/${id}`), api('/api/crusade-guilds')]);
  sovereignCrusadeState.crusade = crusade;
  sovereignCrusadeState.participants = crusade.participants;
  sovereignCrusadeState.guilds = guilds;
  renderCrusadeDetail();
}

function renderCrusadeDetail() {
  populateCrusadeHeaderForm();
  populateCrusadeGuildSelect();
  renderCrusadePartyGrid();
  renderCrusadeDistribution();
}

function populateCrusadeHeaderForm() {
  const form = document.getElementById('crusadeHeaderForm');
  const c = sovereignCrusadeState.crusade;
  form.elements.name.value = c.name || '';
  form.elements.eventDate.value = c.eventDate ? String(c.eventDate).slice(0, 10) : '';
  form.elements.warType.value = c.warType || '';
  form.elements.stance.value = c.stance || '';
  form.elements.area.value = c.area || '';
  form.elements.leader.value = c.leader || '';
  form.elements.result.value = c.result || 'pending';
  form.elements.diamondReward.value = c.diamondReward || 0;
  form.elements.attendancePct.value = c.attendancePct ?? 50;
  form.elements.notes.value = c.notes || '';
}

function populateCrusadeGuildSelect() {
  const select = document.getElementById('crusadeParticipantGuildSelect');
  const current = select.value;
  select.innerHTML = '<option value="">—</option>' + sovereignCrusadeState.guilds.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');
  select.value = current;
}

document.getElementById('crusadeHeaderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const updated = await api(`/api/crusades/${sovereignCrusadeState.crusadeId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: form.elements.name.value,
        eventDate: form.elements.eventDate.value || null,
        warType: form.elements.warType.value || null,
        stance: form.elements.stance.value || null,
        area: form.elements.area.value || null,
        leader: form.elements.leader.value || null,
        result: form.elements.result.value,
        diamondReward: Number(form.elements.diamondReward.value) || 0,
        attendancePct: Number(form.elements.attendancePct.value),
        notes: form.elements.notes.value || null,
      }),
    });
    sovereignCrusadeState.crusade = { ...sovereignCrusadeState.crusade, ...updated };
    document.title = `Crusade — ${updated.name} — Capital Records`;
    renderCrusadeDistribution();
    toast('Crusade details saved');
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('deleteCrusadeBtn').addEventListener('click', async () => {
  const c = sovereignCrusadeState.crusade;
  if (!confirm(`Delete crusade "${c.name}"? This also removes its entire roster.`)) return;
  try {
    await api(`/api/crusades/${sovereignCrusadeState.crusadeId}`, { method: 'DELETE' });
    toast('Crusade deleted');
    window.location.hash = '#/sovereign-crusades';
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Party roster grid ----------

function renderCrusadePartyGrid() {
  const grid = document.getElementById('crusadePartyGrid');
  const participants = sovereignCrusadeState.participants;
  document.getElementById('crusadeRosterEmptyState').classList.toggle('hidden', participants.length !== 0);

  const parties = new Map();
  participants.forEach((p) => {
    if (!parties.has(p.partyNumber)) parties.set(p.partyNumber, []);
    parties.get(p.partyNumber).push(p);
  });
  const partyNumbers = Array.from(parties.keys()).sort((a, b) => a - b);

  grid.innerHTML = partyNumbers
    .map((n) => {
      const rows = parties
        .get(n)
        .map(
          (p) => `
        <tr>
          <td style="font-weight:600;">${escapeHtml(p.name)}</td>
          <td>${crusadeGuildBadge(p.guildName)}</td>
          <td>${p.position ? escapeHtml(p.position) : '–'}</td>
          <td>${crusadeFormatGold(p.goldBid)}</td>
          <td><input type="checkbox" class="crusade-attended-check admin-disable" data-participant-id="${p.id}" ${p.attended ? 'checked' : ''}></td>
          <td class="admin-only" style="white-space:nowrap;">
            <button type="button" class="icon-btn" data-edit-participant="${p.id}" title="Edit">✎</button>
            <button type="button" class="icon-btn" data-delete-participant="${p.id}" title="Remove">✕</button>
          </td>
        </tr>`
        )
        .join('');
      return `
      <div class="crusade-party-card">
        <div class="crusade-party-card-header">
          <h3>Party ${n}</h3>
          <button type="button" class="icon-btn admin-only" data-add-to-party="${n}" title="Add to this party">+</button>
        </div>
        <table class="members-table">
          <thead><tr><th data-i18n="common.name">Name</th><th data-i18n="crusade.thGuild">Guild</th><th data-i18n="crusade.fieldPosition">Position</th><th data-i18n="crusade.fieldGoldBid">Gold</th><th data-i18n="crusade.fieldAttended">Enter</th><th class="admin-only"></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join('');
  applyI18n(grid);

  grid.querySelectorAll('.crusade-attended-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleCrusadeParticipantFlag(cb, 'attended'));
  });
  grid.querySelectorAll('[data-edit-participant]').forEach((btn) => {
    btn.addEventListener('click', () => openCrusadeParticipantModal(btn.getAttribute('data-edit-participant')));
  });
  grid.querySelectorAll('[data-delete-participant]').forEach((btn) => {
    btn.addEventListener('click', () => deleteCrusadeParticipant(btn.getAttribute('data-delete-participant')));
  });
  grid.querySelectorAll('[data-add-to-party]').forEach((btn) => {
    btn.addEventListener('click', () => openCrusadeParticipantModal(null, Number(btn.getAttribute('data-add-to-party'))));
  });
}

async function toggleCrusadeParticipantFlag(checkbox, field) {
  const id = checkbox.getAttribute('data-participant-id');
  try {
    const updated = await api(`/api/crusades/${sovereignCrusadeState.crusadeId}/participants/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ [field]: checkbox.checked }),
    });
    const idx = sovereignCrusadeState.participants.findIndex((p) => p.id === id);
    if (idx !== -1) sovereignCrusadeState.participants[idx] = updated;
    renderCrusadeDistribution();
  } catch (err) {
    checkbox.checked = !checkbox.checked;
    toast(err.message);
  }
}

async function deleteCrusadeParticipant(id) {
  const participant = sovereignCrusadeState.participants.find((p) => p.id === id);
  if (!confirm(`Remove "${participant?.name}" from the roster?`)) return;
  try {
    await api(`/api/crusades/${sovereignCrusadeState.crusadeId}/participants/${id}`, { method: 'DELETE' });
    sovereignCrusadeState.participants = sovereignCrusadeState.participants.filter((p) => p.id !== id);
    renderCrusadePartyGrid();
    renderCrusadeDistribution();
    toast('Participant removed');
  } catch (err) {
    toast(err.message);
  }
}

function openCrusadeParticipantModal(participantId, presetPartyNumber) {
  const form = document.getElementById('crusadeParticipantForm');
  form.reset();
  const participant = participantId ? sovereignCrusadeState.participants.find((p) => p.id === participantId) : null;
  document.getElementById('crusadeParticipantModalTitle').textContent = participant ? 'Edit Participant' : 'Add Participant';
  form.elements.participantId.value = participant ? participant.id : '';
  form.elements.name.value = participant ? participant.name : '';
  form.elements.guildName.value = participant ? participant.guildName || '' : '';
  form.elements.position.value = participant ? participant.position || '' : '';
  form.elements.partyNumber.value = participant ? participant.partyNumber : presetPartyNumber || 1;
  form.elements.goldBid.value = participant ? participant.goldBid : '';
  form.elements.attended.checked = participant ? participant.attended : true;
  document.getElementById('crusadeParticipantModal').classList.remove('hidden');
}

document.getElementById('addCrusadeParticipantBtn').addEventListener('click', () => openCrusadeParticipantModal(null));

document.getElementById('crusadeParticipantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const participantId = form.elements.participantId.value;
  const payload = {
    name: form.elements.name.value,
    guildName: form.elements.guildName.value || null,
    position: form.elements.position.value || null,
    partyNumber: Number(form.elements.partyNumber.value) || 1,
    goldBid: Number(form.elements.goldBid.value) || 0,
    attended: form.elements.attended.checked,
  };
  try {
    if (participantId) {
      const updated = await api(`/api/crusades/${sovereignCrusadeState.crusadeId}/participants/${participantId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const idx = sovereignCrusadeState.participants.findIndex((p) => p.id === participantId);
      if (idx !== -1) sovereignCrusadeState.participants[idx] = updated;
    } else {
      const created = await api(`/api/crusades/${sovereignCrusadeState.crusadeId}/participants`, { method: 'POST', body: JSON.stringify(payload) });
      sovereignCrusadeState.participants.push(created);
    }
    document.getElementById('crusadeParticipantModal').classList.add('hidden');
    renderCrusadePartyGrid();
    renderCrusadeDistribution();
    toast('Roster saved');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Diamond distribution ----------

// Half the reward splits evenly across everyone who attended; the other half
// splits across gold bidders in proportion to their bid — this collapses to
// an equal split when every bidder bids the same amount (the common case),
// and scales fairly when bids differ.
function computeCrusadeDistribution() {
  const c = sovereignCrusadeState.crusade;
  const participants = sovereignCrusadeState.participants;
  const diamondReward = c ? c.diamondReward || 0 : 0;
  const attendancePct = c ? c.attendancePct ?? 50 : 50;
  const attendancePool = diamondReward * (attendancePct / 100);
  const bidPool = diamondReward - attendancePool;

  const attendees = participants.filter((p) => p.attended);
  const attendanceShare = attendees.length ? attendancePool / attendees.length : 0;
  const totalBid = participants.reduce((sum, p) => sum + (p.goldBid > 0 ? p.goldBid : 0), 0);

  const rows = participants.map((p) => {
    const attendanceAmount = p.attended ? attendanceShare : 0;
    const bidShare = p.goldBid > 0 && totalBid > 0 ? bidPool * (p.goldBid / totalBid) : 0;
    return { participant: p, attendanceAmount, bidShare, total: attendanceAmount + bidShare };
  });

  return { rows, attendancePool, bidPool, totalBid, attendeesCount: attendees.length };
}

function renderCrusadeDistribution() {
  const { rows } = computeCrusadeDistribution();
  const body = document.getElementById('crusadeDistributionBody');
  document.getElementById('crusadeDistributionEmptyState').classList.toggle('hidden', rows.length !== 0);

  body.innerHTML = rows
    .map(
      ({ participant: p, attendanceAmount, bidShare, total }) => `
    <tr>
      <td style="font-weight:600;">${escapeHtml(p.name)}</td>
      <td>${crusadeGuildBadge(p.guildName)}</td>
      <td>${crusadeFormatDiamonds(attendanceAmount)}</td>
      <td>${crusadeFormatDiamonds(bidShare)}</td>
      <td style="font-weight:600;">${crusadeFormatDiamonds(total)}</td>
      <td class="admin-only"><input type="checkbox" class="crusade-paid-check admin-disable" data-participant-id="${p.id}" ${p.paid ? 'checked' : ''}></td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('.crusade-paid-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleCrusadeParticipantFlag(cb, 'paid'));
  });

  renderCrusadeGuildSummary(rows);
}

function renderCrusadeGuildSummary(rows) {
  const el = document.getElementById('crusadeGuildSummary');
  const byGuild = new Map();
  rows.forEach(({ participant: p, total }) => {
    const key = p.guildName || 'Unassigned';
    if (!byGuild.has(key)) byGuild.set(key, { total: 0, count: 0 });
    const g = byGuild.get(key);
    g.total += total;
    g.count += 1;
  });

  if (!byGuild.size) {
    el.innerHTML = '';
    return;
  }

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  const items = Array.from(byGuild.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, g]) => {
      const color = crusadeDetailGuildColor(name) || 'var(--text-muted)';
      return `<div class="crusade-guild-summary-row">
        <span class="schedule-dot" style="background:${color}"></span>
        <span style="flex:1;">${escapeHtml(name)}</span>
        <span>${crusadeFormatDiamonds(g.total)}</span>
        <span style="color:var(--text-muted);">${g.count} member${g.count === 1 ? '' : 's'}</span>
      </div>`;
    })
    .join('');

  el.innerHTML = `${items}<div class="crusade-guild-summary-row crusade-guild-summary-total"><span style="flex:1;">Total</span><span>${crusadeFormatDiamonds(grandTotal)}</span><span></span></div>`;
}
