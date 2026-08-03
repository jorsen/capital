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
}

function renderQueueColumn(slot) {
  const col = document.createElement('div');
  col.className = 'queue-col';

  const names = queueState.queue[slot] || [];
  const doneNames = queueState.done[slot] || [];
  const items = names
    .map((name, i) => {
      const isDone = doneNames.includes(name);
      return `
      <li class="queue-item${isDone ? ' queue-item-done' : ''}" data-index="${i}">
        <span class="queue-rank">${i + 1}</span>
        <input type="checkbox" class="queue-done-check" data-name="${escapeHtml(name)}" title="Mark as done" ${isDone ? 'checked' : ''}>
        <span class="queue-name">${escapeHtml(name)}</span>
        <span class="queue-actions">
          <button class="icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-act="down" title="Move down" ${i === names.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" data-act="remove" title="Remove">✕</button>
        </span>
      </li>`;
    })
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
      const name = cb.getAttribute('data-name');
      const doneArr = new Set(queueState.done[slot] || []);
      if (cb.checked) doneArr.add(name);
      else doneArr.delete(name);
      saveQueueDone(slot, Array.from(doneArr));
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

async function saveQueueDone(slot, done) {
  try {
    const result = await api(`/api/queue/${encodeURIComponent(slot)}/done`, {
      method: 'PUT',
      body: JSON.stringify({ done }),
    });
    queueState.done[slot] = result.done;
    renderQueueView();
  } catch (err) {
    toast(err.message);
  }
}
