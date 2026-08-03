const queueState = {
  slots: [],
  queue: {},
  done: {},
  members: [],
};

function latestRateByName() {
  const map = new Map();
  queueState.members.forEach((m) => {
    if (m.growth.length) map.set(m.name, m.growth[m.growth.length - 1].rate);
  });
  return map;
}

async function loadQueueData() {
  const [{ slots, queue, done }, members] = await Promise.all([api('/api/queue'), api('/api/members')]);
  queueState.slots = slots;
  queueState.queue = queue;
  queueState.done = done;
  queueState.members = members;
  populateQueueDatalist();
  renderQueueView();
}

function populateQueueDatalist() {
  const list = document.getElementById('memberNamesList');
  list.innerHTML = queueState.members.map((m) => `<option value="${escapeHtml(m.name)}">`).join('');
}

function renderQueueView() {
  const root = document.getElementById('queueColumns');
  root.innerHTML = '';
  queueState.slots.forEach((slot) => {
    root.appendChild(renderQueueColumn(slot));
  });
  renderQueueHistory();
}

function renderQueueColumn(slot) {
  const col = document.createElement('div');
  col.className = 'queue-col';

  const names = queueState.queue[slot] || [];
  const items = names
    .map(
      (name, i) => `
      <li class="queue-item" data-index="${i}">
        <span class="queue-rank">${i + 1}</span>
        <input type="checkbox" class="queue-done-check" data-name="${escapeHtml(name)}" title="Mark as done — removes them from this queue">
        <span class="queue-name">${escapeHtml(name)}</span>
        <span class="queue-actions">
          <button class="icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-act="down" title="Move down" ${i === names.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" data-act="remove" title="Remove">✕</button>
        </span>
      </li>`
    )
    .join('');

  col.innerHTML = `
    <div class="queue-col-header">${escapeHtml(slot)}</div>
    <ol class="queue-list">${items}</ol>
    <form class="queue-add-form">
      <input type="text" list="memberNamesList" placeholder="Add name…" required maxlength="40">
      <button type="submit" class="btn small" title="Add to queue">+</button>
    </form>
    <button type="button" class="btn small ghost queue-sort-btn">Sort by Growth Rate</button>
  `;

  col.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const li = btn.closest('.queue-item');
      const i = Number(li.getAttribute('data-index'));
      const arr = queueState.queue[slot].slice();
      if (btn.dataset.act === 'up' && i > 0) {
        [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      } else if (btn.dataset.act === 'down' && i < arr.length - 1) {
        [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
      } else if (btn.dataset.act === 'remove') {
        arr.splice(i, 1);
      } else {
        return;
      }
      saveQueueSlot(slot, arr);
    });
  });

  col.querySelectorAll('.queue-done-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (!cb.checked) return;
      const li = cb.closest('.queue-item');
      li.classList.add('queue-item-done');
      completeQueueMember(slot, cb.getAttribute('data-name'));
    });
  });

  col.querySelector('.queue-add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const name = input.value.trim();
    if (!name) return;
    const arr = queueState.queue[slot].slice();
    arr.push(name);
    saveQueueSlot(slot, arr);
  });

  col.querySelector('.queue-sort-btn').addEventListener('click', () => {
    const rates = latestRateByName();
    const arr = queueState.queue[slot].slice();
    arr.sort((a, b) => {
      const ra = rates.has(a) ? rates.get(a) : -Infinity;
      const rb = rates.has(b) ? rates.get(b) : -Infinity;
      return rb - ra;
    });
    saveQueueSlot(slot, arr);
    toast(`${slot} sorted by growth rate`);
  });

  return col;
}

// "Who already got it" — one card per part, listing everyone who's ever been
// marked done for it (permanent, independent of the active queue lists).
function renderQueueHistory() {
  const root = document.getElementById('queueHistory');
  if (!root) return;

  root.innerHTML = queueState.slots
    .map((slot) => {
      const entries = (queueState.done[slot] || [])
        .slice()
        .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
      const rows = entries.length
        ? entries
            .map(
              (e) => `
          <li class="queue-history-item">
            <span class="queue-history-name">${escapeHtml(e.name)}</span>
            <span class="queue-history-date">${new Date(e.completedAt).toLocaleDateString()}</span>
            <button class="icon-btn" data-undo-slot="${escapeHtml(slot)}" data-undo-name="${escapeHtml(e.name)}" title="Undo — does not re-queue them">✕</button>
          </li>`
            )
            .join('')
        : '<li class="queue-history-empty">No one yet.</li>';
      return `
      <div class="queue-history-col">
        <div class="queue-col-header queue-history-header">${escapeHtml(slot)} <span class="queue-history-count">${entries.length}</span></div>
        <ul class="queue-history-list">${rows}</ul>
      </div>`;
    })
    .join('');

  root.querySelectorAll('[data-undo-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      undoQueueCompletion(btn.getAttribute('data-undo-slot'), btn.getAttribute('data-undo-name'));
    });
  });
}

async function saveQueueSlot(slot, names) {
  try {
    const result = await api(`/api/queue/${encodeURIComponent(slot)}`, {
      method: 'PUT',
      body: JSON.stringify({ names }),
    });
    queueState.queue[slot] = result.names;
    queueState.done[slot] = result.done;
    renderQueueView();
  } catch (err) {
    toast(err.message);
  }
}

async function completeQueueMember(slot, name) {
  try {
    const result = await api(`/api/queue/${encodeURIComponent(slot)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    queueState.queue[slot] = result.names;
    queueState.done[slot] = result.done;
    renderQueueView();
    toast(`${name} marked done for ${slot}`);
  } catch (err) {
    toast(err.message);
    renderQueueView();
  }
}

async function undoQueueCompletion(slot, name) {
  try {
    const result = await api(`/api/queue/${encodeURIComponent(slot)}/complete/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    queueState.done[slot] = result.done;
    renderQueueView();
    toast(`Removed ${name} from ${slot} history`);
  } catch (err) {
    toast(err.message);
  }
}
