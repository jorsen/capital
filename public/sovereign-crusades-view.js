const sovereignCrusadesState = { crusades: [], guilds: [] };

const CRUSADE_RESULT_LABELS = { pending: 'Pending', win: 'Win', lose: 'Lose', draw: 'Draw' };

function crusadeFormatDiamonds(amount) {
  return `${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 💎`;
}

function crusadeFormatGold(amount) {
  return (amount || 0).toLocaleString();
}

function crusadeGuildColor(guildName) {
  const guild = sovereignCrusadesState.guilds.find((g) => g.name === guildName);
  return guild ? guild.color : null;
}

async function loadSovereignCrusadesData() {
  const [crusades, guilds] = await Promise.all([api('/api/crusades'), api('/api/crusade-guilds')]);
  sovereignCrusadesState.crusades = crusades;
  sovereignCrusadesState.guilds = guilds;
  renderSovereignCrusadesList();
}

function renderSovereignCrusadesList() {
  const body = document.getElementById('sovereignCrusadesBody');
  const empty = document.getElementById('sovereignCrusadesEmptyState');
  const crusades = sovereignCrusadesState.crusades;
  empty.classList.toggle('hidden', crusades.length !== 0);

  body.innerHTML = crusades
    .map(
      (c) => `
    <tr>
      <td><a href="#/sovereign-crusade/${c.id}" style="font-weight:600;">${escapeHtml(c.name)}</a></td>
      <td>${c.eventDate ? escapeHtml(String(c.eventDate).slice(0, 10)) : '–'}</td>
      <td>${c.warType ? escapeHtml(c.warType) : '–'}</td>
      <td>${c.stance ? escapeHtml(c.stance) : '–'}</td>
      <td>${escapeHtml(CRUSADE_RESULT_LABELS[c.result] || c.result || 'Pending')}</td>
      <td>${c.participantCount}</td>
      <td>${crusadeFormatDiamonds(c.diamondReward)}</td>
      <td class="admin-only"><button type="button" class="icon-btn" data-delete-crusade="${c.id}" title="Delete crusade">✕</button></td>
    </tr>`
    )
    .join('');

  body.querySelectorAll('[data-delete-crusade]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-crusade');
      const crusade = sovereignCrusadesState.crusades.find((c) => c.id === id);
      if (!confirm(`Delete crusade "${crusade?.name}"? This also removes its entire roster.`)) return;
      try {
        await api(`/api/crusades/${id}`, { method: 'DELETE' });
        sovereignCrusadesState.crusades = sovereignCrusadesState.crusades.filter((c) => c.id !== id);
        renderSovereignCrusadesList();
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
    window.location.hash = `#/sovereign-crusade/${crusade.id}`;
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Manage Guilds modal ----------

function renderCrusadeGuildList() {
  const list = document.getElementById('crusadeGuildList');
  list.innerHTML = sovereignCrusadesState.guilds
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
      const guild = sovereignCrusadesState.guilds.find((g) => g.id === id);
      if (!confirm(`Remove guild "${guild.name}"? Participants already assigned to it keep showing it.`)) return;
      try {
        await api(`/api/crusade-guilds/${id}`, { method: 'DELETE' });
        sovereignCrusadesState.guilds = sovereignCrusadesState.guilds.filter((g) => g.id !== id);
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
    sovereignCrusadesState.guilds.push(guild);
    renderCrusadeGuildList();
    e.target.reset();
    e.target.querySelector('input[name="color"]').value = '#3b82f6';
    toast(`${guild.name} added`);
  } catch (err) {
    toast(err.message);
  }
});
