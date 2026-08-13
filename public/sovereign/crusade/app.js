// Standalone Sovereign / Crusade page — no shared app shell, no hash router
// from router.js. Bare /sovereign shows the crusade list; #<crusadeId> shows
// that crusade's roster + distribution. common.js still supplies
// api()/toast()/escapeHtml()/session handling, which is why it's loaded here.

// A crusade is just the shared date/event container (name + date); every
// team on it is its own independent battle with its own war type, stance,
// result, diamond reward, attendance %, notes, items and fees -- so two
// teams sharing a crusade's date can have completely different outcomes.
// mode tracks which crusade-scoped page is active: 'overview' | 'team' | 'guildSalary'.
const sovereignState = { crusades: [], guilds: [], crusadeId: null, crusade: null, participants: [], teams: [], memberList: [], raffleWinners: [], raffleActivity: [], activeTeam: null, mode: null };

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

  body.innerHTML = crusades
    .map(
      (c) => `
    <tr>
      <td><a href="#crusade/${c.id}" style="font-weight:600;">${c.eventDate ? escapeHtml(formatLongDate(String(c.eventDate).slice(0, 10))) : 'No date set'}</a></td>
      <td>${c.participantCount}</td>
      <td>${crusadeFormatDiamonds(c.netDiamondReward)}</td>
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
  sovereignState.teams = crusade.teams;
  sovereignState.guilds = guilds;
  populateCrusadeGuildSelect(); // shared by the add/edit-participant modal regardless of which page opened it
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
}

function populateCrusadeGuildSelect() {
  const options = '<option value="">—</option>' + sovereignState.guilds.map((g) => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join('');
  ['crusadeParticipantGuildSelect', 'crusadeFeeGuildSelect'].forEach((id) => {
    const select = document.getElementById(id);
    const current = select.value;
    select.innerHTML = options;
    select.value = current;
  });
}

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
    .map((n) => {
      const team = getTeamData(n);
      const rows = computeTeamDistribution(n);
      const count = sovereignState.participants.filter((p) => p.partyNumber === n).length;
      const diamonds = rows.reduce((sum, r) => sum + r.total, 0);
      return `
      <tr>
        <td><a href="#crusade/${sovereignState.crusadeId}/team/${n}" style="font-weight:600;">Team ${n}</a></td>
        <td>${crusadeStatusBadge(team.result)}</td>
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

// One team's own roster, categorized by guild: each guild's entry list is
// every participant's own IGN + their individual salary (from that team's
// own pool), plus a line for any management fee or Defense-bonus payout
// credited to that guild. Scoped to a single team -- unlike the old
// crusade-wide version, nothing here is merged across teams.
function computeTeamGuildSalaryDetail(teamNumber) {
  const team = getTeamData(teamNumber);
  const items = team.items || [];
  const itemSharesByParticipantId = items.map((item) => {
    const map = new Map();
    computeTeamItemShares(teamNumber, item).forEach(({ participant: p, total }) => map.set(p.id, total));
    return map;
  });

  const byGuild = new Map();
  computeTeamDistribution(teamNumber).forEach(({ participant: p, total }) => {
    const key = p.guildName || 'Unassigned';
    if (!byGuild.has(key)) byGuild.set(key, []);
    byGuild.get(key).push({
      name: p.name,
      goldBid: p.goldBid,
      attended: p.attended,
      salary: total,
      itemShares: itemSharesByParticipantId.map((m) => m.get(p.id) || 0),
      isFee: false,
      hasFee: false,
      isBonus: false,
      hasBonus: false,
    });
  });

  // If a fee's IGN matches an existing participant in the same guild
  // (case-insensitive), fold the fee into that one row instead of listing
  // them twice — just flag it so the row can note "+ management fee".
  (team.fees || []).forEach((fee) => {
    if (!fee.guildName) return;
    if (!byGuild.has(fee.guildName)) byGuild.set(fee.guildName, []);
    const entries = byGuild.get(fee.guildName);
    const feeAmount = crusadeFeeAmount(fee, team);
    const match = entries.find((e) => !e.isFee && e.name.trim().toLowerCase() === fee.name.trim().toLowerCase());
    if (match) {
      match.salary += feeAmount;
      match.hasFee = true;
    } else {
      entries.push({
        name: fee.name,
        goldBid: null,
        attended: null,
        salary: feeAmount,
        itemShares: items.map(() => 0),
        isFee: true,
        hasFee: false,
        isBonus: false,
        hasBonus: false,
      });
    }
  });

  // Defense-win bonus: same name-match merge as management fees, so a
  // last-team bidder who's also on this team's roster gets one row with the
  // bonus folded in, instead of a duplicate line.
  const { perBidder } = computeTeamBonusShares(teamNumber);
  if (perBidder > 0) {
    (team.lastTeamBidders || []).forEach((bidder) => {
      const guildKey = bidder.guildName || 'Unassigned';
      if (!byGuild.has(guildKey)) byGuild.set(guildKey, []);
      const entries = byGuild.get(guildKey);
      const match = entries.find((e) => !e.isFee && e.name.trim().toLowerCase() === bidder.name.trim().toLowerCase());
      if (match) {
        match.salary += perBidder;
        match.hasBonus = true;
      } else {
        entries.push({
          name: bidder.name,
          goldBid: null,
          attended: null,
          salary: perBidder,
          itemShares: items.map(() => 0),
          isFee: false,
          hasFee: false,
          isBonus: true,
          hasBonus: false,
        });
      }
    });
  }

  return Array.from(byGuild.entries())
    .map(([name, entries]) => ({
      name,
      entries: entries.sort((a, b) => b.salary - a.salary),
      memberCount: entries.filter((e) => !e.isFee && !e.isBonus).length,
      total: entries.reduce((sum, e) => sum + e.salary, 0),
      itemTotals: items.map((_, i) => entries.reduce((sum, e) => sum + (e.itemShares[i] || 0), 0)),
    }))
    .sort((a, b) => b.total - a.total);
}

// Back to a table (IGN / Max Bid / Present / Salary / one column per item)
// instead of the stacked list -- with several items per person, cramming
// "Max Bid X · Present Y · Item Z pcs · Item2 W pcs" onto one line read
// worse than aligned columns.
function renderTeamGuildSalaryCard(g, itemNames) {
  const rows = g.entries
    .map((e) => {
      const itemCells = itemNames.map((_, i) => `<td>${crusadeFormatItemQty(e.itemShares[i])}</td>`).join('');
      const tagLines = [];
      if (e.isFee) tagLines.push('(management fee)');
      else if (e.hasFee) tagLines.push('(+ management fee)');
      if (e.isBonus) tagLines.push('(defense bonus)');
      else if (e.hasBonus) tagLines.push('(+ defense bonus)');
      const tagLabel = tagLines
        .map((t) => `<div style="font-weight:400; font-size:11px; color:var(--text-muted); white-space:nowrap;">${t}</div>`)
        .join('');
      return `
    <tr>
      <td style="font-weight:600;"><div style="white-space:nowrap;">${escapeHtml(e.name)}</div>${tagLabel}</td>
      <td>${e.goldBid === null ? '–' : crusadeFormatGold(e.goldBid)}</td>
      <td>${e.attended === null ? '–' : e.attended ? '✓' : '✗'}</td>
      <td>${crusadeFormatDiamonds(e.salary)}</td>
      ${itemCells}
    </tr>`;
    })
    .join('');
  const totalRow = itemNames.length
    ? `<tr class="crusade-table-total-row"><td>Total</td><td></td><td></td><td>${crusadeFormatDiamonds(g.total)}</td>${itemNames
        .map((_, i) => `<td>${crusadeFormatItemQty(g.itemTotals[i])}</td>`)
        .join('')}</tr>`
    : '';
  return `
  <div class="crusade-party-card">
    <div class="crusade-party-card-header">
      <h3>${g.name === 'Unassigned' ? 'Unassigned' : escapeHtml(g.name)} — ${crusadeFormatDiamonds(g.total)} (${g.memberCount} member${g.memberCount === 1 ? '' : 's'})</h3>
    </div>
    <div class="table-scroll">
      <table class="members-table">
        <thead><tr><th>IGN</th><th>Max Bid</th><th>Present</th><th>Salary</th>${itemNames.map((name) => `<th>${escapeHtml(name)}</th>`).join('')}</tr></thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
    </div>
  </div>`;
}

// One collapsible section per team (Team 1, Team 2, ...), each holding that
// team's own guild-card breakdown -- every team is its own independent
// battle with its own reward, so nothing here is merged across teams.
function renderCrusadeGuildSalary() {
  const c = sovereignState.crusade;
  const dateText = c && c.eventDate ? formatLongDate(String(c.eventDate).slice(0, 10)) : 'No date set';
  document.getElementById('crusadeGuildSalaryMeta').textContent = `${c ? c.name : ''} — ${dateText}`;

  const el = document.getElementById('crusadeGuildSalaryDetail');
  el.innerHTML = allKnownTeamNumbers()
    .map((teamNumber) => {
      const team = getTeamData(teamNumber);
      const guilds = computeTeamGuildSalaryDetail(teamNumber);
      const itemNames = (team.items || []).map((i) => i.name);
      const teamTotal = guilds.reduce((sum, g) => sum + g.total, 0);
      const cards = guilds.length
        ? guilds.map((g) => renderTeamGuildSalaryCard(g, itemNames)).join('')
        : '<p class="empty-state">No participants in this team yet.</p>';

      return `
      <details class="crusade-team-salary-section" open>
        <summary class="crusade-team-salary-header">
          <h3>Team ${teamNumber}</h3>
          ${crusadeStatusBadge(team.result)}
          <span style="color:var(--text-muted); font-size:13px;">${crusadeFormatDiamonds(teamTotal)}</span>
        </summary>
        <div class="crusade-party-grid">${cards}</div>
      </details>`;
    })
    .join('');

  renderLastCrusadeBidders();
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
      if (!bidders.length) return null;
      const { perBidder } = computeTeamBonusShares(teamNumber);
      const lastTeam = team.lastTeam;
      const sourceText = lastTeam
        ? `${lastTeam.crusadeName} Team ${lastTeam.teamNumber} — ${lastTeam.eventDate ? formatLongDate(String(lastTeam.eventDate).slice(0, 10)) : 'No date set'}`
        : '';

      const rows = bidders
        .map(
          (b) => `
        <tr>
          <td style="font-weight:600; white-space:nowrap;">${escapeHtml(b.name)}</td>
          <td>${crusadeGuildBadge(b.guildName)}</td>
          <td>${crusadeFormatGold(b.goldBid)}</td>
          <td>${crusadeFormatDiamonds(perBidder)}</td>
        </tr>`
        )
        .join('');
      const totalRow = `<tr class="crusade-table-total-row"><td>Total</td><td></td><td></td><td>${crusadeFormatDiamonds(perBidder * bidders.length)}</td></tr>`;

      return `
      <div class="crusade-party-card">
        <div class="crusade-party-card-header">
          <h3>Team ${teamNumber}'s bonus — from ${sourceText}</h3>
        </div>
        <div class="table-scroll">
          <table class="members-table">
            <thead><tr><th>IGN</th><th>Guild</th><th>Gold Bid</th><th>Bonus Share</th></tr></thead>
            <tbody>${rows}${totalRow}</tbody>
          </table>
        </div>
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
          ({ participant: p, attendanceAmount, bidShare, total }) => `
      <tr>
        <td style="font-weight:600; white-space:nowrap;">${escapeHtml(p.name)}</td>
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
      return `
      <div class="crusade-party-card">
        <div class="crusade-party-card-header">
          <h3>Party ${slot} — ${rowsInParty.length}/${CRUSADE_PARTY_MAX_MEMBERS}</h3>
          <button type="button" class="icon-btn admin-only" data-add-to-party-slot="${slot}" title="Add to Party ${slot}" ${full ? 'disabled' : ''}>+</button>
        </div>
        <div class="table-scroll">
          <table class="members-table">
            <thead>
              <tr>
                <th>Name</th><th>Guild</th><th>Position</th><th>Gold Bid</th><th>Enter</th>
                <th>Attendance</th><th>Bid Share</th><th>Total Diamonds</th>
                <th class="admin-only">Paid</th><th class="admin-only"></th>
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
    if (!fee.guildName) return;
    feeCreditsByGuild.set(fee.guildName, (feeCreditsByGuild.get(fee.guildName) || 0) + crusadeFeeAmount(fee, team));
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
  form.elements.goldBid.value = participant ? participant.goldBid : 30000000;
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

// Half a team's (post-fee, post-defense-split) reward splits evenly across
// everyone on that team who attended; the other half splits across that
// team's gold bidders in proportion to their bid — this collapses to an
// equal split when every bidder bids the same amount (the common case), and
// scales fairly when bids differ.
function computeTeamDistribution(teamNumber) {
  const team = getTeamData(teamNumber);
  const participants = sovereignState.participants.filter((p) => p.partyNumber === teamNumber);
  if (crusadeWasLost(team)) {
    return participants.map((p) => ({ participant: p, attendanceAmount: 0, bidShare: 0, total: 0 }));
  }

  const netReward = Math.max(0, team.diamondReward - totalTeamFeeAmount(team));
  const ownPool = isTeamDefenseWin(team) ? netReward * 0.6 : netReward;
  const attendancePool = ownPool * (team.attendancePct / 100);
  const bidPool = ownPool - attendancePool;

  const attendees = participants.filter((p) => p.attended);
  const attendanceShare = attendees.length ? attendancePool / attendees.length : 0;
  const totalBid = participants.reduce((sum, p) => sum + (p.goldBid > 0 ? p.goldBid : 0), 0);

  return participants.map((p) => {
    const attendanceAmount = p.attended ? attendanceShare : 0;
    const bidShare = p.goldBid > 0 && totalBid > 0 ? bidPool * (p.goldBid / totalBid) : 0;
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
    `<th>Guild</th>${items.map((it) => `<th>${escapeHtml(it.name)}</th>`).join('')}<th>Members</th>`;

  const memberCountByGuild = new Map();
  teamParticipants.forEach((p) => {
    const key = p.guildName || 'Unassigned';
    memberCountByGuild.set(key, (memberCountByGuild.get(key) || 0) + 1);
  });

  const rows = guildNames.map((guildName) => {
    const color = guildName === 'Unassigned' ? null : crusadeGuildColor(guildName);
    const cells = shareByGuildPerItem.map((byGuild) => `<td>${crusadeFormatItemQty(byGuild.get(guildName) || 0)}</td>`).join('');
    return `<tr>
      <td style="font-weight:600; ${color ? `color:${color};` : ''}">${escapeHtml(guildName)}</td>
      ${cells}
      <td>${memberCountByGuild.get(guildName)}</td>
    </tr>`;
  });

  const totalCells = shareByGuildPerItem
    .map((byGuild) => `<td>${crusadeFormatItemQty(Array.from(byGuild.values()).reduce((sum, v) => sum + v, 0))}</td>`)
    .join('');
  rows.push(`<tr class="crusade-table-total-row"><td>Total</td>${totalCells}<td>${teamParticipants.length}</td></tr>`);

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
      <span style="flex:1;">${escapeHtml(fee.name)}</span>
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
        return `<td style="white-space:nowrap;">${escapeHtml(m.name)} <button type="button" class="icon-btn admin-only" data-delete-member="${m.id}" title="Remove from member list">✕</button></td>`;
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

document.getElementById('raffleDrawBtn').addEventListener('click', async () => {
  const checked = Array.from(document.querySelectorAll('.raffle-guild-check:checked')).map((cb) => cb.getAttribute('data-name'));
  if (!checked.length) return;

  const winnerName = checked[Math.floor(Math.random() * checked.length)];
  const drawBtn = document.getElementById('raffleDrawBtn');
  const display = document.getElementById('raffleDrawDisplay');

  // The pick above is already final -- this just spins through the checked
  // names first (slowing down toward the end) so the draw feels like an
  // actual random shuffle landing on a winner, not an instant lookup.
  drawBtn.disabled = true;
  display.classList.remove('hidden');
  const spinDelays = [70, 70, 70, 80, 90, 110, 140, 180, 230, 300, 380];
  for (const delay of spinDelays) {
    display.textContent = checked[Math.floor(Math.random() * checked.length)];
    await sleep(delay);
  }
  display.textContent = winnerName;

  try {
    const created = await api('/api/raffle-winners', {
      method: 'POST',
      body: JSON.stringify({ memberName: winnerName, guildName: winnerName }),
    });
    sovereignState.raffleWinners.unshift(created);
    renderRafflePool();
    renderRaffleWinners();
    refreshRaffleActivity();
    toast(`🎲 ${winnerName} wins!`);
  } catch (err) {
    toast(err.message);
    updateRafflePoolCount(); // POST failed, so renderRafflePool() never ran to reset the button itself
  } finally {
    await sleep(1200);
    display.classList.add('hidden');
  }
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

function renderRaffleWinners() {
  const winners = sovereignState.raffleWinners;
  document.getElementById('raffleWinnersEmptyState').classList.toggle('hidden', winners.length !== 0);

  const list = document.getElementById('raffleWinnersList');
  list.innerHTML = winners
    .map((w) => {
      const color = crusadeGuildColor(w.guildName) || 'var(--text-muted)';
      const time = new Date(w.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `
      <div class="crusade-guild-summary-row" data-winner-id="${w.id}">
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
