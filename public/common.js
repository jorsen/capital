async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2500);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function totalQty(session) {
  return session.records.reduce((sum, r) => sum + r.quantity, 0);
}

function itemIconImg(iconUrl, name, size) {
  const px = size || 32;
  const style = `width:${px}px; height:${px}px;`;
  if (iconUrl) {
    return `<img src="${escapeHtml(iconUrl)}" alt="" class="item-icon" style="${style}">`;
  }
  return `<span class="item-icon item-icon-placeholder" style="${style}" title="${escapeHtml(name || '')}"></span>`;
}

// Delegated once for every modal on the page, regardless of which view rendered it.
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) {
    document.getElementById(closeBtn.getAttribute('data-close')).classList.add('hidden');
    return;
  }
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});
