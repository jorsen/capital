// Populated before the first route renders (see router.js) so every view's
// first render already reflects the real role — avoids a flash of admin
// controls that then disappear once the session check resolves.
const appSession = { role: null };

function isAdmin() {
  return appSession.role === 'admin';
}

async function loadSession() {
  try {
    const { role } = await api('/api/session');
    appSession.role = role;
  } catch (err) {
    appSession.role = null;
  }
  document.body.classList.toggle('view-only', !isAdmin());
  const badge = document.getElementById('roleBadge');
  if (badge) badge.classList.toggle('hidden', isAdmin());
}

const sessionReady = loadSession();

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

function memberDisplayName(member) {
  return member.alias ? `${member.name} (${member.alias})` : member.name;
}

// "2026-08-10" -> "August 10, 2026" — used wherever a cave-attendance date
// is displayed to a person, rather than typed into a date input.
function formatLongDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function currentMonthValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
// Clicking the backdrop does NOT close the modal — only the explicit close button does,
// so an accidental click outside doesn't discard whatever the user was editing.
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) {
    document.getElementById(closeBtn.getAttribute('data-close')).classList.add('hidden');
  }
});

// Mobile burger menu: toggles the nav dropdown, closes on link click or on
// clicking anywhere outside of it.
(() => {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('pageNav');
  if (!toggle || !nav) return;

  function closeNav() {
    nav.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  nav.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', closeNav);
  });

  document.addEventListener('click', (e) => {
    if (nav.classList.contains('open') && !nav.contains(e.target) && e.target !== toggle) {
      closeNav();
    }
  });
})();
