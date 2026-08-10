const scheduleState = {
  month: null,
  servers: [], // [{id, name}]
  schedule: {}, // { 'YYYY-MM-DD': 'Server Name' }
  mode: 'manual',
  evenlyOrder: [], // server names, user-orderable — rotation order for "evenly"
};

const SCHEDULE_COLORS = ['#22c55e', '#3b82f6', '#f2a93c', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];
const SCHEDULE_WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleColorForServer(name) {
  const idx = scheduleState.servers.findIndex((s) => s.name === name);
  return idx === -1 ? null : SCHEDULE_COLORS[idx % SCHEDULE_COLORS.length];
}

async function loadCaveScheduleData() {
  const monthInput = document.getElementById('caveScheduleMonthInput');
  if (!scheduleState.month) scheduleState.month = currentMonthValue();
  monthInput.value = scheduleState.month;

  const [servers, schedule] = await Promise.all([
    api('/api/cave-schedule-servers'),
    api(`/api/cave-schedule?month=${scheduleState.month}`),
  ]);
  scheduleState.servers = servers;
  scheduleState.schedule = {};
  schedule.forEach((s) => {
    scheduleState.schedule[s.date] = s.serverName;
  });

  // Keep any custom ordering the admin already set up, but drop servers that
  // no longer exist and append newly-added ones at the end.
  const known = new Set(servers.map((s) => s.name));
  scheduleState.evenlyOrder = scheduleState.evenlyOrder.filter((n) => known.has(n));
  servers.forEach((s) => {
    if (!scheduleState.evenlyOrder.includes(s.name)) scheduleState.evenlyOrder.push(s.name);
  });

  renderScheduleView();
}

function renderScheduleView() {
  document.getElementById('scheduleNoServersState').classList.toggle('hidden', scheduleState.servers.length !== 0);
  renderScheduleLegend();
  renderScheduleCalendar();
  renderScheduleEvenlyOrder();
}

function renderScheduleLegend() {
  document.getElementById('scheduleCalendarLegend').innerHTML = scheduleState.servers
    .map(
      (s, i) => `<span class="schedule-legend-item"><span class="schedule-dot" style="background:${SCHEDULE_COLORS[i % SCHEDULE_COLORS.length]}"></span>${escapeHtml(s.name)}</span>`
    )
    .join('');
}

// What the calendar would look like if "Apply to This Month" were clicked
// right now, computed from the current evenlyOrder — day 1 of the month
// gets evenlyOrder[0], day 2 gets evenlyOrder[1], wrapping around. Purely a
// client-side preview; nothing is saved until Apply actually runs the same
// rotation server-side.
function getEvenlyPreviewSchedule() {
  if (!scheduleState.evenlyOrder.length) return {};
  const [year, month] = scheduleState.month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const preview = {};
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${scheduleState.month}-${String(day).padStart(2, '0')}`;
    preview[date] = scheduleState.evenlyOrder[(day - 1) % scheduleState.evenlyOrder.length];
  }
  return preview;
}

function renderScheduleCalendar() {
  document.getElementById('scheduleMonthHeading').textContent = formatMonthYear(scheduleState.month);
  document.getElementById('scheduleWeekdayRow').innerHTML = SCHEDULE_WEEKDAY_LABELS.map((d) => `<div class="schedule-weekday">${d}</div>`).join('');

  const [year, month] = scheduleState.month.split('-').map(Number);
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isManual = scheduleState.mode === 'manual';
  const displaySchedule = isManual ? scheduleState.schedule : getEvenlyPreviewSchedule();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div class="schedule-day schedule-day-empty"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${scheduleState.month}-${String(day).padStart(2, '0')}`;
    const assigned = displaySchedule[date];
    const color = assigned ? scheduleColorForServer(assigned) : null;
    const optionsHtml = scheduleState.servers
      .map((s) => `<option value="${escapeHtml(s.name)}" ${s.name === assigned ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
      .join('');
    cells.push(`
      <div class="schedule-day ${color ? 'schedule-day-filled' : ''}" style="${color ? `background:${color};` : ''}">
        <div class="schedule-day-number">${day}</div>
        ${
          isManual
            ? `<select class="schedule-day-select" data-date="${date}"><option value="">—</option>${optionsHtml}</select>`
            : assigned
              ? `<div class="schedule-day-badge">${escapeHtml(assigned)}</div>`
              : `<div class="schedule-day-badge schedule-day-badge-empty">—</div>`
        }
      </div>`);
  }

  const grid = document.getElementById('scheduleCalendarGrid');
  grid.innerHTML = cells.join('');

  if (isManual) {
    grid.querySelectorAll('.schedule-day-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const date = sel.getAttribute('data-date');
        try {
          await api(`/api/cave-schedule/${date}`, { method: 'PUT', body: JSON.stringify({ serverName: sel.value }) });
          if (sel.value) scheduleState.schedule[date] = sel.value;
          else delete scheduleState.schedule[date];
          renderScheduleCalendar();
        } catch (err) {
          toast(err.message);
        }
      });
    });
  }
}

function renderScheduleEvenlyOrder() {
  const el = document.getElementById('scheduleEvenlyOrderList');
  if (!scheduleState.evenlyOrder.length) {
    el.innerHTML = `<p class="empty-state" style="padding:8px 0;">Add servers first via "Manage Servers".</p>`;
    return;
  }

  el.innerHTML = scheduleState.evenlyOrder
    .map((name, i) => {
      const color = scheduleColorForServer(name) || 'var(--text-muted)';
      return `
      <div class="schedule-order-row">
        <span class="schedule-dot" style="background:${color}"></span>
        <span style="flex:1;">${i + 1}. ${escapeHtml(name)}</span>
        <button type="button" class="icon-btn" data-move-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" class="icon-btn" data-move-down="${i}" ${i === scheduleState.evenlyOrder.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
      </div>`;
    })
    .join('');

  el.querySelectorAll('[data-move-up]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-move-up'));
      [scheduleState.evenlyOrder[i - 1], scheduleState.evenlyOrder[i]] = [scheduleState.evenlyOrder[i], scheduleState.evenlyOrder[i - 1]];
      renderScheduleEvenlyOrder();
      renderScheduleCalendar();
    });
  });
  el.querySelectorAll('[data-move-down]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-move-down'));
      [scheduleState.evenlyOrder[i + 1], scheduleState.evenlyOrder[i]] = [scheduleState.evenlyOrder[i], scheduleState.evenlyOrder[i + 1]];
      renderScheduleEvenlyOrder();
      renderScheduleCalendar();
    });
  });
}

document.getElementById('caveScheduleMonthInput').addEventListener('change', (e) => {
  scheduleState.month = e.target.value;
  loadCaveScheduleData().catch((err) => toast(err.message));
});

document.querySelectorAll('input[name="scheduleMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    scheduleState.mode = document.querySelector('input[name="scheduleMode"]:checked').value;
    document.getElementById('scheduleEvenlyControls').classList.toggle('hidden', scheduleState.mode !== 'evenly');
    document.getElementById('scheduleManualHint').classList.toggle('hidden', scheduleState.mode !== 'manual');
    renderScheduleCalendar();
  });
});

document.getElementById('applyEvenlyScheduleBtn').addEventListener('click', async () => {
  if (!scheduleState.evenlyOrder.length) return;
  if (!confirm(`Overwrite the entire schedule for ${scheduleState.month} using this rotation, starting with "${scheduleState.evenlyOrder[0]}" on day 1?`)) return;
  try {
    await api('/api/cave-schedule/apply-evenly', {
      method: 'POST',
      body: JSON.stringify({ month: scheduleState.month, serverOrder: scheduleState.evenlyOrder }),
    });
    toast('Schedule applied');
    loadCaveScheduleData().catch((err) => toast(err.message));
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Manage Servers modal ----------

function renderScheduleServerList() {
  const list = document.getElementById('scheduleServerList');
  list.innerHTML = scheduleState.servers
    .map(
      (s, i) => `
      <li style="display:flex; gap:8px; align-items:center;" data-server-id="${s.id}">
        <span class="schedule-dot" style="background:${SCHEDULE_COLORS[i % SCHEDULE_COLORS.length]}"></span>
        <span style="flex:1;">${escapeHtml(s.name)}</span>
        <button type="button" class="icon-btn" data-delete-server="${s.id}" title="Delete server">✕</button>
      </li>`
    )
    .join('');

  list.querySelectorAll('[data-delete-server]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-server');
      const server = scheduleState.servers.find((s) => s.id === id);
      if (!confirm(`Remove "${server.name}" from the server list? Dates already assigned to it keep showing it, but it won't be offered anymore.`)) return;
      try {
        await api(`/api/cave-schedule-servers/${id}`, { method: 'DELETE' });
        scheduleState.servers = scheduleState.servers.filter((s) => s.id !== id);
        renderScheduleServerList();
        renderScheduleView();
        toast('Server removed');
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

document.getElementById('manageScheduleServersBtn').addEventListener('click', () => {
  renderScheduleServerList();
  document.getElementById('manageScheduleServersModal').classList.remove('hidden');
});

document.getElementById('addScheduleServerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const server = await api('/api/cave-schedule-servers', { method: 'POST', body: JSON.stringify({ name: fd.get('name') }) });
    scheduleState.servers.push(server);
    scheduleState.evenlyOrder.push(server.name);
    renderScheduleServerList();
    renderScheduleView();
    e.target.reset();
    toast(`${server.name} added`);
  } catch (err) {
    toast(err.message);
  }
});
