const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
// Deliberately not thrown at module load: that would crash every request (even
// the login page) on a cold start. Instead it surfaces from ensureSchema(),
// which callers already wrap in a try/catch to return a clean 500.
const sql = connectionString
  ? neon(connectionString, { fullResults: true })
  : async () => {
      throw new Error('DATABASE_URL (or POSTGRES_URL) environment variable is required');
    };

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
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
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
          await sql`INSERT INTO item_categories (id, name) VALUES (${crypto.randomUUID()}, ${name}) ON CONFLICT (name) DO NOTHING`;
        }
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
