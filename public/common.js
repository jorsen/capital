// Populated before the first route renders (see router.js) so every view's
// first render already reflects the real role — avoids a flash of admin
// controls that then disappear once the session check resolves.
const appSession = { role: null, username: null };

// Admin and editor share the same day-to-day editing powers (members, cave
// attendance, loot, salary, boss timers, etc.) — the existing .admin-only /
// .admin-disable classes gate on this. Only a few areas (Users management,
// the Activity Log) are admin-exclusive — those use .owner-only instead,
// gated by isAdmin() specifically.
function canEdit() {
  return appSession.role === 'admin' || appSession.role === 'editor';
}

function isAdmin() {
  return appSession.role === 'admin';
}

async function loadSession() {
  try {
    const { role, username } = await api('/api/session');
    appSession.role = role;
    appSession.username = username;
  } catch (err) {
    appSession.role = null;
    appSession.username = null;
  }
  document.body.classList.toggle('view-only', !canEdit());
  document.body.classList.toggle('not-admin', !isAdmin());
  const badge = document.getElementById('roleBadge');
  if (badge) badge.classList.toggle('hidden', canEdit());
  const whoami = document.getElementById('whoamiBadge');
  if (whoami) {
    whoami.classList.toggle('hidden', !appSession.username);
    if (appSession.username) whoami.textContent = `${appSession.username} (${appSession.role})`;
  }
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

// Formats just the time-of-day portion of a full timestamp (e.g. a
// cave_sessions.created_at) — paired with formatLongDate(session.date) so a
// cave session shows when it was actually logged, not just which day.
function formatTimeOfDay(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// "2026-08" -> "August 2026" — a month heading above a monthly calendar.
function formatMonthYear(monthStr) {
  const d = new Date(`${monthStr}-01T00:00:00`);
  if (Number.isNaN(d.getTime())) return monthStr;
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
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
