const membersState = {
  members: [],
  classes: [],
  search: '',
  classFilter: '',
  sortKey: 'name',
  sortDir: 1,
  loaded: false,
};

const SVGNS = 'http://www.w3.org/2000/svg';

function latestGrowth(member) {
  if (!member.growth.length) return null;
  return member.growth[member.growth.length - 1];
}

function fmtRate(rate) {
  if (rate === null || rate === undefined) return '–';
  const sign = rate > 0 ? '+' : '';
  return `${sign}${rate.toLocaleString()}`;
}

function growthClass(rate) {
  if (rate === null || rate === undefined) return 'neutral';
  if (rate > 0) return 'pos';
  if (rate < 0) return 'neg';
  return 'neutral';
}

// ---------- Load ----------

async function loadMembersData() {
  const [classes, members] = await Promise.all([api('/api/classes'), api('/api/members')]);
  membersState.classes = classes;
  membersState.members = members;
  membersState.loaded = true;
  populateClassOptions();
  renderMembersView();
}

function populateClassOptions() {
  const selects = [document.getElementById('classSelect')];
  selects.forEach((sel) => {
    sel.innerHTML = membersState.classes.map((c) => `<option value="${c}">${c}</option>`).join('');
  });
  const filter = document.getElementById('classFilter');
  const current = filter.value;
  filter.innerHTML =
    '<option value="">All Classes</option>' +
    membersState.classes.map((c) => `<option value="${c}">${c}</option>`).join('');
  filter.value = current;
}

// ---------- Render orchestration ----------

function getFilteredSortedMembers() {
  let list = membersState.members.filter((m) => {
    const matchesSearch = m.name.toLowerCase().includes(membersState.search.toLowerCase());
    const matchesClass = !membersState.classFilter || m.className === membersState.classFilter;
    return matchesSearch && matchesClass;
  });
  list = list.slice().sort((a, b) => {
    let av, bv;
    if (membersState.sortKey === 'latest') {
      av = latestGrowth(a)?.rate ?? -Infinity;
      bv = latestGrowth(b)?.rate ?? -Infinity;
    } else {
      av = (a[membersState.sortKey] || '').toLowerCase();
      bv = (b[membersState.sortKey] || '').toLowerCase();
    }
    if (av < bv) return -1 * membersState.sortDir;
    if (av > bv) return 1 * membersState.sortDir;
    return 0;
  });
  return list;
}

function renderMembersView() {
  renderStats();
  renderClassChart();
  renderTable();
}

function renderStats() {
  const members = membersState.members;
  document.getElementById('statTotal').textContent = members.length;

  const rates = members.map((m) => latestGrowth(m)?.rate).filter((r) => r !== null && r !== undefined);
  const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  document.getElementById('statAvg').textContent = avg === null ? '–' : Math.round(avg).toLocaleString();

  let top = null;
  members.forEach((m) => {
    const g = latestGrowth(m);
    if (g && (top === null || g.rate > top.rate)) top = { name: m.name, rate: g.rate };
  });
  document.getElementById('statTop').textContent = top ? `${top.name} (${fmtRate(top.rate)})` : '–';
}

// ---------- Class distribution bar chart ----------

function renderClassChart() {
  const root = document.getElementById('classChart');
  root.innerHTML = '';

  const counts = membersState.classes.map((c) => ({
    className: c,
    count: membersState.members.filter((m) => m.className === c).length,
  }));
  counts.sort((a, b) => b.count - a.count);

  const maxCount = Math.max(1, ...counts.map((c) => c.count));
  const rowHeight = 26;
  const width = Math.max(320, root.clientWidth || 560);
  const labelWidth = 150;
  const chartWidth = width - labelWidth - 50;
  const height = counts.length * rowHeight + 10;

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  root.appendChild(tooltip);

  counts.forEach((row, i) => {
    const y = i * rowHeight + 6;
    const barW = (row.count / maxCount) * chartWidth;

    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('x', labelWidth - 8);
    label.setAttribute('y', y + rowHeight / 2 + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'bar-row-label');
    label.textContent = row.className;
    svg.appendChild(label);

    const track = document.createElementNS(SVGNS, 'rect');
    track.setAttribute('x', labelWidth);
    track.setAttribute('y', y + 4);
    track.setAttribute('width', chartWidth);
    track.setAttribute('height', rowHeight - 12);
    track.setAttribute('rx', 4);
    track.setAttribute('class', 'grid-line');
    track.setAttribute('fill', 'none');
    svg.appendChild(track);

    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('x', labelWidth);
    rect.setAttribute('y', y + 4);
    rect.setAttribute('width', Math.max(2, barW));
    rect.setAttribute('height', rowHeight - 12);
    rect.setAttribute('rx', 4);
    rect.setAttribute('class', 'bar-rect');
    svg.appendChild(rect);

    rect.addEventListener('mousemove', (e) => {
      const rectBounds = root.getBoundingClientRect();
      tooltip.textContent = `${row.className}: ${row.count} member${row.count === 1 ? '' : 's'}`;
      tooltip.style.left = `${e.clientX - rectBounds.left}px`;
      tooltip.style.top = `${e.clientY - rectBounds.top}px`;
      tooltip.classList.add('show');
    });
    rect.addEventListener('mouseleave', () => tooltip.classList.remove('show'));

    const value = document.createElementNS(SVGNS, 'text');
    value.setAttribute('x', labelWidth + Math.max(2, barW) + 8);
    value.setAttribute('y', y + rowHeight / 2 + 4);
    value.setAttribute('class', 'bar-row-value');
    value.textContent = row.count;
    svg.appendChild(value);
  });

  root.appendChild(svg);
}

// ---------- Members table ----------

function renderTable() {
  const list = getFilteredSortedMembers();
  const body = document.getElementById('membersBody');
  body.innerHTML = '';
  document.getElementById('membersEmptyState').classList.toggle('hidden', membersState.members.length !== 0);

  list.forEach((m) => {
    const tr = document.createElement('tr');
    const g = latestGrowth(m);
    tr.innerHTML = `
      <td><span class="member-name"><span class="avatar">${escapeHtml(initials(m.name))}</span>${escapeHtml(m.name)}</span></td>
      <td><span class="class-badge">${escapeHtml(m.className)}</span></td>
      <td class="col-right growth-value ${growthClass(g?.rate)}">${fmtRate(g?.rate)}</td>
      <td class="col-center sparkline-cell"></td>
      <td class="col-right"><button class="icon-btn" data-delete="${m.id}" title="Delete member">✕</button></td>
    `;
    tr.querySelector('.sparkline-cell').appendChild(renderSparkline(m.growth));
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete]')) return;
      openMemberModal(m.id);
    });
    tr.querySelector('[data-delete]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove ${m.name} from the tracker?`)) return;
      await api(`/api/members/${m.id}`, { method: 'DELETE' });
      membersState.members = membersState.members.filter((x) => x.id !== m.id);
      renderMembersView();
      toast(`${m.name} removed`);
    });
    body.appendChild(tr);
  });
}

function renderSparkline(growth) {
  const wrap = document.createElement('div');
  if (growth.length < 2) {
    wrap.innerHTML = '<span class="sparkline-empty">—</span>';
    return wrap;
  }
  const points = growth.slice(-8);
  const w = 80, h = 24, pad = 3;
  const rates = points.map((p) => p.rate);
  const min = Math.min(...rates), max = Math.max(...rates);
  const span = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const path = document.createElementNS(SVGNS, 'path');
  const d = points
    .map((p, i) => {
      const x = pad + i * step;
      const y = h - pad - ((p.rate - min) / span) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
  path.setAttribute('d', d);
  path.setAttribute('class', 'sparkline-path');
  svg.appendChild(path);
  wrap.appendChild(svg);
  return wrap;
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}

// ---------- Member detail modal ----------

function openMemberModal(id) {
  const member = membersState.members.find((m) => m.id === id);
  if (!member) return;
  renderMemberModal(member);
  document.getElementById('memberModal').classList.remove('hidden');
}

function renderMemberModal(member) {
  const content = document.getElementById('memberModalContent');
  const classOptions = membersState.classes
    .map((c) => `<option value="${c}" ${c === member.className ? 'selected' : ''}>${c}</option>`)
    .join('');

  const growthRows = member.growth
    .slice()
    .reverse()
    .map(
      (g) => `
      <tr>
        <td>${g.date}</td>
        <td class="growth-value ${growthClass(g.rate)}">${fmtRate(g.rate)}</td>
        <td>${escapeHtml(g.note || '')}</td>
        <td><button class="icon-btn" data-del-growth="${g.id}" title="Delete entry">✕</button></td>
      </tr>`
    )
    .join('');

  content.innerHTML = `
    <div class="member-header">
      <div>
        <h2>${escapeHtml(member.name)}</h2>
        <div class="member-meta">Joined ${new Date(member.createdAt).toLocaleDateString()}</div>
      </div>
    </div>
    <form id="editMemberForm" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
      <label style="flex:1; min-width:140px;">Name<input name="name" value="${escapeHtml(member.name)}" required></label>
      <label style="flex:1; min-width:160px;">Class<select name="className">${classOptions}</select></label>
      <label style="flex-basis:100%;">Notes<textarea name="notes" rows="2">${escapeHtml(member.notes || '')}</textarea></label>
      <button type="submit" class="btn small">Save Changes</button>
      <button type="button" class="btn small danger" id="deleteMemberBtn">Delete Member</button>
    </form>

    <h3 style="margin-bottom:6px;">Growth Rate History</h3>
    <div id="growthChart" class="chart-root"></div>

    <form id="addGrowthForm" class="growth-form-row">
      <label>Date<input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}"></label>
      <label>Growth Rate<input type="number" step="1" name="rate" required placeholder="e.g. 12500"></label>
      <label>Note<input type="text" name="note" placeholder="optional"></label>
      <button type="submit" class="btn primary small">Add Entry</button>
    </form>

    <table class="growth-table">
      <thead><tr><th>Date</th><th>Rate</th><th>Note</th><th></th></tr></thead>
      <tbody>${growthRows || '<tr><td colspan="4" style="color:var(--text-muted)">No growth entries yet.</td></tr>'}</tbody>
    </table>
  `;

  renderLineChart(document.getElementById('growthChart'), member.growth);

  content.querySelector('#editMemberForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const updated = await api(`/api/members/${member.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: fd.get('name'),
        className: fd.get('className'),
        notes: fd.get('notes'),
      }),
    });
    Object.assign(member, updated);
    renderMembersView();
    toast('Member updated');
  });

  content.querySelector('#deleteMemberBtn').addEventListener('click', async () => {
    if (!confirm(`Delete ${member.name} permanently?`)) return;
    await api(`/api/members/${member.id}`, { method: 'DELETE' });
    membersState.members = membersState.members.filter((m) => m.id !== member.id);
    document.getElementById('memberModal').classList.add('hidden');
    renderMembersView();
    toast(`${member.name} removed`);
  });

  content.querySelector('#addGrowthForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const entry = await api(`/api/members/${member.id}/growth`, {
      method: 'POST',
      body: JSON.stringify({
        date: fd.get('date'),
        rate: Number(fd.get('rate')),
        note: fd.get('note'),
      }),
    });
    member.growth.push(entry);
    member.growth.sort((a, b) => a.date.localeCompare(b.date));
    renderMemberModal(member);
    renderMembersView();
  });

  content.querySelectorAll('[data-del-growth]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const growthId = btn.getAttribute('data-del-growth');
      await api(`/api/members/${member.id}/growth/${growthId}`, { method: 'DELETE' });
      member.growth = member.growth.filter((g) => g.id !== growthId);
      renderMemberModal(member);
      renderMembersView();
    });
  });
}

// ---------- Line chart ----------

function renderLineChart(root, growth) {
  root.innerHTML = '';
  if (growth.length === 0) {
    root.innerHTML = '<p class="sparkline-empty">No data yet — add a growth entry below to start tracking.</p>';
    return;
  }

  const width = Math.max(300, root.clientWidth || 560);
  const height = 200;
  const padL = 60, padR = 16, padT = 16, padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const rates = growth.map((g) => g.rate);
  let min = Math.min(0, ...rates);
  let max = Math.max(0, ...rates);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;

  const xStep = growth.length > 1 ? innerW / (growth.length - 1) : 0;
  const yFor = (rate) => padT + innerH - ((rate - min) / (max - min)) * innerH;
  const xFor = (i) => padL + i * xStep;

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  // gridlines (4 horizontal)
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = min + ((max - min) * i) / steps;
    const y = yFor(val);
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', padL);
    line.setAttribute('x2', width - padR);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('class', 'grid-line');
    svg.appendChild(line);

    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('x', padL - 8);
    label.setAttribute('y', y + 4);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'axis-label');
    label.textContent = Math.round(val).toLocaleString();
    svg.appendChild(label);
  }

  // zero baseline emphasis
  if (min < 0 && max > 0) {
    const zeroLine = document.createElementNS(SVGNS, 'line');
    zeroLine.setAttribute('x1', padL);
    zeroLine.setAttribute('x2', width - padR);
    zeroLine.setAttribute('y1', yFor(0));
    zeroLine.setAttribute('y2', yFor(0));
    zeroLine.setAttribute('class', 'axis-line');
    svg.appendChild(zeroLine);
  }

  const d = growth.map((g, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(g.rate)}`).join(' ');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'line-path');
  svg.appendChild(path);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';

  growth.forEach((g, i) => {
    const circle = document.createElementNS(SVGNS, 'circle');
    circle.setAttribute('cx', xFor(i));
    circle.setAttribute('cy', yFor(g.rate));
    circle.setAttribute('r', 4);
    circle.setAttribute('class', 'line-point');
    circle.addEventListener('mousemove', (e) => {
      const bounds = root.getBoundingClientRect();
      tooltip.textContent = `${g.date}: ${fmtRate(g.rate)}${g.note ? ' — ' + g.note : ''}`;
      tooltip.style.left = `${e.clientX - bounds.left}px`;
      tooltip.style.top = `${e.clientY - bounds.top}px`;
      tooltip.classList.add('show');
    });
    circle.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
    svg.appendChild(circle);

    // sparse x labels: first, last, and evenly spaced if room
    if (growth.length <= 6 || i === 0 || i === growth.length - 1) {
      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('x', xFor(i));
      label.setAttribute('y', height - 8);
      label.setAttribute('text-anchor', i === 0 ? 'start' : i === growth.length - 1 ? 'end' : 'middle');
      label.setAttribute('class', 'axis-label');
      label.textContent = g.date.slice(5);
      svg.appendChild(label);
    }
  });

  root.appendChild(svg);
  root.appendChild(tooltip);
}

// ---------- Event wiring (bound once — DOM persists across view switches) ----------

document.getElementById('addMemberBtn').addEventListener('click', () => {
  document.getElementById('addModal').classList.remove('hidden');
});

document.getElementById('addMemberForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const member = await api('/api/members', {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        className: fd.get('className'),
        notes: fd.get('notes'),
      }),
    });
    membersState.members.push(member);
    renderMembersView();
    e.target.reset();
    document.getElementById('addModal').classList.add('hidden');
    toast(`${member.name} added`);
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById('membersSearchInput').addEventListener('input', (e) => {
  membersState.search = e.target.value;
  renderTable();
});

document.getElementById('classFilter').addEventListener('change', (e) => {
  membersState.classFilter = e.target.value;
  renderTable();
});

document.querySelectorAll('#view-members th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.getAttribute('data-sort');
    if (membersState.sortKey === key) {
      membersState.sortDir *= -1;
    } else {
      membersState.sortKey = key;
      membersState.sortDir = 1;
    }
    renderTable();
  });
});

window.addEventListener('resize', () => {
  if (!membersState.loaded) return;
  renderClassChart();
});
