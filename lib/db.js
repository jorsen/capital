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

// One-off migrations need to know whether an old column is still there
// before deciding to migrate its data and drop it (running the drop twice
// is harmless, but querying a column that's already gone would error).
async function columnExists(table, column) {
  const { rows } = await sql`
    SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}
  `;
  return rows.length > 0;
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
      // The actual parsed Time of Death for a synced kill (NULL for a
      // manually-created session, or a synced one whose message didn't use
      // the explicit "Boss: X / Time of Death: Y" format) -- lets the sync
      // tell apart a boss that spawns more than once in the same day, so
      // each spawn gets its own session instead of all merging into one.
      await sql`ALTER TABLE cave_sessions ADD COLUMN IF NOT EXISTS killed_at TIMESTAMPTZ`;
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

      // Cave Schedule — a standalone planning calendar (doesn't touch
      // cave_sessions/attendance) mapping one server name to each date, so
      // officers can see "today is Server A's day" at a glance. Servers are
      // a simple named list (add/remove), same shape as classes/item
      // categories; cave_schedule just references a server by its name text
      // rather than an id, so renaming isn't needed and a removed server
      // still reads correctly on any date it was already assigned to.
      await sql`
        CREATE TABLE IF NOT EXISTS cave_schedule_servers (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS cave_schedule (
          date DATE PRIMARY KEY,
          server_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      // World Dungeon Schedule — every Thursday and Sunday, an admin manually
      // assigns which guild is taking on each of two fixed world bosses
      // (Hisharat, Chantarat; see WORLD_DUNGEON_NAMES in lib/app.js — not a
      // managed list, the two names are fixed). Reuses cave_schedule_servers
      // as the guild picklist rather than a second duplicate list, since
      // that's already exactly "an admin-managed list of other guilds' names"
      // — guild_name is denormalized text for the same reason server_name is
      // above. One row per (date, dungeon); PK matches that shape.
      await sql`
        CREATE TABLE IF NOT EXISTS world_dungeon_schedule (
          date DATE NOT NULL,
          dungeon TEXT NOT NULL,
          guild_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (date, dungeon)
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

      // Marks a #cave-attendance message as already logged, independent of
      // the poll cursor above — the cursor only stops the recurring auto-poll
      // from re-scanning old messages, but the manual month-scoped sync
      // re-scans everything in range every time it's run (e.g. re-running it
      // for a month you already synced). Without this, that would re-merge
      // attendees (harmless) but also re-post a "Logged Successfully"
      // confirmation into the channel for every already-synced message,
      // flooding it. A message id in here is skipped on any future run.
      await sql`
        CREATE TABLE IF NOT EXISTS cave_attendance_logged_messages (
          message_id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Discord's edited_timestamp at the time we last processed this
      // message (NULL if it had never been edited yet) -- lets a later sync
      // tell "someone edited this after we logged it" apart from "nothing's
      // changed, still skip it", instead of treating every logged message id
      // as permanently done regardless of edits.
      await sql`ALTER TABLE cave_attendance_logged_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`;
      // Which cave_sessions row this exact message created -- every new
      // message gets its own session (no guessing whether two different
      // messages refer to the same kill), so an edit to THIS message only
      // ever updates the one session it originally made, never merges into
      // some other session found by matching date/boss/time against it.
      await sql`ALTER TABLE cave_attendance_logged_messages ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES cave_sessions(id) ON DELETE SET NULL`;

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
      await sql`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS before_data JSONB`;
      await sql`ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS after_data JSONB`;

      // Sovereign / Crusade — a small admin-managed guild list (name + color
      // tag) plus one row per crusade and one row per roster participant.
      // guild_name on participants is denormalized text (same reasoning as
      // cave_schedule.server_name above) rather than an FK, so removing a
      // guild later doesn't corrupt a past crusade's roster.
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_guilds (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // crusades is now just the shared date/event container -- name,
      // event_date, notes. Every field that drives a payout (war type,
      // stance, area, leader, result, diamond reward, attendance %) lives on
      // crusade_teams instead, one row per team within the crusade, so two
      // teams fighting the same date's crusade can have entirely different
      // rewards/outcomes. The old columns stay on this table (unused) rather
      // than being dropped, since the one-time migration below reads them.
      await sql`
        CREATE TABLE IF NOT EXISTS crusades (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          war_type TEXT,
          stance TEXT,
          area TEXT,
          leader TEXT,
          result TEXT NOT NULL DEFAULT 'pending',
          diamond_reward NUMERIC NOT NULL DEFAULT 0,
          attendance_pct NUMERIC NOT NULL DEFAULT 50,
          event_date DATE,
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_teams (
          id UUID PRIMARY KEY,
          crusade_id UUID NOT NULL REFERENCES crusades(id) ON DELETE CASCADE,
          team_number INT NOT NULL,
          war_type TEXT,
          stance TEXT,
          area TEXT,
          leader TEXT,
          result TEXT NOT NULL DEFAULT 'pending',
          diamond_reward NUMERIC NOT NULL DEFAULT 0,
          attendance_pct NUMERIC NOT NULL DEFAULT 50,
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (crusade_id, team_number)
        )
      `;
      // Named items per crusade TEAM (e.g. Morion x215, Guild Coins x500),
      // each split evenly across that team's own attendees only -- same
      // "attended is a must" rule as the diamond attendance portion, just for
      // physical item counts. crusade_id is kept alongside team_id purely so
      // a team's items still cascade-delete if the parent crusade goes away.
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_items (
          id UUID PRIMARY KEY,
          crusade_id UUID NOT NULL REFERENCES crusades(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          quantity NUMERIC NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`ALTER TABLE crusade_items ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES crusade_teams(id) ON DELETE CASCADE`;
      // Superseded a single item_name/item_quantity pair directly on
      // crusades — migrate any existing value into this table (safe to
      // re-run: only touches crusades without a row here yet) before
      // dropping those columns.
      if (await columnExists('crusades', 'item_name')) {
        const { rows: legacyItemRows } = await sql`
          SELECT id, item_name, item_quantity FROM crusades
          WHERE item_name IS NOT NULL AND id NOT IN (SELECT crusade_id FROM crusade_items)
        `;
        for (const row of legacyItemRows) {
          await sql`INSERT INTO crusade_items (id, crusade_id, name, quantity) VALUES (${crypto.randomUUID()}, ${row.id}, ${row.item_name}, ${row.item_quantity})`;
        }
        await sql`ALTER TABLE crusades DROP COLUMN item_name`;
        await sql`ALTER TABLE crusades DROP COLUMN IF EXISTS item_quantity`;
      }

      // A management fee takes a percentage of a team's total diamond
      // reward off the top, before the remainder is split via the normal
      // attendance/bid formula — same idea as the cave salary accounting
      // fees (see cave_salary_fees), just per-team and keyed by IGN
      // (free text) rather than a member id.
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_fees (
          id UUID PRIMARY KEY,
          crusade_id UUID NOT NULL REFERENCES crusades(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          percent NUMERIC NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Which guild the fee's diamonds should count toward in the per-team
      // guild summary — added after the fact, hence ALTER.
      await sql`ALTER TABLE crusade_fees ADD COLUMN IF NOT EXISTS guild_name TEXT`;
      await sql`ALTER TABLE crusade_fees ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES crusade_teams(id) ON DELETE CASCADE`;

      // A standing list of fee recipients (not tied to any crusade/team) --
      // copied onto crusade_fees automatically the first time a new team is
      // ever saved (see ensureCrusadeTeam in lib/app.js), so a guild leader's
      // cut doesn't need to be re-added by hand on every single team.
      // Editing this list only affects teams created afterward.
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_default_fees (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          guild_name TEXT,
          percent NUMERIC NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_participants (
          id UUID PRIMARY KEY,
          crusade_id UUID NOT NULL REFERENCES crusades(id) ON DELETE CASCADE,
          party_number INT NOT NULL DEFAULT 1,
          name TEXT NOT NULL,
          guild_name TEXT,
          position TEXT,
          gold_bid NUMERIC NOT NULL DEFAULT 0,
          attended BOOLEAN NOT NULL DEFAULT true,
          paid BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // party_slot groups a team's members into battle parties of up to 5
      // (see the 5-member cap enforced in the participant routes below) —
      // added after the fact, hence ALTER rather than a column in the
      // CREATE TABLE above.
      await sql`ALTER TABLE crusade_participants ADD COLUMN IF NOT EXISTS party_slot INT NOT NULL DEFAULT 1`;

      // One-time migration: crusade details (war type/stance/area/leader/
      // result/diamond reward/attendance %/notes) plus items and fees used
      // to be shared crusade-wide; each is now scoped per team instead. Copy
      // the crusade's existing values onto a crusade_teams row for every
      // team number already in use (so nothing changes visually until
      // someone edits a specific team going forward), and duplicate each
      // existing item/fee onto every one of those teams.
      //
      // Guarded PER CRUSADE (does this one already have any crusade_teams
      // row?) rather than one global "has this ever run" flag -- a global
      // flag would mean a single crusade throwing partway through (bad data,
      // a transient connection hiccup) permanently skips every crusade after
      // it in the loop, even on retry, since the flag would already read
      // "done". Per-crusade, a retry just picks up wherever it left off.
      const { rows: legacyCrusades } = await sql`SELECT * FROM crusades`;
      for (const c of legacyCrusades) {
        const { rows: alreadyMigrated } = await sql`SELECT 1 FROM crusade_teams WHERE crusade_id = ${c.id} LIMIT 1`;
        if (alreadyMigrated.length) continue;

        const { rows: partyRows } = await sql`
          SELECT DISTINCT party_number FROM crusade_participants WHERE crusade_id = ${c.id}
        `;
        const teamNumbers = new Set([1, 2, 3, ...partyRows.map((r) => r.party_number)]);
        for (const teamNumber of teamNumbers) {
          // ON CONFLICT DO NOTHING guards against two server instances
          // racing this same one-time migration concurrently at cold
          // start -- if that happens, the locally generated id never made
          // it into the table, so re-fetch whichever id actually won.
          const { rows: insertedTeamRows } = await sql`
            INSERT INTO crusade_teams
              (id, crusade_id, team_number, war_type, stance, area, leader, result, diamond_reward, attendance_pct, notes)
            VALUES (
              ${crypto.randomUUID()}, ${c.id}, ${teamNumber}, ${c.war_type}, ${c.stance}, ${c.area}, ${c.leader},
              ${c.result}, ${c.diamond_reward}, ${c.attendance_pct}, ${c.notes}
            )
            ON CONFLICT (crusade_id, team_number) DO NOTHING
            RETURNING id
          `;
          let teamId = insertedTeamRows[0]?.id;
          if (!teamId) {
            const { rows: existingTeamRows } = await sql`
              SELECT id FROM crusade_teams WHERE crusade_id = ${c.id} AND team_number = ${teamNumber}
            `;
            teamId = existingTeamRows[0].id;
          }
          const { rows: legacyItems } = await sql`
            SELECT * FROM crusade_items WHERE crusade_id = ${c.id} AND team_id IS NULL
          `;
          for (const item of legacyItems) {
            await sql`
              INSERT INTO crusade_items (id, crusade_id, team_id, name, quantity)
              VALUES (${crypto.randomUUID()}, ${c.id}, ${teamId}, ${item.name}, ${item.quantity})
            `;
          }
          const { rows: legacyFees } = await sql`
            SELECT * FROM crusade_fees WHERE crusade_id = ${c.id} AND team_id IS NULL
          `;
          for (const fee of legacyFees) {
            await sql`
              INSERT INTO crusade_fees (id, crusade_id, team_id, name, guild_name, percent)
              VALUES (${crypto.randomUUID()}, ${c.id}, ${teamId}, ${fee.name}, ${fee.guild_name}, ${fee.percent})
            `;
          }
        }
        await sql`DELETE FROM crusade_items WHERE crusade_id = ${c.id} AND team_id IS NULL`;
        await sql`DELETE FROM crusade_fees WHERE crusade_id = ${c.id} AND team_id IS NULL`;
      }

      // Generic "has this one-time migration run" tracker -- reused below
      // instead of the structural guards above (crusade_teams row count,
      // column existence) because this next cleanup's own end-state can't
      // double as its own guard: after it runs, "no items on a non-Team-2
      // team" would look identical to "nobody's added one yet", and the
      // whole point is to keep allowing that going forward.
      await sql`
        CREATE TABLE IF NOT EXISTS crusade_migration_flags (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

      // The per-team migration above copied every crusade's items/fees onto
      // EVERY one of its teams (per instructions at the time), which meant a
      // crusade with "150 Alluvial Pouches" ended up with 150 on Team 1 AND
      // Team 2 AND Team 3 -- inflating the Guild Salary total 3x. One-time
      // cleanup: for any crusade that has a Team 2, keep only Team 2's copy
      // and delete the rest. Guarded by a flag row (not a structural check)
      // since after this runs, "no items on Team 1/3" must stay a normal,
      // allowed state going forward -- not something this re-deletes.
      const CRUSADE_TEAM2_CLEANUP_FLAG = 'team2-only-items-fees-cleanup';
      const { rows: team2CleanupDone } = await sql`SELECT 1 FROM crusade_migration_flags WHERE name = ${CRUSADE_TEAM2_CLEANUP_FLAG}`;
      if (!team2CleanupDone.length) {
        await sql`
          DELETE FROM crusade_items
          WHERE team_id IN (
            SELECT ct.id FROM crusade_teams ct
            WHERE ct.team_number != 2
              AND EXISTS (SELECT 1 FROM crusade_teams ct2 WHERE ct2.crusade_id = ct.crusade_id AND ct2.team_number = 2)
          )
        `;
        await sql`
          DELETE FROM crusade_fees
          WHERE team_id IN (
            SELECT ct.id FROM crusade_teams ct
            WHERE ct.team_number != 2
              AND EXISTS (SELECT 1 FROM crusade_teams ct2 WHERE ct2.crusade_id = ct.crusade_id AND ct2.team_number = 2)
          )
        `;
        await sql`INSERT INTO crusade_migration_flags (name) VALUES (${CRUSADE_TEAM2_CLEANUP_FLAG}) ON CONFLICT DO NOTHING`;
      }

      // Master roster of everyone ever saved into a crusade party roster,
      // one row per unique name (case-insensitive) — kept up to date by
      // upsertSovereignMember() every time a crusade_participants row is
      // saved, so it always reflects each person's most recent guild.
      await sql`
        CREATE TABLE IF NOT EXISTS sovereign_members (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          guild_name TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // Lets the Add Participant search auto-fill Position too, not just
      // Guild -- added after the fact, hence ALTER.
      await sql`ALTER TABLE sovereign_members ADD COLUMN IF NOT EXISTS position TEXT`;

      // Standalone raffle, independent of any crusade -- an append-only
      // stack of draw results (member + which item they won). The pool for
      // the *next* draw is whoever from sovereign_members hasn't already won
      // since the stack was last cleared -- derived from this table, not
      // stored separately.
      await sql`
        CREATE TABLE IF NOT EXISTS raffle_winners (
          id UUID PRIMARY KEY,
          member_name TEXT NOT NULL,
          guild_name TEXT,
          item TEXT,
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
