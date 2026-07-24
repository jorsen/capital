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

const CLASSES = [
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
      await sql`
        CREATE TABLE IF NOT EXISTS loot_sessions (
          id UUID PRIMARY KEY,
          date TEXT NOT NULL,
          run TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS loot_records (
          id UUID PRIMARY KEY,
          session_id UUID NOT NULL REFERENCES loot_sessions(id) ON DELETE CASCADE,
          recipient_id UUID REFERENCES members(id) ON DELETE SET NULL,
          recipient_name TEXT NOT NULL DEFAULT '',
          item TEXT NOT NULL,
          quantity NUMERIC NOT NULL DEFAULT 1,
          notes TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;

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
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

module.exports = { sql, ensureSchema, CLASSES, SLOTS, DEFAULT_ITEM_CATEGORIES };
