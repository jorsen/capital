// Standalone Sovereign / Crusade page — no shared app shell, no hash router
// from router.js. Bare /sovereign shows the crusade list; #<crusadeId> shows
// that crusade's roster + distribution. common.js still supplies
// api()/toast()/escapeHtml()/session handling, which is why it's loaded here.

// mode tracks which crusade-scoped page is active: 'overview' | 'team'.
const sovereignState = { crusades: [], guilds: [], crusadeId: null, crusade: null, participants: [], memberList: [], activeTeam: null, mode: null };

const CRUSADE_RESULT_LABELS = { pending: 'Pending', win: 'Win', lose: 'Lose', draw: 'Draw' };

function crusadeFormatDiamonds(amount) {
  return `${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 💎`;
}

function crusadeFormatGold(amount) {
  return (amount || 0).toLocaleString();
}

function crusadeGuildColor(guildName) {
  const guild = sovereignState.guilds.find((g) => g.name === guildName);
  return guild ? guild.color : null;
}

function crusadeGuildBadge(guildName) {
  if (!guildName) return '–';
  const color = crusadeGuildColor(guildName) || 'var(--text-muted)';
  return `<span class="crusade-guild-badge" style="color:${color}; border-color:${color};">${escapeHtml(guildName)}</span>`;
}

// ---------- Routing between the four panels ----------
// '' -> crusade list, '#members' -> master member list, '#crusade/<id>' ->
// crusade overview (details + team list), '#crusade/<id>/team/<n>' -> one
// team's full records.

function route() {
  const hash = window.location.hash.slice(1);
  const teamMatch = hash.match(/^crusade\/([^/]+)\/team\/(\d+)$/);
  const crusadeMatch = hash.match(/^crusade\/([^/]+)$/);

  if (hash === 'members') {
    sovereignState.mode = null;
    showPanel('members');
    loadMemberList().catch((err) => toast(err.message));
    return;
  }
  if (teamMatch) {
    sovereignState.crusadeId = teamMatch[1];
    sovereignState.activeTeam = Number(teamMatch[2]);
    sovereignState.mode = 'team';
  } else if (crusadeMatch) {
    sovereignState.crusadeId = crusadeMatch[1];
    sovereignState.activeTeam = null;
    sovereignState.mode = 'overview';
  } else {
    sovereignState.mode = null;
    showPanel('list');
    loadCrusadeList().catch((err) => toast(err.message));
    return;
  }
  showPanel(sovereignState.mode === 'overview' ? 'detail' : 'team');
  loadCrusadeDetail(sovereignState.crusadeId).catch((err) => toast(err.message));
}

function showPanel(name) {
  document.getElementById('sovereignListPanel').classList.toggle('hidden', name !== 'list');
  document.getElementById('sovereignDetailPanel').classList.toggle('hidden', name !== 'detail');
  document.getElementById('sovereignTeamPanel').classList.toggle('hidden', name !== 'team');
  document.getElementById('sovereignMembersPanel').classList.toggle('hidden', name !== 'members');
  document.querySelectorAll('#pageNav .nav-link').forEach((a) => a.classList.toggle('active', a.getAttribute('data-panel') === name));
  // 'detail' and 'team' set their own title once their data loads.
  if (name === 'list' || name === 'members') document.title = 'Sovereign — Crusade';
}

document.getElementById('sovereignBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = '';
});

document.getElementById('sovereignTeamBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = `crusade/${sovereignState.crusadeId}`;
});

window.addEventListener('hashchange', route);
sessionReady.then(() => {
  document.getElementById('sovereignLoginLink').classList.toggle('hidden', !!appSession.username);
  document.getElementById('sovereignLogoutBtn').classList.toggle('hidden', !appSession.username);
  route();
});

document.getElementById('sovereignLogoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.reload();
});

// ---------- Crusade list ----------

async function loadCrusadeList() {
  const [crusades, guilds] = await Promise.all([api('/api/crusades'), api('/api/crusade-guilds')]);
  sovereignState.crusades = crusades;
  sovereignState.guilds = guilds;
  renderCrusadeList();
}

function renderCrusadeList() {
  const body = document.getElementById('sovereignCrusadesBody');
  const empty = document.getElementById('sovereignCrusadesEmptyState');
  const crusades = sovereignState.crusades;
  empty.classList.toggle('hidden', crusades.length !== 0);

  body.innerHTML = crusades
    .map(
      (c) => `
    <tr>
      <td><a href="#crusade/${c.id}" style="font-weight:600;">${c.eventDate ? escapeHtml(formatLongDate(String(c.eventDate).slice(0, 10))) : 'No date set'}</a></td>
      <td>${c.participantCount}</td>
      <td>${crusadeFormatDiamonds(c.diamondReward)}</td>
      <td class="admin-only"><button type="button" class="icon-btn" data-delete-crusade="${c.id}" title="Delete crusade">✕</button></td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('[data-delete-crusade]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-crusade');
      const crusade = sovereignState.crusades.find((c) => c.id === id);
      if (!confirm(`Delete crusade "${crusade?.name}"? This also removes its entire roster.`)) return;
      try {
        await api(`/api/crusades/${id}`, { method: 'DELETE' });
        sovereignState.crusades = sovereignState.crusades.filter((c) => c.id !== id);
        renderCrusadeList();
        toast('Crusade deleted');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('addCrusadeBtn').addEventListener('click', () => {
  document.getElementById('addCrusadeForm').reset();
  document.getElementById('addCrusadeModal').classList.remove('hidden');
});

document.getElementById('addCrusadeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const crusade = await api('/api/crusades', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        eventDate: fd.get('eventDate') || null,
        warType: fd.get('warType') || null,
        diamondReward: fd.get('diamondReward') ? Number(fd.get('diamondReward')) : 0,
      }),
    });
    document.getElementById('addCrusadeModal').classList.add('hidden');
    window.location.hash = `crusade/${crusade.id}`;
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Manage Guilds modal ----------

function renderCrusadeGuildList() {
  const list = document.getElementById('crusadeGuildList');
  list.innerHTML = sovereignState.guilds
    .map(
      (g) => `
      <li style="display:flex; gap:8px; align-items:center;" data-guild-id="${g.id}">
        <span class="schedule-dot" style="background:${g.color}"></span>
        <span style="flex:1;">${escapeHtml(g.name)}</span>
        <button type="button" class="icon-btn" data-delete-guild="${g.id}" title="Delete guild">✕</button>
      </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-guild]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-guild');
      const guild = sovereignState.guilds.find((g) => g.id === id);
      if (!confirm(`Remove guild "${guild.name}"? Participants already assigned to it keep showing it.`)) return;
      try {
        await api(`/api/crusade-guilds/${id}`, { method: 'DELETE' });
        sovereignState.guilds = sovereignState.guilds.filter((g) => g.id !== id);
        renderCrusadeGuildList();
        toast('Guild removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('manageCrusadeGuildsBtn').addEventListener('click', () => {
  renderCrusadeGuildList();
  document.getElementById('manageCrusadeGuildsModal').classList.remove('hidden');
});

document.getElementById('addCrusadeGuildForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const guild = await api('/api/crusade-guilds', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), color: fd.get('color') }) });
    sovereignState.guilds.push(guild);
    renderCrusadeGuildList();
    e.target.reset();
    e.target.querySelector('input[name="color"]').value = '#3b82f6';
    toast(`${guild.name} added`);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Crusade detail ----------

async function loadCrusadeDetail(id) {
  const [crusade, guilds] = await Promise.all([api(`/api/crusades/${id}`), api('/api/crusade-guilds')]);
  sovereignState.crusade = crusade;
  sovereignState.participants = crusade.participants;
  sovereignState.guilds = guilds;
  populateCrusadeGuildSelect(); // shared by the add/edit-participant modal regardless of which page opened it

  if (sovereignState.mode === 'team') {
    renderTeamDetail(sovereignState.activeTeam); // sets its own title
  } else {
    document.title = `Sovereign — ${crusade.name}`;
    populateCrusadeSummaryStrip();
    populateCrusadeHeaderForm();
    renderTeamList();
  }
}

// Called after any roster change (add/edit/delete participant, or toggling
// attended/paid) so every place that reflects the roster — the summary
// strip's participant count, the team list's per-team totals, and the
// currently open team's full records — stays in sync, without needing to
// re-render pages that aren't currently visible.
function refreshAfterRosterChange() {
  if (sovereignState.mode === 'team') renderTeamDetail(sovereignState.activeTeam);
  else {
    populateCrusadeSummaryStrip();
    renderTeamList();
  }
}

function nextTeamNumber() {
  return sovereignState.participants.reduce((max, p) => Math.max(max, p.partyNumber), 0) + 1;
}

function populateCrusadeSummaryStrip() {
  const c = sovereignState.crusade;
  document.getElementById('crusadeSummaryName').textContent = c.name || '—';
  document.getElementById('crusadeSummaryDate').textContent = c.eventDate ? formatLongDate(String(c.eventDate).slice(0, 10)) : '—';
  document.getElementById('crusadeSummaryType').textContent = c.warType || '—';
  document.getElementById('crusadeSummaryStance').textContent = c.stance || '—';
  document.getElementById('crusadeSummaryResult').textContent = CRUSADE_RESULT_LABELS[c.result] || c.result || 'Pending';
  document.getElementById('crusadeSummaryParticipants').textContent = sovereignState.participants.length;
  document.getElementById('crusadeSummaryReward').textContent = crusadeFormatDiamonds(c.diamondReward);
}

function populateCrusadeHeaderForm() {
  const form = document.getElementById('crusadeHeaderForm');
  const c = sovereignState.crusade;
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
  select.innerHTML = '<option value="">—</option>' + sovereignState.guilds.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');
  select.value = current;
}

document.getElementById('crusadeHeaderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}`, {
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
    sovereignState.crusade = { ...sovereignState.crusade, ...updated };
    document.title = `Sovereign — ${updated.name}`;
    populateCrusadeSummaryStrip();
    renderTeamList();
    toast('Crusade details saved');
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('deleteCrusadeBtn').addEventListener('click', async () => {
  const c = sovereignState.crusade;
  if (!confirm(`Delete crusade "${c.name}"? This also removes its entire roster.`)) return;
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}`, { method: 'DELETE' });
    toast('Crusade deleted');
    window.location.hash = '';
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Team list (crusade-level) and single-team roster ----------

// Teams 1-3 always show up (clickable, even empty) so there's always
// somewhere to start adding a roster from; any higher team number that
// already has a participant shows up too.
function visibleTeamNumbers() {
  const numbers = new Set(sovereignState.participants.map((p) => p.partyNumber));
  numbers.add(1);
  numbers.add(2);
  numbers.add(3);
  return Array.from(numbers).sort((a, b) => a - b);
}

function renderTeamList() {
  const body = document.getElementById('crusadeTeamListBody');

  const byTeam = new Map();
  computeCrusadeDistribution().forEach(({ participant: p, total }) => {
    if (!byTeam.has(p.partyNumber)) byTeam.set(p.partyNumber, { count: 0, diamonds: 0 });
    const t = byTeam.get(p.partyNumber);
    t.count += 1;
    t.diamonds += total;
  });

  body.innerHTML = visibleTeamNumbers()
    .map((n) => {
      const t = byTeam.get(n) || { count: 0, diamonds: 0 };
      return `
      <tr>
        <td><a href="#crusade/${sovereignState.crusadeId}/team/${n}" style="font-weight:600;">Team ${n}</a></td>
        <td>${t.count}</td>
        <td>${crusadeFormatDiamonds(t.diamonds)}</td>
      </tr>`;
    })
    .join('');
}

// The team's own page shows *all* of its records in one place: roster
// fields plus each person's diamond earnings (still computed from the
// crusade-wide attendance/bid pools, just filtered down to this team) and a
// guild breakdown scoped to this team.
function renderTeamDetail(n) {
  document.getElementById('crusadeTeamHeading').textContent = `Team ${n}`;
  document.title = `Sovereign — ${sovereignState.crusade.name} — Team ${n}`;

  const teamRows = computeCrusadeDistribution().filter(({ participant: p }) => p.partyNumber === n);
  document.getElementById('crusadeTeamRosterEmptyState').classList.toggle('hidden', teamRows.length !== 0);

  const body = document.getElementById('crusadeTeamRosterBody');
  body.innerHTML = teamRows
    .map(
      ({ participant: p, attendanceAmount, bidShare, total }) => `
    <tr>
      <td style="font-weight:600;">${escapeHtml(p.name)}</td>
      <td>${crusadeGuildBadge(p.guildName)}</td>
      <td>${p.position ? escapeHtml(p.position) : '–'}</td>
      <td>${crusadeFormatGold(p.goldBid)}</td>
      <td><input type="checkbox" class="crusade-attended-check admin-disable" data-participant-id="${p.id}" ${p.attended ? 'checked' : ''}></td>
      <td>${crusadeFormatDiamonds(attendanceAmount)}</td>
      <td>${crusadeFormatDiamonds(bidShare)}</td>
      <td style="font-weight:600;">${crusadeFormatDiamonds(total)}</td>
      <td class="admin-only"><input type="checkbox" class="crusade-paid-check admin-disable" data-participant-id="${p.id}" ${p.paid ? 'checked' : ''}></td>
      <td class="admin-only" style="white-space:nowrap;">
        <button type="button" class="icon-btn" data-edit-participant="${p.id}" title="Edit">✎</button>
        <button type="button" class="icon-btn" data-delete-participant="${p.id}" title="Remove">✕</button>
      </td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('.crusade-attended-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleCrusadeParticipantFlag(cb, 'attended'));
  });
  body.querySelectorAll('.crusade-paid-check').forEach((cb) => {
    cb.addEventListener('change', () => toggleCrusadeParticipantFlag(cb, 'paid'));
  });
  body.querySelectorAll('[data-edit-participant]').forEach((btn) => {
    btn.addEventListener('click', () => openCrusadeParticipantModal(btn.getAttribute('data-edit-participant')));
  });
  body.querySelectorAll('[data-delete-participant]').forEach((btn) => {
    btn.addEventListener('click', () => deleteCrusadeParticipant(btn.getAttribute('data-delete-participant')));
  });

  renderCrusadeGuildSummary(teamRows, 'crusadeTeamGuildSummary');
}

async function toggleCrusadeParticipantFlag(checkbox, field) {
  const id = checkbox.getAttribute('data-participant-id');
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}/participants/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ [field]: checkbox.checked }),
    });
    const idx = sovereignState.participants.findIndex((p) => p.id === id);
    if (idx !== -1) sovereignState.participants[idx] = updated;
    refreshAfterRosterChange();
  } catch (err) {
    checkbox.checked = !checkbox.checked;
    toast(err.message);
  }
}

async function deleteCrusadeParticipant(id) {
  const participant = sovereignState.participants.find((p) => p.id === id);
  if (!confirm(`Remove "${participant?.name}" from the roster?`)) return;
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}/participants/${id}`, { method: 'DELETE' });
    sovereignState.participants = sovereignState.participants.filter((p) => p.id !== id);
    refreshAfterRosterChange();
    toast('Participant removed');
  } catch (err) {
    toast(err.message);
  }
}

function openCrusadeParticipantModal(participantId, presetPartyNumber) {
  const form = document.getElementById('crusadeParticipantForm');
  form.reset();
  const participant = participantId ? sovereignState.participants.find((p) => p.id === participantId) : null;
  document.getElementById('crusadeParticipantModalTitle').textContent = participant ? 'Edit Participant' : 'Add Participant';
  form.elements.participantId.value = participant ? participant.id : '';
  form.elements.name.value = participant ? participant.name : '';
  form.elements.guildName.value = participant ? participant.guildName || '' : '';
  form.elements.position.value = participant ? participant.position || '' : '';
  form.elements.partyNumber.value = participant ? participant.partyNumber : presetPartyNumber || nextTeamNumber();
  form.elements.goldBid.value = participant ? participant.goldBid : '';
  form.elements.attended.checked = participant ? participant.attended : true;
  document.getElementById('crusadeParticipantModal').classList.remove('hidden');
}

document.getElementById('addCrusadeParticipantBtn').addEventListener('click', () => openCrusadeParticipantModal(null));
document.getElementById('addTeamParticipantBtn').addEventListener('click', () => openCrusadeParticipantModal(null, sovereignState.activeTeam));

// Jumps straight to the next team past whatever's already visible in the
// list (the 1-3 baseline, or higher if teams already exist beyond that) —
// landing on its (empty) roster page ready for "+ Add Participant".
document.getElementById('addCrusadeTeamBtn').addEventListener('click', () => {
  const nextTeam = Math.max(...visibleTeamNumbers()) + 1;
  window.location.hash = `crusade/${sovereignState.crusadeId}/team/${nextTeam}`;
});

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
      const updated = await api(`/api/crusades/${sovereignState.crusadeId}/participants/${participantId}`, { method: 'PUT', body: JSON.stringify(payload) });
      const idx = sovereignState.participants.findIndex((p) => p.id === participantId);
      if (idx !== -1) sovereignState.participants[idx] = updated;
    } else {
      const created = await api(`/api/crusades/${sovereignState.crusadeId}/participants`, { method: 'POST', body: JSON.stringify(payload) });
      sovereignState.participants.push(created);
    }
    document.getElementById('crusadeParticipantModal').classList.add('hidden');
    refreshAfterRosterChange();
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
  const c = sovereignState.crusade;
  const participants = sovereignState.participants;
  const diamondReward = c ? c.diamondReward || 0 : 0;
  const attendancePct = c ? c.attendancePct ?? 50 : 50;
  const attendancePool = diamondReward * (attendancePct / 100);
  const bidPool = diamondReward - attendancePool;

  const attendees = participants.filter((p) => p.attended);
  const attendanceShare = attendees.length ? attendancePool / attendees.length : 0;
  const totalBid = participants.reduce((sum, p) => sum + (p.goldBid > 0 ? p.goldBid : 0), 0);

  return participants.map((p) => {
    const attendanceAmount = p.attended ? attendanceShare : 0;
    const bidShare = p.goldBid > 0 && totalBid > 0 ? bidPool * (p.goldBid / totalBid) : 0;
    return { participant: p, attendanceAmount, bidShare, total: attendanceAmount + bidShare };
  });
}

function renderCrusadeGuildSummary(rows, containerId) {
  const el = document.getElementById(containerId);
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
      const color = crusadeGuildColor(name) || 'var(--text-muted)';
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

// ---------- Member list (master roster, grouped by guild column) ----------

async function loadMemberList() {
  const [members, guilds] = await Promise.all([api('/api/sovereign-members'), api('/api/crusade-guilds')]);
  sovereignState.memberList = members;
  sovereignState.guilds = guilds;
  renderMemberList();
}

function renderMemberList() {
  const members = sovereignState.memberList;
  document.getElementById('sovereignMemberListEmptyState').classList.toggle('hidden', members.length !== 0);

  const groups = new Map();
  members.forEach((m) => {
    const key = m.guildName || 'Unassigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  groups.forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)));

  // Column order: guilds in the order they were created (Manage Guilds),
  // then any guild name that only shows up via saved members but was since
  // removed from the guild list, then "Unassigned" last.
  const knownOrder = sovereignState.guilds.map((g) => g.name);
  const guildKeys = Array.from(groups.keys()).filter((k) => k !== 'Unassigned');
  guildKeys.sort((a, b) => {
    const ai = knownOrder.indexOf(a);
    const bi = knownOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  if (groups.has('Unassigned')) guildKeys.push('Unassigned');

  const head = document.getElementById('sovereignMemberListHead');
  head.innerHTML = guildKeys
    .map((g) => {
      const color = g === 'Unassigned' ? null : crusadeGuildColor(g);
      return `<th style="${color ? `color:${color};` : ''}">${escapeHtml(g)} <span style="color:var(--text-muted); font-weight:400;">(${groups.get(g).length})</span></th>`;
    })
    .join('');

  const maxRows = guildKeys.reduce((max, g) => Math.max(max, groups.get(g).length), 0);
  const rowsHtml = [];
  for (let i = 0; i < maxRows; i++) {
    const cells = guildKeys
      .map((g) => {
        const m = groups.get(g)[i];
        if (!m) return '<td></td>';
        return `<td>${escapeHtml(m.name)} <button type="button" class="icon-btn admin-only" data-delete-member="${m.id}" title="Remove from member list">✕</button></td>`;
      })
      .join('');
    rowsHtml.push(`<tr>${cells}</tr>`);
  }

  const body = document.getElementById('sovereignMemberListBody');
  body.innerHTML = rowsHtml.join('');
  body.querySelectorAll('[data-delete-member]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-member');
      const member = sovereignState.memberList.find((m) => m.id === id);
      if (!confirm(`Remove "${member?.name}" from the member list?`)) return;
      try {
        await api(`/api/sovereign-members/${id}`, { method: 'DELETE' });
        sovereignState.memberList = sovereignState.memberList.filter((m) => m.id !== id);
        renderMemberList();
        toast('Member removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}
