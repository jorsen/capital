const express = require('express');
const cookie = require('cookie');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { sql, ensureSchema, CLASSES, SLOTS } = require('./db');
const { verifyDiscordRequest, handleInteraction, registerCommands } = require('./discord');
const ICON_MANIFEST = require('./icon-manifest');

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'capital-records';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_PATHS = new Set(['/login', '/login.js', '/styles.css', '/favicon.svg']);

const AUTH_COOKIE = 'crAuth';
const AUTH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds

function authToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('authenticated').digest('hex');
}

function isAuthenticated(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies[AUTH_COOKIE];
  if (!token) return false;
  const expected = authToken();
  const provided = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}

function setAuthCookie(res) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(AUTH_COOKIE, authToken(), {
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
  };
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

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'incorrect password' });
  }
  setAuthCookie(res);
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

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', withSchema);

app.get('/api/classes', (req, res) => {
  res.json(CLASSES);
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
  if (!name || !name.trim() || !CLASSES.includes(className)) {
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
    if (!CLASSES.includes(className)) return res.status(400).json({ error: 'invalid class' });
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
  const doneNames = new Set(existingDone.map((d) => d.name));

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
  const nextDone = existingDone.filter((d) => d.name !== req.params.name);
  await sql`UPDATE queue_slots SET done = ${JSON.stringify(nextDone)} WHERE slot = ${slot}`;
  res.json({ slot, done: nextDone });
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
