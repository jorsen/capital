const express = require('express');
const cookie = require('cookie');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { sql, ensureSchema, getClasses, SLOTS, hashPassword, verifyPassword } = require('./db');
const { verifyDiscordRequest, handleInteraction, registerCommands } = require('./discord');
const ICON_MANIFEST = require('./icon-manifest');

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const AUTH_COOKIE = 'crAuth';
const AUTH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds

// Cookie payload is "<userId>.<hmac(userId)>" — the signature just proves
// the userId wasn't tampered with client-side; the actual role/username
// always comes fresh from the users table so a role change or deletion
// takes effect on the user's very next request.
function signUserId(userId) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(userId).digest('hex');
}

function setAuthCookie(res, userId) {
  const token = `${userId}.${signUserId(userId)}`;
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!process.env.VERCEL,
      maxAge: AUTH_COOKIE_MAX_AGE,
      path: '/',
    })
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(AUTH_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!process.env.VERCEL,
      maxAge: 0,
      path: '/',
    })
  );
}

// Resolves the signed cookie to a live user row ({id, username, role}) or
// null. Fails closed (treated as logged-out) on a bad/missing/tampered
// cookie, an unknown user, or a database error — mutating routes need the
// database anyway, so degrading to "viewer" during an outage doesn't open
// up anything that wasn't already unusable.
async function getCurrentUser(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies[AUTH_COOKIE] || '';
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;
  const userId = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const expectedBuf = Buffer.from(signUserId(userId));
  const providedBuf = Buffer.from(signature);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  try {
    await ensureSchema();
    const { rows } = await sql`SELECT id, username, role FROM users WHERE id = ${userId}`;
    return rows[0] || null;
  } catch (err) {
    return null;
  }
}

function canEdit(user) {
  return !!user && (user.role === 'admin' || user.role === 'editor');
}

function isAdminUser(user) {
  return !!user && user.role === 'admin';
}

// Records one row per mutating action for the Activity Log page. `before`/
// `after` are optional plain-object snapshots of the affected record (e.g.
// the row before an UPDATE and the row returned by its RETURNING clause) —
// omit either when there's nothing meaningful to show (e.g. on create,
// there's no "before"). Never throws — a logging failure should not take
// down the action it's describing, so errors are swallowed after a console
// warning.
async function logActivity(req, { action, entityType, entityId, description, user: explicitUser, before, after }) {
  const user = explicitUser || req.currentUser;
  if (!user) return;
  try {
    await sql`
      INSERT INTO activity_log (id, user_id, username, role, action, entity_type, entity_id, description, before_data, after_data)
      VALUES (
        ${crypto.randomUUID()}, ${user.id}, ${user.username}, ${user.role}, ${action}, ${entityType}, ${entityId ?? null}, ${description},
        ${before !== undefined ? JSON.stringify(before) : null},
        ${after !== undefined ? JSON.stringify(after) : null}
      )
    `;
  } catch (err) {
    console.error('logActivity failed', err);
  }
}

async function withSchema(req, res, next) {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'database unavailable' });
  }
}

// Resolves member ids to display names (matching memberDisplayName() on the
// frontend) for activity-log before/after snapshots — a raw UUID means
// nothing to a human reading the Activity Log's Changes column. Falls back
// to the id itself for one that's since been deleted, rather than dropping
// it silently.
async function memberNamesForIds(ids) {
  if (!ids || !ids.length) return [];
  const { rows } = await sql`SELECT id, name, alias FROM members WHERE id = ANY(${ids}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r.alias ? `${r.name} (${r.alias})` : r.name]));
  return ids.map((id) => byId.get(id) || id);
}

async function fetchGrowthByMemberIds(memberIds) {
  if (memberIds.length === 0) return new Map();
  const { rows } = await sql`
    SELECT id, member_id, date, rate, note
    FROM growth_entries
    WHERE member_id = ANY(${memberIds}::uuid[])
    ORDER BY date ASC
  `;
  const map = new Map();
  for (const row of rows) {
    const entry = { id: row.id, date: row.date, rate: Number(row.rate), note: row.note };
    if (!map.has(row.member_id)) map.set(row.member_id, []);
    map.get(row.member_id).push(entry);
  }
  return map;
}

async function serializeMember(row) {
  const growthMap = await fetchGrowthByMemberIds([row.id]);
  return {
    id: row.id,
    name: row.name,
    alias: row.alias,
    className: row.class_name,
    notes: row.notes,
    createdAt: row.created_at,
    growth: growthMap.get(row.id) || [],
  };
}

async function fetchLootRecords(sessionIds) {
  if (sessionIds.length === 0) return new Map();
  const { rows } = await sql`
    SELECT id, session_id, recipient_id, recipient_name, item, quantity, notes, via_raffle, excluded_from_raffle, sent, via_reservation, created_at
    FROM loot_records
    WHERE session_id = ANY(${sessionIds}::uuid[])
    ORDER BY created_at ASC
  `;
  const map = new Map();
  for (const row of rows) {
    const record = {
      id: row.id,
      recipientId: row.recipient_id,
      recipientName: row.recipient_name,
      item: row.item,
      quantity: Number(row.quantity),
      notes: row.notes,
      viaRaffle: row.via_raffle,
      excludedFromRaffle: row.excluded_from_raffle,
      sent: row.sent,
      viaReservation: row.via_reservation,
      createdAt: row.created_at,
    };
    if (!map.has(row.session_id)) map.set(row.session_id, []);
    map.get(row.session_id).push(record);
  }
  return map;
}

function lootRecordSnapshot(row) {
  return {
    recipientName: row.recipient_name || null,
    item: row.item,
    quantity: Number(row.quantity),
    notes: row.notes,
    viaRaffle: row.via_raffle,
    excludedFromRaffle: row.excluded_from_raffle,
    sent: row.sent,
    viaReservation: row.via_reservation,
  };
}

function serializeLootSession(row, records) {
  return {
    id: row.id,
    date: row.date,
    run: row.run,
    notes: row.notes,
    absentees: row.absentees || [],
    raffleLog: row.raffle_log || [],
    createdAt: row.created_at,
    records: records || [],
    attendanceSubmittedAt: row.attendance_submitted_at,
    bossId: row.boss_id,
    bossConfirmedAt: row.boss_confirmed_at,
    bossConfirmedBy: row.boss_confirmed_by,
  };
}

async function fetchCaveRecords(sessionIds) {
  if (sessionIds.length === 0) return new Map();
  const { rows } = await sql`
    SELECT id, session_id, item, quantity, notes, sold_price, buyer, created_at
    FROM cave_records
    WHERE session_id = ANY(${sessionIds}::uuid[])
    ORDER BY created_at ASC
  `;
  const map = new Map();
  for (const row of rows) {
    const record = {
      id: row.id,
      item: row.item,
      quantity: Number(row.quantity),
      notes: row.notes,
      soldPrice: Number(row.sold_price),
      buyer: row.buyer,
      createdAt: row.created_at,
    };
    if (!map.has(row.session_id)) map.set(row.session_id, []);
    map.get(row.session_id).push(record);
  }
  return map;
}

function caveRecordSnapshot(row) {
  return {
    item: row.item,
    quantity: Number(row.quantity),
    notes: row.notes,
    soldPrice: Number(row.sold_price),
    buyer: row.buyer,
  };
}

function serializeCaveSession(row, records) {
  return {
    id: row.id,
    date: row.date,
    run: row.run,
    notes: row.notes,
    attendees: row.attendees || [],
    createdAt: row.created_at,
    records: records || [],
  };
}

// Matches a loot session's free-text "run" field to one of the named boss
// timers even when it's not the complete name (e.g. run "Corrupted Guild
// Dungeon" against boss name "Corrupted") by checking substring containment
// in either direction.
function matchBossByRunName(run, bosses) {
  const normalizedRun = (run || '').trim().toLowerCase();
  if (!normalizedRun) return null;
  return (
    bosses.find((b) => {
      const name = b.name.trim().toLowerCase();
      return !!name && (normalizedRun.includes(name) || name.includes(normalizedRun));
    }) || null
  );
}

// Guild operates on Philippines time — fixed UTC+8, no DST — so converting a
// wall-clock time written in chat to a UTC instant is plain arithmetic below.
const BOSS_CHAT_TIMEZONE_OFFSET_MINUTES = 8 * 60;

// Parses an explicit kill-confirmation message like:
//   Boss: Hotura
//   Time of Death: 8:35pm
// into { bossName, killedAt } — preferred over the message's own post
// timestamp (used as a fallback elsewhere) since that can lag the real kill
// by however long it took someone to type up attendance afterward. Assumes
// one Boss:/Time of Death: pair per message.
function parseTimeOfDeathMessage(content, postedAt) {
  const bossMatch = /Boss:\s*(.+)/i.exec(content || '');
  const timeMatch = /Time of Death:\s*(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(content || '');
  if (!bossMatch || !timeMatch) return null;

  let hour = Number(timeMatch[1]) % 12;
  const minute = Number(timeMatch[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (/pm/i.test(timeMatch[3])) hour += 12;

  const posted = new Date(postedAt);
  // Calendar date the message was posted on, read in the guild's local timezone.
  const localPosted = new Date(posted.getTime() + BOSS_CHAT_TIMEZONE_OFFSET_MINUTES * 60000);
  let candidateMs =
    Date.UTC(localPosted.getUTCFullYear(), localPosted.getUTCMonth(), localPosted.getUTCDate(), hour, minute) -
    BOSS_CHAT_TIMEZONE_OFFSET_MINUTES * 60000;

  // A stated time more than 2 hours after the post almost certainly means it
  // refers to the previous day (e.g. posted just after midnight about an
  // 11:58pm kill), not a kill claimed before it happened.
  if (candidateMs - posted.getTime() > 2 * 60 * 60 * 1000) {
    candidateMs -= 24 * 60 * 60 * 1000;
  }

  return { bossName: bossMatch[1].trim(), killedAt: new Date(candidateMs).toISOString() };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Discord's REST API rate-limits per route — a handful of requests per
// couple of seconds for most channel endpoints — which a tight pagination
// loop (scanning many pages of message history back-to-back) or a burst of
// several confirmation replies in one sync run can trip well before
// anything looks obviously wrong. Retries on 429 using the retry_after
// Discord itself reports, instead of letting the whole scan/cleanup fail
// outright over one transient limit.
async function discordFetch(url, options, retriesLeft = 3) {
  const res = await fetch(url, options);
  if (res.status === 429 && retriesLeft > 0) {
    const body = await res.clone().json().catch(() => ({}));
    const retryAfterMs = Math.ceil((body.retry_after || 1) * 1000) + 150;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return discordFetch(url, options, retriesLeft - 1);
  }
  return res;
}

// Discord snowflake IDs encode a timestamp in their high bits — this lets us
// use a synthetic ID as a before/after cursor for a specific instant even
// though no message with that exact ID exists.
const DISCORD_EPOCH_MS = 1420070400000n;
function snowflakeForTimestamp(ms) {
  return ((BigInt(Math.floor(ms)) - DISCORD_EPOCH_MS) << 22n).toString();
}

// Loose normalization for matching a Discord-typed name against a roster
// name/alias: strips punctuation, folds common leetspeak digit substitutions,
// and collapses stretched-out letters (jejemon-style "heeeey") so minor
// typos and shortcuts still line up.
function normalizeNameToken(raw) {
  return (raw || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9À-ɏ぀-ヿ一-鿿]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/(.)\1{2,}/g, '$1$1');
}

function levenshteinDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// A member's IGN often carries a guild-tag prefix ("CAP | Name") that
// wouldn't appear in casual Discord chat, so the tag-stripped tail is
// matched as its own candidate alongside the full name and alias.
function nameMatchCandidates(member) {
  const variants = new Set();
  const addVariant = (raw) => {
    const norm = normalizeNameToken(raw);
    if (norm) variants.add(norm);
  };
  addVariant(member.name);
  if (member.alias) addVariant(member.alias);
  const parts = (member.name || '').split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) addVariant(parts[parts.length - 1]);
  return Array.from(variants);
}

// Matches one typed token against the roster — exact normalized match wins
// outright; otherwise the first substring or close-typo match found is used.
// Ambiguous/no matches surface as unmatched in the sync report for a human
// to resolve, rather than guessing further.
function matchMemberForToken(token, members) {
  const normToken = normalizeNameToken(token);
  if (!normToken) return null;

  let fallback = null;
  for (const member of members) {
    for (const candidate of nameMatchCandidates(member)) {
      if (candidate === normToken) return { member, quality: 'exact' };
      if (!fallback && (candidate.includes(normToken) || normToken.includes(candidate))) {
        fallback = { member, quality: 'substring' };
        continue;
      }
      if (!fallback) {
        const dist = levenshteinDistance(candidate, normToken);
        const threshold = Math.max(1, Math.floor(Math.min(candidate.length, normToken.length) / 3));
        if (dist <= threshold) fallback = { member, quality: 'fuzzy' };
      }
    }
  }
  return fallback;
}

const MONTH_NAME_DATE_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?\b/i;
const NUMERIC_DATE_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Pulls candidate attendee names out of a message, discarding whole header
// lines rather than just the matched substring — attendance messages tend
// to pack the boss name, date, session label ("C1"), a "Boss:"/"Time of
// Death:" line, or a "+N" caveat note all on lines of their own, and any of
// those left half-stripped would otherwise surface as a bogus "unmatched
// name". Handles numbered/bulleted lists, plain line-per-name, and
// comma-separated names on one line.
function extractNameTokens(content, bossName) {
  const bossRe = bossName ? new RegExp(`\\b${escapeRegex(bossName)}\\b`, 'i') : null;
  const tokens = [];
  (content || '').split(/\r?\n/).forEach((rawLine) => {
    let line = rawLine.trim();
    if (!line) return;
    if (bossRe && bossRe.test(line)) return;
    if (MONTH_NAME_DATE_RE.test(line) || NUMERIC_DATE_RE.test(line)) return;
    if (/^(boss|time of death)\s*:/i.test(line)) return;
    if (/^\+/.test(line)) return;

    line = line.replace(/^\d+[.)\:]\s*/, '').replace(/^[-•*–]\s*/, '').trim();
    if (!line) return;
    line.split(',').forEach((part) => {
      const t = part.trim();
      if (t) tokens.push(t);
    });
  });
  return tokens;
}

// Finds an explicit date (M/D, M/D/YYYY, YYYY-MM-DD, or a spelled-out month
// like "Aug 4 2026") written in the message — falls back to the message's
// own post date (in PH time) when nothing is found, since attendance is
// often typed up after the fact.
function extractDateFromText(content, fallbackYear) {
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(content || '');
  if (iso) {
    const [, y, m, d] = iso;
    return { match: iso[0], date: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` };
  }
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(content || '');
  if (slash) {
    const [, m, d, yRaw] = slash;
    const y = yRaw ? (yRaw.length === 2 ? `20${yRaw}` : yRaw) : String(fallbackYear);
    return { match: slash[0], date: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` };
  }
  const monthName = MONTH_NAME_DATE_RE.exec(content || '');
  if (monthName) {
    const [, mon, d, yRaw] = monthName;
    const m = MONTH_NUM[mon.toLowerCase()];
    const y = yRaw || String(fallbackYear);
    return { match: monthName[0], date: `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}` };
  }
  return null;
}

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.post('/api/discord/interactions', async (req, res) => {
  const valid = await verifyDiscordRequest(req);
  if (!valid) return res.status(401).send('invalid request signature');
  try {
    const result = await handleInteraction(req.body);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.json({
      type: 4,
      data: { content: 'Something went wrong handling that command.', flags: 64 },
    });
  }
});

// Scans a configured Discord channel for boss-kill mentions and restarts
// the matching interval-type boss timer(s). Outside the cookie-auth gate
// (below) so it can be triggered by Vercel Cron or an external scheduler —
// protected by its own CRON_SECRET bearer check instead, when configured.
app.all('/api/discord/poll-boss-kills', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const channelId = process.env.DISCORD_BOSS_CHANNEL_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !botToken) {
    return res.json({ skipped: true, reason: 'DISCORD_BOSS_CHANNEL_ID or DISCORD_BOT_TOKEN not configured' });
  }

  try {
    await ensureSchema();

    const { rows: stateRows } = await sql`SELECT last_message_id FROM boss_kill_poll_state WHERE id = 1`;
    const lastId = stateRows[0]?.last_message_id;

    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    url.searchParams.set('limit', '100');
    if (lastId) url.searchParams.set('after', lastId);

    const discordRes = await discordFetch(url, { headers: { Authorization: `Bot ${botToken}` } });
    if (!discordRes.ok) {
      const details = await discordRes.text();
      return res.status(502).json({ error: 'discord fetch failed', details });
    }
    // The API always returns newest-first regardless of the after/before
    // param used. Advance the cursor off the raw (unfiltered) newest id so a
    // quiet-channel gap doesn't get re-fetched forever, but only match kills
    // within the last 12 hours so a poll never restarts a timer off a stale
    // mention sitting further back in a since-idle cursor window. Bot
    // messages (including our own "spawns in about 10 minutes!" pings, which
    // literally contain the boss's name) are excluded so this poll never
    // mistakes its own notification for a real kill confirmation.
    const rawMessages = await discordRes.json();
    const newestRawId = rawMessages[0]?.id;
    const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
    const messages = rawMessages
      .filter((msg) => !msg.author?.bot)
      .filter((msg) => new Date(msg.timestamp).getTime() >= twelveHoursAgo)
      .reverse();

    const { rows: bosses } = await sql`SELECT id, name, last_killed_at FROM boss_timers WHERE type = 'interval'`;
    const existingLastKilledAt = new Map(bosses.map((b) => [b.id, b.last_killed_at]));

    // Log every matching message to history (so who-posted-what stays
    // auditable even if several mentions show up in one poll window), but
    // only the most recent kill per boss actually restarts that boss's
    // timer — messages aren't guaranteed to be processed in kill-time order
    // (an explicit Time-of-Death message can name an instant earlier than a
    // generic mention processed right before it), so track the max rather
    // than just whatever was seen last.
    const killedAtByBossId = new Map();
    const setIfNewer = (bossId, killedAt) => {
      const current = killedAtByBossId.get(bossId);
      if (!current || new Date(killedAt).getTime() > new Date(current).getTime()) {
        killedAtByBossId.set(bossId, killedAt);
      }
    };
    for (const msg of messages) {
      const author = msg.author?.global_name || msg.author?.username || null;

      // Prefer an explicit "Boss: X / Time of Death: Y" message — it names
      // the actual kill instant instead of assuming it's whenever the
      // message happened to get posted. Falls through to the generic
      // substring scan below if the message doesn't use that format, or
      // names a boss that doesn't match any configured timer.
      const explicit = parseTimeOfDeathMessage(msg.content, msg.timestamp);
      const explicitBoss = explicit && matchBossByRunName(explicit.bossName, bosses);
      if (explicit && explicitBoss) {
        setIfNewer(explicitBoss.id, explicit.killedAt);
        await sql`
          INSERT INTO boss_kill_history (id, boss_id, boss_name, killed_at, source, discord_author)
          VALUES (${crypto.randomUUID()}, ${explicitBoss.id}, ${explicitBoss.name}, ${explicit.killedAt}, 'discord', ${author})
        `;
        continue;
      }

      const content = (msg.content || '').toLowerCase();
      for (const boss of bosses) {
        if (content.includes(boss.name.toLowerCase())) {
          setIfNewer(boss.id, msg.timestamp);
          await sql`
            INSERT INTO boss_kill_history (id, boss_id, boss_name, killed_at, source, discord_author)
            VALUES (${crypto.randomUUID()}, ${boss.id}, ${boss.name}, ${msg.timestamp}, 'discord', ${author})
          `;
        }
      }
    }

    // Only advance a boss's timer forward — a message surfaced by this poll
    // (e.g. an older mention caught by the 12-hour window, or a delayed
    // Discord post) must never roll last_killed_at backwards past a kill
    // that's already recorded, including one set by a manual correction.
    for (const [bossId, killedAt] of killedAtByBossId) {
      const existing = existingLastKilledAt.get(bossId);
      if (existing && new Date(existing).getTime() >= new Date(killedAt).getTime()) continue;
      await sql`UPDATE boss_timers SET last_killed_at = ${killedAt} WHERE id = ${bossId}`;
    }

    if (newestRawId) {
      await sql`
        INSERT INTO boss_kill_poll_state (id, last_message_id, updated_at) VALUES (1, ${newestRawId}, now())
        ON CONFLICT (id) DO UPDATE SET last_message_id = ${newestRawId}, updated_at = now()
      `;
    }

    res.json({ scanned: messages.length, matchedBosses: Array.from(killedAtByBossId.keys()) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'database unavailable' });
  }
});

// Posts a "spawning soon" Discord message for any interval-type boss whose
// next spawn falls within its own configured notify_lead_minutes (see
// validateNotifyLeadMinutes / boss_timers.notify_lead_minutes — defaults to
// 5). Meant to be hit by an external scheduler roughly once a minute, and
// more often than the SHORTEST configured lead time across all bosses, or a
// check can land after that boss's window has already closed — daily and
// Vercel Cron's coarser cadence are both too slow to reliably catch it.

// Matches boss-timer-view.js's EARLY_MARGIN_MS — biases the effective spawn
// instant a few minutes early, since arriving late risks losing the boss to
// a rival guild while arriving early just costs a short wait.
const EARLY_MARGIN_MS = 3 * 60 * 1000;

app.all('/api/discord/notify-spawns', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const channelId = process.env.DISCORD_BOSS_CHANNEL_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !botToken) {
    return res.json({ skipped: true, reason: 'DISCORD_BOSS_CHANNEL_ID or DISCORD_BOT_TOKEN not configured' });
  }

  try {
    await ensureSchema();

    const { rows: bosses } = await sql`
      SELECT * FROM boss_timers WHERE type = 'interval' AND last_killed_at IS NOT NULL
    `;

    const now = Date.now();
    const notified = [];
    for (const boss of bosses) {
      const nextSpawnMs = new Date(boss.last_killed_at).getTime() + boss.interval_minutes * 60000 - EARLY_MARGIN_MS;
      const alreadyNotified = boss.notified_spawn_at && new Date(boss.notified_spawn_at).getTime() === nextSpawnMs;
      if (alreadyNotified) continue;
      const leadMs = (boss.notify_lead_minutes || 5) * 60 * 1000;
      if (nextSpawnMs - now > leadMs || nextSpawnMs - now < 0) continue;

      const discordRes = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `@everyone ⏰ **${boss.name}** spawns in about ${boss.notify_lead_minutes || 5} minutes!` }),
      });
      if (!discordRes.ok) {
        console.error('discord notify failed', boss.name, await discordRes.text());
        continue;
      }

      await sql`UPDATE boss_timers SET notified_spawn_at = ${new Date(nextSpawnMs).toISOString()} WHERE id = ${boss.id}`;
      notified.push(boss.name);
    }

    res.json({ checked: bosses.length, notified });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'database unavailable' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  try {
    await ensureSchema();
    const { rows } = await sql`SELECT id, username, password_hash, role FROM users WHERE LOWER(username) = LOWER(${username})`;
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'incorrect username or password' });
    }
    setAuthCookie(res, user.id);
    await logActivity(req, { action: 'login', entityType: 'user', entityId: user.id, description: `Logged in as "${user.username}"`, user });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'database unavailable' });
  }
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/login.html', (req, res) => res.redirect('/login'));
app.get('/index.html', (req, res) => res.redirect('/'));

// Sovereign is its own standalone page (own header, no Capital Records
// nav/topbar) — the crusade roster/distribution tool lives in a real
// public/sovereign/crusade folder, only reachable through this /sovereign
// route rather than being wired into the main app's nav.
app.get('/sovereign', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'sovereign', 'crusade', 'index.html'));
});

// Viewing the site — every page and every GET /api/* — requires no login at
// all; anyone without a session is just a "viewer" by default. A couple of
// routes are GET but have a real mutating side effect (they register
// Discord commands / write icon URLs) — treated as writes here too, even
// though the blanket rule below only keys off HTTP method. User management
// is admin-only regardless of method.
const ADMIN_ONLY_GET_PATHS = new Set([
  '/api/discord/register-commands',
  '/api/item-categories/apply-icon-manifest',
  '/api/discord/cave-attendance-duplicates',
]);

// Registered after (not before, unlike poll-boss-kills) the gating
// middleware below, so it needs an explicit bypass here — it's protected by
// its own CRON_SECRET bearer check instead, since Vercel Cron/an external
// scheduler calls it directly with no user cookie at all.
const COOKIE_AUTH_EXEMPT_PATHS = new Set(['/api/discord/poll-cave-attendance']);

// Enforced here in one place rather than per-route, so a new mutating
// endpoint is safe-by-default instead of accidentally open to viewers.
// Stashes the resolved user on req.currentUser so route handlers can log
// activity without a second lookup.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (COOKIE_AUTH_EXEMPT_PATHS.has(req.path)) return next();
  const needsAuth = req.method !== 'GET' || ADMIN_ONLY_GET_PATHS.has(req.path);
  const needsAdmin =
    req.path.startsWith('/api/users') ||
    req.path === '/api/activity-log' ||
    req.path.startsWith('/api/discord/cave-attendance-duplicates') ||
    ADMIN_ONLY_GET_PATHS.has(req.path);
  if (!needsAuth && !needsAdmin) return next();

  const user = await getCurrentUser(req);
  req.currentUser = user;
  if (needsAdmin && !isAdminUser(user)) {
    return res.status(403).json({ error: 'admin access required' });
  }
  if (needsAuth && !canEdit(user)) {
    return res.status(403).json({ error: 'view-only access — log in to make changes' });
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/session', async (req, res) => {
  const user = await getCurrentUser(req);
  res.json({ role: user?.role || 'viewer', username: user?.username || null });
});

app.use('/api', withSchema);

const USER_ROLES = new Set(['admin', 'editor', 'viewer']);

app.get('/api/users', async (req, res) => {
  const { rows } = await sql`SELECT id, username, role, created_at FROM users ORDER BY created_at ASC`;
  res.json(rows.map((r) => ({ id: r.id, username: r.username, role: r.role, createdAt: r.created_at })));
});

app.post('/api/users', async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: 'username is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  if (!USER_ROLES.has(role)) return res.status(400).json({ error: 'role must be admin, editor, or viewer' });

  const trimmedUsername = username.trim();
  const { rows: existing } = await sql`SELECT id FROM users WHERE LOWER(username) = LOWER(${trimmedUsername})`;
  if (existing[0]) return res.status(400).json({ error: 'that username is already taken' });

  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO users (id, username, password_hash, role)
    VALUES (${id}, ${trimmedUsername}, ${hashPassword(password)}, ${role})
    RETURNING id, username, role, created_at
  `;
  const row = rows[0];
  await logActivity(req, {
    action: 'create',
    entityType: 'user',
    entityId: row.id,
    description: `Created user "${row.username}" with role ${row.role}`,
    after: { username: row.username, role: row.role },
  });
  res.status(201).json({ id: row.id, username: row.username, role: row.role, createdAt: row.created_at });
});

app.put('/api/users/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM users WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'user not found' });

  const { username, password, role } = req.body || {};
  let nextUsername = existing.username;
  let nextPasswordHash = existing.password_hash;
  let nextRole = existing.role;

  if (username !== undefined) {
    if (!username.trim()) return res.status(400).json({ error: 'username cannot be empty' });
    const { rows: dupe } = await sql`SELECT id FROM users WHERE LOWER(username) = LOWER(${username.trim()}) AND id != ${existing.id}`;
    if (dupe[0]) return res.status(400).json({ error: 'that username is already taken' });
    nextUsername = username.trim();
  }
  if (password !== undefined && password !== '') {
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    nextPasswordHash = hashPassword(password);
  }
  if (role !== undefined) {
    if (!USER_ROLES.has(role)) return res.status(400).json({ error: 'role must be admin, editor, or viewer' });
    if (existing.role === 'admin' && role !== 'admin') {
      const { rows: adminCountRows } = await sql`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'`;
      if (adminCountRows[0].count <= 1) {
        return res.status(400).json({ error: 'cannot demote the last remaining admin' });
      }
    }
    nextRole = role;
  }

  const { rows } = await sql`
    UPDATE users SET username = ${nextUsername}, password_hash = ${nextPasswordHash}, role = ${nextRole}
    WHERE id = ${req.params.id}
    RETURNING id, username, role, created_at
  `;
  const row = rows[0];
  await logActivity(req, {
    action: 'update',
    entityType: 'user',
    entityId: row.id,
    description: `Updated user "${row.username}" (role: ${row.role})`,
    before: { username: existing.username, role: existing.role },
    after: { username: row.username, role: row.role },
  });
  res.json({ id: row.id, username: row.username, role: row.role, createdAt: row.created_at });
});

app.delete('/api/users/:id', async (req, res) => {
  if (req.params.id === req.currentUser.id) {
    return res.status(400).json({ error: "you can't delete your own account" });
  }
  const { rows: existingRows } = await sql`SELECT username, role FROM users WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'user not found' });

  if (existing.role === 'admin') {
    const { rows: adminCountRows } = await sql`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'`;
    if (adminCountRows[0].count <= 1) {
      return res.status(400).json({ error: 'cannot delete the last remaining admin' });
    }
  }

  await sql`DELETE FROM users WHERE id = ${req.params.id}`;
  await logActivity(req, { action: 'delete', entityType: 'user', entityId: req.params.id, description: `Deleted user "${existing.username}"`, before: { username: existing.username, role: existing.role } });
  res.status(204).end();
});

app.get('/api/activity-log', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const entityType = req.query.entityType || null;
  const { rows } = entityType
    ? await sql`
        SELECT id, username, role, action, entity_type, entity_id, description, before_data, after_data, created_at
        FROM activity_log
        WHERE entity_type = ${entityType}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT id, username, role, action, entity_type, entity_id, description, before_data, after_data, created_at
        FROM activity_log
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
  res.json(
    rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      description: r.description,
      before: r.before_data,
      after: r.after_data,
      createdAt: r.created_at,
    }))
  );
});

// Scoped clear -- requires entityType so a stray call can't wipe the whole
// site's audit trail. Deliberately NOT logged itself: a "cleared the log"
// entry would immediately become the one thing left sitting in an
// otherwise-empty log, which defeats clearing it.
app.delete('/api/activity-log', async (req, res) => {
  const entityType = req.query.entityType;
  if (!entityType) return res.status(400).json({ error: 'entityType query param is required' });

  await sql`DELETE FROM activity_log WHERE entity_type = ${entityType}`;
  res.status(204).end();
});

app.get('/api/classes', async (req, res) => {
  res.json(await getClasses());
});

// Adding a class here is what "just add it and it shows up in Discord" means
// in practice: the /growth command's class choices are baked into the command
// definition at registration time (Discord has no live/dynamic choice list),
// so a new class only appears in Discord once registerCommands() re-runs —
// done automatically here rather than requiring a separate manual step.
app.post('/api/classes', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const trimmed = name.trim();

  const { rows: existing } = await sql`SELECT id FROM classes WHERE LOWER(name) = LOWER(${trimmed})`;
  if (existing.length) return res.status(400).json({ error: 'that class already exists' });

  const id = crypto.randomUUID();
  await sql`INSERT INTO classes (id, name) VALUES (${id}, ${trimmed})`;

  let discordRegistered = false;
  let discordError = null;
  try {
    await registerCommands();
    discordRegistered = true;
  } catch (err) {
    discordError = err.message;
    console.error('failed to re-register Discord commands after adding class', err, err.details);
  }

  await logActivity(req, { action: 'create', entityType: 'class', entityId: id, description: `Added class "${trimmed}"`, after: { name: trimmed } });
  res.status(201).json({ id, name: trimmed, discordRegistered, discordError });
});

// Keyed by name (not id) since GET /api/classes returns plain name strings —
// existing consumers (member forms, class filters) expect that shape, so this
// avoids changing it just to thread ids through everywhere that uses it.
app.delete('/api/classes/:name', async (req, res) => {
  const { rowCount } = await sql`DELETE FROM classes WHERE name = ${req.params.name}`;
  if (!rowCount) return res.status(404).json({ error: 'class not found' });

  let discordRegistered = false;
  let discordError = null;
  try {
    await registerCommands();
    discordRegistered = true;
  } catch (err) {
    discordError = err.message;
    console.error('failed to re-register Discord commands after removing class', err, err.details);
  }

  await logActivity(req, { action: 'delete', entityType: 'class', entityId: req.params.name, description: `Removed class "${req.params.name}"`, before: { name: req.params.name } });
  res.json({ discordRegistered, discordError });
});

app.get('/api/discord/register-commands', async (req, res) => {
  try {
    const registered = await registerCommands();
    res.json({ registered: registered.map((c) => ({ name: c.name, description: c.description })) });
  } catch (err) {
    console.error(err, err.details);
    res.status(500).json({ error: err.message, details: err.details });
  }
});

app.get('/api/members', async (req, res) => {
  const { rows } = await sql`SELECT * FROM members ORDER BY created_at ASC`;
  const growthMap = await fetchGrowthByMemberIds(rows.map((r) => r.id));
  res.json(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      alias: row.alias,
      className: row.class_name,
      notes: row.notes,
      createdAt: row.created_at,
      growth: growthMap.get(row.id) || [],
    }))
  );
});

app.get('/api/members/export', async (req, res) => {
  const { rows } = await sql`SELECT * FROM members ORDER BY name ASC`;
  const growthMap = await fetchGrowthByMemberIds(rows.map((r) => r.id));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Capital Records';
  workbook.created = new Date();

  const membersSheet = workbook.addWorksheet('Members');
  membersSheet.columns = [
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Alias', key: 'alias', width: 20 },
    { header: 'Class', key: 'className', width: 20 },
    { header: 'Latest Growth Rate', key: 'latestRate', width: 20 },
    { header: 'Latest Growth Date', key: 'latestDate', width: 18 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Joined', key: 'createdAt', width: 14 },
  ];
  membersSheet.getRow(1).font = { bold: true };

  rows.forEach((row) => {
    const growth = growthMap.get(row.id) || [];
    const latest = growth[growth.length - 1];
    membersSheet.addRow({
      name: row.name,
      alias: row.alias,
      className: row.class_name,
      latestRate: latest ? latest.rate : null,
      latestDate: latest ? latest.date : '',
      notes: row.notes,
      createdAt: new Date(row.created_at).toISOString().slice(0, 10),
    });
  });

  const growthSheet = workbook.addWorksheet('Growth History');
  growthSheet.columns = [
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Rate', key: 'rate', width: 14 },
    { header: 'Note', key: 'note', width: 30 },
  ];
  growthSheet.getRow(1).font = { bold: true };

  rows.forEach((row) => {
    const growth = growthMap.get(row.id) || [];
    growth.forEach((g) => {
      growthSheet.addRow({ name: row.name, date: g.date, rate: g.rate, note: g.note });
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="capital-records-members.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
});

app.post('/api/members', async (req, res) => {
  const { name, className, notes, alias } = req.body || {};
  if (!name || !name.trim() || !(await getClasses()).includes(className)) {
    return res.status(400).json({ error: 'name and a valid class are required' });
  }
  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO members (id, name, class_name, notes, alias)
    VALUES (${id}, ${name.trim()}, ${className}, ${(notes || '').trim()}, ${(alias || '').trim()})
    RETURNING *
  `;
  await logActivity(req, {
    action: 'create',
    entityType: 'member',
    entityId: rows[0].id,
    description: `Added member "${rows[0].name}"`,
    after: { name: rows[0].name, alias: rows[0].alias, className: rows[0].class_name, notes: rows[0].notes },
  });
  res.status(201).json(await serializeMember(rows[0]));
});

app.put('/api/members/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM members WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'member not found' });

  const { name, className, notes, alias } = req.body || {};
  let nextName = existing.name;
  let nextClassName = existing.class_name;
  let nextNotes = existing.notes;
  let nextAlias = existing.alias;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
  }
  if (className !== undefined) {
    if (!(await getClasses()).includes(className)) return res.status(400).json({ error: 'invalid class' });
    nextClassName = className;
  }
  if (notes !== undefined) nextNotes = notes.trim();
  if (alias !== undefined) nextAlias = alias.trim();

  const { rows } = await sql`
    UPDATE members SET name = ${nextName}, class_name = ${nextClassName}, notes = ${nextNotes}, alias = ${nextAlias}
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'member',
    entityId: rows[0].id,
    description: `Updated member "${rows[0].name}"`,
    before: { name: existing.name, alias: existing.alias, className: existing.class_name, notes: existing.notes },
    after: { name: rows[0].name, alias: rows[0].alias, className: rows[0].class_name, notes: rows[0].notes },
  });
  res.json(await serializeMember(rows[0]));
});

app.delete('/api/members/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM members WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  const { rowCount } = await sql`DELETE FROM members WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'member not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'member',
    entityId: req.params.id,
    description: `Removed member "${existing?.name}"`,
    before: existing ? { name: existing.name, alias: existing.alias, className: existing.class_name, notes: existing.notes } : undefined,
  });
  res.status(204).end();
});

app.post('/api/members/:id/growth', async (req, res) => {
  const { rows: memberRows } = await sql`SELECT id, name FROM members WHERE id = ${req.params.id}`;
  if (!memberRows[0]) return res.status(404).json({ error: 'member not found' });

  const { date, rate, note } = req.body || {};
  const numericRate = Number(rate);
  if (!date || Number.isNaN(numericRate)) {
    return res.status(400).json({ error: 'date and a numeric rate are required' });
  }
  const id = crypto.randomUUID();
  const trimmedNote = (note || '').trim();
  await sql`
    INSERT INTO growth_entries (id, member_id, date, rate, note)
    VALUES (${id}, ${req.params.id}, ${date}, ${numericRate}, ${trimmedNote})
  `;
  await logActivity(req, {
    action: 'create',
    entityType: 'growth_entry',
    entityId: id,
    description: `Added growth entry for "${memberRows[0].name}" (${date}: ${numericRate})`,
    after: { member: memberRows[0].name, date, rate: numericRate, note: trimmedNote },
  });
  res.status(201).json({ id, date, rate: numericRate, note: trimmedNote });
});

app.delete('/api/members/:id/growth/:growthId', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT date, rate, note FROM growth_entries WHERE id = ${req.params.growthId} AND member_id = ${req.params.id}`;
  const existing = existingRows[0];
  const { rowCount } = await sql`
    DELETE FROM growth_entries WHERE id = ${req.params.growthId} AND member_id = ${req.params.id}
  `;
  if (!rowCount) return res.status(404).json({ error: 'growth entry not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'growth_entry',
    entityId: req.params.growthId,
    description: 'Removed a growth entry',
    before: existing ? { date: existing.date, rate: Number(existing.rate), note: existing.note } : undefined,
  });
  res.status(204).end();
});

app.get('/api/queue', async (req, res) => {
  const { rows } = await sql`SELECT slot, names, done FROM queue_slots`;
  const queue = SLOTS.reduce((acc, slot) => {
    acc[slot] = [];
    return acc;
  }, {});
  const done = SLOTS.reduce((acc, slot) => {
    acc[slot] = [];
    return acc;
  }, {});
  rows.forEach((row) => {
    queue[row.slot] = row.names;
    done[row.slot] = row.done;
  });
  res.json({ slots: SLOTS, queue, done });
});

// An earlier version of this feature stored `done` as plain name strings
// instead of {name, completedAt} objects — normalize either shape.
function doneEntryName(d) {
  return typeof d === 'string' ? d : d.name;
}

app.put('/api/queue/:slot', async (req, res) => {
  const slot = req.params.slot;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: 'invalid slot' });

  const { names } = req.body || {};
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
    return res.status(400).json({ error: 'names must be an array of strings' });
  }

  const cleaned = names.map((n) => n.trim()).filter(Boolean);
  const { rows: existingRows } = await sql`SELECT names, done FROM queue_slots WHERE slot = ${slot}`;
  const existingNames = existingRows[0]?.names || [];
  const existingDone = existingRows[0]?.done || [];
  const doneNames = new Set(existingDone.map(doneEntryName));

  // Anyone already marked complete for this slot can't be re-queued for it.
  const newlyAdded = cleaned.filter((n) => !existingNames.includes(n));
  const blocked = newlyAdded.find((n) => doneNames.has(n));
  if (blocked) {
    return res.status(400).json({ error: `${blocked} has already received this insignia part` });
  }

  await sql`
    INSERT INTO queue_slots (slot, names) VALUES (${slot}, ${JSON.stringify(cleaned)})
    ON CONFLICT (slot) DO UPDATE SET names = ${JSON.stringify(cleaned)}
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'queue_slot',
    entityId: slot,
    description: `Updated the ${slot} insignia queue`,
    before: { names: existingNames },
    after: { names: cleaned },
  });
  res.json({ slot, names: cleaned, done: existingDone });
});

// Marks a queued member as having received this insignia part: removes them
// from the active queue and adds a permanent (never-pruned) completion
// record, so they can't be re-queued for the same part later.
app.post('/api/queue/:slot/complete', async (req, res) => {
  const slot = req.params.slot;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: 'invalid slot' });

  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const trimmedName = name.trim();

  const { rows } = await sql`SELECT names, done FROM queue_slots WHERE slot = ${slot}`;
  const existingNames = rows[0]?.names || [];
  const existingDone = rows[0]?.done || [];
  if (!existingNames.includes(trimmedName)) {
    return res.status(400).json({ error: 'name is not in this queue' });
  }

  const nextNames = existingNames.filter((n) => n !== trimmedName);
  const nextDone = [...existingDone, { name: trimmedName, completedAt: new Date().toISOString() }];
  await sql`
    UPDATE queue_slots SET names = ${JSON.stringify(nextNames)}, done = ${JSON.stringify(nextDone)}
    WHERE slot = ${slot}
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'queue_slot',
    entityId: slot,
    description: `Marked "${trimmedName}" as received ${slot} insignia`,
    before: { names: existingNames },
    after: { names: nextNames },
  });
  res.json({ slot, names: nextNames, done: nextDone });
});

// Undo a completion record (e.g. checked by mistake) — does not re-queue them.
app.delete('/api/queue/:slot/complete/:name', async (req, res) => {
  const slot = req.params.slot;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: 'invalid slot' });

  const { rows } = await sql`SELECT done FROM queue_slots WHERE slot = ${slot}`;
  const existingDone = rows[0]?.done || [];
  const nextDone = existingDone.filter((d) => doneEntryName(d) !== req.params.name);
  await sql`UPDATE queue_slots SET done = ${JSON.stringify(nextDone)} WHERE slot = ${slot}`;
  await logActivity(req, {
    action: 'update',
    entityType: 'queue_slot',
    entityId: slot,
    description: `Undid "${req.params.name}"'s completion record for ${slot}`,
    before: { done: existingDone.map(doneEntryName) },
    after: { done: nextDone.map(doneEntryName) },
  });
  res.json({ slot, done: nextDone });
});

function serializeBossTimer(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    spawnTime: row.spawn_time,
    intervalMinutes: row.interval_minutes,
    lastKilledAt: row.last_killed_at,
    notifyLeadMinutes: row.notify_lead_minutes,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function bossTimerSnapshot(row) {
  return {
    name: row.name,
    type: row.type,
    spawnTime: row.spawn_time,
    intervalMinutes: row.interval_minutes,
    notifyLeadMinutes: row.notify_lead_minutes,
    notes: row.notes,
  };
}

function validateNotifyLeadMinutes(value) {
  const mins = Number(value);
  return Number.isFinite(mins) && mins > 0 ? mins : null;
}

app.get('/api/boss-timers', async (req, res) => {
  const { rows } = await sql`SELECT * FROM boss_timers ORDER BY created_at ASC`;
  res.json(rows.map(serializeBossTimer));
});

app.post('/api/boss-timers', async (req, res) => {
  const { name, type, spawnTime, intervalMinutes, notifyLeadMinutes, notes } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (type !== 'daily' && type !== 'interval') {
    return res.status(400).json({ error: 'type must be "daily" or "interval"' });
  }
  if (type === 'daily' && (!spawnTime || !/^\d{2}:\d{2}$/.test(spawnTime))) {
    return res.status(400).json({ error: 'spawnTime must be in HH:MM format' });
  }
  if (type === 'interval') {
    const mins = Number(intervalMinutes);
    if (!Number.isFinite(mins) || mins < 1) {
      return res.status(400).json({ error: 'intervalMinutes must be a positive number' });
    }
  }
  const leadMinutes = notifyLeadMinutes !== undefined ? validateNotifyLeadMinutes(notifyLeadMinutes) : 5;
  if (leadMinutes === null) return res.status(400).json({ error: 'notifyLeadMinutes must be a positive number' });

  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO boss_timers (id, name, type, spawn_time, interval_minutes, notify_lead_minutes, notes)
    VALUES (
      ${id}, ${name.trim()}, ${type},
      ${type === 'daily' ? spawnTime : null},
      ${type === 'interval' ? Number(intervalMinutes) : null},
      ${leadMinutes},
      ${(notes || '').trim()}
    )
    RETURNING *
  `;
  await logActivity(req, { action: 'create', entityType: 'boss_timer', entityId: rows[0].id, description: `Added boss timer "${rows[0].name}"`, after: bossTimerSnapshot(rows[0]) });
  res.status(201).json(serializeBossTimer(rows[0]));
});

app.put('/api/boss-timers/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM boss_timers WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'boss timer not found' });

  const { name, type, spawnTime, intervalMinutes, notifyLeadMinutes, notes } = req.body || {};

  let nextType = existing.type;
  if (type !== undefined) {
    if (type !== 'daily' && type !== 'interval') {
      return res.status(400).json({ error: 'type must be "daily" or "interval"' });
    }
    nextType = type;
  }

  let nextSpawnTime = existing.spawn_time;
  let nextIntervalMinutes = existing.interval_minutes;
  if (nextType === 'daily') {
    if (spawnTime !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(spawnTime)) return res.status(400).json({ error: 'spawnTime must be in HH:MM format' });
      nextSpawnTime = spawnTime;
    }
    nextIntervalMinutes = null;
  } else {
    if (intervalMinutes !== undefined) {
      const mins = Number(intervalMinutes);
      if (!Number.isFinite(mins) || mins < 1) return res.status(400).json({ error: 'intervalMinutes must be a positive number' });
      nextIntervalMinutes = mins;
    }
    nextSpawnTime = null;
  }

  const nextName = name !== undefined ? name.trim() : existing.name;
  if (!nextName) return res.status(400).json({ error: 'name cannot be empty' });
  const nextNotes = notes !== undefined ? notes.trim() : existing.notes;

  let nextLeadMinutes = existing.notify_lead_minutes;
  if (notifyLeadMinutes !== undefined) {
    nextLeadMinutes = validateNotifyLeadMinutes(notifyLeadMinutes);
    if (nextLeadMinutes === null) return res.status(400).json({ error: 'notifyLeadMinutes must be a positive number' });
  }

  const { rows } = await sql`
    UPDATE boss_timers
    SET name = ${nextName}, type = ${nextType}, spawn_time = ${nextSpawnTime},
        interval_minutes = ${nextIntervalMinutes}, notify_lead_minutes = ${nextLeadMinutes}, notes = ${nextNotes}
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'boss_timer',
    entityId: rows[0].id,
    description: `Updated boss timer "${rows[0].name}"`,
    before: bossTimerSnapshot(existing),
    after: bossTimerSnapshot(rows[0]),
  });
  res.json(serializeBossTimer(rows[0]));
});

app.post('/api/boss-timers/:id/kill', async (req, res) => {
  const { killedAt } = req.body || {};
  let killedAtValue = new Date();
  if (killedAt !== undefined) {
    killedAtValue = new Date(killedAt);
    if (Number.isNaN(killedAtValue.getTime())) return res.status(400).json({ error: 'killedAt must be a valid date' });
  }
  const { rows: existingRows } = await sql`SELECT last_killed_at FROM boss_timers WHERE id = ${req.params.id}`;
  const { rows } = await sql`
    UPDATE boss_timers SET last_killed_at = ${killedAtValue.toISOString()} WHERE id = ${req.params.id} AND type = 'interval'
    RETURNING *
  `;
  if (!rows[0]) return res.status(404).json({ error: 'interval boss timer not found' });
  await sql`
    INSERT INTO boss_kill_history (id, boss_id, boss_name, killed_at, source)
    VALUES (${crypto.randomUUID()}, ${rows[0].id}, ${rows[0].name}, ${killedAtValue.toISOString()}, 'manual')
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'boss_timer',
    entityId: rows[0].id,
    description: `Set "${rows[0].name}" kill time to ${killedAtValue.toISOString()}`,
    before: { lastKilledAt: existingRows[0]?.last_killed_at ?? null },
    after: { lastKilledAt: rows[0].last_killed_at },
  });
  res.json(serializeBossTimer(rows[0]));
});

app.delete('/api/boss-timers/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM boss_timers WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  const { rowCount } = await sql`DELETE FROM boss_timers WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'boss timer not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'boss_timer',
    entityId: req.params.id,
    description: `Removed boss timer "${existing?.name}"`,
    before: existing ? bossTimerSnapshot(existing) : undefined,
  });
  res.status(204).end();
});

app.get('/api/boss-history', async (req, res) => {
  const { rows } = await sql`
    SELECT id, boss_name, killed_at, source, discord_author
    FROM boss_kill_history
    ORDER BY killed_at DESC
    LIMIT 200
  `;
  res.json(
    rows.map((r) => ({
      id: r.id,
      bossName: r.boss_name,
      killedAt: r.killed_at,
      source: r.source,
      discordAuthor: r.discord_author,
    }))
  );
});

app.delete('/api/boss-history/:id', async (req, res) => {
  const { rows: entryRows } = await sql`SELECT * FROM boss_kill_history WHERE id = ${req.params.id}`;
  const entry = entryRows[0];
  if (!entry) return res.status(404).json({ error: 'history entry not found' });

  // If this entry's killed_at is what boss_timers.last_killed_at is currently
  // set to, deleting it without also rolling the timer back would leave the
  // countdown pointed at a kill that no longer appears in the log at all.
  // Compared by exact value against the live column — NOT by "is this the
  // max killed_at in the log" — because poll-boss-kills sets last_killed_at
  // from whichever message it processes last in Discord's posting order,
  // which isn't necessarily the entry with the latest computed kill time
  // (e.g. a wrongly-logged entry can sit at a non-max timestamp while still
  // being the one actually driving the timer).
  let revertedBossId = null;
  let revertedTo = null;
  if (entry.boss_id) {
    const { rows: bossRows } = await sql`SELECT last_killed_at FROM boss_timers WHERE id = ${entry.boss_id}`;
    const boss = bossRows[0];
    const isCurrent = boss?.last_killed_at && new Date(boss.last_killed_at).getTime() === new Date(entry.killed_at).getTime();
    if (isCurrent) {
      const { rows: nextRows } = await sql`
        SELECT killed_at FROM boss_kill_history
        WHERE boss_id = ${entry.boss_id} AND id != ${entry.id}
        ORDER BY killed_at DESC LIMIT 1
      `;
      revertedBossId = entry.boss_id;
      revertedTo = nextRows[0]?.killed_at || null;
      await sql`UPDATE boss_timers SET last_killed_at = ${revertedTo} WHERE id = ${entry.boss_id}`;
    }
  }

  await sql`DELETE FROM boss_kill_history WHERE id = ${req.params.id}`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'boss_kill_history',
    entityId: req.params.id,
    description: `Removed a "${entry.boss_name}" kill history entry`,
    before: { bossName: entry.boss_name, killedAt: entry.killed_at, source: entry.source, discordAuthor: entry.discord_author },
  });
  res.json({ deleted: true, revertedBossId, revertedTo });
});

// Read-only peek at the configured boss channel's recent history, for
// diagnosing why auto-detection did/didn't match. Cookie-gated like the
// rest of the app rather than CRON_SECRET-gated like the poller itself.
app.get('/api/discord/boss-channel-messages', async (req, res) => {
  const channelId = process.env.DISCORD_BOSS_CHANNEL_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !botToken) {
    return res.json({ skipped: true, reason: 'DISCORD_BOSS_CHANNEL_ID or DISCORD_BOT_TOKEN not configured' });
  }
  const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
  url.searchParams.set('limit', '100');
  const discordRes = await discordFetch(url, { headers: { Authorization: `Bot ${botToken}` } });
  if (!discordRes.ok) {
    const details = await discordRes.text();
    return res.status(502).json({ error: 'discord fetch failed', details });
  }
  const messages = (await discordRes.json()).slice().reverse();
  if (req.query.raw) return res.json(messages);
  res.json(
    messages.map((m) => ({
      timestamp: m.timestamp,
      author: m.author?.global_name || m.author?.username,
      content: m.content,
      attachments: (m.attachments || []).map((a) => a.filename),
      embeds: (m.embeds || []).length,
      type: m.type,
      hasSnapshots: !!(m.message_snapshots && m.message_snapshots.length),
    }))
  );
});

app.get('/api/item-categories', async (req, res) => {
  const { rows } = await sql`SELECT id, name, icon_url FROM item_categories ORDER BY created_at ASC`;
  res.json(rows.map((r) => ({ id: r.id, name: r.name, iconUrl: r.icon_url })));
});

app.get('/api/item-categories/apply-icon-manifest', async (req, res) => {
  const results = [];
  for (const entry of ICON_MANIFEST) {
    const iconUrl = entry.file ? `/item-icons/${entry.file}` : null;
    const { rows: existing } = await sql`SELECT id FROM item_categories WHERE LOWER(name) = LOWER(${entry.name})`;
    if (existing.length) {
      // Only touch icon_url when the manifest actually has one to apply — a
      // name-only entry (no icon source yet) shouldn't blank out an icon
      // someone already set by hand via Manage Items.
      if (iconUrl) {
        await sql`UPDATE item_categories SET icon_url = ${iconUrl} WHERE id = ${existing[0].id}`;
        results.push({ name: entry.name, action: 'updated' });
      } else {
        results.push({ name: entry.name, action: 'skipped (already exists)' });
      }
    } else {
      await sql`INSERT INTO item_categories (id, name, icon_url) VALUES (${crypto.randomUUID()}, ${entry.name}, ${iconUrl})`;
      results.push({ name: entry.name, action: 'created' });
    }
  }
  res.json({ results });
});

app.post('/api/item-categories', async (req, res) => {
  const { name, iconUrl } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const trimmed = name.trim();
  const { rows: existing } = await sql`
    SELECT id FROM item_categories WHERE LOWER(name) = LOWER(${trimmed})
  `;
  if (existing.length) return res.status(400).json({ error: 'that item already exists' });

  const id = crypto.randomUUID();
  const trimmedIcon = (iconUrl || '').trim() || null;
  await sql`INSERT INTO item_categories (id, name, icon_url) VALUES (${id}, ${trimmed}, ${trimmedIcon})`;
  await logActivity(req, { action: 'create', entityType: 'item_category', entityId: id, description: `Added item "${trimmed}"`, after: { name: trimmed, iconUrl: trimmedIcon } });
  res.status(201).json({ id, name: trimmed, iconUrl: trimmedIcon });
});

app.put('/api/item-categories/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM item_categories WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'item not found' });

  const { name, iconUrl } = req.body || {};
  let nextName = existing.name;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();

    const { rows: dupRows } = await sql`
      SELECT id FROM item_categories WHERE LOWER(name) = LOWER(${nextName}) AND id != ${req.params.id}
    `;
    if (dupRows.length) return res.status(400).json({ error: 'that item already exists' });
  }
  const nextIcon = iconUrl !== undefined ? (iconUrl || '').trim() || null : existing.icon_url;

  await sql`UPDATE item_categories SET name = ${nextName}, icon_url = ${nextIcon} WHERE id = ${req.params.id}`;
  await logActivity(req, {
    action: 'update',
    entityType: 'item_category',
    entityId: req.params.id,
    description: `Updated item "${nextName}"`,
    before: { name: existing.name, iconUrl: existing.icon_url },
    after: { name: nextName, iconUrl: nextIcon },
  });
  res.json({ id: req.params.id, name: nextName, iconUrl: nextIcon });
});

app.delete('/api/item-categories/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name, icon_url FROM item_categories WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  const { rowCount } = await sql`DELETE FROM item_categories WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'item not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'item_category',
    entityId: req.params.id,
    description: `Removed item "${existing?.name}"`,
    before: existing ? { name: existing.name, iconUrl: existing.icon_url } : undefined,
  });
  res.status(204).end();
});

app.get('/api/loot', async (req, res) => {
  const { rows } = await sql`SELECT * FROM loot_sessions ORDER BY created_at ASC`;
  const recordsMap = await fetchLootRecords(rows.map((r) => r.id));
  res.json(rows.map((row) => serializeLootSession(row, recordsMap.get(row.id))));
});

app.get('/api/loot/:id', async (req, res) => {
  const { rows } = await sql`SELECT * FROM loot_sessions WHERE id = ${req.params.id}`;
  if (!rows[0]) return res.status(404).json({ error: 'session not found' });
  const recordsMap = await fetchLootRecords([rows[0].id]);
  res.json(serializeLootSession(rows[0], recordsMap.get(rows[0].id)));
});

app.post('/api/loot', async (req, res) => {
  const { date, run, notes } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date is required' });

  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO loot_sessions (id, date, run, notes)
    VALUES (${id}, ${date}, ${(run || '').trim()}, ${(notes || '').trim()})
    RETURNING *
  `;
  await logActivity(req, {
    action: 'create',
    entityType: 'loot_session',
    entityId: rows[0].id,
    description: `Logged a Guild Dungeon date: ${rows[0].date}${rows[0].run ? ` (${rows[0].run})` : ''}`,
    after: { date: rows[0].date, run: rows[0].run, notes: rows[0].notes },
  });
  res.status(201).json(serializeLootSession(rows[0], []));
});

app.put('/api/loot/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM loot_sessions WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'session not found' });

  const { date, run, notes, absentees } = req.body || {};
  if (date !== undefined && !date) return res.status(400).json({ error: 'date cannot be empty' });
  if (absentees !== undefined && (!Array.isArray(absentees) || !absentees.every((a) => typeof a === 'string'))) {
    return res.status(400).json({ error: 'absentees must be an array of member ids' });
  }

  const nextDate = date !== undefined ? date : existing.date;
  const nextRun = run !== undefined ? run.trim() : existing.run;
  const nextNotes = notes !== undefined ? notes.trim() : existing.notes;
  const nextAbsentees = absentees !== undefined ? absentees : existing.absentees;

  const { rows } = await sql`
    UPDATE loot_sessions
    SET date = ${nextDate}, run = ${nextRun}, notes = ${nextNotes}, absentees = ${JSON.stringify(nextAbsentees)}
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  const recordsMap = await fetchLootRecords([rows[0].id]);
  const [beforeAbsentees, afterAbsentees] = await Promise.all([
    memberNamesForIds(existing.absentees || []),
    memberNamesForIds(rows[0].absentees || []),
  ]);
  await logActivity(req, {
    action: 'update',
    entityType: 'loot_session',
    entityId: rows[0].id,
    description: `Updated Guild Dungeon date: ${rows[0].date}${rows[0].run ? ` (${rows[0].run})` : ''}`,
    before: { date: existing.date, run: existing.run, notes: existing.notes, absentees: beforeAbsentees },
    after: { date: rows[0].date, run: rows[0].run, notes: rows[0].notes, absentees: afterAbsentees },
  });
  res.json(serializeLootSession(rows[0], recordsMap.get(rows[0].id)));
});

app.delete('/api/loot/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT date, run, notes FROM loot_sessions WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  const { rowCount } = await sql`DELETE FROM loot_sessions WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'session not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'loot_session',
    entityId: req.params.id,
    description: 'Deleted a Guild Dungeon date',
    before: existing ? { date: existing.date, run: existing.run, notes: existing.notes } : undefined,
  });
  res.status(204).end();
});

// Finalizes attendance for a session. If the session's "run" name matches an
// interval-type boss timer, posts a Discord button to the boss channel —
// clicking it (handled in lib/discord.js) is what actually restarts that
// boss's timer, so a raid officer confirms the kill from Discord rather than
// this endpoint restarting it unconditionally from a possibly-wrong name match.
app.post('/api/loot/:id/submit-attendance', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM loot_sessions WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'session not found' });

  if (existing.attendance_submitted_at) {
    const recordsMap = await fetchLootRecords([existing.id]);
    return res.json({
      session: serializeLootSession(existing, recordsMap.get(existing.id)),
      alreadySubmitted: true,
    });
  }

  const { rows: bosses } = await sql`SELECT id, name FROM boss_timers WHERE type = 'interval'`;
  const matchedBoss = matchBossByRunName(existing.run, bosses);

  const { rows } = await sql`
    UPDATE loot_sessions SET attendance_submitted_at = now(), boss_id = ${matchedBoss ? matchedBoss.id : null}
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  const updated = rows[0];

  let discordPosted = false;
  let discordSkippedReason = null;
  if (matchedBoss) {
    const channelId = process.env.DISCORD_BOSS_CHANNEL_ID;
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!channelId || !botToken) {
      discordSkippedReason = 'DISCORD_BOSS_CHANNEL_ID or DISCORD_BOT_TOKEN not configured';
    } else {
      try {
        const discordRes = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `📋 Attendance submitted for **${matchedBoss.name}** (${existing.run || existing.date}). Confirm the kill to start its timer:`,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 3,
                    label: `Confirm ${matchedBoss.name} kill`,
                    custom_id: `confirm_boss_kill:${matchedBoss.id}:${updated.id}`,
                  },
                ],
              },
            ],
          }),
        });
        if (discordRes.ok) {
          discordPosted = true;
        } else {
          discordSkippedReason = await discordRes.text();
          console.error('discord confirm-kill post failed', discordSkippedReason);
        }
      } catch (err) {
        discordSkippedReason = err.message;
        console.error('discord confirm-kill post failed', err);
      }
    }
  }

  const recordsMap = await fetchLootRecords([updated.id]);
  await logActivity(req, {
    action: 'update',
    entityType: 'loot_session',
    entityId: updated.id,
    description: `Submitted attendance for ${updated.date}${updated.run ? ` (${updated.run})` : ''}`,
    before: { attendanceSubmittedAt: existing.attendance_submitted_at },
    after: { attendanceSubmittedAt: updated.attendance_submitted_at, matchedBoss: matchedBoss?.name || null },
  });
  res.json({
    session: serializeLootSession(updated, recordsMap.get(updated.id)),
    matchedBoss: matchedBoss ? { id: matchedBoss.id, name: matchedBoss.name } : null,
    discordPosted,
    discordSkippedReason,
  });
});

app.post('/api/loot/:id/raffle-log', async (req, res) => {
  const { rows: sessionRows } = await sql`SELECT raffle_log FROM loot_sessions WHERE id = ${req.params.id}`;
  const session = sessionRows[0];
  if (!session) return res.status(404).json({ error: 'session not found' });

  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });

  const entry = { id: crypto.randomUUID(), message: message.trim(), createdAt: new Date().toISOString() };
  const nextLog = [...(session.raffle_log || []), entry];

  await sql`UPDATE loot_sessions SET raffle_log = ${JSON.stringify(nextLog)} WHERE id = ${req.params.id}`;
  await logActivity(req, { action: 'create', entityType: 'raffle_log', entityId: req.params.id, description: entry.message, after: { message: entry.message } });
  res.status(201).json(entry);
});

app.delete('/api/loot/:id/raffle-log', async (req, res) => {
  const { rows: sessionRows } = await sql`SELECT id, raffle_log FROM loot_sessions WHERE id = ${req.params.id}`;
  if (!sessionRows[0]) return res.status(404).json({ error: 'session not found' });

  await sql`UPDATE loot_sessions SET raffle_log = '[]' WHERE id = ${req.params.id}`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'raffle_log',
    entityId: req.params.id,
    description: 'Cleared the raffle activity log',
    before: { messages: (sessionRows[0].raffle_log || []).map((e) => e.message) },
  });
  res.status(204).end();
});

app.post('/api/loot/:id/records', async (req, res) => {
  const { rows: sessionRows } = await sql`SELECT id FROM loot_sessions WHERE id = ${req.params.id}`;
  if (!sessionRows[0]) return res.status(404).json({ error: 'session not found' });

  const { recipientId, item, quantity, notes, viaRaffle, viaReservation } = req.body || {};
  if (!item || !item.trim()) return res.status(400).json({ error: 'item is required' });
  const qty = quantity === undefined || quantity === '' ? 1 : Number(quantity);
  if (Number.isNaN(qty) || qty < 1) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  let member = null;
  if (recipientId) {
    const { rows: memberRows } = await sql`SELECT id, name FROM members WHERE id = ${recipientId}`;
    member = memberRows[0];
    if (!member) return res.status(400).json({ error: 'recipient does not exist' });
  }

  const id = crypto.randomUUID();
  const trimmedNotes = (notes || '').trim();
  const trimmedItem = item.trim();
  const { rows } = await sql`
    INSERT INTO loot_records (id, session_id, recipient_id, recipient_name, item, quantity, notes, via_raffle, via_reservation)
    VALUES (${id}, ${req.params.id}, ${member ? member.id : null}, ${member ? member.name : ''}, ${trimmedItem}, ${qty}, ${trimmedNotes}, ${!!viaRaffle}, ${!!viaReservation})
    RETURNING *
  `;
  const row = rows[0];
  await logActivity(req, {
    action: 'create',
    entityType: 'loot_record',
    entityId: row.id,
    description: `Added loot "${row.item}" (x${row.quantity})${row.recipient_name ? ` for ${row.recipient_name}` : ''}`,
    after: lootRecordSnapshot(row),
  });
  res.status(201).json({
    id: row.id,
    recipientId: row.recipient_id,
    recipientName: row.recipient_name,
    item: row.item,
    quantity: Number(row.quantity),
    notes: row.notes,
    viaRaffle: row.via_raffle,
    excludedFromRaffle: row.excluded_from_raffle,
    sent: row.sent,
    viaReservation: row.via_reservation,
    createdAt: row.created_at,
  });
});

app.put('/api/loot/:id/records/:recordId', async (req, res) => {
  const { rows: sessionRows } = await sql`SELECT id FROM loot_sessions WHERE id = ${req.params.id}`;
  if (!sessionRows[0]) return res.status(404).json({ error: 'session not found' });

  const { rows: recordRows } = await sql`
    SELECT * FROM loot_records WHERE id = ${req.params.recordId} AND session_id = ${req.params.id}
  `;
  const existing = recordRows[0];
  if (!existing) return res.status(404).json({ error: 'record not found' });

  const { recipientId, item, quantity, notes, viaRaffle, excludedFromRaffle, sent, viaReservation } = req.body || {};

  let nextRecipientId = existing.recipient_id;
  let nextRecipientName = existing.recipient_name;
  let nextViaRaffle = existing.via_raffle;
  let nextExcludedFromRaffle = existing.excluded_from_raffle;
  let nextSent = existing.sent;
  let nextViaReservation = existing.via_reservation;
  if (excludedFromRaffle !== undefined) nextExcludedFromRaffle = !!excludedFromRaffle;
  if (sent !== undefined) nextSent = !!sent;
  if (viaReservation !== undefined) nextViaReservation = !!viaReservation;
  if (recipientId !== undefined) {
    if (!recipientId) {
      nextRecipientId = null;
      nextRecipientName = '';
      nextViaRaffle = false; // no longer anyone's raffle win once unassigned
      nextSent = false; // nothing to mark "sent" once unassigned
      nextViaReservation = false; // no longer reserved once unassigned
    } else {
      const { rows: memberRows } = await sql`SELECT id, name FROM members WHERE id = ${recipientId}`;
      const member = memberRows[0];
      if (!member) return res.status(400).json({ error: 'recipient does not exist' });
      nextRecipientId = member.id;
      nextRecipientName = member.name;
    }
  }
  if (viaRaffle !== undefined) nextViaRaffle = !!viaRaffle;

  let nextItem = existing.item;
  if (item !== undefined) {
    if (!item.trim()) return res.status(400).json({ error: 'item cannot be empty' });
    nextItem = item.trim();
  }

  let nextQuantity = existing.quantity;
  if (quantity !== undefined) {
    const qty = Number(quantity);
    if (Number.isNaN(qty) || qty < 1) return res.status(400).json({ error: 'quantity must be a positive number' });
    nextQuantity = qty;
  }

  const nextNotes = notes !== undefined ? notes.trim() : existing.notes;

  const { rows } = await sql`
    UPDATE loot_records
    SET recipient_id = ${nextRecipientId}, recipient_name = ${nextRecipientName},
        item = ${nextItem}, quantity = ${nextQuantity}, notes = ${nextNotes}, via_raffle = ${nextViaRaffle},
        excluded_from_raffle = ${nextExcludedFromRaffle}, sent = ${nextSent}, via_reservation = ${nextViaReservation}
    WHERE id = ${req.params.recordId}
    RETURNING *
  `;
  const row = rows[0];
  await logActivity(req, {
    action: 'update',
    entityType: 'loot_record',
    entityId: row.id,
    description: `Updated loot "${row.item}" (x${row.quantity})${row.recipient_name ? ` for ${row.recipient_name}` : ''}`,
    before: lootRecordSnapshot(existing),
    after: lootRecordSnapshot(row),
  });
  res.json({
    id: row.id,
    recipientId: row.recipient_id,
    recipientName: row.recipient_name,
    item: row.item,
    quantity: Number(row.quantity),
    notes: row.notes,
    viaRaffle: row.via_raffle,
    excludedFromRaffle: row.excluded_from_raffle,
    sent: row.sent,
    viaReservation: row.via_reservation,
    createdAt: row.created_at,
  });
});

app.delete('/api/loot/:id/records/:recordId', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM loot_records WHERE id = ${req.params.recordId} AND session_id = ${req.params.id}`;
  const existing = existingRows[0];
  const { rowCount } = await sql`
    DELETE FROM loot_records WHERE id = ${req.params.recordId} AND session_id = ${req.params.id}
  `;
  if (!rowCount) return res.status(404).json({ error: 'record not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'loot_record',
    entityId: req.params.recordId,
    description: `Removed loot "${existing?.item}"`,
    before: existing ? lootRecordSnapshot(existing) : undefined,
  });
  res.status(204).end();
});

app.get('/api/caves', async (req, res) => {
  const { rows } = await sql`SELECT * FROM cave_sessions ORDER BY created_at ASC`;
  const recordsMap = await fetchCaveRecords(rows.map((r) => r.id));
  res.json(rows.map((row) => serializeCaveSession(row, recordsMap.get(row.id))));
});

app.get('/api/caves/:id', async (req, res) => {
  const { rows } = await sql`SELECT * FROM cave_sessions WHERE id = ${req.params.id}`;
  if (!rows[0]) return res.status(404).json({ error: 'cave date not found' });
  const recordsMap = await fetchCaveRecords([rows[0].id]);
  res.json(serializeCaveSession(rows[0], recordsMap.get(rows[0].id)));
});

app.post('/api/caves', async (req, res) => {
  const { date, run, notes } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date is required' });

  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO cave_sessions (id, date, run, notes)
    VALUES (${id}, ${date}, ${(run || '').trim()}, ${(notes || '').trim()})
    RETURNING *
  `;
  await logActivity(req, {
    action: 'create',
    entityType: 'cave_session',
    entityId: rows[0].id,
    description: `Logged a cave boss run: ${rows[0].date}${rows[0].run ? ` (${rows[0].run})` : ''}`,
    after: { date: rows[0].date, run: rows[0].run, notes: rows[0].notes },
  });
  res.status(201).json(serializeCaveSession(rows[0], []));
});

app.put('/api/caves/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM cave_sessions WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'cave date not found' });

  const { date, run, notes, attendees } = req.body || {};
  if (date !== undefined && !date) return res.status(400).json({ error: 'date cannot be empty' });
  if (attendees !== undefined && (!Array.isArray(attendees) || !attendees.every((a) => typeof a === 'string'))) {
    return res.status(400).json({ error: 'attendees must be an array of member ids' });
  }

  const nextDate = date !== undefined ? date : existing.date;
  const nextRun = run !== undefined ? run.trim() : existing.run;
  const nextNotes = notes !== undefined ? notes.trim() : existing.notes;
  const nextAttendees = attendees !== undefined ? attendees : existing.attendees;

  const { rows } = await sql`
    UPDATE cave_sessions
    SET date = ${nextDate}, run = ${nextRun}, notes = ${nextNotes}, attendees = ${JSON.stringify(nextAttendees)}
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  const recordsMap = await fetchCaveRecords([rows[0].id]);
  const [beforeAttendees, afterAttendees] = await Promise.all([
    memberNamesForIds(existing.attendees || []),
    memberNamesForIds(rows[0].attendees || []),
  ]);
  await logActivity(req, {
    action: 'update',
    entityType: 'cave_session',
    entityId: rows[0].id,
    description: `Updated cave boss run: ${rows[0].date}${rows[0].run ? ` (${rows[0].run})` : ''} — ${rows[0].attendees.length} attendee(s)`,
    before: { date: existing.date, run: existing.run, notes: existing.notes, attendees: beforeAttendees },
    after: { date: rows[0].date, run: rows[0].run, notes: rows[0].notes, attendees: afterAttendees },
  });
  res.json(serializeCaveSession(rows[0], recordsMap.get(rows[0].id)));
});

app.delete('/api/caves/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT date, run, notes FROM cave_sessions WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  const { rowCount } = await sql`DELETE FROM cave_sessions WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'cave date not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'cave_session',
    entityId: req.params.id,
    description: 'Deleted a cave boss run',
    before: existing ? { date: existing.date, run: existing.run, notes: existing.notes } : undefined,
  });
  res.status(204).end();
});

app.post('/api/caves/:id/records', async (req, res) => {
  const { rows: sessionRows } = await sql`SELECT id FROM cave_sessions WHERE id = ${req.params.id}`;
  if (!sessionRows[0]) return res.status(404).json({ error: 'cave date not found' });

  const { item, quantity, notes, soldPrice, buyer } = req.body || {};
  if (!item || !item.trim()) return res.status(400).json({ error: 'item is required' });
  const qty = quantity === undefined || quantity === '' ? 1 : Number(quantity);
  if (Number.isNaN(qty) || qty < 1) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }
  const price = soldPrice === undefined || soldPrice === '' ? 0 : Number(soldPrice);
  if (Number.isNaN(price) || price < 0) {
    return res.status(400).json({ error: 'sold price must be zero or a positive number' });
  }

  const id = crypto.randomUUID();
  const trimmedNotes = (notes || '').trim();
  const trimmedItem = item.trim();
  const trimmedBuyer = (buyer || '').trim();
  const { rows } = await sql`
    INSERT INTO cave_records (id, session_id, item, quantity, notes, sold_price, buyer)
    VALUES (${id}, ${req.params.id}, ${trimmedItem}, ${qty}, ${trimmedNotes}, ${price}, ${trimmedBuyer})
    RETURNING *
  `;
  const row = rows[0];
  await logActivity(req, { action: 'create', entityType: 'cave_record', entityId: row.id, description: `Added cave loot "${row.item}" (x${row.quantity})`, after: caveRecordSnapshot(row) });
  res.status(201).json({
    id: row.id,
    item: row.item,
    quantity: Number(row.quantity),
    notes: row.notes,
    soldPrice: Number(row.sold_price),
    buyer: row.buyer,
    createdAt: row.created_at,
  });
});

app.put('/api/caves/:id/records/:recordId', async (req, res) => {
  const { rows: sessionRows } = await sql`SELECT id FROM cave_sessions WHERE id = ${req.params.id}`;
  if (!sessionRows[0]) return res.status(404).json({ error: 'cave date not found' });

  const { rows: recordRows } = await sql`
    SELECT * FROM cave_records WHERE id = ${req.params.recordId} AND session_id = ${req.params.id}
  `;
  const existing = recordRows[0];
  if (!existing) return res.status(404).json({ error: 'record not found' });

  const { item, quantity, notes, soldPrice, buyer } = req.body || {};

  let nextItem = existing.item;
  if (item !== undefined) {
    if (!item.trim()) return res.status(400).json({ error: 'item cannot be empty' });
    nextItem = item.trim();
  }

  let nextQuantity = existing.quantity;
  if (quantity !== undefined) {
    const qty = Number(quantity);
    if (Number.isNaN(qty) || qty < 1) return res.status(400).json({ error: 'quantity must be a positive number' });
    nextQuantity = qty;
  }

  let nextSoldPrice = existing.sold_price;
  if (soldPrice !== undefined) {
    const price = soldPrice === '' ? 0 : Number(soldPrice);
    if (Number.isNaN(price) || price < 0) return res.status(400).json({ error: 'sold price must be zero or a positive number' });
    nextSoldPrice = price;
  }

  const nextBuyer = buyer !== undefined ? buyer.trim() : existing.buyer;
  const nextNotes = notes !== undefined ? notes.trim() : existing.notes;

  const { rows } = await sql`
    UPDATE cave_records
    SET item = ${nextItem}, quantity = ${nextQuantity}, notes = ${nextNotes}, sold_price = ${nextSoldPrice}, buyer = ${nextBuyer}
    WHERE id = ${req.params.recordId}
    RETURNING *
  `;
  const row = rows[0];
  await logActivity(req, {
    action: 'update',
    entityType: 'cave_record',
    entityId: row.id,
    description: `Updated cave loot "${row.item}" (x${row.quantity})`,
    before: caveRecordSnapshot(existing),
    after: caveRecordSnapshot(row),
  });
  res.json({
    id: row.id,
    item: row.item,
    quantity: Number(row.quantity),
    notes: row.notes,
    soldPrice: Number(row.sold_price),
    buyer: row.buyer,
    createdAt: row.created_at,
  });
});

app.delete('/api/caves/:id/records/:recordId', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM cave_records WHERE id = ${req.params.recordId} AND session_id = ${req.params.id}`;
  const existing = existingRows[0];
  const { rowCount } = await sql`
    DELETE FROM cave_records WHERE id = ${req.params.recordId} AND session_id = ${req.params.id}
  `;
  if (!rowCount) return res.status(404).json({ error: 'record not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'cave_record',
    entityId: req.params.recordId,
    description: `Removed cave loot "${existing?.item}"`,
    before: existing ? caveRecordSnapshot(existing) : undefined,
  });
  res.status(204).end();
});

function serializeSalaryFee(row) {
  return {
    id: row.id,
    month: row.month,
    name: row.name,
    memberId: row.member_id,
    percent: Number(row.percent),
    createdAt: row.created_at,
  };
}

app.get('/api/salary-fees', async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month is required' });
  const { rows } = await sql`SELECT * FROM cave_salary_fees WHERE month = ${month} ORDER BY created_at ASC`;
  res.json(rows.map(serializeSalaryFee));
});

app.post('/api/salary-fees', async (req, res) => {
  const { month, name, memberId, percent } = req.body || {};
  if (!month) return res.status(400).json({ error: 'month is required' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const pct = Number(percent);
  if (Number.isNaN(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ error: 'percent must be between 0 and 100' });
  }

  let member = null;
  if (memberId) {
    const { rows: memberRows } = await sql`SELECT id, name FROM members WHERE id = ${memberId}`;
    member = memberRows[0];
    if (!member) return res.status(400).json({ error: 'member does not exist' });
  }

  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO cave_salary_fees (id, month, name, member_id, percent)
    VALUES (${id}, ${month}, ${name.trim()}, ${member ? member.id : null}, ${pct})
    RETURNING *
  `;
  await logActivity(req, {
    action: 'create',
    entityType: 'salary_fee',
    entityId: rows[0].id,
    description: `Added ${pct}% accounting fee for "${rows[0].name}" (${month})`,
    after: { month: rows[0].month, name: rows[0].name, percent: Number(rows[0].percent) },
  });
  res.status(201).json(serializeSalaryFee(rows[0]));
});

app.delete('/api/salary-fees/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT month, name, percent FROM cave_salary_fees WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM cave_salary_fees WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'fee entry not found' });
  const removed = existingRows[0];
  await logActivity(req, {
    action: 'delete',
    entityType: 'salary_fee',
    entityId: req.params.id,
    description: removed ? `Removed ${removed.percent}% accounting fee for "${removed.name}" (${removed.month})` : 'Removed an accounting fee',
    before: removed ? { month: removed.month, name: removed.name, percent: Number(removed.percent) } : undefined,
  });
  res.status(204).end();
});

app.get('/api/salary-paid', async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month is required' });
  const { rows } = await sql`SELECT member_id FROM cave_salary_paid WHERE month = ${month}`;
  res.json(rows.map((r) => r.member_id));
});

app.post('/api/salary-paid', async (req, res) => {
  const { month, memberId } = req.body || {};
  if (!month || !memberId) return res.status(400).json({ error: 'month and memberId are required' });
  const { rows: memberRows } = await sql`SELECT id, name FROM members WHERE id = ${memberId}`;
  if (!memberRows[0]) return res.status(400).json({ error: 'member does not exist' });

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO cave_salary_paid (id, month, member_id)
    VALUES (${id}, ${month}, ${memberId})
    ON CONFLICT (month, member_id) DO NOTHING
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'salary_paid',
    entityId: memberId,
    description: `Marked "${memberRows[0].name}" as paid for ${month}`,
    before: { paid: false },
    after: { paid: true },
  });
  res.status(201).json({ month, memberId });
});

app.delete('/api/salary-paid', async (req, res) => {
  const { month, memberId } = req.query;
  if (!month || !memberId) return res.status(400).json({ error: 'month and memberId are required' });
  await sql`DELETE FROM cave_salary_paid WHERE month = ${month} AND member_id = ${memberId}`;
  await logActivity(req, { action: 'update', entityType: 'salary_paid', entityId: memberId, description: `Unmarked a member as paid for ${month}`, before: { paid: true }, after: { paid: false } });
  res.status(204).end();
});

app.get('/api/cave-schedule-servers', async (req, res) => {
  const { rows } = await sql`SELECT id, name FROM cave_schedule_servers ORDER BY created_at ASC`;
  res.json(rows.map((r) => ({ id: r.id, name: r.name })));
});

app.post('/api/cave-schedule-servers', async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const trimmed = name.trim();
  const { rows: existing } = await sql`SELECT id FROM cave_schedule_servers WHERE LOWER(name) = LOWER(${trimmed})`;
  if (existing.length) return res.status(400).json({ error: 'that server already exists' });

  const id = crypto.randomUUID();
  await sql`INSERT INTO cave_schedule_servers (id, name) VALUES (${id}, ${trimmed})`;
  await logActivity(req, { action: 'create', entityType: 'cave_schedule_server', entityId: id, description: `Added server "${trimmed}"`, after: { name: trimmed } });
  res.status(201).json({ id, name: trimmed });
});

app.delete('/api/cave-schedule-servers/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM cave_schedule_servers WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM cave_schedule_servers WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'server not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'cave_schedule_server',
    entityId: req.params.id,
    description: `Removed server "${existingRows[0]?.name}"`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

app.get('/api/cave-schedule', async (req, res) => {
  const { month } = req.query;
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month must be in YYYY-MM format' });
  const { rows } = await sql`
    SELECT to_char(date, 'YYYY-MM-DD') AS date, server_name FROM cave_schedule
    WHERE to_char(date, 'YYYY-MM') = ${month}
    ORDER BY date ASC
  `;
  res.json(rows.map((r) => ({ date: r.date, serverName: r.server_name })));
});

app.put('/api/cave-schedule/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
  const { serverName } = req.body || {};
  const { rows: existingRows } = await sql`SELECT server_name FROM cave_schedule WHERE date = ${date}`;
  const before = existingRows[0] ? { serverName: existingRows[0].server_name } : { serverName: null };

  if (!serverName || !serverName.trim()) {
    await sql`DELETE FROM cave_schedule WHERE date = ${date}`;
    await logActivity(req, { action: 'update', entityType: 'cave_schedule', entityId: date, description: `Cleared the scheduled server for ${date}`, before, after: { serverName: null } });
    return res.status(204).end();
  }

  const trimmed = serverName.trim();
  await sql`
    INSERT INTO cave_schedule (date, server_name) VALUES (${date}, ${trimmed})
    ON CONFLICT (date) DO UPDATE SET server_name = ${trimmed}
  `;
  await logActivity(req, { action: 'update', entityType: 'cave_schedule', entityId: date, description: `Set ${date}'s server to "${trimmed}"`, before, after: { serverName: trimmed } });
  res.json({ date, serverName: trimmed });
});

// Overwrites an entire month's schedule with an evenly-rotating assignment —
// day 1 of the month gets serverOrder[0], day 2 gets serverOrder[1], and so
// on, wrapping back to serverOrder[0] once it reaches the end of the list.
// Bulk (not per-date PUTs) so it's one confirm-and-apply action, and one
// activity-log entry, instead of 28-31 individual ones.
app.post('/api/cave-schedule/apply-evenly', async (req, res) => {
  const { month, serverOrder } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month must be in YYYY-MM format' });
  if (!Array.isArray(serverOrder) || serverOrder.length < 1 || !serverOrder.every((s) => typeof s === 'string' && s.trim())) {
    return res.status(400).json({ error: 'serverOrder must be a non-empty array of server names' });
  }

  const [year, monthNum] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const assignments = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const serverName = serverOrder[(day - 1) % serverOrder.length].trim();
    assignments.push({ date, serverName });
  }

  for (const a of assignments) {
    await sql`
      INSERT INTO cave_schedule (date, server_name) VALUES (${a.date}, ${a.serverName})
      ON CONFLICT (date) DO UPDATE SET server_name = ${a.serverName}
    `;
  }

  await logActivity(req, {
    action: 'update',
    entityType: 'cave_schedule',
    entityId: month,
    description: `Applied an evenly-rotating schedule for ${month} (${serverOrder.join(' → ')})`,
  });
  res.json({ month, assignments });
});

// ---------- World Dungeon Schedule ----------
// Fixed weekly cadence (every Thursday and Sunday), fixed pair of bosses --
// unlike Cave Schedule's servers, the dungeon names themselves aren't a
// managed list, just these two constants. Guild picklist is shared with
// Cave Schedule via cave_schedule_servers (see the comment in lib/db.js).

const WORLD_DUNGEON_NAMES = ['Hisharat', 'Chantarat'];

app.get('/api/world-dungeon-schedule', async (req, res) => {
  const { from } = req.query;
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : null;
  const { rows } = fromDate
    ? await sql`
        SELECT to_char(date, 'YYYY-MM-DD') AS date, dungeon, guild_name FROM world_dungeon_schedule
        WHERE date >= ${fromDate}
        ORDER BY date ASC, dungeon ASC
      `
    : await sql`
        SELECT to_char(date, 'YYYY-MM-DD') AS date, dungeon, guild_name FROM world_dungeon_schedule
        ORDER BY date ASC, dungeon ASC
      `;
  res.json(rows.map((r) => ({ date: r.date, dungeon: r.dungeon, guildName: r.guild_name })));
});

app.put('/api/world-dungeon-schedule/:date/:dungeon', async (req, res) => {
  const { date, dungeon } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
  if (!WORLD_DUNGEON_NAMES.includes(dungeon)) return res.status(400).json({ error: `dungeon must be one of: ${WORLD_DUNGEON_NAMES.join(', ')}` });

  const { guildName } = req.body || {};
  const { rows: existingRows } = await sql`SELECT guild_name FROM world_dungeon_schedule WHERE date = ${date} AND dungeon = ${dungeon}`;
  const before = existingRows[0] ? { guildName: existingRows[0].guild_name } : { guildName: null };

  if (!guildName || !guildName.trim()) {
    await sql`DELETE FROM world_dungeon_schedule WHERE date = ${date} AND dungeon = ${dungeon}`;
    await logActivity(req, {
      action: 'update',
      entityType: 'world_dungeon_schedule',
      entityId: `${date}:${dungeon}`,
      description: `Cleared ${dungeon}'s assigned guild for ${date}`,
      before,
      after: { guildName: null },
    });
    return res.status(204).end();
  }

  const trimmed = guildName.trim();
  await sql`
    INSERT INTO world_dungeon_schedule (date, dungeon, guild_name) VALUES (${date}, ${dungeon}, ${trimmed})
    ON CONFLICT (date, dungeon) DO UPDATE SET guild_name = ${trimmed}
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'world_dungeon_schedule',
    entityId: `${date}:${dungeon}`,
    description: `Assigned ${dungeon} to "${trimmed}" for ${date}`,
    before,
    after: { guildName: trimmed },
  });
  res.json({ date, dungeon, guildName: trimmed });
});

// ---------- Sovereign / Crusade ----------

function serializeCrusadeGuild(row) {
  return { id: row.id, name: row.name, color: row.color };
}

// A crusade is just the shared date/event container now -- name, event
// date. Everything that drives a payout lives on crusade_teams instead (see
// serializeCrusadeTeam), one row per team, so two teams on the same
// crusade can have entirely different rewards/outcomes.
function serializeCrusade(row) {
  return {
    id: row.id,
    name: row.name,
    eventDate: row.event_date,
    createdAt: row.created_at,
  };
}

function serializeCrusadeTeam(row) {
  return {
    id: row.id,
    crusadeId: row.crusade_id,
    teamNumber: row.team_number,
    warType: row.war_type,
    stance: row.stance,
    area: row.area,
    leader: row.leader,
    result: row.result,
    diamondReward: Number(row.diamond_reward),
    attendancePct: Number(row.attendance_pct),
    notes: row.notes,
  };
}

function serializeCrusadeItem(row) {
  return { id: row.id, teamId: row.team_id, name: row.name, quantity: Number(row.quantity) };
}

function serializeCrusadeFee(row) {
  return { id: row.id, teamId: row.team_id, name: row.name, guildName: row.guild_name, percent: Number(row.percent) };
}

function serializeCrusadeParticipant(row) {
  return {
    id: row.id,
    crusadeId: row.crusade_id,
    partyNumber: row.party_number,
    partySlot: row.party_slot,
    name: row.name,
    guildName: row.guild_name,
    position: row.position,
    goldBid: Number(row.gold_bid),
    attended: row.attended,
    paid: row.paid,
  };
}

const CRUSADE_PARTY_MAX_MEMBERS = 5;

// A team's roster is split into parties of at most 5 — counts every OTHER
// participant already in that crusade/team/party slot (excludeId lets an
// update check its new slot without counting itself against the cap).
async function countCrusadePartySlot(crusadeId, partyNumber, partySlot, excludeId) {
  const { rows } = await sql`
    SELECT COUNT(*)::int AS count FROM crusade_participants
    WHERE crusade_id = ${crusadeId} AND party_number = ${partyNumber} AND party_slot = ${partySlot}
      AND id != ${excludeId ?? '00000000-0000-0000-0000-000000000000'}
  `;
  return rows[0].count;
}

// A team's details/items/fees are created lazily -- opening a team that's
// never been saved shows defaults, and the row only actually gets created
// the first time something on it is saved (its own Team Details form, or
// its first item/fee). Returns the existing row if there is one.
async function ensureCrusadeTeam(crusadeId, teamNumber) {
  const { rows } = await sql`SELECT * FROM crusade_teams WHERE crusade_id = ${crusadeId} AND team_number = ${teamNumber}`;
  if (rows[0]) return rows[0];
  const id = crypto.randomUUID();
  const { rows: inserted } = await sql`
    INSERT INTO crusade_teams (id, crusade_id, team_number)
    VALUES (${id}, ${crusadeId}, ${teamNumber})
    ON CONFLICT (crusade_id, team_number) DO NOTHING
    RETURNING *
  `;
  if (inserted[0]) {
    // Brand new team -- seed it with the standing default management fees
    // (if any). Only happens once, right here at creation; editing the
    // default list afterward never touches teams that already exist.
    const { rows: defaults } = await sql`SELECT * FROM crusade_default_fees ORDER BY created_at ASC`;
    for (const d of defaults) {
      await sql`
        INSERT INTO crusade_fees (id, crusade_id, team_id, name, guild_name, percent)
        VALUES (${crypto.randomUUID()}, ${crusadeId}, ${id}, ${d.name}, ${d.guild_name}, ${d.percent})
      `;
    }
    return inserted[0];
  }
  const { rows: refetched } = await sql`SELECT * FROM crusade_teams WHERE crusade_id = ${crusadeId} AND team_number = ${teamNumber}`;
  return refetched[0];
}

// Winning on Defense pays 40% of a team's reward out to whoever bid gold
// last time -- a thank-you to last time's bidders, funded by this time's
// defenders. "Last time" means every Attack team from the source crusade
// (an earlier team in THIS crusade if one exists, else the most recent
// other crusade), not just its single highest-numbered team -- someone who
// only bid on an earlier team of that crusade still counts. A source
// team's own win/lose doesn't matter, only that gold was bid there; a
// Defense-stance source team is excluded since it never had bidding to
// begin with. Returns both which crusade that was (for display) and the
// pooled bidder list.
async function getLastTeamBidders(crusade, team) {
  const { rows: sameCrusadeTeams } = await sql`
    SELECT team_number, stance FROM crusade_teams WHERE crusade_id = ${crusade.id} AND team_number < ${team.team_number}
  `;

  let sourceCrusadeId = crusade.id;
  let sourceCrusadeName = crusade.name;
  let sourceEventDate = crusade.event_date;
  let sourceTeams = sameCrusadeTeams;

  if (!sourceTeams.length) {
    if (!crusade.event_date) return { lastTeam: null, bidders: [] };
    const { rows: prevCrusadeRows } = await sql`
      SELECT id, name, event_date FROM crusades
      WHERE event_date < ${crusade.event_date}
         OR (event_date = ${crusade.event_date} AND created_at < ${crusade.created_at})
      ORDER BY event_date DESC, created_at DESC
      LIMIT 1
    `;
    const prevCrusade = prevCrusadeRows[0];
    if (!prevCrusade) return { lastTeam: null, bidders: [] };
    sourceCrusadeId = prevCrusade.id;
    sourceCrusadeName = prevCrusade.name;
    sourceEventDate = prevCrusade.event_date;
    const { rows: otherCrusadeTeams } = await sql`
      SELECT team_number, stance FROM crusade_teams WHERE crusade_id = ${prevCrusade.id}
    `;
    sourceTeams = otherCrusadeTeams;
  }

  const lastTeam = { crusadeId: sourceCrusadeId, crusadeName: sourceCrusadeName, eventDate: sourceEventDate };
  const attackTeamNumbers = sourceTeams.filter((t) => t.stance !== 'Defense').map((t) => t.team_number);
  if (!attackTeamNumbers.length) return { lastTeam, bidders: [] };

  const bidders = [];
  for (const teamNumber of attackTeamNumbers) {
    const { rows: bidderRows } = await sql`
      SELECT name, guild_name, gold_bid FROM crusade_participants
      WHERE crusade_id = ${sourceCrusadeId} AND party_number = ${teamNumber} AND gold_bid > 0
      ORDER BY name ASC
    `;
    bidders.push(...bidderRows.map((r) => ({ name: r.name, guildName: r.guild_name, goldBid: Number(r.gold_bid) })));
  }

  return { lastTeam, bidders };
}

app.get('/api/crusade-guilds', async (req, res) => {
  const { rows } = await sql`SELECT id, name, color FROM crusade_guilds ORDER BY created_at ASC`;
  res.json(rows.map(serializeCrusadeGuild));
});

app.post('/api/crusade-guilds', async (req, res) => {
  const { name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const trimmed = name.trim();
  const { rows: existing } = await sql`SELECT id FROM crusade_guilds WHERE LOWER(name) = LOWER(${trimmed})`;
  if (existing.length) return res.status(400).json({ error: 'that guild already exists' });

  const finalColor = (color && color.trim()) || '#3b82f6';
  const id = crypto.randomUUID();
  await sql`INSERT INTO crusade_guilds (id, name, color) VALUES (${id}, ${trimmed}, ${finalColor})`;
  await logActivity(req, { action: 'create', entityType: 'crusade_guild', entityId: id, description: `Added guild "${trimmed}"`, after: { name: trimmed, color: finalColor } });
  res.status(201).json({ id, name: trimmed, color: finalColor });
});

app.put('/api/crusade-guilds/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM crusade_guilds WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'guild not found' });

  const { name, color } = req.body || {};
  let nextName = existing.name;
  let nextColor = existing.color;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
    const { rows: dup } = await sql`SELECT id FROM crusade_guilds WHERE LOWER(name) = LOWER(${nextName}) AND id != ${req.params.id}`;
    if (dup.length) return res.status(400).json({ error: 'that guild already exists' });
  }
  if (color !== undefined && color.trim()) nextColor = color.trim();

  const { rows } = await sql`UPDATE crusade_guilds SET name = ${nextName}, color = ${nextColor} WHERE id = ${req.params.id} RETURNING *`;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_guild',
    entityId: req.params.id,
    description: `Updated guild "${rows[0].name}"`,
    before: { name: existing.name, color: existing.color },
    after: { name: rows[0].name, color: rows[0].color },
  });
  res.json(serializeCrusadeGuild(rows[0]));
});

app.delete('/api/crusade-guilds/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM crusade_guilds WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM crusade_guilds WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'guild not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_guild',
    entityId: req.params.id,
    description: `Removed guild "${existingRows[0]?.name}"`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

function serializeCrusadeDefaultFee(row) {
  return { id: row.id, name: row.name, guildName: row.guild_name, percent: Number(row.percent) };
}

// A standing list of fee recipients, copied onto every new team the first
// time it's saved (see ensureCrusadeTeam) -- editing this list never
// touches teams that already exist, only ones created afterward.
app.get('/api/crusade-default-fees', async (req, res) => {
  const { rows } = await sql`SELECT * FROM crusade_default_fees ORDER BY created_at ASC`;
  res.json(rows.map(serializeCrusadeDefaultFee));
});

app.post('/api/crusade-default-fees', async (req, res) => {
  const { name, guildName, percent } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const finalPercent = Number(percent);
  if (Number.isNaN(finalPercent) || finalPercent < 0 || finalPercent > 100) {
    return res.status(400).json({ error: 'percent must be between 0 and 100' });
  }

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO crusade_default_fees (id, name, guild_name, percent)
    VALUES (${id}, ${name.trim()}, ${guildName || null}, ${finalPercent})
  `;
  const { rows } = await sql`SELECT * FROM crusade_default_fees WHERE id = ${id}`;
  await logActivity(req, {
    action: 'create',
    entityType: 'crusade_default_fee',
    entityId: id,
    description: `Added a standing ${finalPercent}% default fee for "${name.trim()}" (applies to new teams going forward)`,
    after: { name: name.trim(), guildName: guildName || null, percent: finalPercent },
  });
  res.status(201).json(serializeCrusadeDefaultFee(rows[0]));
});

app.delete('/api/crusade-default-fees/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name, percent FROM crusade_default_fees WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM crusade_default_fees WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'default fee not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_default_fee',
    entityId: req.params.id,
    description: `Removed the standing default fee for "${existingRows[0]?.name}"`,
    before: existingRows[0] ? { name: existingRows[0].name, percent: existingRows[0].percent } : undefined,
  });
  res.status(204).end();
});

app.get('/api/crusades', async (req, res) => {
  const { rows } = await sql`
    SELECT c.id, c.name, c.event_date, c.created_at,
      (SELECT COUNT(*)::int FROM crusade_participants p WHERE p.crusade_id = c.id) AS participant_count,
      (
        -- Sum each of this crusade's teams' own (post-fee, zeroed-if-lost)
        -- pool -- mirrors the client-side math so this matches what the
        -- Team List and Guild Salary page actually pay out in total.
        SELECT COALESCE(SUM(
          CASE WHEN ct.result = 'lose' THEN 0
               ELSE ct.diamond_reward * GREATEST(0, 1 - COALESCE(feesum.total_pct, 0) / 100)
          END
        ), 0)
        FROM crusade_teams ct
        LEFT JOIN (SELECT team_id, SUM(percent) AS total_pct FROM crusade_fees GROUP BY team_id) feesum
          ON feesum.team_id = ct.id
        WHERE ct.crusade_id = c.id
      ) AS net_diamond_reward
    FROM crusades c
    ORDER BY c.created_at DESC
  `;
  res.json(
    rows.map((r) => ({
      ...serializeCrusade(r),
      participantCount: r.participant_count,
      netDiamondReward: Number(r.net_diamond_reward),
    }))
  );
});

app.post('/api/crusades', async (req, res) => {
  const { name, eventDate } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const id = crypto.randomUUID();
  await sql`INSERT INTO crusades (id, name, event_date) VALUES (${id}, ${name.trim()}, ${eventDate || null})`;
  const { rows } = await sql`SELECT id, name, event_date, created_at FROM crusades WHERE id = ${id}`;
  await logActivity(req, { action: 'create', entityType: 'crusade', entityId: id, description: `Created crusade "${name.trim()}"`, after: { name: name.trim() } });
  res.status(201).json({ ...serializeCrusade(rows[0]), participantCount: 0, netDiamondReward: 0 });
});

app.get('/api/crusades/:id', async (req, res) => {
  const { rows } = await sql`SELECT id, name, event_date, created_at FROM crusades WHERE id = ${req.params.id}`;
  const crusade = rows[0];
  if (!crusade) return res.status(404).json({ error: 'crusade not found' });

  const { rows: participantRows } = await sql`
    SELECT * FROM crusade_participants WHERE crusade_id = ${req.params.id} ORDER BY party_number ASC, party_slot ASC, created_at ASC
  `;
  const { rows: teamRows } = await sql`SELECT * FROM crusade_teams WHERE crusade_id = ${req.params.id} ORDER BY team_number ASC`;
  const { rows: itemRows } = await sql`
    SELECT i.* FROM crusade_items i JOIN crusade_teams t ON t.id = i.team_id WHERE t.crusade_id = ${req.params.id} ORDER BY i.created_at ASC
  `;
  const { rows: feeRows } = await sql`
    SELECT f.* FROM crusade_fees f JOIN crusade_teams t ON t.id = f.team_id WHERE t.crusade_id = ${req.params.id} ORDER BY f.created_at ASC
  `;

  const itemsByTeam = new Map();
  itemRows.forEach((r) => {
    if (!itemsByTeam.has(r.team_id)) itemsByTeam.set(r.team_id, []);
    itemsByTeam.get(r.team_id).push(serializeCrusadeItem(r));
  });
  const feesByTeam = new Map();
  feeRows.forEach((r) => {
    if (!feesByTeam.has(r.team_id)) feesByTeam.set(r.team_id, []);
    feesByTeam.get(r.team_id).push(serializeCrusadeFee(r));
  });

  // Sequential (not Promise.all) since typical team counts are small and
  // each lookup is its own couple of small queries -- fine to keep simple.
  const teams = [];
  for (const t of teamRows) {
    const { lastTeam, bidders: lastTeamBidders } = await getLastTeamBidders(crusade, t);
    teams.push({
      ...serializeCrusadeTeam(t),
      items: itemsByTeam.get(t.id) || [],
      fees: feesByTeam.get(t.id) || [],
      lastTeam,
      lastTeamBidders,
    });
  }

  res.json({
    ...serializeCrusade(crusade),
    participants: participantRows.map(serializeCrusadeParticipant),
    teams,
  });
});

app.put('/api/crusades/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT id, name, event_date, created_at FROM crusades WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'crusade not found' });

  const { name, eventDate } = req.body || {};
  let nextName = existing.name;
  let nextEventDate = existing.event_date;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
  }
  if (eventDate !== undefined) nextEventDate = eventDate || null;

  const { rows } = await sql`
    UPDATE crusades SET name = ${nextName}, event_date = ${nextEventDate}
    WHERE id = ${req.params.id}
    RETURNING id, name, event_date, created_at
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade',
    entityId: req.params.id,
    description: `Updated crusade "${rows[0].name}"`,
    before: serializeCrusade(existing),
    after: serializeCrusade(rows[0]),
  });
  res.json(serializeCrusade(rows[0]));
});

app.put('/api/crusades/:id/teams/:teamNumber', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  if (!Number.isInteger(teamNumber) || teamNumber < 1) return res.status(400).json({ error: 'invalid team number' });

  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const existing = await ensureCrusadeTeam(req.params.id, teamNumber);

  const { warType, stance, area, leader, result, diamondReward, attendancePct, notes } = req.body || {};
  let nextWarType = existing.war_type;
  let nextStance = existing.stance;
  let nextArea = existing.area;
  let nextLeader = existing.leader;
  let nextResult = existing.result;
  let nextDiamondReward = existing.diamond_reward;
  let nextAttendancePct = existing.attendance_pct;
  let nextNotes = existing.notes;

  if (warType !== undefined) nextWarType = warType || null;
  if (stance !== undefined) nextStance = stance || null;
  if (area !== undefined) nextArea = area || null;
  if (leader !== undefined) nextLeader = leader || null;
  if (result !== undefined) nextResult = result || 'pending';
  if (diamondReward !== undefined) {
    const n = Number(diamondReward);
    if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'diamondReward must be a non-negative number' });
    nextDiamondReward = n;
  }
  if (attendancePct !== undefined) {
    const n = Number(attendancePct);
    if (Number.isNaN(n) || n < 0 || n > 100) return res.status(400).json({ error: 'attendancePct must be between 0 and 100' });
    nextAttendancePct = n;
  }
  if (notes !== undefined) nextNotes = notes || null;

  const { rows } = await sql`
    UPDATE crusade_teams SET
      war_type = ${nextWarType}, stance = ${nextStance}, area = ${nextArea}, leader = ${nextLeader},
      result = ${nextResult}, diamond_reward = ${nextDiamondReward}, attendance_pct = ${nextAttendancePct}, notes = ${nextNotes}
    WHERE id = ${existing.id}
    RETURNING *
  `;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_team',
    entityId: rows[0].id,
    description: `Updated Team ${teamNumber} details`,
    before: serializeCrusadeTeam(existing),
    after: serializeCrusadeTeam(rows[0]),
  });
  res.json(serializeCrusadeTeam(rows[0]));
});

// Removing a team clears its roster (participants are keyed by party_number,
// not a foreign key to crusade_teams, so they don't cascade-delete on their
// own) plus its crusade_teams row -- which does cascade-delete that team's
// own items and fees.
app.delete('/api/crusades/:id/teams/:teamNumber', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  if (!Number.isInteger(teamNumber) || teamNumber < 1) return res.status(400).json({ error: 'invalid team number' });

  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const { rows: participantRows } = await sql`
    SELECT id FROM crusade_participants WHERE crusade_id = ${req.params.id} AND party_number = ${teamNumber}
  `;
  await sql`DELETE FROM crusade_participants WHERE crusade_id = ${req.params.id} AND party_number = ${teamNumber}`;
  await sql`DELETE FROM crusade_teams WHERE crusade_id = ${req.params.id} AND team_number = ${teamNumber}`;

  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_team',
    entityId: `${req.params.id}:${teamNumber}`,
    description: `Removed Team ${teamNumber} and its ${participantRows.length} participant${participantRows.length === 1 ? '' : 's'} from crusade`,
  });
  res.status(204).end();
});

app.delete('/api/crusades/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM crusades WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM crusades WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'crusade not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade',
    entityId: req.params.id,
    description: `Deleted crusade "${existingRows[0]?.name}"`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

app.post('/api/crusades/:id/teams/:teamNumber/items', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const { name, quantity } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const finalQuantity = Number(quantity) || 0;
  if (finalQuantity < 0) return res.status(400).json({ error: 'quantity must be a non-negative number' });

  const team = await ensureCrusadeTeam(req.params.id, teamNumber);
  const id = crypto.randomUUID();
  await sql`INSERT INTO crusade_items (id, crusade_id, team_id, name, quantity) VALUES (${id}, ${req.params.id}, ${team.id}, ${name.trim()}, ${finalQuantity})`;
  const { rows } = await sql`SELECT * FROM crusade_items WHERE id = ${id}`;
  await logActivity(req, {
    action: 'create',
    entityType: 'crusade_item',
    entityId: id,
    description: `Added item "${name.trim()}" (${finalQuantity}) to Team ${teamNumber}`,
    after: { name: name.trim(), quantity: finalQuantity },
  });
  res.status(201).json(serializeCrusadeItem(rows[0]));
});

app.put('/api/crusades/:id/teams/:teamNumber/items/:itemId', async (req, res) => {
  const { rows: existingRows } = await sql`
    SELECT i.* FROM crusade_items i JOIN crusade_teams t ON t.id = i.team_id
    WHERE i.id = ${req.params.itemId} AND t.crusade_id = ${req.params.id} AND t.team_number = ${Number(req.params.teamNumber)}
  `;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'item not found' });

  const { name, quantity } = req.body || {};
  let nextName = existing.name;
  let nextQuantity = existing.quantity;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
  }
  if (quantity !== undefined) {
    const n = Number(quantity);
    if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'quantity must be a non-negative number' });
    nextQuantity = n;
  }

  const { rows } = await sql`UPDATE crusade_items SET name = ${nextName}, quantity = ${nextQuantity} WHERE id = ${req.params.itemId} RETURNING *`;
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_item',
    entityId: req.params.itemId,
    description: `Updated item "${rows[0].name}"`,
    before: serializeCrusadeItem(existing),
    after: serializeCrusadeItem(rows[0]),
  });
  res.json(serializeCrusadeItem(rows[0]));
});

app.delete('/api/crusades/:id/teams/:teamNumber/items/:itemId', async (req, res) => {
  const { rows: existingRows } = await sql`
    SELECT i.name FROM crusade_items i JOIN crusade_teams t ON t.id = i.team_id
    WHERE i.id = ${req.params.itemId} AND t.crusade_id = ${req.params.id} AND t.team_number = ${Number(req.params.teamNumber)}
  `;
  if (!existingRows.length) return res.status(404).json({ error: 'item not found' });
  await sql`DELETE FROM crusade_items WHERE id = ${req.params.itemId}`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_item',
    entityId: req.params.itemId,
    description: `Removed item "${existingRows[0]?.name}" from Team ${req.params.teamNumber}`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

app.post('/api/crusades/:id/teams/:teamNumber/fees', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const { name, guildName, percent } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const finalPercent = Number(percent);
  if (Number.isNaN(finalPercent) || finalPercent < 0 || finalPercent > 100) {
    return res.status(400).json({ error: 'percent must be between 0 and 100' });
  }

  const team = await ensureCrusadeTeam(req.params.id, teamNumber);
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO crusade_fees (id, crusade_id, team_id, name, guild_name, percent)
    VALUES (${id}, ${req.params.id}, ${team.id}, ${name.trim()}, ${guildName || null}, ${finalPercent})
  `;
  const { rows } = await sql`SELECT * FROM crusade_fees WHERE id = ${id}`;
  await logActivity(req, {
    action: 'create',
    entityType: 'crusade_fee',
    entityId: id,
    description: `Added a ${finalPercent}% management fee for "${name.trim()}" on Team ${teamNumber}`,
    after: { name: name.trim(), guildName: guildName || null, percent: finalPercent },
  });
  res.status(201).json(serializeCrusadeFee(rows[0]));
});

// Copies the current standing default fees (see crusade_default_fees) onto
// THIS specific team -- for teams that already existed before a default was
// added, since ensureCrusadeTeam only auto-seeds brand-new teams. Skips any
// default whose IGN (case-insensitive) is already on this team's fee list,
// so it's safe to click more than once.
app.post('/api/crusades/:id/teams/:teamNumber/apply-default-fees', async (req, res) => {
  const teamNumber = Number(req.params.teamNumber);
  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const team = await ensureCrusadeTeam(req.params.id, teamNumber);
  const { rows: existingFees } = await sql`SELECT name FROM crusade_fees WHERE team_id = ${team.id}`;
  const existingNames = new Set(existingFees.map((f) => f.name.trim().toLowerCase()));
  const { rows: defaults } = await sql`SELECT * FROM crusade_default_fees ORDER BY created_at ASC`;
  const toAdd = defaults.filter((d) => !existingNames.has(d.name.trim().toLowerCase()));

  const added = [];
  for (const d of toAdd) {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO crusade_fees (id, crusade_id, team_id, name, guild_name, percent)
      VALUES (${id}, ${req.params.id}, ${team.id}, ${d.name}, ${d.guild_name}, ${d.percent})
    `;
    const { rows } = await sql`SELECT * FROM crusade_fees WHERE id = ${id}`;
    added.push(serializeCrusadeFee(rows[0]));
  }

  if (added.length) {
    await logActivity(req, {
      action: 'update',
      entityType: 'crusade_fee',
      entityId: team.id,
      description: `Applied ${added.length} standing default fee${added.length === 1 ? '' : 's'} to Team ${teamNumber}`,
      after: { names: added.map((f) => f.name) },
    });
  }
  res.status(201).json(added);
});

app.delete('/api/crusades/:id/teams/:teamNumber/fees/:feeId', async (req, res) => {
  const { rows: existingRows } = await sql`
    SELECT f.name, f.percent FROM crusade_fees f JOIN crusade_teams t ON t.id = f.team_id
    WHERE f.id = ${req.params.feeId} AND t.crusade_id = ${req.params.id} AND t.team_number = ${Number(req.params.teamNumber)}
  `;
  if (!existingRows.length) return res.status(404).json({ error: 'fee not found' });
  await sql`DELETE FROM crusade_fees WHERE id = ${req.params.feeId}`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_fee',
    entityId: req.params.feeId,
    description: `Removed the management fee for "${existingRows[0]?.name}" from Team ${req.params.teamNumber}`,
    before: existingRows[0] ? { name: existingRows[0].name, percent: existingRows[0].percent } : undefined,
  });
  res.status(204).end();
});

function serializeSovereignMember(row) {
  return { id: row.id, name: row.name, guildName: row.guild_name, position: row.position, updatedAt: row.updated_at };
}

// Keeps the master Member List (sovereign_members) in sync every time a
// crusade participant is saved — one row per unique name, always reflecting
// whichever guild/position was most recently entered for them. Never
// throws: a failure here shouldn't take down the participant save that
// triggered it.
async function upsertSovereignMember(name, guildName, position) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  try {
    const { rows: existing } = await sql`SELECT id FROM sovereign_members WHERE LOWER(name) = LOWER(${trimmed})`;
    if (existing.length) {
      await sql`UPDATE sovereign_members SET name = ${trimmed}, guild_name = ${guildName || null}, position = ${position || null}, updated_at = now() WHERE id = ${existing[0].id}`;
    } else {
      await sql`INSERT INTO sovereign_members (id, name, guild_name, position) VALUES (${crypto.randomUUID()}, ${trimmed}, ${guildName || null}, ${position || null})`;
    }
  } catch (err) {
    console.error('upsertSovereignMember failed', err);
  }
}

app.get('/api/sovereign-members', async (req, res) => {
  const { rows } = await sql`SELECT * FROM sovereign_members ORDER BY guild_name ASC NULLS LAST, LOWER(name) ASC`;
  res.json(rows.map(serializeSovereignMember));
});

app.delete('/api/sovereign-members/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM sovereign_members WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM sovereign_members WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'member not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'sovereign_member',
    entityId: req.params.id,
    description: `Removed "${existingRows[0]?.name}" from the Sovereign member list`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

function serializeRaffleWinner(row) {
  return { id: row.id, memberName: row.member_name, guildName: row.guild_name, item: row.item, createdAt: row.created_at };
}

// Standalone raffle draw stack, independent of any crusade -- newest first
// so the most recent draw shows at the top of the Winners list.
app.get('/api/raffle-winners', async (req, res) => {
  const { rows } = await sql`SELECT * FROM raffle_winners ORDER BY created_at DESC`;
  res.json(rows.map(serializeRaffleWinner));
});

// The winner itself is picked client-side (Math.random over whoever's
// checked and not already in the stack) -- this just persists that result.
app.post('/api/raffle-winners', async (req, res) => {
  const { memberName, guildName, item } = req.body || {};
  if (!memberName || !memberName.trim()) return res.status(400).json({ error: 'memberName is required' });

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO raffle_winners (id, member_name, guild_name, item)
    VALUES (${id}, ${memberName.trim()}, ${guildName || null}, ${item ? item.trim() : null})
  `;
  const { rows } = await sql`SELECT * FROM raffle_winners WHERE id = ${id}`;
  await logActivity(req, {
    action: 'create',
    entityType: 'raffle_winner',
    entityId: id,
    description: `🎲 ${memberName.trim()} won the raffle${item && item.trim() ? ` (${item.trim()})` : ''}`,
    after: { memberName: memberName.trim(), guildName: guildName || null, item: item ? item.trim() : null },
  });
  res.status(201).json(serializeRaffleWinner(rows[0]));
});

// Lets the item be filled in (or corrected) after the draw, since you often
// don't know exactly what they won until you've handed it over.
app.put('/api/raffle-winners/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM raffle_winners WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'raffle winner not found' });

  const { item } = req.body || {};
  const nextItem = item !== undefined ? (item ? item.trim() : null) : existing.item;

  const { rows } = await sql`UPDATE raffle_winners SET item = ${nextItem} WHERE id = ${req.params.id} RETURNING *`;
  await logActivity(req, {
    action: 'update',
    entityType: 'raffle_winner',
    entityId: req.params.id,
    description: `Updated ${rows[0].member_name}'s raffle item to "${rows[0].item || '—'}"`,
    before: serializeRaffleWinner(existing),
    after: serializeRaffleWinner(rows[0]),
  });
  res.json(serializeRaffleWinner(rows[0]));
});

// Undoes a single draw -- that member goes back into the eligible pool.
app.delete('/api/raffle-winners/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT member_name FROM raffle_winners WHERE id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM raffle_winners WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'raffle winner not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'raffle_winner',
    entityId: req.params.id,
    description: `Removed "${existingRows[0]?.member_name}" from the raffle winners list`,
    before: existingRows[0] ? { name: existingRows[0].member_name } : undefined,
  });
  res.status(204).end();
});

// Clears the whole stack to start a fresh raffle -- everyone becomes
// eligible again.
app.delete('/api/raffle-winners', async (req, res) => {
  const { rows: countRows } = await sql`SELECT COUNT(*)::int AS count FROM raffle_winners`;
  await sql`DELETE FROM raffle_winners`;
  await logActivity(req, {
    action: 'delete',
    entityType: 'raffle_winner',
    entityId: 'all',
    description: `Cleared the raffle winners list (${countRows[0].count} winner${countRows[0].count === 1 ? '' : 's'})`,
  });
  res.status(204).end();
});

app.post('/api/crusades/:id/participants', async (req, res) => {
  const { rows: crusadeRows } = await sql`SELECT id FROM crusades WHERE id = ${req.params.id}`;
  if (!crusadeRows.length) return res.status(404).json({ error: 'crusade not found' });

  const { name, guildName, position, goldBid, partyNumber, partySlot, attended } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const finalGoldBid = Number(goldBid) || 0;
  if (finalGoldBid < 0) return res.status(400).json({ error: 'goldBid must be a non-negative number' });
  const finalPartyNumber = Number(partyNumber) || 1;
  const finalPartySlot = Number(partySlot) || 1;

  const partyCount = await countCrusadePartySlot(req.params.id, finalPartyNumber, finalPartySlot);
  if (partyCount >= CRUSADE_PARTY_MAX_MEMBERS) {
    return res.status(400).json({ error: `Party ${finalPartySlot} on Team ${finalPartyNumber} already has ${CRUSADE_PARTY_MAX_MEMBERS} members — pick another party.` });
  }

  const id = crypto.randomUUID();
  await sql`
    INSERT INTO crusade_participants (id, crusade_id, party_number, party_slot, name, guild_name, position, gold_bid, attended)
    VALUES (${id}, ${req.params.id}, ${finalPartyNumber}, ${finalPartySlot}, ${name.trim()}, ${guildName || null}, ${position || null}, ${finalGoldBid}, ${attended !== false})
  `;
  const { rows } = await sql`SELECT * FROM crusade_participants WHERE id = ${id}`;
  await upsertSovereignMember(rows[0].name, rows[0].guild_name, rows[0].position);
  await logActivity(req, {
    action: 'create',
    entityType: 'crusade_participant',
    entityId: id,
    description: `Added "${name.trim()}" to crusade roster`,
    after: { name: name.trim(), guildName: guildName || null, partyNumber: finalPartyNumber },
  });
  res.status(201).json(serializeCrusadeParticipant(rows[0]));
});

app.put('/api/crusades/:id/participants/:pid', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM crusade_participants WHERE id = ${req.params.pid} AND crusade_id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'participant not found' });

  const { name, guildName, position, goldBid, partyNumber, partySlot, attended, paid } = req.body || {};
  let nextName = existing.name;
  let nextGuildName = existing.guild_name;
  let nextPosition = existing.position;
  let nextGoldBid = existing.gold_bid;
  let nextPartyNumber = existing.party_number;
  let nextPartySlot = existing.party_slot;
  let nextAttended = existing.attended;
  let nextPaid = existing.paid;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
  }
  if (guildName !== undefined) nextGuildName = guildName || null;
  if (position !== undefined) nextPosition = position || null;
  if (goldBid !== undefined) {
    const n = Number(goldBid);
    if (Number.isNaN(n) || n < 0) return res.status(400).json({ error: 'goldBid must be a non-negative number' });
    nextGoldBid = n;
  }
  if (partyNumber !== undefined) nextPartyNumber = Number(partyNumber) || 1;
  if (partySlot !== undefined) nextPartySlot = Number(partySlot) || 1;
  if (attended !== undefined) nextAttended = !!attended;
  if (paid !== undefined) nextPaid = !!paid;

  if (nextPartyNumber !== existing.party_number || nextPartySlot !== existing.party_slot) {
    const partyCount = await countCrusadePartySlot(req.params.id, nextPartyNumber, nextPartySlot, req.params.pid);
    if (partyCount >= CRUSADE_PARTY_MAX_MEMBERS) {
      return res.status(400).json({ error: `Party ${nextPartySlot} on Team ${nextPartyNumber} already has ${CRUSADE_PARTY_MAX_MEMBERS} members — pick another party.` });
    }
  }

  const { rows } = await sql`
    UPDATE crusade_participants SET
      name = ${nextName}, guild_name = ${nextGuildName}, position = ${nextPosition},
      gold_bid = ${nextGoldBid}, party_number = ${nextPartyNumber}, party_slot = ${nextPartySlot},
      attended = ${nextAttended}, paid = ${nextPaid}
    WHERE id = ${req.params.pid}
    RETURNING *
  `;
  await upsertSovereignMember(rows[0].name, rows[0].guild_name, rows[0].position);
  await logActivity(req, {
    action: 'update',
    entityType: 'crusade_participant',
    entityId: req.params.pid,
    description: `Updated "${rows[0].name}" in crusade roster`,
    before: serializeCrusadeParticipant(existing),
    after: serializeCrusadeParticipant(rows[0]),
  });
  res.json(serializeCrusadeParticipant(rows[0]));
});

app.delete('/api/crusades/:id/participants/:pid', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT name FROM crusade_participants WHERE id = ${req.params.pid} AND crusade_id = ${req.params.id}`;
  const { rowCount } = await sql`DELETE FROM crusade_participants WHERE id = ${req.params.pid} AND crusade_id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'participant not found' });
  await logActivity(req, {
    action: 'delete',
    entityType: 'crusade_participant',
    entityId: req.params.pid,
    description: `Removed "${existingRows[0]?.name}" from crusade roster`,
    before: existingRows[0] ? { name: existingRows[0].name } : undefined,
  });
  res.status(204).end();
});

// Resolves the #cave-attendance channel id — an explicit env var wins (same
// pattern as DISCORD_BOSS_CHANNEL_ID) since the by-name lookup only sees
// channels the bot's own channel-list call returns; a channel it can't see
// there but can still read/post in (permission quirks) still works by id.
async function resolveCaveAttendanceChannelId(botToken, guildId) {
  const envChannelId = process.env.DISCORD_CAVE_ATTENDANCE_CHANNEL_ID;
  if (envChannelId) return { channelId: envChannelId };

  const channelsRes = await discordFetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!channelsRes.ok) return { error: { status: 502, body: { error: 'failed to list Discord channels', details: await channelsRes.text() } } };

  const channels = await channelsRes.json();
  const channel = channels.find((c) => (c.name || '').toLowerCase() === 'cave-attendance');
  if (!channel) {
    return {
      error: {
        status: 404,
        body: { error: 'no channel named "cave-attendance" found in this Discord server — set DISCORD_CAVE_ATTENDANCE_CHANNEL_ID to its channel ID instead' },
      },
    };
  }
  return { channelId: channel.id };
}

// Matches each message's attendee list against the roster (name/alias,
// fuzzy) and logs attendance onto the matching cave date + boss, creating
// the boss log if it doesn't exist yet. Posts a confirmation back into the
// channel for every session it touches so the match is visible for a human
// to sanity-check, rather than only living in the app. Shared by the
// manual month-scoped sync and the recurring auto-poll below. Skips (and
// never re-confirms) any message id already recorded in
// cave_attendance_logged_messages, so re-running the manual sync over a
// range that's already been synced is always safe — it won't re-flood the
// channel with duplicate "Logged Successfully" replies.
async function processCaveAttendanceMessages(messages, { channelId, botToken, year }) {
  await ensureSchema();
  const [{ rows: bosses }, { rows: members }, { rows: loggedRows }] = await Promise.all([
    sql`SELECT name FROM boss_timers`,
    sql`SELECT id, name, alias FROM members`,
    sql`SELECT message_id FROM cave_attendance_logged_messages WHERE message_id = ANY(${messages.map((m) => m.id)})`,
  ]);
  const bossNames = bosses.map((b) => b.name).sort((a, b) => b.length - a.length);
  const alreadyLogged = new Set(loggedRows.map((r) => r.message_id));

  const results = [];
  for (const msg of messages) {
    if (alreadyLogged.has(msg.id)) {
      results.push({ messageId: msg.id, skipped: true, reason: 'already logged' });
      continue;
    }

    const bossName = bossNames.find((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, 'i').test(msg.content));
    if (!bossName) {
      results.push({ messageId: msg.id, skipped: true, reason: 'no known boss name found in message' });
      continue;
    }

    const localPosted = new Date(new Date(msg.timestamp).getTime() + BOSS_CHAT_TIMEZONE_OFFSET_MINUTES * 60000);
    const fallbackDate = localPosted.toISOString().slice(0, 10);
    const dateMatch = extractDateFromText(msg.content, year ?? localPosted.getUTCFullYear());
    const date = dateMatch ? dateMatch.date : fallbackDate;

    const tokens = extractNameTokens(msg.content, bossName);
    const matchedIds = new Set();
    const matchedNames = [];
    const unmatched = [];
    for (const token of tokens) {
      const match = matchMemberForToken(token, members);
      if (match) {
        matchedIds.add(match.member.id);
        matchedNames.push(match.member.name);
      } else {
        unmatched.push(token);
      }
    }
    if (!matchedIds.size) {
      results.push({ messageId: msg.id, skipped: true, reason: 'no attendee names recognized', boss: bossName, date });
      continue;
    }

    const { rows: existingRows } = await sql`
      SELECT * FROM cave_sessions WHERE date = ${date} AND LOWER(run) = LOWER(${bossName})
    `;
    let session = existingRows[0];
    const mergedAttendees = Array.from(new Set([...(session?.attendees || []), ...matchedIds]));

    if (session) {
      const { rows } = await sql`
        UPDATE cave_sessions SET attendees = ${JSON.stringify(mergedAttendees)} WHERE id = ${session.id} RETURNING *
      `;
      session = rows[0];
    } else {
      const { rows } = await sql`
        INSERT INTO cave_sessions (id, date, run, attendees)
        VALUES (${crypto.randomUUID()}, ${date}, ${bossName}, ${JSON.stringify(mergedAttendees)})
        RETURNING *
      `;
      session = rows[0];
    }

    // Recorded as soon as the attendance itself is saved — before the
    // confirmation post below — so a message is never re-applied (or
    // re-confirmed) on a later sync even if that post attempt fails.
    await sql`INSERT INTO cave_attendance_logged_messages (message_id) VALUES (${msg.id}) ON CONFLICT DO NOTHING`;

    // A confirmation reply is only useful while it's still visible near the
    // original message in the channel — for a message this old, someone is
    // running a historical backfill (a big date-range manual sync, or a
    // first-ever poll with no prior cursor/dedup state), where posting a
    // reply for every match would flood the channel with confirmations for
    // dates everyone already moved past. The attendance itself is still
    // saved either way; only the Discord reply is conditional on recency —
    // this holds regardless of cave_attendance_logged_messages/poll-cursor
    // state, so it can't regress into a flood again if either is ever reset.
    const CONFIRMATION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
    const isRecent = Date.now() - new Date(msg.timestamp).getTime() <= CONFIRMATION_MAX_AGE_MS;

    let discordPosted = false;
    if (isRecent) {
      try {
        const confirmRes = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: [
              `✅ Logged Successfully — **${bossName}** (${date})`,
              'Attendees:',
              ...matchedNames.map((name, i) => `${i + 1}. ${name}`),
              unmatched.length ? `⚠️ Not recognized:\n${unmatched.map((t) => `- ${t}`).join('\n')}` : null,
            ].filter(Boolean).join('\n'),
            message_reference: { message_id: msg.id },
          }),
        });
        discordPosted = confirmRes.ok;
      } catch (err) {
        console.error('cave-attendance-sync confirm post failed', err);
      }
    }

    results.push({
      messageId: msg.id,
      sessionId: session.id,
      boss: bossName,
      date,
      matchedNames,
      unmatched,
      discordPosted,
    });
  }

  return results;
}

// Scans #cave-attendance for a given month — manual, admin-triggered version
// (see /api/discord/poll-cave-attendance below for the automatic one).
app.post('/api/cave-attendance-sync', async (req, res) => {
  const { month } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month must be in YYYY-MM format' });

  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!botToken || !guildId) {
    return res.status(400).json({ error: 'DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be configured' });
  }

  const { channelId, error } = await resolveCaveAttendanceChannelId(botToken, guildId);
  if (error) return res.status(error.status).json(error.body);

  const [year, monthNum] = month.split('-').map(Number);
  const startMs = Date.UTC(year, monthNum - 1, 1) - BOSS_CHAT_TIMEZONE_OFFSET_MINUTES * 60000;
  const endMs = Date.UTC(year, monthNum, 1) - BOSS_CHAT_TIMEZONE_OFFSET_MINUTES * 60000;

  const messages = [];
  let before = snowflakeForTimestamp(endMs);
  for (let page = 0; page < 20; page++) {
    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('before', before);
    const msgRes = await discordFetch(url, { headers: { Authorization: `Bot ${botToken}` } });
    if (!msgRes.ok) return res.status(502).json({ error: 'failed to fetch messages', details: await msgRes.text() });
    const batch = await msgRes.json();
    if (!batch.length) break;
    // A brief pause between pages — the messages endpoint's rate limit is
    // tight enough that scanning a busy month back-to-back can trip it even
    // with discordFetch's retry as a backstop.
    if (page > 0) await new Promise((resolve) => setTimeout(resolve, 300));

    let hitOlder = false;
    for (const msg of batch) {
      const t = new Date(msg.timestamp).getTime();
      if (t < startMs) { hitOlder = true; continue; }
      if (t < endMs && !msg.author?.bot) messages.push(msg);
    }
    before = batch[batch.length - 1].id;
    if (hitOlder || batch.length < 100) break;
  }

  const results = await processCaveAttendanceMessages(messages, { channelId, botToken, year });
  const applied = results.filter((r) => !r.skipped);
  await logActivity(req, {
    action: 'update',
    entityType: 'cave_attendance_sync',
    entityId: null,
    description: `Synced attendance from Discord for ${month} — scanned ${messages.length} message(s), logged ${applied.length}`,
  });
  res.json({ channelId, scanned: messages.length, results });
});

// Automatic version of the sync above — polls for whatever's new since the
// last run (cursor in cave_attendance_poll_state, same pattern as
// poll-boss-kills) instead of requiring someone to click "Sync from
// Discord". Outside the cookie-auth gate so Vercel Cron or an external
// scheduler can call it directly, protected by its own CRON_SECRET bearer
// check instead — see vercel.json for the schedule.
app.all('/api/discord/poll-cave-attendance', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!botToken || !guildId) {
    return res.json({ skipped: true, reason: 'DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not configured' });
  }

  try {
    await ensureSchema();

    const { channelId, error } = await resolveCaveAttendanceChannelId(botToken, guildId);
    if (error) return res.status(error.status).json(error.body);

    const { rows: stateRows } = await sql`SELECT last_message_id FROM cave_attendance_poll_state WHERE id = 1`;
    const lastId = stateRows[0]?.last_message_id;

    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    url.searchParams.set('limit', '100');
    if (lastId) url.searchParams.set('after', lastId);

    const discordRes = await discordFetch(url, { headers: { Authorization: `Bot ${botToken}` } });
    if (!discordRes.ok) {
      return res.status(502).json({ error: 'discord fetch failed', details: await discordRes.text() });
    }
    // Newest-first regardless of the after param — advance the cursor off
    // the raw (unfiltered) newest id so a quiet channel doesn't get
    // re-fetched forever, then process oldest-first so an earlier date's
    // attendance is never overshadowed by a same-poll later message.
    const rawMessages = await discordRes.json();
    const newestRawId = rawMessages[0]?.id;
    const messages = rawMessages.filter((msg) => !msg.author?.bot).reverse();

    const results = await processCaveAttendanceMessages(messages, { channelId, botToken });

    if (newestRawId) {
      await sql`
        INSERT INTO cave_attendance_poll_state (id, last_message_id, updated_at) VALUES (1, ${newestRawId}, now())
        ON CONFLICT (id) DO UPDATE SET last_message_id = ${newestRawId}, updated_at = now()
      `;
    }

    res.json({ scanned: messages.length, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'database unavailable' });
  }
});

// Finds the bot's own "Logged Successfully" replies in #cave-attendance,
// grouped by which original message each one is replying to. A group with
// more than one reply means a historical backfill re-confirmed a message
// that was already answered — the fix above (48-hour recency gate) stops
// this from happening again, but doesn't touch replies already posted, so
// this is a one-off way to find (and, via the cleanup route below, remove)
// the leftover duplicates. Keeps the oldest reply in each group and reports
// the rest — never deletes anything itself.
async function findDuplicateCaveConfirmations(botToken, channelId) {
  const messages = [];
  let before;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    url.searchParams.set('limit', '100');
    if (before) url.searchParams.set('before', before);
    const discordRes = await discordFetch(url, { headers: { Authorization: `Bot ${botToken}` } });
    if (!discordRes.ok) throw new Error(`discord fetch failed: ${await discordRes.text()}`);
    const batch = await discordRes.json();
    if (!batch.length) break;
    messages.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
    // A brief pause between pages — the messages endpoint's rate limit is
    // tight enough that a 20-page scan back-to-back can trip it even with
    // discordFetch's retry as a backstop.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const confirmations = messages.filter(
    (m) =>
      m.author?.bot &&
      typeof m.content === 'string' &&
      m.content.startsWith('✅ Logged Successfully') &&
      m.message_reference?.message_id
  );

  const byOriginal = new Map();
  for (const m of confirmations) {
    const key = m.message_reference.message_id;
    if (!byOriginal.has(key)) byOriginal.set(key, []);
    byOriginal.get(key).push(m);
  }

  const duplicateGroups = [];
  for (const [originalMessageId, group] of byOriginal) {
    if (group.length < 2) continue;
    group.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const [keep, ...duplicates] = group;
    duplicateGroups.push({
      originalMessageId,
      keptMessageId: keep.id,
      duplicateMessageIds: duplicates.map((d) => d.id),
      preview: keep.content.split('\n')[0],
    });
  }
  return duplicateGroups;
}

app.get('/api/discord/cave-attendance-duplicates', async (req, res) => {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!botToken || !guildId) {
    return res.status(400).json({ error: 'DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be configured' });
  }
  const { channelId, error } = await resolveCaveAttendanceChannelId(botToken, guildId);
  if (error) return res.status(error.status).json(error.body);

  try {
    const duplicateGroups = await findDuplicateCaveConfirmations(botToken, channelId);
    const totalDuplicates = duplicateGroups.reduce((sum, g) => sum + g.duplicateMessageIds.length, 0);
    res.json({ duplicateGroups, totalDuplicates });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/discord/cave-attendance-duplicates/cleanup', async (req, res) => {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!botToken || !guildId) {
    return res.status(400).json({ error: 'DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be configured' });
  }
  const { channelId, error } = await resolveCaveAttendanceChannelId(botToken, guildId);
  if (error) return res.status(error.status).json(error.body);

  try {
    const duplicateGroups = await findDuplicateCaveConfirmations(botToken, channelId);
    let deleted = 0;
    const failed = [];
    for (const group of duplicateGroups) {
      for (const id of group.duplicateMessageIds) {
        const delRes = await discordFetch(`https://discord.com/api/v10/channels/${channelId}/messages/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bot ${botToken}` },
        });
        if (delRes.ok) {
          deleted++;
        } else {
          failed.push({ messageId: id, status: delRes.status, details: await delRes.text() });
        }
        // Individual message deletes are rate-limited fairly tightly —
        // a short pause between calls keeps a big cleanup from tripping it.
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    await logActivity(req, {
      action: 'delete',
      entityType: 'cave_attendance_duplicate_confirmation',
      description: `Cleaned up ${deleted} duplicate Discord confirmation(s) in #cave-attendance${failed.length ? ` — ${failed.length} failed` : ''}`,
    });
    res.json({ deleted, failed });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

module.exports = app;
