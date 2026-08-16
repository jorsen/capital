// Standalone Sovereign / Crusade page — no shared app shell, no hash router
// from router.js. Bare /sovereign shows the crusade list; #<crusadeId> shows
// that crusade's roster + distribution. common.js still supplies
// api()/toast()/escapeHtml()/session handling, which is why it's loaded here.

// A crusade is just the shared date/event container (name + date); every
// team on it is its own independent battle with its own war type, stance,
// result, diamond reward, attendance %, notes, items and fees -- so two
// teams sharing a crusade's date can have completely different outcomes.
// mode tracks which crusade-scoped page is active: 'overview' | 'team' | 'guildSalary'.
const sovereignState = { crusades: [], guilds: [], crusadeId: null, crusade: null, participants: [], teams: [], memberList: [], defaultFees: [], raffleWinners: [], raffleActivity: [], activeTeam: null, mode: null };

function crusadeFormatDiamonds(amount) {
  return `${Math.round(amount || 0).toLocaleString()} 💎`;
}

function crusadeFormatGold(amount) {
  return (amount || 0).toLocaleString();
}

function crusadeFormatItemQty(amount) {
  return `${Math.round(amount || 0).toLocaleString()} pcs`;
}

function crusadeGuildColor(guildName) {
  const guild = sovereignState.guilds.find((g) => g.name === guildName);
  return guild ? guild.color : null;
}

// Kept in sync with CRUSADE_PARTY_MAX_MEMBERS server-side (lib/app.js) — this
// copy only drives the UI hint (disabling a full party's "+" button); the
// server is what actually enforces the cap.
const CRUSADE_PARTY_MAX_MEMBERS = 5;

// Kept in sync with the Item Name dropdown in the Add Item form (index.html)
// -- the fixed set of items the Crusade Salary summary always shows one
// column for, regardless of which of them any given team actually used.
const CRUSADE_SUMMARY_ITEM_NAMES = ['Morions', 'Guild Coins', 'Alluvial Gold Pouch'];

// pending/win/lose/draw -> a small colored pill, reused on the Team List
// overview (one per row) and each team's own page (next to its heading), so
// the outcome is visible at a glance without opening Team Details.
function crusadeStatusLabel(result) {
  const value = result || 'pending';
  return { value, label: value.charAt(0).toUpperCase() + value.slice(1) };
}

function crusadeStatusBadge(result) {
  const { value, label } = crusadeStatusLabel(result);
  return `<span class="crusade-status-badge ${escapeHtml(value)}">${escapeHtml(label)}</span>`;
}

function crusadeGuildBadge(guildName) {
  if (!guildName) return '–';
  const color = crusadeGuildColor(guildName) || 'var(--text-muted)';
  return `<span class="crusade-guild-badge" style="color:${color}; border-color:${color};">${escapeHtml(guildName)}</span>`;
}

// A team that's never been saved doesn't have a row on the server yet --
// this fills in the same defaults the backend would apply once it's first
// saved, so opening a brand-new team shows a sensible blank slate instead of
// an error.
function defaultTeamData(teamNumber) {
  return {
    id: null,
    teamNumber,
    warType: '',
    stance: '',
    area: '',
    leader: '',
    result: 'pending',
    diamondReward: 0,
    attendancePct: 50,
    notes: '',
    items: [],
    fees: [],
    lastTeam: null,
    lastTeamBidders: [],
  };
}

function getTeamData(teamNumber) {
  return sovereignState.teams.find((t) => t.teamNumber === teamNumber) || defaultTeamData(teamNumber);
}

// ---------- Routing between the four panels ----------
// '' -> crusade list, '#members' -> master member list, '#crusade/<id>' ->
// crusade overview (details + team list), '#crusade/<id>/team/<n>' -> one
// team's full records.

function route() {
  const hash = window.location.hash.slice(1);
  const teamMatch = hash.match(/^crusade\/([^/]+)\/team\/(\d+)$/);
  const guildSalaryMatch = hash.match(/^crusade\/([^/]+)\/guild-salary$/);
  const crusadeMatch = hash.match(/^crusade\/([^/]+)$/);

  if (hash === 'members') {
    sovereignState.mode = null;
    showPanel('members');
    loadMemberList().catch((err) => toast(err.message));
    return;
  }
  if (hash === 'raffle') {
    sovereignState.mode = null;
    showPanel('raffle');
    loadRaffle().catch((err) => toast(err.message));
    return;
  }
  if (teamMatch) {
    sovereignState.crusadeId = teamMatch[1];
    sovereignState.activeTeam = Number(teamMatch[2]);
    sovereignState.mode = 'team';
  } else if (guildSalaryMatch) {
    sovereignState.crusadeId = guildSalaryMatch[1];
    sovereignState.activeTeam = null;
    sovereignState.mode = 'guildSalary';
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
  showPanel(sovereignState.mode === 'overview' ? 'detail' : sovereignState.mode === 'guildSalary' ? 'guildSalary' : 'team');
  loadCrusadeDetail(sovereignState.crusadeId).catch((err) => toast(err.message));
}

function showPanel(name) {
  document.getElementById('sovereignListPanel').classList.toggle('hidden', name !== 'list');
  document.getElementById('sovereignDetailPanel').classList.toggle('hidden', name !== 'detail');
  document.getElementById('sovereignGuildSalaryPanel').classList.toggle('hidden', name !== 'guildSalary');
  document.getElementById('sovereignTeamPanel').classList.toggle('hidden', name !== 'team');
  document.getElementById('sovereignMembersPanel').classList.toggle('hidden', name !== 'members');
  document.getElementById('sovereignRafflePanel').classList.toggle('hidden', name !== 'raffle');
  document.querySelectorAll('#pageNav .nav-link').forEach((a) => a.classList.toggle('active', a.getAttribute('data-panel') === name));
  // 'detail', 'guildSalary' and 'team' set their own title once their data loads.
  if (name === 'list' || name === 'members' || name === 'raffle') document.title = 'Sovereign — Crusade';
}

document.getElementById('sovereignBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = '';
});

document.getElementById('viewGuildSalaryLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = `crusade/${sovereignState.crusadeId}/guild-salary`;
});

document.getElementById('sovereignGuildSalaryBackLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.hash = `crusade/${sovereignState.crusadeId}`;
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

  const rows = crusades.map(
    (c, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><a href="#crusade/${c.id}" style="font-weight:600;">${c.eventDate ? escapeHtml(formatLongDate(String(c.eventDate).slice(0, 10))) : 'No date set'}</a></td>
      <td>${c.participantCount}</td>
      <td>${crusadeFormatDiamonds(c.feeDiamonds)}</td>
      <td>${crusadeFormatDiamonds(c.netDiamondReward)}</td>
      <td class="admin-only"><button type="button" class="icon-btn" data-delete-crusade="${c.id}" title="Delete crusade">✕</button></td>
    </tr>`
  );

  // Grand total across every crusade -- same columns, no per-row actions.
  const totalRow = crusades.length
    ? `<tr class="crusade-table-total-row"><td></td><td>Total</td><td>${crusades.reduce(
        (sum, c) => sum + c.participantCount,
        0
      )}</td><td>${crusadeFormatDiamonds(crusades.reduce((sum, c) => sum + c.feeDiamonds, 0))}</td><td>${crusadeFormatDiamonds(
        crusades.reduce((sum, c) => sum + c.netDiamondReward, 0)
      )}</td><td class="admin-only"></td></tr>`
    : '';

  body.innerHTML = rows.join('') + totalRow;

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

// ---------- Manage Default Fees modal ----------
// A standing list of fee recipients (independent of any one crusade/team)
// that gets copied onto crusade_fees automatically the first time a brand
// new team is saved (see ensureCrusadeTeam server-side) -- editing this list
// only ever affects teams created afterward.

function renderCrusadeDefaultFeeList() {
  const list = document.getElementById('crusadeDefaultFeeList');
  const fees = sovereignState.defaultFees;
  document.getElementById('crusadeDefaultFeeListEmptyState').classList.toggle('hidden', fees.length !== 0);

  list.innerHTML = fees
    .map(
      (fee) => `
      <li style="display:flex; gap:8px; align-items:center;" data-default-fee-id="${fee.id}">
        <span style="flex:1; font-weight:600;">${escapeHtml(fee.name)}</span>
        ${crusadeGuildBadge(fee.guildName)}
        <span style="color:var(--text-muted);">${fee.percent}%</span>
        <button type="button" class="icon-btn" data-delete-default-fee="${fee.id}" title="Remove default fee">✕</button>
      </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-default-fee]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-default-fee');
      const fee = fees.find((f) => f.id === id);
      if (!confirm(`Remove the standing ${fee?.percent}% default fee for "${fee?.name}"? New teams created from now on won't include it.`)) return;
      try {
        await api(`/api/crusade-default-fees/${id}`, { method: 'DELETE' });
        sovereignState.defaultFees = sovereignState.defaultFees.filter((f) => f.id !== id);
        renderCrusadeDefaultFeeList();
        toast('Default fee removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('manageCrusadeDefaultFeesBtn').addEventListener('click', () => {
  renderCrusadeDefaultFeeList();
  document.getElementById('manageCrusadeDefaultFeesModal').classList.remove('hidden');
});

document.querySelector('#addCrusadeDefaultFeeForm input[name="name"]').addEventListener('input', (e) => {
  const guildSelect = document.getElementById('crusadeDefaultFeeGuildSelect');
  if (guildSelect.value) return;
  const match = sovereignState.memberList.find((m) => m.name.trim().toLowerCase() === e.target.value.trim().toLowerCase());
  if (match && match.guildName) guildSelect.value = match.guildName;
});

document.getElementById('addCrusadeDefaultFeeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const fee = await api('/api/crusade-default-fees', {
      method: 'POST',
      body: JSON.stringify({
        name: form.elements.name.value,
        guildName: form.elements.guildName.value || null,
        percent: Number(form.elements.percent.value) || 0,
      }),
    });
    sovereignState.defaultFees.push(fee);
    renderCrusadeDefaultFeeList();
    form.reset();
    toast(`${fee.name}'s default fee added`);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Crusade detail ----------

async function loadCrusadeDetail(id) {
  const [crusade, guilds, memberList, defaultFees] = await Promise.all([
    api(`/api/crusades/${id}`),
    api('/api/crusade-guilds'),
    api('/api/sovereign-members'),
    api('/api/crusade-default-fees'),
  ]);
  sovereignState.crusade = crusade;
  sovereignState.participants = crusade.participants;
  sovereignState.teams = crusade.teams;
  sovereignState.guilds = guilds;
  sovereignState.memberList = memberList;
  sovereignState.defaultFees = defaultFees;
  populateCrusadeGuildSelect(); // shared by the add/edit-participant modal regardless of which page opened it
  populateSovereignMemberSuggestions(); // lets the participant modal's Name field search the master member list
  populateCrusadeInfoForm();

  if (sovereignState.mode === 'team') {
    populateTeamDetailsForm(sovereignState.activeTeam);
    renderTeamDetail(sovereignState.activeTeam); // sets its own title
  } else if (sovereignState.mode === 'guildSalary') {
    document.title = `Sovereign — ${crusade.name} — Crusade Salary`;
    renderCrusadeGuildSalary();
  } else {
    document.title = `Sovereign — ${crusade.name}`;
    renderTeamList();
  }
}

// Called after any roster change (add/edit/delete participant, or toggling
// attended/paid) so every place that reflects the roster — the team list's
// per-team totals and the currently open team's full records — stays in
// sync, without needing to re-render pages that aren't currently visible.
function refreshAfterRosterChange() {
  if (sovereignState.mode === 'team') renderTeamDetail(sovereignState.activeTeam);
  else if (sovereignState.mode === 'guildSalary') renderCrusadeGuildSalary();
  else renderTeamList();
}

function nextTeamNumber() {
  return sovereignState.participants.reduce((max, p) => Math.max(max, p.partyNumber), 0) + 1;
}

// First party slot (starting at 1) within the given team that isn't already
// at the 5-member cap — used to default the Party field when adding someone
// new, so admins don't have to hunt for room manually.
function nextAvailablePartySlot(teamNumber) {
  const counts = new Map();
  sovereignState.participants
    .filter((p) => p.partyNumber === teamNumber)
    .forEach((p) => counts.set(p.partySlot, (counts.get(p.partySlot) || 0) + 1));
  let slot = 1;
  while ((counts.get(slot) || 0) >= CRUSADE_PARTY_MAX_MEMBERS) slot++;
  return slot;
}

// Name + Date only -- shared by every team on this crusade.
function populateCrusadeInfoForm() {
  const form = document.getElementById('crusadeInfoForm');
  const c = sovereignState.crusade;
  form.elements.name.value = c.name || '';
  form.elements.eventDate.value = c.eventDate ? String(c.eventDate).slice(0, 10) : '';
}

// Everything else -- war type, stance, result, diamond reward, attendance %,
// notes -- lives on the active team, independent of every other team.
function populateTeamDetailsForm(teamNumber) {
  const form = document.getElementById('teamDetailsForm');
  const t = getTeamData(teamNumber);
  form.elements.warType.value = t.warType || '';
  form.elements.stance.value = t.stance || '';
  form.elements.area.value = t.area || '';
  form.elements.leader.value = t.leader || '';
  form.elements.result.value = t.result || 'pending';
  form.elements.diamondReward.value = t.diamondReward || 0;
  form.elements.attendancePct.value = t.attendancePct ?? 50;
  form.elements.notes.value = t.notes || '';
  updateTeamDetailsStanceUI(form.elements.stance.value);
}

// No bidding while defending, so the Attendance Share % field (which only
// exists to split a pool between attendance and bid) is meaningless for a
// Defense team -- hide it rather than leave a control that does nothing.
function updateTeamDetailsStanceUI(stance) {
  document.querySelector('.crusade-attendance-pct-field').classList.toggle('hidden', stance === 'Defense');
}

document.querySelector('#teamDetailsForm select[name="stance"]').addEventListener('change', (e) => {
  updateTeamDetailsStanceUI(e.target.value);
});

function populateCrusadeGuildSelect() {
  const options = '<option value="">—</option>' + sovereignState.guilds.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');
  ['crusadeParticipantGuildSelect', 'crusadeFeeGuildSelect', 'crusadeDefaultFeeGuildSelect'].forEach((id) => {
    const select = document.getElementById(id);
    const current = select.value;
    select.innerHTML = options;
    select.value = current;
  });
}

// Lets the Add/Edit Participant modal's Name field search everyone ever
// saved into a crusade roster (the master Member List), instead of typing a
// fresh name every time.
function populateSovereignMemberSuggestions() {
  document.getElementById('sovereignMemberSuggestions').innerHTML = sovereignState.memberList
    .map((m) => `<option value="${escapeHtml(m.name)}">`)
    .join('');
}

// Picking (or typing) a name that matches a known member auto-fills their
// last-known guild and position -- only when each field is still blank, so
// it never clobbers a guild/position the admin already chose on purpose.
document.querySelector('#crusadeParticipantForm input[name="name"]').addEventListener('input', (e) => {
  const guildSelect = document.getElementById('crusadeParticipantGuildSelect');
  const positionInput = document.querySelector('#crusadeParticipantForm input[name="position"]');
  const match = sovereignState.memberList.find((m) => m.name.trim().toLowerCase() === e.target.value.trim().toLowerCase());
  if (!match) return;
  if (!guildSelect.value && match.guildName) guildSelect.value = match.guildName;
  if (!positionInput.value && match.position) positionInput.value = match.position;
});

// Same search-and-auto-fill-guild behavior for the Management Fee IGN field.
document.querySelector('#addCrusadeFeeForm input[name="name"]').addEventListener('input', (e) => {
  const guildSelect = document.getElementById('crusadeFeeGuildSelect');
  if (guildSelect.value) return;
  const match = sovereignState.memberList.find((m) => m.name.trim().toLowerCase() === e.target.value.trim().toLowerCase());
  if (match && match.guildName) guildSelect.value = match.guildName;
});

document.getElementById('crusadeInfoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: form.elements.name.value,
        eventDate: form.elements.eventDate.value || null,
      }),
    });
    sovereignState.crusade = { ...sovereignState.crusade, ...updated };
    document.title = sovereignState.mode === 'team' ? `Sovereign — ${updated.name} — Team ${sovereignState.activeTeam}` : `Sovereign — ${updated.name}`;
    toast('Crusade info saved');
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('teamDetailsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const teamNumber = sovereignState.activeTeam;
  try {
    const updated = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${teamNumber}`, {
      method: 'PUT',
      body: JSON.stringify({
        warType: form.elements.warType.value || null,
        stance: form.elements.stance.value || null,
        area: form.elements.area.value || null,
        leader: form.elements.leader.value || null,
        result: form.elements.result.value,
        diamondReward: Number(form.elements.diamondReward.value) || 0,
        attendancePct: Number(form.elements.attendancePct.value),
      }),
    });
    // The team may not have existed server-side until this save -- refetch
    // its full detail (items/fees/lastTeam) rather than patching in place.
    const crusade = await api(`/api/crusades/${sovereignState.crusadeId}`);
    sovereignState.teams = crusade.teams;
    renderTeamDetail(teamNumber); // diamond math depends on reward/attendance %, so recompute
    toast('Team details saved');
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

document.getElementById('deleteTeamBtn').addEventListener('click', async () => {
  const n = sovereignState.activeTeam;
  const count = sovereignState.participants.filter((p) => p.partyNumber === n).length;
  if (!confirm(`Delete Team ${n}? This removes its ${count} participant${count === 1 ? '' : 's'} and all of its items, fees, and details.`)) return;
  try {
    await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}`, { method: 'DELETE' });
    sovereignState.participants = sovereignState.participants.filter((p) => p.partyNumber !== n);
    sovereignState.teams = sovereignState.teams.filter((t) => t.teamNumber !== n);
    toast(`Team ${n} deleted`);
    window.location.hash = `crusade/${sovereignState.crusadeId}`;
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Team list (crusade-level) and single-team roster ----------

// Only team numbers that actually have a participant or a saved Team
// Details/items/fees row show up -- so deleting a team makes it disappear
// entirely instead of reverting to an empty "Pending" placeholder. A
// brand-new crusade with nothing on it yet still shows "Team 1" so there's
// always somewhere to start.
function visibleTeamNumbers() {
  const numbers = new Set(sovereignState.participants.map((p) => p.partyNumber));
  sovereignState.teams.forEach((t) => numbers.add(t.teamNumber));
  const sorted = Array.from(numbers).sort((a, b) => a - b);
  return sorted.length ? sorted : [1];
}

function renderTeamList() {
  const body = document.getElementById('crusadeTeamListBody');

  body.innerHTML = visibleTeamNumbers()
    .map((n, i) => {
      const team = getTeamData(n);
      const rows = computeTeamDistribution(n);
      const count = sovereignState.participants.filter((p) => p.partyNumber === n).length;
      const diamonds = rows.reduce((sum, r) => sum + r.total, 0);
      return `
      <tr>
        <td>${i + 1}</td>
        <td><a href="#crusade/${sovereignState.crusadeId}/team/${n}" style="font-weight:600;">Team ${n}</a></td>
        <td>${crusadeStatusBadge(team.result)}</td>
        <td>${team.stance ? escapeHtml(team.stance) : '–'}</td>
        <td>${count}</td>
        <td>${crusadeFormatDiamonds(diamonds)}</td>
      </tr>`;
    })
    .join('');
}

// Every team number known on this crusade, whether it already has a saved
// Team Details row or is still just a baseline/participant-only number.
function allKnownTeamNumbers() {
  return visibleTeamNumbers();
}

// Every player's accumulated totals across EVERY team on this crusade,
// categorized by guild -- one row per player (matched case-insensitively by
// name), not one row per team, so someone who fought on three teams shows
// up once with everything summed instead of three near-identical rows.
function computeCrusadeGuildSalaryDetail() {
  const byGuild = new Map(); // guildName -> Map(nameKey -> entry)

  function ensureEntry(guildKey, nameKey, displayName) {
    if (!byGuild.has(guildKey)) byGuild.set(guildKey, new Map());
    const players = byGuild.get(guildKey);
    if (!players.has(nameKey)) {
      players.set(nameKey, {
        name: displayName,
        isParticipant: false, // true once seen on an actual roster (controls Max Bid/Present display)
        maxBid: 0,
        hasAttackTeam: false, // true once seen on a non-Defense team -- distinguishes "never bid" (0) from "never had the option" (all Defense)
        present: 0,
        teamsCount: 0,
        salary: 0,
        feePercent: 0,
        feeAmount: 0,
        bonusShare: 0,
        itemTotals: Object.fromEntries(CRUSADE_SUMMARY_ITEM_NAMES.map((name) => [name, 0])),
      });
    }
    return players.get(nameKey);
  }

  allKnownTeamNumbers().forEach((n) => {
    const team = getTeamData(n);
    const isDefense = isDefenseStance(team);

    computeTeamDistribution(n).forEach(({ participant: p, total }) => {
      const entry = ensureEntry(p.guildName || 'Unassigned', p.name.trim().toLowerCase(), p.name);
      entry.isParticipant = true;
      entry.teamsCount += 1;
      entry.present += p.attended ? 1 : 0;
      if (!isDefense) {
        entry.hasAttackTeam = true;
        if (p.goldBid > 0) entry.maxBid = Math.max(entry.maxBid, p.goldBid);
      }
      entry.salary += total;
    });

    (team.items || []).forEach((item) => {
      if (!CRUSADE_SUMMARY_ITEM_NAMES.includes(item.name)) return; // custom/unknown item name -- no fixed column for it
      computeTeamItemShares(n, item).forEach(({ participant: p, total }) => {
        const entry = ensureEntry(p.guildName || 'Unassigned', p.name.trim().toLowerCase(), p.name);
        entry.itemTotals[item.name] += total;
      });
    });

    // Management fees fold into a matching roster row by name (case-
    // insensitive), kept in their own Fee %/Fee Amount fields rather than
    // mixed into Salary -- a recurring 2.5% fee applied across 3 fights
    // this crusade shows as a combined 7.5% and its total diamond amount,
    // not three separate numbers. A fee with no guild picked falls back to
    // "Unassigned" (same as participants/bonus bidders below) instead of
    // being silently dropped from the total. If there's no matching roster
    // row (on any team), the fee just gets its own fee-only entry
    // (isParticipant stays false, decided once every team has been
    // processed).
    (team.fees || []).forEach((fee) => {
      const entry = ensureEntry(fee.guildName || 'Unassigned', fee.name.trim().toLowerCase(), fee.name);
      entry.feePercent += Number(fee.percent) || 0;
      entry.feeAmount += crusadeFeeAmount(fee, team);
    });

    // Defense-win bonus, credited by name/guild to whoever bid gold on the
    // team this one inherited its bonus from -- regardless of whether
    // they're on THIS team's (or any team's) roster at all.
    const { perBidder } = computeTeamBonusShares(n);
    if (perBidder > 0) {
      (team.lastTeamBidders || []).forEach((bidder) => {
        const entry = ensureEntry(bidder.guildName || 'Unassigned', bidder.name.trim().toLowerCase(), bidder.name);
        entry.bonusShare += perBidder;
      });
    }
  });

  return Array.from(byGuild.entries())
    .map(([name, players]) => {
      const entries = Array.from(players.values())
        .map((e) => ({ ...e, total: e.salary + e.feeAmount + e.bonusShare }))
        .sort((a, b) => b.total - a.total);
      return {
        name,
        entries,
        memberCount: entries.filter((e) => e.isParticipant).length,
        total: entries.reduce((sum, e) => sum + e.total, 0),
      };
    })
    .sort((a, b) => b.total - a.total);
}

// One row per player: IGN / Max Bid / Present / Salary / Fee % / Fee Amount /
// Bonus Share / Total Salary / one column per known item (see
// CRUSADE_SUMMARY_ITEM_NAMES). Fee % and Fee Amount are each summed across
// every fee applied to that player on any team this crusade -- a recurring
// 2.5% fee applied to 3 fights shows as a combined 7.5% and its total
// diamond amount, not three separate numbers.
function renderPlayerSalaryCard(g) {
  const rows = g.entries
    .map((e, i) => {
      const itemCells = CRUSADE_SUMMARY_ITEM_NAMES.map((name) => `<td>${crusadeFormatItemQty(e.itemTotals[name])}</td>`).join('');
      const presentCell = e.isParticipant ? `${e.present}/${e.teamsCount}` : '–';
      const maxBidCell = !e.isParticipant ? '–' : !e.hasAttackTeam ? 'DEF' : crusadeFormatGold(e.maxBid);
      const feePercentCell = e.feePercent > 0 ? `${e.feePercent}%` : '–';
      return `
    <tr>
      <td>${i + 1}</td>
      <td style="font-weight:600;"><div style="white-space:nowrap;">${escapeHtml(e.name)}</div></td>
      <td>${maxBidCell}</td>
      <td>${presentCell}</td>
      <td>${crusadeFormatDiamonds(e.salary)}</td>
      <td>${feePercentCell}</td>
      <td>${crusadeFormatDiamonds(e.feeAmount)}</td>
      <td>${crusadeFormatDiamonds(e.bonusShare)}</td>
      <td style="font-weight:600;">${crusadeFormatDiamonds(e.total)}</td>
      ${itemCells}
    </tr>`;
    })
    .join('');
  const totalRow = `<tr class="crusade-table-total-row"><td></td><td>Total</td><td></td><td></td><td>${crusadeFormatDiamonds(
    g.entries.reduce((sum, e) => sum + e.salary, 0)
  )}</td><td></td><td>${crusadeFormatDiamonds(g.entries.reduce((sum, e) => sum + e.feeAmount, 0))}</td><td>${crusadeFormatDiamonds(
    g.entries.reduce((sum, e) => sum + e.bonusShare, 0)
  )}</td><td>${crusadeFormatDiamonds(g.total)}</td>${CRUSADE_SUMMARY_ITEM_NAMES.map(
    (name) => `<td>${crusadeFormatItemQty(g.entries.reduce((sum, e) => sum + e.itemTotals[name], 0))}</td>`
  ).join('')}</tr>`;
  return `
  <div class="crusade-party-card">
    <div class="crusade-party-card-header">
      <h3>${g.name === 'Unassigned' ? 'Unassigned' : escapeHtml(g.name)} — ${crusadeFormatDiamonds(g.total)} (${g.memberCount} member${g.memberCount === 1 ? '' : 's'})</h3>
    </div>
    <div class="table-scroll">
      <table class="members-table">
        <thead><tr><th>#</th><th>IGN</th><th>Max Bid</th><th>Present</th><th>Salary</th><th>Fee %</th><th>Fee Amount</th><th>Bonus Share</th><th>Total Salary</th>${CRUSADE_SUMMARY_ITEM_NAMES.map((name) => `<th>${escapeHtml(name)}</th>`).join('')}</tr></thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
    </div>
  </div>`;
}

// Every player's accumulated totals across every team on this crusade,
// grouped by guild -- one card per guild instead of one section per team,
// so the same player fighting on multiple teams shows up once, not
// repeated once per team.
function renderCrusadeGuildSalary() {
  const c = sovereignState.crusade;
  const dateText = c && c.eventDate ? formatLongDate(String(c.eventDate).slice(0, 10)) : 'No date set';
  document.getElementById('crusadeGuildSalaryMeta').textContent = `${c ? c.name : ''} — ${dateText}`;

  const guilds = computeCrusadeGuildSalaryDetail();
  const el = document.getElementById('crusadeGuildSalaryDetail');
  el.innerHTML = guilds.length
    ? `<div class="crusade-salary-list">${guilds.map((g) => renderPlayerSalaryCard(g)).join('')}</div>`
    : '<p class="empty-state">No participants on this crusade yet.</p>';

  renderCrusadeGuildTotals(guilds);
  renderLastCrusadeBidders();
}

// One row per guild: its grand total (diamonds) plus each known item,
// summed across every one of that guild's players -- a quick top-level
// overview above the full player-by-player breakdown.
function renderCrusadeGuildTotals(guilds) {
  document.getElementById('crusadeGuildTotalsEmptyState').classList.toggle('hidden', guilds.length !== 0);

  const rows = guilds.map((g, i) => {
    const salary = g.entries.reduce((sum, e) => sum + e.salary, 0);
    const feeAmount = g.entries.reduce((sum, e) => sum + e.feeAmount, 0);
    const bonusShare = g.entries.reduce((sum, e) => sum + e.bonusShare, 0);
    return `
    <tr>
      <td>${i + 1}</td>
      <td style="font-weight:600;">${g.name === 'Unassigned' ? 'Unassigned' : crusadeGuildBadge(g.name)}</td>
      <td>${crusadeFormatDiamonds(salary)}</td>
      <td>${crusadeFormatDiamonds(feeAmount)}</td>
      <td>${crusadeFormatDiamonds(bonusShare)}</td>
      <td style="font-weight:600;">${crusadeFormatDiamonds(g.total)}</td>
      ${CRUSADE_SUMMARY_ITEM_NAMES.map((name) => `<td>${crusadeFormatItemQty(g.entries.reduce((sum, e) => sum + e.itemTotals[name], 0))}</td>`).join('')}
    </tr>`;
  });

  // Grand total across every guild -- same columns, no guild badge.
  const allEntries = guilds.flatMap((g) => g.entries);
  const grandSalary = allEntries.reduce((sum, e) => sum + e.salary, 0);
  const grandFeeAmount = allEntries.reduce((sum, e) => sum + e.feeAmount, 0);
  const grandBonusShare = allEntries.reduce((sum, e) => sum + e.bonusShare, 0);
  const grandTotal = guilds.reduce((sum, g) => sum + g.total, 0);
  const totalRow = guilds.length
    ? `<tr class="crusade-table-total-row"><td></td><td>Total</td><td>${crusadeFormatDiamonds(grandSalary)}</td><td>${crusadeFormatDiamonds(
        grandFeeAmount
      )}</td><td>${crusadeFormatDiamonds(grandBonusShare)}</td><td>${crusadeFormatDiamonds(grandTotal)}</td>${CRUSADE_SUMMARY_ITEM_NAMES.map(
        (name) => `<td>${crusadeFormatItemQty(allEntries.reduce((sum, e) => sum + e.itemTotals[name], 0))}</td>`
      ).join('')}</tr>`
    : '';

  document.getElementById('crusadeGuildTotalsBody').innerHTML = rows.join('') + totalRow;
}

// Every team is its own independent battle now, so each team's Defense
// bonus (if it has one) pulls from its own "last team" -- this renders one
// card per team that actually has bidders to track, rather than one shared
// table for the whole crusade.
function renderLastCrusadeBidders() {
  const emptyState = document.getElementById('crusadeLastBiddersEmptyState');
  const container = document.getElementById('crusadeLastBiddersDetail');

  const cards = allKnownTeamNumbers()
    .map((teamNumber) => {
      const team = getTeamData(teamNumber);
      const bidders = team.lastTeamBidders || [];
      const { perBidder } = computeTeamBonusShares(teamNumber);
      // No bonus share at all (this team isn't a Defense win, or it lost)
      // means there's nothing to actually pay out -- skip the card entirely
      // rather than showing a table full of 0s.
      if (!bidders.length || perBidder <= 0) return null;
      const lastTeam = team.lastTeam;
      const sourceDateText = lastTeam?.eventDate ? formatLongDate(String(lastTeam.eventDate).slice(0, 10)) : 'No date set';

      // A single team's bidder list can run long with only one card ever
      // showing (every other team either isn't a Defense win or inherited
      // from the same source), leaving the second grid slot empty -- split
      // it into two side-by-side mini-tables within this one card instead,
      // numbered continuously across both halves.
      const buildRows = (list, offset) =>
        list
          .map(
            (b, i) => `
        <tr>
          <td>${offset + i + 1}</td>
          <td style="font-weight:600; white-space:nowrap;">${escapeHtml(b.name)}</td>
          <td>${crusadeGuildBadge(b.guildName)}</td>
          <td>${crusadeFormatGold(b.goldBid)}</td>
          <td>${crusadeFormatDiamonds(perBidder)}</td>
        </tr>`
          )
          .join('');
      const buildTable = (list, offset) => `
        <div class="table-scroll">
          <table class="members-table">
            <thead><tr><th>#</th><th>IGN</th><th>Guild</th><th>Gold Bid</th><th>Bonus Share</th></tr></thead>
            <tbody>${buildRows(list, offset)}</tbody>
          </table>
        </div>`;

      const half = Math.ceil(bidders.length / 2);
      const firstHalf = bidders.slice(0, half);
      const secondHalf = bidders.slice(half);

      return `
      <div class="crusade-party-card">
        <div class="crusade-party-card-header">
          <h3>Team ${teamNumber}'s bonus</h3>
        </div>
        <p style="color:var(--text-muted); font-size:12px; margin:-4px 0 10px;">Source crusade: ${escapeHtml(lastTeam.crusadeName)} — <strong style="color:var(--text);">${sourceDateText}</strong></p>
        <div class="crusade-bidders-columns">
          ${buildTable(firstHalf, 0)}
          ${secondHalf.length ? buildTable(secondHalf, half) : ''}
        </div>
        <div class="crusade-table-total-row" style="text-align:right; padding:8px 4px 0;">Total — ${crusadeFormatDiamonds(perBidder * bidders.length)}</div>
      </div>`;
    })
    .filter(Boolean);

  emptyState.classList.toggle('hidden', cards.length !== 0);
  container.innerHTML = cards.join('');
}

// The team's own page shows *all* of its records in one place: roster
// fields plus each person's diamond earnings (computed from this team's own
// attendance/bid pool) and a guild breakdown scoped to this team.
function renderTeamDetail(n) {
  document.getElementById('crusadeTeamHeading').textContent = `Team ${n}`;
  document.title = `Sovereign — ${sovereignState.crusade.name} — Team ${n}`;

  const team = getTeamData(n);
  const isDefense = isDefenseStance(team); // no bidding while defending, so the roster skips Bid/Share entirely
  const { value: statusValue, label: statusLabel } = crusadeStatusLabel(team.result);
  const statusBadge = document.getElementById('crusadeTeamStatusBadge');
  statusBadge.className = `crusade-status-badge ${statusValue}`;
  statusBadge.textContent = statusLabel;
  const teamRows = computeTeamDistribution(n);
  document.getElementById('crusadeTeamRosterEmptyState').classList.toggle('hidden', teamRows.length !== 0);

  // Split into parties of up to 5 — Party 1 always shows even if empty, so
  // there's always somewhere to start.
  const byParty = new Map();
  teamRows.forEach((row) => {
    const slot = row.participant.partySlot;
    if (!byParty.has(slot)) byParty.set(slot, []);
    byParty.get(slot).push(row);
  });
  const partySlots = Array.from(new Set([1, ...byParty.keys()])).sort((a, b) => a - b);

  // Each party is its own card/table side by side (grid wraps as needed) —
  // reads all as columns instead of one long table, so a 4-party team
  // doesn't turn into a long vertical scroll.
  const body = document.getElementById('crusadeTeamRosterBody');
  body.innerHTML = partySlots
    .map((slot) => {
      const rowsInParty = byParty.get(slot) || [];
      const full = rowsInParty.length >= CRUSADE_PARTY_MAX_MEMBERS;
      const memberRows = rowsInParty
        .map(
          ({ participant: p, attendanceAmount, bidShare, total }, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="crusade-roster-name-cell" style="font-weight:600;"><span class="crusade-roster-name-click" data-edit-participant="${p.id}" title="Click to edit">${escapeHtml(p.name)}</span></td>
        <td>${crusadeGuildBadge(p.guildName)}</td>
        <td class="crusade-roster-position-col">${p.position ? escapeHtml(p.position) : '–'}</td>
        ${isDefense ? '' : `<td>${crusadeFormatGold(p.goldBid)}</td>`}
        <td><input type="checkbox" class="crusade-attended-check admin-disable" data-participant-id="${p.id}" ${p.attended ? 'checked' : ''}></td>
        <td>${crusadeFormatDiamonds(attendanceAmount)}</td>
        ${isDefense ? '' : `<td>${crusadeFormatDiamonds(bidShare)}</td>`}
        <td style="font-weight:600;">${crusadeFormatDiamonds(total)}</td>
        <td class="admin-only"><input type="checkbox" class="crusade-paid-check admin-disable" data-participant-id="${p.id}" ${p.paid ? 'checked' : ''}></td>
        <td class="admin-only crusade-roster-actions-cell">
          <button type="button" class="icon-btn" data-edit-participant="${p.id}" title="Edit">✎</button>
          <button type="button" class="icon-btn" data-delete-participant="${p.id}" title="Remove">✕</button>
        </td>
      </tr>`
        )
        .join('');
      return `
      <div class="crusade-party-card">
        <div class="crusade-party-card-header">
          <h3>Party ${slot} — ${rowsInParty.length}/${CRUSADE_PARTY_MAX_MEMBERS}</h3>
          <button type="button" class="icon-btn admin-only" data-add-to-party-slot="${slot}" title="Add to Party ${slot}" ${full ? 'disabled' : ''}>+</button>
        </div>
        <div class="table-scroll">
          <table class="members-table crusade-roster-table">
            <thead>
              <tr>
                <th style="width:4%;">#</th><th style="width:20%;">Name</th><th>Guild</th><th class="crusade-roster-position-col">Position</th>
                ${isDefense ? '' : '<th>Bid</th>'}
                <th style="width:6%;">Enter</th>
                <th>Attend</th>
                ${isDefense ? '' : '<th>Share</th>'}
                <th>Total</th>
                <th class="admin-only" style="width:6%;">Paid</th><th class="admin-only" style="width:8%;"></th>
              </tr>
            </thead>
            <tbody>${memberRows}</tbody>
          </table>
        </div>
      </div>`;
    })
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
  body.querySelectorAll('[data-add-to-party-slot]').forEach((btn) => {
    btn.addEventListener('click', () => openCrusadeParticipantModal(null, n, Number(btn.getAttribute('data-add-to-party-slot'))));
  });

  const feeCreditsByGuild = new Map();
  (team.fees || []).forEach((fee) => {
    const guildKey = fee.guildName || 'Unassigned';
    feeCreditsByGuild.set(guildKey, (feeCreditsByGuild.get(guildKey) || 0) + crusadeFeeAmount(fee, team));
  });
  renderCrusadeGuildSummary(teamRows, 'crusadeTeamGuildSummary', undefined, feeCreditsByGuild);
  renderTeamItemTable(n);
  renderCrusadeItemList(n);
  renderCrusadeFeeList(n);
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

function openCrusadeParticipantModal(participantId, presetPartyNumber, presetPartySlot) {
  const form = document.getElementById('crusadeParticipantForm');
  form.reset();
  const participant = participantId ? sovereignState.participants.find((p) => p.id === participantId) : null;
  document.getElementById('crusadeParticipantModalTitle').textContent = participant ? 'Edit Participant' : 'Add Participant';
  form.elements.participantId.value = participant ? participant.id : '';
  form.elements.name.value = participant ? participant.name : '';
  form.elements.guildName.value = participant ? participant.guildName || '' : '';
  form.elements.position.value = participant ? participant.position || '' : '';
  const teamNumber = participant ? participant.partyNumber : presetPartyNumber || nextTeamNumber();
  form.elements.partyNumber.value = teamNumber;
  form.elements.partySlot.value = participant ? participant.partySlot : presetPartySlot || nextAvailablePartySlot(teamNumber);
  const noBidding = isDefenseStance(getTeamData(teamNumber));
  // Defaults to 0, not a placeholder bid amount -- only someone who actually
  // bid gold should end up with a nonzero value, since that's what marks
  // them as a bidder everywhere else (Last Crusade's Bidders, Max Bid, etc).
  form.elements.goldBid.value = noBidding ? 0 : participant ? participant.goldBid : 0;
  form.querySelector('.crusade-goldbid-field').classList.toggle('hidden', noBidding);
  form.elements.attended.checked = participant ? participant.attended : true;
  document.getElementById('crusadeParticipantModal').classList.remove('hidden');
}

document.getElementById('addCrusadeParticipantBtn').addEventListener('click', () => openCrusadeParticipantModal(null));
document.getElementById('addTeamParticipantBtn').addEventListener('click', () => openCrusadeParticipantModal(null, sovereignState.activeTeam));

// ---------- Add Multiple Participants (search the Member List, click many) ----------

const crusadeBulkAddState = { selectedNames: [] };

function renderCrusadeBulkResults() {
  const query = document.getElementById('crusadeBulkSearchInput').value.trim().toLowerCase();
  const results = query ? sovereignState.memberList.filter((m) => m.name.toLowerCase().includes(query)) : sovereignState.memberList;

  document.getElementById('crusadeBulkResultsList').innerHTML = results
    .map((m) => {
      const selected = crusadeBulkAddState.selectedNames.includes(m.name);
      return `
      <div class="crusade-bulk-result-row ${selected ? 'selected' : ''}" data-name="${escapeHtml(m.name)}">
        <span class="crusade-bulk-result-check">${selected ? '✓' : ''}</span>
        <span style="flex:1;">${escapeHtml(m.name)}</span>
        ${crusadeGuildBadge(m.guildName)}
      </div>`;
    })
    .join('');

  document.querySelectorAll('.crusade-bulk-result-row').forEach((row) => {
    row.addEventListener('click', () => {
      const name = row.getAttribute('data-name');
      const idx = crusadeBulkAddState.selectedNames.indexOf(name);
      if (idx === -1) crusadeBulkAddState.selectedNames.push(name);
      else crusadeBulkAddState.selectedNames.splice(idx, 1);
      renderCrusadeBulkResults();
      renderCrusadeBulkSelected();
    });
  });
}

function renderCrusadeBulkSelected() {
  document.getElementById('crusadeBulkSelectedCount').textContent = crusadeBulkAddState.selectedNames.length;
  document.getElementById('crusadeBulkSelectedList').innerHTML = crusadeBulkAddState.selectedNames
    .map((name) => `<span class="crusade-bulk-chip">${escapeHtml(name)} <button type="button" data-remove-chip="${escapeHtml(name)}">✕</button></span>`)
    .join('');

  document.querySelectorAll('[data-remove-chip]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-remove-chip');
      crusadeBulkAddState.selectedNames = crusadeBulkAddState.selectedNames.filter((n) => n !== name);
      renderCrusadeBulkResults();
      renderCrusadeBulkSelected();
    });
  });
}

function openCrusadeBulkAddModal(presetPartyNumber) {
  crusadeBulkAddState.selectedNames = [];
  document.getElementById('crusadeBulkSearchInput').value = '';
  const form = document.getElementById('crusadeBulkAddForm');
  form.reset();
  const teamNumber = presetPartyNumber || nextTeamNumber();
  form.elements.partyNumber.value = teamNumber;
  form.elements.partySlot.value = nextAvailablePartySlot(teamNumber);
  const noBidding = isDefenseStance(getTeamData(teamNumber));
  // Defaults to 0 -- a shared bulk-add batch usually mixes bidders and
  // non-bidders, so presuming everyone bid would misrepresent whoever
  // didn't as a bidder (see the single-add modal for the same reasoning).
  form.elements.goldBid.value = 0;
  form.querySelector('.crusade-goldbid-field').classList.toggle('hidden', noBidding);
  renderCrusadeBulkResults();
  renderCrusadeBulkSelected();
  document.getElementById('crusadeBulkAddModal').classList.remove('hidden');
}

document.getElementById('addCrusadeBulkBtn').addEventListener('click', () => openCrusadeBulkAddModal(null));
document.getElementById('addTeamBulkBtn').addEventListener('click', () => openCrusadeBulkAddModal(sovereignState.activeTeam));
document.getElementById('crusadeBulkSearchInput').addEventListener('input', renderCrusadeBulkResults);

document.getElementById('crusadeBulkAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const names = crusadeBulkAddState.selectedNames;
  if (!names.length) {
    toast('Select at least one member first');
    return;
  }

  const teamNumber = Number(form.elements.partyNumber.value) || 1;
  let partySlot = Number(form.elements.partySlot.value) || 1;
  const goldBid = Number(form.elements.goldBid.value) || 0;
  const attended = form.elements.attended.checked;

  let added = 0;
  for (const name of names) {
    const member = sovereignState.memberList.find((m) => m.name === name);
    // Respect the 5-per-party cap by advancing to the next slot whenever the
    // current one fills up (including from participants just added in this
    // same batch, since sovereignState.participants is updated as we go).
    while (
      sovereignState.participants.filter((p) => p.partyNumber === teamNumber && p.partySlot === partySlot).length >=
      CRUSADE_PARTY_MAX_MEMBERS
    ) {
      partySlot++;
    }
    try {
      const created = await api(`/api/crusades/${sovereignState.crusadeId}/participants`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          guildName: member?.guildName || null,
          position: member?.position || null,
          partyNumber: teamNumber,
          partySlot,
          goldBid,
          attended,
        }),
      });
      sovereignState.participants.push(created);
      added++;
    } catch (err) {
      toast(`${name}: ${err.message}`);
    }
  }

  document.getElementById('crusadeBulkAddModal').classList.add('hidden');
  refreshAfterRosterChange();
  toast(`${added} participant${added === 1 ? '' : 's'} added`);
});

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
    partySlot: Number(form.elements.partySlot.value) || 1,
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

// ---------- Diamond distribution (per team) ----------

// A lost team pays out nothing at all — diamonds, items, and management fees
// all drop to 0 regardless of what's entered, rather than splitting a
// reward that was never actually earned.
function crusadeWasLost(team) {
  return !!(team && team.result === 'lose');
}

// Management fees take a percentage of a team's *own* diamond reward off the
// top (e.g. a guild leader's cut) before anything else is computed — so the
// pool that actually gets split by attendance/bid is that team's reward
// minus every one of its fees' amounts.
function totalTeamFeeAmount(team) {
  if (crusadeWasLost(team)) return 0;
  return (team.fees || []).reduce((sum, f) => sum + team.diamondReward * (f.percent / 100), 0);
}

// Winning on Defense splits a team's (post-fee) reward 60/40 instead of
// paying it all to that team's own roster: 60% stays there, 40% goes to
// whoever bid gold on the team it inherited the bonus from (see
// computeTeamBonusShares). Any other stance/result keeps the full reward for
// that team's roster, same as before.
function isTeamDefenseWin(team) {
  return !!(team && team.stance === 'Defense' && team.result === 'win');
}

// Defending doesn't involve gold bids at all -- there's no attack roll to
// buy a spot on, so a Defense team's own-roster pool is 100% attendance,
// regardless of whatever Attendance Share % happens to be saved.
function isDefenseStance(team) {
  return !!(team && team.stance === 'Defense');
}

// Half a team's (post-fee, post-defense-split) reward splits evenly across
// everyone on that team who attended; the other half splits across that
// team's gold bidders in proportion to their bid — this collapses to an
// equal split when every bidder bids the same amount (the common case), and
// scales fairly when bids differ. Defense teams skip the bid split entirely
// (see isDefenseStance) since there's no bidding to divide.
function computeTeamDistribution(teamNumber) {
  const team = getTeamData(teamNumber);
  const participants = sovereignState.participants.filter((p) => p.partyNumber === teamNumber);
  if (crusadeWasLost(team)) {
    return participants.map((p) => ({ participant: p, attendanceAmount: 0, bidShare: 0, total: 0 }));
  }

  const netReward = Math.max(0, team.diamondReward - totalTeamFeeAmount(team));
  const ownPool = isTeamDefenseWin(team) ? netReward * 0.6 : netReward;
  const noBidding = isDefenseStance(team);
  const attendancePool = noBidding ? ownPool : ownPool * (team.attendancePct / 100);
  const bidPool = noBidding ? 0 : ownPool - attendancePool;

  const attendees = participants.filter((p) => p.attended);
  const attendanceShare = attendees.length ? attendancePool / attendees.length : 0;
  const totalBid = participants.reduce((sum, p) => sum + (p.goldBid > 0 ? p.goldBid : 0), 0);

  return participants.map((p) => {
    const attendanceAmount = p.attended ? attendanceShare : 0;
    const bidShare = !noBidding && p.goldBid > 0 && totalBid > 0 ? bidPool * (p.goldBid / totalBid) : 0;
    return { participant: p, attendanceAmount, bidShare, total: attendanceAmount + bidShare };
  });
}

// The other 40% of a Defense win's reward, split evenly across everyone who
// placed a gold bid on the team this one inherited its bonus from — paid out
// to them by name/guild, regardless of whether they're on this team's roster
// at all.
function computeTeamBonusShares(teamNumber) {
  const team = getTeamData(teamNumber);
  if (crusadeWasLost(team) || !isTeamDefenseWin(team)) return { pool: 0, perBidder: 0, bidders: [] };

  const netReward = Math.max(0, team.diamondReward - totalTeamFeeAmount(team));
  const pool = netReward * 0.4;
  const bidders = team.lastTeamBidders || [];
  const perBidder = bidders.length ? pool / bidders.length : 0;
  return { pool, perBidder, bidders };
}

// Each named item (e.g. Morion) has its own total quantity, split evenly
// across that team's attendees only — no bid portion, unlike diamonds.
// Non-attendees get none, same "attended is a must" rule as the diamond
// attendance share.
function computeTeamItemShares(teamNumber, item) {
  const team = getTeamData(teamNumber);
  const participants = sovereignState.participants.filter((p) => p.partyNumber === teamNumber);
  if (crusadeWasLost(team)) return participants.map((p) => ({ participant: p, total: 0 }));

  const quantity = item ? item.quantity || 0 : 0;
  const attendees = participants.filter((p) => p.attended);
  const share = attendees.length ? quantity / attendees.length : 0;
  return participants.map((p) => ({ participant: p, total: p.attended ? share : 0 }));
}

// Multiple items laid out as columns (one per item) with one row per guild
// present on this team, so several items can be compared at a glance instead
// of scrolling through a separate summary per item.
function renderTeamItemTable(n) {
  const heading = document.getElementById('crusadeTeamItemsHeading');
  const table = document.getElementById('crusadeTeamItemTable');
  const items = getTeamData(n).items || [];

  if (!items.length) {
    heading.classList.add('hidden');
    table.classList.add('hidden');
    return;
  }
  heading.classList.remove('hidden');
  table.classList.remove('hidden');

  const teamParticipants = sovereignState.participants.filter((p) => p.partyNumber === n);
  const guildNames = Array.from(new Set(teamParticipants.map((p) => p.guildName || 'Unassigned'))).sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });

  const shareByGuildPerItem = items.map((item) => {
    const byGuild = new Map();
    computeTeamItemShares(n, item).forEach(({ participant: p, total }) => {
      const key = p.guildName || 'Unassigned';
      byGuild.set(key, (byGuild.get(key) || 0) + total);
    });
    return byGuild;
  });

  document.getElementById('crusadeTeamItemTableHead').innerHTML =
    `<th>#</th><th>Guild</th>${items.map((it) => `<th>${escapeHtml(it.name)}</th>`).join('')}<th>Members</th>`;

  const memberCountByGuild = new Map();
  teamParticipants.forEach((p) => {
    const key = p.guildName || 'Unassigned';
    memberCountByGuild.set(key, (memberCountByGuild.get(key) || 0) + 1);
  });

  const rows = guildNames.map((guildName, i) => {
    const color = guildName === 'Unassigned' ? null : crusadeGuildColor(guildName);
    const cells = shareByGuildPerItem.map((byGuild) => `<td>${crusadeFormatItemQty(byGuild.get(guildName) || 0)}</td>`).join('');
    return `<tr>
      <td>${i + 1}</td>
      <td style="font-weight:600; ${color ? `color:${color};` : ''}">${escapeHtml(guildName)}</td>
      ${cells}
      <td>${memberCountByGuild.get(guildName)}</td>
    </tr>`;
  });

  const totalCells = shareByGuildPerItem
    .map((byGuild) => `<td>${crusadeFormatItemQty(Array.from(byGuild.values()).reduce((sum, v) => sum + v, 0))}</td>`)
    .join('');
  rows.push(`<tr class="crusade-table-total-row"><td></td><td>Total</td>${totalCells}<td>${teamParticipants.length}</td></tr>`);

  document.getElementById('crusadeTeamItemTableBody').innerHTML = rows.join('');
}

function renderCrusadeItemList(n) {
  const list = document.getElementById('crusadeItemList');
  const items = getTeamData(n).items || [];
  document.getElementById('crusadeItemListEmptyState').classList.toggle('hidden', items.length !== 0);

  list.innerHTML = items
    .map(
      (item) => `
    <li style="display:flex; gap:8px; align-items:center;" data-item-id="${item.id}">
      <span style="flex:1;">${escapeHtml(item.name)}</span>
      <span style="color:var(--text-muted);">${crusadeFormatItemQty(item.quantity)}</span>
      <button type="button" class="icon-btn admin-only" data-delete-item="${item.id}" title="Remove item">✕</button>
    </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const itemId = btn.getAttribute('data-delete-item');
      const item = items.find((i) => i.id === itemId);
      if (!confirm(`Remove item "${item?.name}" from this team?`)) return;
      try {
        await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/items/${itemId}`, { method: 'DELETE' });
        const team = sovereignState.teams.find((t) => t.teamNumber === n);
        if (team) team.items = team.items.filter((i) => i.id !== itemId);
        renderCrusadeItemList(n);
        renderTeamItemTable(n);
        toast('Item removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('addCrusadeItemForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const n = sovereignState.activeTeam;
  try {
    const item = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/items`, {
      method: 'POST',
      body: JSON.stringify({ name: form.elements.name.value, quantity: Number(form.elements.quantity.value) || 0 }),
    });
    let team = sovereignState.teams.find((t) => t.teamNumber === n);
    if (!team) {
      team = { ...defaultTeamData(n), id: item.teamId };
      sovereignState.teams.push(team);
    }
    team.items.push(item);
    renderCrusadeItemList(n);
    renderTeamItemTable(n);
    form.reset();
    toast(`${item.name} added`);
  } catch (err) {
    toast(err.message);
  }
});

function crusadeFeeAmount(fee, team) {
  if (crusadeWasLost(team)) return 0;
  return (team ? team.diamondReward || 0 : 0) * (fee.percent / 100);
}

function renderCrusadeFeeList(n) {
  const list = document.getElementById('crusadeFeeList');
  const team = getTeamData(n);
  const fees = team.fees || [];
  document.getElementById('crusadeFeeListEmptyState').classList.toggle('hidden', fees.length !== 0);

  list.innerHTML = fees
    .map(
      (fee) => `
    <li style="display:flex; gap:8px; align-items:center;" data-fee-id="${fee.id}">
      <span style="flex:1; font-weight:600;">${escapeHtml(fee.name)}</span>
      ${crusadeGuildBadge(fee.guildName)}
      <span style="color:var(--text-muted);">${fee.percent}% → ${crusadeFormatDiamonds(crusadeFeeAmount(fee, team))}</span>
      <button type="button" class="icon-btn admin-only" data-delete-fee="${fee.id}" title="Remove fee">✕</button>
    </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-fee]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const feeId = btn.getAttribute('data-delete-fee');
      const fee = fees.find((f) => f.id === feeId);
      if (!confirm(`Remove the ${fee?.percent}% management fee for "${fee?.name}"?`)) return;
      try {
        await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/fees/${feeId}`, { method: 'DELETE' });
        const teamState = sovereignState.teams.find((t) => t.teamNumber === n);
        if (teamState) teamState.fees = teamState.fees.filter((f) => f.id !== feeId);
        renderTeamDetail(n); // fee removal changes this team's pool, so recompute (also re-renders this list)
        toast('Fee removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('addCrusadeFeeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const n = sovereignState.activeTeam;
  try {
    const fee = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/fees`, {
      method: 'POST',
      body: JSON.stringify({
        name: form.elements.name.value,
        guildName: form.elements.guildName.value || null,
        percent: Number(form.elements.percent.value) || 0,
      }),
    });
    let team = sovereignState.teams.find((t) => t.teamNumber === n);
    if (!team) {
      team = { ...defaultTeamData(n), id: fee.teamId };
      sovereignState.teams.push(team);
    }
    team.fees.push(fee);
    renderTeamDetail(n); // new fee changes this team's pool, so recompute (also re-renders this list)
    form.reset();
    toast(`${fee.name}'s fee added`);
  } catch (err) {
    toast(err.message);
  }
});

// Copies the standing default fees onto THIS team -- for teams that already
// existed before a default was added (ensureCrusadeTeam only auto-seeds
// brand-new teams). Skips any default already on this team's fee list.
document.getElementById('applyCrusadeDefaultFeesBtn').addEventListener('click', async () => {
  const n = sovereignState.activeTeam;
  try {
    const added = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/apply-default-fees`, { method: 'POST' });
    if (!added.length) {
      toast('Nothing to apply — this team already has every standing default fee');
      return;
    }
    let team = sovereignState.teams.find((t) => t.teamNumber === n);
    if (!team) {
      team = { ...defaultTeamData(n), id: added[0].teamId };
      sovereignState.teams.push(team);
    }
    team.fees.push(...added);
    renderTeamDetail(n); // new fees change this team's pool, so recompute (also re-renders this list)
    toast(`Applied ${added.length} default fee${added.length === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message);
  }
});

// Same as Apply Defaults, but for every team on this crusade at once --
// makes sure no team gets left out just because it existed before a
// default fee was added. Each team is applied independently (skipping IGNs
// it already has), so it's safe to run again even if some teams already
// have everything.
document.getElementById('applyCrusadeDefaultFeesAllTeamsBtn').addEventListener('click', async () => {
  const teamNumbers = visibleTeamNumbers();
  if (!confirm(`Apply the standing default fees to all ${teamNumbers.length} team${teamNumbers.length === 1 ? '' : 's'} on this crusade?`)) return;

  let totalAdded = 0;
  let teamsChanged = 0;
  try {
    for (const n of teamNumbers) {
      const added = await api(`/api/crusades/${sovereignState.crusadeId}/teams/${n}/apply-default-fees`, { method: 'POST' });
      if (!added.length) continue;
      let team = sovereignState.teams.find((t) => t.teamNumber === n);
      if (!team) {
        team = { ...defaultTeamData(n), id: added[0].teamId };
        sovereignState.teams.push(team);
      }
      team.fees.push(...added);
      totalAdded += added.length;
      teamsChanged += 1;
    }
    refreshAfterRosterChange(); // fees change each affected team's pool, so recompute whatever's currently visible
    toast(
      totalAdded
        ? `Applied ${totalAdded} default fee${totalAdded === 1 ? '' : 's'} across ${teamsChanged} team${teamsChanged === 1 ? '' : 's'}`
        : 'Nothing to apply — every team already has every standing default fee'
    );
  } catch (err) {
    toast(err.message);
  }
});

// extraByGuild optionally adds a flat amount to a guild's total without
// counting as a member — used to fold management fees into the guild that
// the fee's IGN belongs to, even though the fee isn't itself a participant.
function renderCrusadeGuildSummary(rows, containerId, formatFn, extraByGuild) {
  const format = formatFn || crusadeFormatDiamonds;
  const el = document.getElementById(containerId);
  const byGuild = new Map();
  rows.forEach(({ participant: p, total }) => {
    const key = p.guildName || 'Unassigned';
    if (!byGuild.has(key)) byGuild.set(key, { total: 0, count: 0 });
    const g = byGuild.get(key);
    g.total += total;
    g.count += 1;
  });

  let extraTotal = 0;
  if (extraByGuild) {
    extraByGuild.forEach((amount, guildName) => {
      if (!byGuild.has(guildName)) byGuild.set(guildName, { total: 0, count: 0 });
      byGuild.get(guildName).total += amount;
      extraTotal += amount;
    });
  }

  if (!byGuild.size) {
    el.innerHTML = '';
    return;
  }

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0) + extraTotal;
  const items = Array.from(byGuild.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, g]) => {
      const color = crusadeGuildColor(name) || 'var(--text-muted)';
      return `<div class="crusade-guild-summary-row">
        <span class="schedule-dot" style="background:${color}"></span>
        <span style="flex:1;">${escapeHtml(name)}</span>
        <span>${format(g.total)}</span>
        <span style="color:var(--text-muted);">${g.count} member${g.count === 1 ? '' : 's'}</span>
      </div>`;
    })
    .join('');

  el.innerHTML = `${items}<div class="crusade-guild-summary-row crusade-guild-summary-total"><span style="flex:1;">Total</span><span>${format(grandTotal)}</span><span></span></div>`;
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
  head.innerHTML =
    `<th style="width:4%;">#</th>` +
    guildKeys
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
        return `<td style="white-space:nowrap;">${escapeHtml(m.name)} <button type="button" class="icon-btn admin-only" data-delete-member="${m.id}" title="Remove from member list">✕</button></td>`;
      })
      .join('');
    rowsHtml.push(`<tr><td>${i + 1}</td>${cells}</tr>`);
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

// ---------- Raffle (standalone, independent of any crusade) ----------
// Draws from the same master Member List as above. Anyone already in the
// Winners stack drops out of the eligible pool until "Clear Winners" resets
// it -- the pool is derived each render, never stored separately.

async function loadRaffle() {
  const [guilds, winners, activity] = await Promise.all([
    api('/api/crusade-guilds'),
    api('/api/raffle-winners'),
    api('/api/activity-log?entityType=raffle_winner&limit=50'),
  ]);
  sovereignState.guilds = guilds;
  sovereignState.raffleWinners = winners;
  sovereignState.raffleActivity = activity;
  renderRafflePool();
  renderRaffleWinners();
  renderRaffleActivity();
}

// Re-fetches just the log (draw/edit/undo/clear all write through
// logActivity() server-side, so the freshest record is whatever comes back
// from there rather than something reconstructed client-side).
async function refreshRaffleActivity() {
  try {
    sovereignState.raffleActivity = await api('/api/activity-log?entityType=raffle_winner&limit=50');
    renderRaffleActivity();
  } catch (err) {
    // non-fatal -- the action itself already succeeded
  }
}

function renderRaffleActivity() {
  const entries = sovereignState.raffleActivity || [];
  document.getElementById('raffleActivityEmptyState').classList.toggle('hidden', entries.length !== 0);

  document.getElementById('raffleActivityList').innerHTML = entries
    .map((e) => {
      const time = new Date(e.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `
      <div style="display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid var(--gridline); font-size:13px;">
        <span>${escapeHtml(e.description || '')}</span>
        <span style="color:var(--text-muted); white-space:nowrap;">${e.username ? `${escapeHtml(e.username)} · ` : ''}${time}</span>
      </div>`;
    })
    .join('');
}

document.getElementById('clearRaffleActivityBtn').addEventListener('click', async () => {
  if (!sovereignState.raffleActivity.length) return;
  if (!confirm(`Clear all ${sovereignState.raffleActivity.length} raffle activity log entr${sovereignState.raffleActivity.length === 1 ? 'y' : 'ies'}? This can't be undone.`)) return;
  try {
    await api('/api/activity-log?entityType=raffle_winner', { method: 'DELETE' });
    await refreshRaffleActivity();
    toast('Raffle activity log cleared');
  } catch (err) {
    toast(err.message);
  }
});

// The winner is a whole guild, not an individual member -- a guild already
// in the Winners stack drops out of the pool until "Clear Winners" resets it.
function raffleEligibleGuilds() {
  const wonNames = new Set(sovereignState.raffleWinners.map((w) => w.guildName?.trim().toLowerCase()));
  return sovereignState.guilds.filter((g) => !wonNames.has(g.name.trim().toLowerCase()));
}

function renderRafflePool() {
  const container = document.getElementById('rafflePoolDetail');
  const eligible = raffleEligibleGuilds();
  document.getElementById('rafflePoolEmptyState').classList.toggle('hidden', eligible.length !== 0);

  const items = eligible
    .map(
      (g) => `
    <li>
      <label style="display:flex; flex-direction:row; align-items:center; gap:8px; font-weight:400;">
        <input type="checkbox" class="raffle-guild-check admin-disable" data-name="${escapeHtml(g.name)}">
        <span class="schedule-dot" style="background:${g.color}"></span>
        ${escapeHtml(g.name)}
      </label>
    </li>`
    )
    .join('');

  container.innerHTML = eligible.length
    ? `
    <div class="crusade-party-card">
      <div class="crusade-party-card-header">
        <h3>Guilds (${eligible.length})</h3>
        <label style="display:flex; flex-direction:row; align-items:center; gap:4px; font-weight:400; font-size:11px; text-transform:none; color:var(--text-muted);">
          <input type="checkbox" class="raffle-select-all admin-disable">
          All
        </label>
      </div>
      <ul style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:6px;">${items}</ul>
    </div>`
    : '';

  container.querySelectorAll('.raffle-select-all').forEach((allCb) => {
    allCb.addEventListener('change', () => {
      const card = allCb.closest('.crusade-party-card');
      card.querySelectorAll('.raffle-guild-check').forEach((cb) => (cb.checked = allCb.checked));
      updateRafflePoolCount();
    });
  });
  container.querySelectorAll('.raffle-guild-check').forEach((cb) => {
    cb.addEventListener('change', updateRafflePoolCount);
  });
  updateRafflePoolCount();
}

function updateRafflePoolCount() {
  const checked = document.querySelectorAll('.raffle-guild-check:checked').length;
  document.getElementById('rafflePoolCount').textContent = checked ? `${checked} selected` : '';
  document.getElementById('raffleDrawBtn').disabled = checked === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fisher-Yates -- the shuffled order IS the draw result, index 0 = 1st place.
function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

document.getElementById('raffleDrawBtn').addEventListener('click', async () => {
  const checked = Array.from(document.querySelectorAll('.raffle-guild-check:checked')).map((cb) => cb.getAttribute('data-name'));
  if (!checked.length) return;

  const order = shuffled(checked);
  const drawBtn = document.getElementById('raffleDrawBtn');
  const display = document.getElementById('raffleDrawDisplay');

  drawBtn.disabled = true;
  display.classList.remove('hidden');

  // One spin to build suspense (cycling through everyone checked), then
  // reveal every placement in the shuffled order -- one Draw ranks the whole
  // checked pool at once instead of needing a click per placement.
  const spinDelays = [70, 70, 70, 80, 90, 110, 140, 180, 230];
  for (const delay of spinDelays) {
    display.textContent = checked[Math.floor(Math.random() * checked.length)];
    await sleep(delay);
  }

  let failed = null;
  for (const name of order) {
    const nextPlace = sovereignState.raffleWinners.length + 1;
    display.textContent = `${ordinal(nextPlace)}: ${name}`;
    try {
      const created = await api('/api/raffle-winners', {
        method: 'POST',
        body: JSON.stringify({ memberName: name, guildName: name }),
      });
      sovereignState.raffleWinners.unshift(created);
      renderRafflePool();
      renderRaffleWinners();
    } catch (err) {
      failed = err;
      break;
    }
    await sleep(400);
  }
  refreshRaffleActivity();

  if (failed) {
    toast(failed.message);
    updateRafflePoolCount(); // the failed POST's renderRafflePool() never ran, so reset the button here
  } else {
    toast(`🎉 ${order.length} placement${order.length === 1 ? '' : 's'} drawn!`);
  }
  await sleep(1200);
  display.classList.add('hidden');
});

document.getElementById('clearRaffleWinnersBtn').addEventListener('click', async () => {
  if (!sovereignState.raffleWinners.length) return;
  if (!confirm(`Clear all ${sovereignState.raffleWinners.length} raffle winner(s)? Every guild becomes eligible again.`)) return;
  try {
    await api('/api/raffle-winners', { method: 'DELETE' });
    sovereignState.raffleWinners = [];
    renderRafflePool();
    renderRaffleWinners();
    refreshRaffleActivity();
    toast('Raffle winners cleared');
  } catch (err) {
    toast(err.message);
  }
});

// 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th", 21 -> "21st"...
function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

const RAFFLE_PLACE_MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

function renderRaffleWinners() {
  const winners = sovereignState.raffleWinners; // newest draw first
  document.getElementById('raffleWinnersEmptyState').classList.toggle('hidden', winners.length !== 0);

  // Placement is draw order, not recency -- whoever was drawn first holds
  // 1st place regardless of how many more have been drawn since.
  const chronological = [...winners].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const placeById = new Map(chronological.map((w, i) => [w.id, i + 1]));

  const list = document.getElementById('raffleWinnersList');
  list.innerHTML = winners
    .map((w) => {
      const color = crusadeGuildColor(w.guildName) || 'var(--text-muted)';
      const time = new Date(w.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const place = placeById.get(w.id);
      const placeLabel = `${RAFFLE_PLACE_MEDAL[place] || '🎗️'} ${ordinal(place)}`;
      return `
      <div class="crusade-guild-summary-row" data-winner-id="${w.id}">
        <span style="font-weight:700; white-space:nowrap; min-width:56px;">${placeLabel}</span>
        <span class="schedule-dot" style="background:${color}"></span>
        <span style="flex:1; font-weight:600; white-space:nowrap;">${escapeHtml(w.guildName || w.memberName)}</span>
        <input type="text" class="raffle-item-input admin-disable" data-winner-id="${w.id}" value="${escapeHtml(w.item || '')}" placeholder="What did they win?" style="max-width:200px; flex:1;">
        <span style="color:var(--text-muted); font-size:12px; white-space:nowrap;">${time}</span>
        <button type="button" class="icon-btn admin-only" data-remove-winner="${w.id}" title="Undo this draw">✕</button>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.raffle-item-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.getAttribute('data-winner-id');
      try {
        const updated = await api(`/api/raffle-winners/${id}`, { method: 'PUT', body: JSON.stringify({ item: input.value }) });
        const idx = sovereignState.raffleWinners.findIndex((w) => w.id === id);
        if (idx !== -1) sovereignState.raffleWinners[idx] = updated;
        refreshRaffleActivity();
        toast('Item saved');
      } catch (err) {
        toast(err.message);
      }
    });
  });
  list.querySelectorAll('[data-remove-winner]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-remove-winner');
      const winner = sovereignState.raffleWinners.find((w) => w.id === id);
      if (!confirm(`Undo ${winner?.guildName || winner?.memberName}'s win? It'll go back into the eligible pool.`)) return;
      try {
        await api(`/api/raffle-winners/${id}`, { method: 'DELETE' });
        sovereignState.raffleWinners = sovereignState.raffleWinners.filter((w) => w.id !== id);
        renderRafflePool();
        renderRaffleWinners();
        refreshRaffleActivity();
        toast('Draw undone');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}
