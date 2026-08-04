const { verifyKey, InteractionType, InteractionResponseType, InteractionResponseFlags } = require('discord-interactions');
const crypto = require('crypto');
const { sql, ensureSchema, CLASSES } = require('./db');

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const GROWTH_EMBED_COLOR = 0xf2a93c;
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://capital-records.vercel.app';
const SAMPLE_SCREENSHOT_URL = `${SITE_BASE_URL}/discord-assets/growth-sample.webp`;

function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

async function verifyDiscordRequest(req) {
  if (!DISCORD_PUBLIC_KEY) return false;
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (!signature || !timestamp || !req.rawBody) return false;
  return verifyKey(req.rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
}

function getDisplayName(member) {
  if (!member) return '';
  const name = member.nick || (member.user && (member.user.global_name || member.user.username)) || '';
  return name.trim();
}

function ephemeralMessage(content, { includeSample } = {}) {
  const data = { content, flags: InteractionResponseFlags.EPHEMERAL };
  if (includeSample) {
    data.embeds = [{ title: 'Example screenshot', image: { url: SAMPLE_SCREENSHOT_URL } }];
  }
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  };
}

async function handleGrowthCommand(interaction) {
  const displayName = getDisplayName(interaction.member);
  const options = interaction.data.options || [];
  const rateOption = options.find((o) => o.name === 'value');
  const classOption = options.find((o) => o.name === 'class');
  const screenshotOption = options.find((o) => o.name === 'screenshot');
  const rate = rateOption ? Number(rateOption.value) : NaN;

  if (!displayName) {
    return ephemeralMessage("Couldn't determine your Discord display name.");
  }
  if (Number.isNaN(rate)) {
    return ephemeralMessage('Growth rate must be a number.');
  }

  const attachment =
    screenshotOption && interaction.data.resolved && interaction.data.resolved.attachments
      ? interaction.data.resolved.attachments[screenshotOption.value]
      : null;
  if (!attachment) {
    return ephemeralMessage('Please attach a screenshot of your growth rate. Here\'s an example:', {
      includeSample: true,
    });
  }
  if (!attachment.content_type || !attachment.content_type.startsWith('image/')) {
    return ephemeralMessage('The attached file must be an image (screenshot). Here\'s an example:', {
      includeSample: true,
    });
  }

  await ensureSchema();
  const { rows } = await sql`SELECT id, name, class_name FROM members WHERE LOWER(name) = LOWER(${displayName})`;
  let member = rows[0];

  if (!member) {
    const className = classOption && CLASSES.includes(classOption.value) ? classOption.value : null;
    if (!className) {
      return ephemeralMessage(
        `No guild member named "${displayName}" was found in Capital Records, so I can't record this yet. Run /growth again and fill in the "class" option too, and I'll add you to the roster automatically.`
      );
    }
    const newId = crypto.randomUUID();
    const { rows: createdRows } = await sql`
      INSERT INTO members (id, name, class_name, notes)
      VALUES (${newId}, ${displayName}, ${className}, 'Added via Discord')
      RETURNING id, name, class_name
    `;
    member = createdRows[0];
  }

  const id = crypto.randomUUID();
  const date = new Date().toISOString().slice(0, 10);
  await sql`
    INSERT INTO growth_entries (id, member_id, date, rate, note)
    VALUES (${id}, ${member.id}, ${date}, ${rate}, 'Reported via Discord')
  `;

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: member.class_name,
          description: `**Growth Rate**\n${formatNumber(rate)}`,
          color: GROWTH_EMBED_COLOR,
          image: { url: attachment.url },
          footer: { text: member.name },
        },
      ],
    },
  };
}

function updateMessage(content) {
  return { type: InteractionResponseType.UPDATE_MESSAGE, data: { content, components: [] } };
}

// Handles a click on the "Confirm <boss> kill" button posted by
// POST /api/loot/:id/submit-attendance (lib/app.js) — this is the actual
// trigger that restarts the boss's timer, so a raid officer confirms the
// kill from Discord rather than the web submit action restarting it
// unconditionally off a possibly-wrong name match.
async function handleConfirmBossKill(interaction) {
  const [, bossId, sessionId] = interaction.data.custom_id.split(':');
  await ensureSchema();

  const { rows: sessionRows } = await sql`SELECT * FROM loot_sessions WHERE id = ${sessionId}`;
  const session = sessionRows[0];
  if (!session) return updateMessage('This attendance session no longer exists.');

  const { rows: bossRows } = await sql`SELECT * FROM boss_timers WHERE id = ${bossId}`;
  const boss = bossRows[0];
  if (!boss) return updateMessage('This boss timer no longer exists.');

  if (session.boss_confirmed_at) {
    return updateMessage(`✅ **${boss.name}** kill already confirmed by ${session.boss_confirmed_by} — timer is running.`);
  }

  const displayName = getDisplayName(interaction.member) || 'someone';
  const now = new Date();
  await sql`
    UPDATE loot_sessions SET boss_confirmed_at = ${now.toISOString()}, boss_confirmed_by = ${displayName}
    WHERE id = ${sessionId}
  `;
  await sql`UPDATE boss_timers SET last_killed_at = ${now.toISOString()} WHERE id = ${bossId} AND type = 'interval'`;
  await sql`
    INSERT INTO boss_kill_history (id, boss_id, boss_name, killed_at, source, discord_author)
    VALUES (${crypto.randomUUID()}, ${boss.id}, ${boss.name}, ${now.toISOString()}, 'discord', ${displayName})
  `;

  return updateMessage(`✅ **${boss.name}** kill confirmed by ${displayName} — timer started!`);
}

async function handleInteraction(interaction) {
  if (interaction.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }
  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data && interaction.data.name === 'growth') {
    return handleGrowthCommand(interaction);
  }
  if (
    interaction.type === InteractionType.MESSAGE_COMPONENT &&
    interaction.data &&
    typeof interaction.data.custom_id === 'string' &&
    interaction.data.custom_id.startsWith('confirm_boss_kill:')
  ) {
    return handleConfirmBossKill(interaction);
  }
  return ephemeralMessage('Unsupported interaction.');
}

const GROWTH_COMMAND = {
  name: 'growth',
  description: 'Report your current growth rate',
  options: [
    {
      name: 'value',
      description: 'Your growth rate number',
      type: 4, // INTEGER
      required: true,
    },
    {
      name: 'screenshot',
      description: 'Screenshot proof of your growth rate',
      type: 11, // ATTACHMENT
      required: true,
    },
    {
      name: 'class',
      description: 'Your class (only needed the first time, to add you to the roster)',
      type: 3, // STRING
      required: false,
      choices: CLASSES.map((name) => ({ name, value: name })),
    },
  ],
};

async function registerCommands() {
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!applicationId || !botToken) {
    throw new Error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN must be set');
  }

  const url = guildId
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([GROWTH_COMMAND]),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error('Failed to register Discord commands');
    err.details = body;
    throw err;
  }
  return body;
}

module.exports = { verifyDiscordRequest, handleInteraction, registerCommands };
