const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

// Client creation is deliberately lazy: neon() itself can throw synchronously
// on a malformed connection string, and doing that at module load would crash
// every request (even the login page) on a cold start. Deferring it here means
// any failure only surfaces when a route actually queries the database, where
// callers already wrap ensureSchema()/queries in a try/catch for a clean 500.
let sqlClient = null;
let sqlInitError = null;

function getSqlClient() {
  if (sqlClient) return sqlClient;
  if (sqlInitError) throw sqlInitError;
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    sqlInitError = new Error('DATABASE_URL (or POSTGRES_URL) environment variable is required');
    throw sqlInitError;
  }
  try {
    sqlClient = neon(connectionString, { fullResults: true });
    return sqlClient;
  } catch (err) {
    sqlInitError = err;
    throw err;
  }
}

const sql = (...args) => getSqlClient()(...args);

// Seed data only — the live list lives in the `classes` table (see
// ensureSchema/getClasses below) so new classes can be added at runtime and
// picked up by the Discord /growth command's choices on next registration.
const DEFAULT_CLASSES = [
  'Eternal Commander',
  'Fatal Lord',
  'Crusader',
  'Blood Enforcer',
  'Storm Hawkeye',
  'Soul Reaper',
  'Prime Savior',
  'Grand Wizard',
  'Divine Priest',
  'Mystic Luminary',
  'Mighty Demolisher',
];

const SLOTS = ['Helmet', 'Armor', 'Cape', 'Gloves', 'Bottoms', 'Shoes', 'Ring', 'Necklace'];

const DEFAULT_ITEM_CATEGORIES = [
  'Morion',
  'Guild Coins',
  'Gold',
  'Crystal of Liberation',
  '(Bound) Arcane Scrolls',
  'Legendary Materials',
  "Star Soul's Fragment",
  'Insignia',
  'Superior Arcane Scroll',
  '(Bound) Invitation of Distorted Reverie',
  'Brilliant Enhancement Scroll',
  'Pitch-Black Enhancement Scroll',
  'Essence of Curses',
  'Frozen Tear',
  'Remnants',
  "Master's Aircraft Toolbox",
  'Essence of the Sky',
  'Orb of Winds',
];

const DEFAULT_ITEM_ICONS = {
  Morion: '/item-icons/morion.webp',
};

// scrypt (built into Node, no extra dependency) with a random per-password
// salt stored alongside the hash as "salt:hash", both hex-encoded.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(password, salt, 64);
  const hashBuf = Buffer.from(hashHex, 'hex');
  return hashBuf.length === hash.length && crypto.timingSafeEqual(hash, hashBuf);
}

let schemaReady = null;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS members (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          class_name TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`ALTER TABLE members ADD COLUMN IF NOT EXISTS alias TEXT NOT NULL DEFAULT ''`;
      await sql`
        CREATE TABLE IF NOT EXISTS growth_entries (
          id UUID PRIMARY KEY,
          member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          rate NUMERIC NOT NULL,
          note TEXT NOT NULL DEFAULT ''
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS classes (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS item_categories (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          icon_url TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`ALTER TABLE item_categories ADD COLUMN IF NOT EXISTS icon_url TEXT`;
      await sql`
        CREATE TABLE IF NOT EXISTS queue_slots (
          slot TEXT PRIMARY KEY,
          names JSONB NOT NULL DEFAULT '[]'
        )
      `;
      await sql`ALTER TABLE queue_slots ADD COLUMN IF NOT EXISTS done JSONB NOT NULL DEFAULT '[]'`;
      await sql`
        CREATE TABLE IF NOT EXISTS loot_sessions (
          id UUID PRIMARY KEY,
          date TEXT NOT NULL,
          run TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          absentees JSONB NOT NULL DEFAULT '[]',
          raffle_log JSONB NOT NULL DEFAULT '[]',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`ALTER TABLE loot_sessions ADD COLUMN IF NOT EXISTS absentees JSONB NOT NULL DEFAULT '[]'`;
      await sql`ALTER TABLE loot_sessions DROP COLUMN IF EXISTS attendees`;
      await sql`ALTER TABLE loot_sessions DROP COLUMN IF EXISTS raffle_winner_id`;
      await sql`ALTER TABLE loot_sessions DROP COLUMN IF EXISTS raffle_draws`;
      await sql`ALTER TABLE loot_sessions ADD COLUMN IF NOT EXISTS raffle_log JSONB NOT NULL DEFAULT '[]'`;
      await sql`
        CREATE TABLE IF NOT EXISTS loot_records (
          id UUID PRIMARY KEY,
          session_id UUID NOT NULL REFERENCES loot_sessions(id) ON DELETE CASCADE,
          recipient_id UUID REFERENCES members(id) ON DELETE SET NULL,
          recipient_name TEXT NOT NULL DEFAULT '',
          item TEXT NOT NULL,
          quantity NUMERIC NOT NULL DEFAULT 1,
          notes TEXT NOT NULL DEFAULT '',
          via_raffle BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`ALTER TABLE loot_records ADD COLUMN IF NOT EXISTS via_raffle BOOLEAN NOT NULL DEFAULT false`;
      await sql`ALTER TABLE loot_records ADD COLUMN IF NOT EXISTS excluded_from_raffle BOOLEAN NOT NULL DEFAULT false`;
      await sql`ALTER TABLE loot_records ADD COLUMN IF NOT EXISTS sent BOOLEAN NOT NULL DEFAULT false`;
      await sql`ALTER TABLE loot_records ADD COLUMN IF NOT EXISTS via_reservation BOOLEAN NOT NULL DEFAULT false`;

      // Cave attendance mirrors loot_sessions/loot_records but flips the
      // attendance model: everyone is assumed ABSENT and `attendees` holds
      // ids of members who showed up (opposite of loot_sessions.absentees).
      await sql`
        CREATE TABLE IF NOT EXISTS cave_sessions (
          id UUID PRIMARY KEY,
          date TEXT NOT NULL,
          run TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          attendees JSONB NOT NULL DEFAULT '[]',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS cave_records (
          id UUID PRIMARY KEY,
          session_id UUID NOT NULL REFERENCES cave_sessions(id) ON DELETE CASCADE,
          item TEXT NOT NULL,
          quantity NUMERIC NOT NULL DEFAULT 1,
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Cave loot isn't assigned to a specific recipient (unlike guild dungeon
      // loot) and doesn't track a "sent" status — drop these columns for
      // anyone who already has the table from an earlier version of this
      // feature.
      await sql`ALTER TABLE cave_records DROP COLUMN IF EXISTS recipient_id`;
      await sql`ALTER TABLE cave_records DROP COLUMN IF EXISTS recipient_name`;
      await sql`ALTER TABLE cave_records DROP COLUMN IF EXISTS sent`;

      // Per-unit sold price — the Loot List report shows qty × sold_price as
      // Total Price per record, and the Salary tab sums that same product
      // (for records in a given month's cave dates) to get that month's
      // Salary Pool, since caves don't use a fixed per-item price list.
      await sql`ALTER TABLE cave_records ADD COLUMN IF NOT EXISTS sold_price NUMERIC NOT NULL DEFAULT 0`;
      // Free-text label for who the item was sold to — display-only, doesn't
      // feed the salary calculation.
      await sql`ALTER TABLE cave_records ADD COLUMN IF NOT EXISTS buyer TEXT NOT NULL DEFAULT ''`;

      // One row per accounting-fee recipient per payout month — a flat % of
      // that month's raw Salary Pool taken off the top before the rest is
      // split by attendance share, then added back on top of that
      // recipient's own distributed share as their compensation. member_id
      // is nullable since a recipient can be a role/group name (e.g.
      // "Attendance Marshals") rather than a single tracked member.
      await sql`
        CREATE TABLE IF NOT EXISTS cave_salary_fees (
          id UUID PRIMARY KEY,
          month TEXT NOT NULL,
          name TEXT NOT NULL,
          member_id UUID REFERENCES members(id) ON DELETE SET NULL,
          percent NUMERIC NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      // Marks a member's Final Salary as already paid out for a given
      // month — row existence IS the "sent" flag, so checking the box
      // inserts a row and unchecking it deletes one.
      await sql`
        CREATE TABLE IF NOT EXISTS cave_salary_paid (
          id UUID PRIMARY KEY,
          month TEXT NOT NULL,
          member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (month, member_id)
        )
      `;

      const { rows: classRows } = await sql`SELECT COUNT(*)::int AS count FROM classes`;
      if (classRows[0].count === 0) {
        for (const name of DEFAULT_CLASSES) {
          await sql`INSERT INTO classes (id, name) VALUES (${crypto.randomUUID()}, ${name}) ON CONFLICT (name) DO NOTHING`;
        }
      }

      const { rows: categoryRows } = await sql`SELECT COUNT(*)::int AS count FROM item_categories`;
      if (categoryRows[0].count === 0) {
        for (const name of DEFAULT_ITEM_CATEGORIES) {
          await sql`
            INSERT INTO item_categories (id, name, icon_url)
            VALUES (${crypto.randomUUID()}, ${name}, ${DEFAULT_ITEM_ICONS[name] || null})
            ON CONFLICT (name) DO NOTHING
          `;
        }
      }
      for (const [name, iconUrl] of Object.entries(DEFAULT_ITEM_ICONS)) {
        await sql`UPDATE item_categories SET icon_url = ${iconUrl} WHERE name = ${name} AND icon_url IS NULL`;
      }

      for (const slot of SLOTS) {
        await sql`INSERT INTO queue_slots (slot, names) VALUES (${slot}, '[]') ON CONFLICT (slot) DO NOTHING`;
      }

      await sql`
        CREATE TABLE IF NOT EXISTS boss_timers (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'daily',
          spawn_time TEXT,
          interval_minutes INTEGER,
          last_killed_at TIMESTAMPTZ,
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      // Tracks the exact spawn instant already announced in Discord, so a
      // frequent notify-spawns poll doesn't repost for the same spawn.
      await sql`ALTER TABLE boss_timers ADD COLUMN IF NOT EXISTS notified_spawn_at TIMESTAMPTZ`;

      // How many minutes before an interval boss's next spawn to ping
      // Discord — configurable per boss instead of one fixed value for all.
      await sql`ALTER TABLE boss_timers ADD COLUMN IF NOT EXISTS notify_lead_minutes INTEGER NOT NULL DEFAULT 5`;

      // Submitting attendance on a session matched to an interval boss posts
      // a Discord confirm button (lib/discord.js handleConfirmBossKill); these
      // columns track that submit -> boss match -> Discord confirm pipeline
      // so a repeat button click or repeat submit doesn't re-trigger it.
      await sql`ALTER TABLE loot_sessions ADD COLUMN IF NOT EXISTS attendance_submitted_at TIMESTAMPTZ`;
      await sql`ALTER TABLE loot_sessions ADD COLUMN IF NOT EXISTS boss_id UUID REFERENCES boss_timers(id) ON DELETE SET NULL`;
      await sql`ALTER TABLE loot_sessions ADD COLUMN IF NOT EXISTS boss_confirmed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE loot_sessions ADD COLUMN IF NOT EXISTS boss_confirmed_by TEXT`;

      // One row per detected/logged kill, independent of boss_timers (which
      // only holds the latest kill per boss). boss_name is denormalized so
      // history survives a boss being renamed or removed later.
      await sql`
        CREATE TABLE IF NOT EXISTS boss_kill_history (
          id UUID PRIMARY KEY,
          boss_id UUID REFERENCES boss_timers(id) ON DELETE SET NULL,
          boss_name TEXT NOT NULL,
          killed_at TIMESTAMPTZ NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          discord_author TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      // Single-row cursor tracking the newest Discord message id already
      // scanned for boss-kill mentions, so re-polling doesn't reprocess and
      // re-trigger the same message repeatedly.
      await sql`
        CREATE TABLE IF NOT EXISTS boss_kill_poll_state (
          id INTEGER PRIMARY KEY DEFAULT 1,
          last_message_id TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`INSERT INTO boss_kill_poll_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;

      // Same cursor pattern as boss_kill_poll_state, for the #cave-attendance
      // auto-sync poll — tracks the newest message id already processed so a
      // recurring poll only ever looks at what's new.
      await sql`
        CREATE TABLE IF NOT EXISTS cave_attendance_poll_state (
          id INTEGER PRIMARY KEY DEFAULT 1,
          last_message_id TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`INSERT INTO cave_attendance_poll_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;

      // Individual accounts (replaces the old single shared SITE_PASSWORD).
      // role is one of 'admin' | 'editor' | 'viewer'. Admin: everything,
      // including user management. Editor: same day-to-day data access as
      // admin (members, cave attendance, loot, salary, boss timers) but not
      // user management. Viewer: read-only, same as an anonymous visitor.
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'viewer',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      const { rows: userCountRows } = await sql`SELECT COUNT(*)::int AS count FROM users`;
      if (userCountRows[0].count === 0) {
        // Bootstraps continuity from the old single-password model: whoever
        // knows the current SITE_PASSWORD can still log in (now as username
        // "admin") and take it from there via the Users page.
        const sitePassword = process.env.SITE_PASSWORD || 'capital-records';
        await sql`
          INSERT INTO users (id, username, password_hash, role)
          VALUES (${crypto.randomUUID()}, 'admin', ${hashPassword(sitePassword)}, 'admin')
          ON CONFLICT (username) DO NOTHING
        `;
      }

      // Append-only audit trail — one row per mutating action taken through
      // the app. username/role are denormalized snapshots so history stays
      // readable even after a user is renamed or removed.
      await sql`
        CREATE TABLE IF NOT EXISTS activity_log (
          id UUID PRIMARY KEY,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          username TEXT NOT NULL,
          role TEXT NOT NULL,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          description TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function getClasses() {
  const { rows } = await sql`SELECT name FROM classes ORDER BY name ASC`;
  return rows.map((r) => r.name);
}

module.exports = { sql, ensureSchema, getClasses, SLOTS, DEFAULT_ITEM_CATEGORIES, hashPassword, verifyPassword };
