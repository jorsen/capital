const express = require('express');
const cookie = require('cookie');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { sql, ensureSchema, getClasses, SLOTS } = require('./db');
const { verifyDiscordRequest, handleInteraction, registerCommands } = require('./discord');
const ICON_MANIFEST = require('./icon-manifest');

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'capital-records';
// Optional second, lower-privilege password: logs in with read-only access —
// every GET still works, but any POST/PUT/DELETE under /api/ is blocked
// regardless of cookie, so a view-only visitor can never mutate data even if
// they inspect/replay requests.
const VIEW_PASSWORD = process.env.VIEW_PASSWORD || null;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_PATHS = new Set(['/login', '/login.js', '/styles.css', '/favicon.svg']);
const ROLES = ['admin', 'viewer'];

const AUTH_COOKIE = 'crAuth';
const AUTH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds

function authToken(role) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(`authenticated:${role}`).digest('hex');
}

// Cookie value is just an HMAC of a fixed per-role string (same trust model
// the original single-role cookie used) — checked against both roles' tokens
// so a viewer can't upgrade themselves to admin by editing the cookie value.
function getAuthRole(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies[AUTH_COOKIE];
  if (!token) return null;
  const provided = Buffer.from(token);
  for (const role of ROLES) {
    const expectedBuf = Buffer.from(authToken(role));
    if (provided.length === expectedBuf.length && crypto.timingSafeEqual(provided, expectedBuf)) {
      return role;
    }
  }
  return null;
}

function isAuthenticated(req) {
  return !!getAuthRole(req);
}

function isAdmin(req) {
  return getAuthRole(req) === 'admin';
}

function setAuthCookie(res, role) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(AUTH_COOKIE, authToken(role), {
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

async function withSchema(req, res, next) {
  try {
    await ensureSchema();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'database unavailable' });
  }
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

    const discordRes = await fetch(url, { headers: { Authorization: `Bot ${botToken}` } });
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

    const { rows: bosses } = await sql`SELECT id, name FROM boss_timers WHERE type = 'interval'`;

    // Log every matching message to history (so who-posted-what stays
    // auditable even if several mentions show up in one poll window), but
    // only the last one per boss actually restarts that boss's timer.
    const killedAtByBossId = new Map();
    for (const msg of messages) {
      const content = (msg.content || '').toLowerCase();
      for (const boss of bosses) {
        if (content.includes(boss.name.toLowerCase())) {
          killedAtByBossId.set(boss.id, msg.timestamp);
          const author = msg.author?.global_name || msg.author?.username || null;
          await sql`
            INSERT INTO boss_kill_history (id, boss_id, boss_name, killed_at, source, discord_author)
            VALUES (${crypto.randomUUID()}, ${boss.id}, ${boss.name}, ${msg.timestamp}, 'discord', ${author})
          `;
        }
      }
    }

    for (const [bossId, killedAt] of killedAtByBossId) {
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
// next spawn falls within the next 10 minutes. Meant to be hit by an external
// scheduler roughly once a minute — daily and Vercel Cron's coarser cadence
// are both too slow to reliably catch this window precisely.
const NOTIFY_LEAD_MS = 10 * 60 * 1000;

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
      if (nextSpawnMs - now > NOTIFY_LEAD_MS || nextSpawnMs - now < 0) continue;

      const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `@everyone ⏰ **${boss.name}** spawns in about 10 minutes!` }),
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

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  let role = null;
  if (password === SITE_PASSWORD) role = 'admin';
  else if (VIEW_PASSWORD && password === VIEW_PASSWORD) role = 'viewer';
  if (!role) {
    return res.status(401).json({ error: 'incorrect password' });
  }
  setAuthCookie(res, role);
  res.status(204).end();
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

app.use((req, res, next) => {
  if (isAuthenticated(req) || PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  if (req.path === '/' || req.path.endsWith('.html')) return res.redirect('/login');
  return res.status(401).end();
});

// A couple of routes are GET but have a real mutating side effect (they
// register Discord commands / write icon URLs) — treated as writes here too,
// even though the blanket rule below only keys off HTTP method.
const ADMIN_ONLY_GET_PATHS = new Set(['/api/discord/register-commands', '/api/item-categories/apply-icon-manifest']);

// Viewer-role sessions (VIEW_PASSWORD) can reach any GET, but never a write —
// enforced here in one place rather than per-route, so a new mutating
// endpoint is safe-by-default instead of accidentally open to viewers.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const needsAdmin = req.method !== 'GET' || ADMIN_ONLY_GET_PATHS.has(req.path);
  if (needsAdmin && !isAdmin(req)) {
    return res.status(403).json({ error: 'view-only access — log in as admin to make changes' });
  }
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// No DB dependency — kept ahead of the withSchema gate so the frontend can
// always determine its role even if the database is unreachable.
app.get('/api/session', (req, res) => {
  res.json({ role: getAuthRole(req) });
});

app.use('/api', withSchema);

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
  const { name, className, notes } = req.body || {};
  if (!name || !name.trim() || !(await getClasses()).includes(className)) {
    return res.status(400).json({ error: 'name and a valid class are required' });
  }
  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO members (id, name, class_name, notes)
    VALUES (${id}, ${name.trim()}, ${className}, ${(notes || '').trim()})
    RETURNING *
  `;
  res.status(201).json(await serializeMember(rows[0]));
});

app.put('/api/members/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM members WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'member not found' });

  const { name, className, notes } = req.body || {};
  let nextName = existing.name;
  let nextClassName = existing.class_name;
  let nextNotes = existing.notes;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    nextName = name.trim();
  }
  if (className !== undefined) {
    if (!(await getClasses()).includes(className)) return res.status(400).json({ error: 'invalid class' });
    nextClassName = className;
  }
  if (notes !== undefined) nextNotes = notes.trim();

  const { rows } = await sql`
    UPDATE members SET name = ${nextName}, class_name = ${nextClassName}, notes = ${nextNotes}
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  res.json(await serializeMember(rows[0]));
});

app.delete('/api/members/:id', async (req, res) => {
  const { rowCount } = await sql`DELETE FROM members WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'member not found' });
  res.status(204).end();
});

app.post('/api/members/:id/growth', async (req, res) => {
  const { rows: memberRows } = await sql`SELECT id FROM members WHERE id = ${req.params.id}`;
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
  res.status(201).json({ id, date, rate: numericRate, note: trimmedNote });
});

app.delete('/api/members/:id/growth/:growthId', async (req, res) => {
  const { rowCount } = await sql`
    DELETE FROM growth_entries WHERE id = ${req.params.growthId} AND member_id = ${req.params.id}
  `;
  if (!rowCount) return res.status(404).json({ error: 'growth entry not found' });
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
    notes: row.notes,
    createdAt: row.created_at,
  };
}

app.get('/api/boss-timers', async (req, res) => {
  const { rows } = await sql`SELECT * FROM boss_timers ORDER BY created_at ASC`;
  res.json(rows.map(serializeBossTimer));
});

app.post('/api/boss-timers', async (req, res) => {
  const { name, type, spawnTime, intervalMinutes, notes } = req.body || {};
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

  const id = crypto.randomUUID();
  const { rows } = await sql`
    INSERT INTO boss_timers (id, name, type, spawn_time, interval_minutes, notes)
    VALUES (
      ${id}, ${name.trim()}, ${type},
      ${type === 'daily' ? spawnTime : null},
      ${type === 'interval' ? Number(intervalMinutes) : null},
      ${(notes || '').trim()}
    )
    RETURNING *
  `;
  res.status(201).json(serializeBossTimer(rows[0]));
});

app.put('/api/boss-timers/:id', async (req, res) => {
  const { rows: existingRows } = await sql`SELECT * FROM boss_timers WHERE id = ${req.params.id}`;
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'boss timer not found' });

  const { name, type, spawnTime, intervalMinutes, notes } = req.body || {};

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

  const { rows } = await sql`
    UPDATE boss_timers
    SET name = ${nextName}, type = ${nextType}, spawn_time = ${nextSpawnTime},
        interval_minutes = ${nextIntervalMinutes}, notes = ${nextNotes}
    WHERE id = ${req.params.id}
    RETURNING *
  `;
  res.json(serializeBossTimer(rows[0]));
});

app.post('/api/boss-timers/:id/kill', async (req, res) => {
  const { killedAt } = req.body || {};
  let killedAtValue = new Date();
  if (killedAt !== undefined) {
    killedAtValue = new Date(killedAt);
    if (Number.isNaN(killedAtValue.getTime())) return res.status(400).json({ error: 'killedAt must be a valid date' });
  }
  const { rows } = await sql`
    UPDATE boss_timers SET last_killed_at = ${killedAtValue.toISOString()} WHERE id = ${req.params.id} AND type = 'interval'
    RETURNING *
  `;
  if (!rows[0]) return res.status(404).json({ error: 'interval boss timer not found' });
  await sql`
    INSERT INTO boss_kill_history (id, boss_id, boss_name, killed_at, source)
    VALUES (${crypto.randomUUID()}, ${rows[0].id}, ${rows[0].name}, ${killedAtValue.toISOString()}, 'manual')
  `;
  res.json(serializeBossTimer(rows[0]));
});

app.delete('/api/boss-timers/:id', async (req, res) => {
  const { rowCount } = await sql`DELETE FROM boss_timers WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'boss timer not found' });
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
  const { rowCount } = await sql`DELETE FROM boss_kill_history WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'history entry not found' });
  res.status(204).end();
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
  const discordRes = await fetch(url, { headers: { Authorization: `Bot ${botToken}` } });
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
    const iconUrl = `/item-icons/${entry.file}`;
    const { rows: existing } = await sql`SELECT id FROM item_categories WHERE LOWER(name) = LOWER(${entry.name})`;
    if (existing.length) {
      await sql`UPDATE item_categories SET icon_url = ${iconUrl} WHERE id = ${existing[0].id}`;
      results.push({ name: entry.name, action: 'updated' });
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
  res.json({ id: req.params.id, name: nextName, iconUrl: nextIcon });
});

app.delete('/api/item-categories/:id', async (req, res) => {
  const { rowCount } = await sql`DELETE FROM item_categories WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'item not found' });
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
  res.json(serializeLootSession(rows[0], recordsMap.get(rows[0].id)));
});

app.delete('/api/loot/:id', async (req, res) => {
  const { rowCount } = await sql`DELETE FROM loot_sessions WHERE id = ${req.params.id}`;
  if (!rowCount) return res.status(404).json({ error: 'session not found' });
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
        const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
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
  res.status(201).json(entry);
});

app.delete('/api/loot/:id/raffle-log', async (req, res) => {
  const { rows: sessionRows } = await sql`SELECT id FROM loot_sessions WHERE id = ${req.params.id}`;
  if (!sessionRows[0]) return res.status(404).json({ error: 'session not found' });

  await sql`UPDATE loot_sessions SET raffle_log = '[]' WHERE id = ${req.params.id}`;
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
  const { rowCount } = await sql`
    DELETE FROM loot_records WHERE id = ${req.params.recordId} AND session_id = ${req.params.id}
  `;
  if (!rowCount) return res.status(404).json({ error: 'record not found' });
  res.status(204).end();
});

module.exports = app;
