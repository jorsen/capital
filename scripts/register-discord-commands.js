const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN environment variables are required');
  process.exit(1);
}

const commands = [
  {
    name: 'growth',
    description: 'Report your current growth rate',
    options: [
      {
        name: 'value',
        description: 'Your growth rate number',
        type: 4, // INTEGER
        required: true,
      },
    ],
  },
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

(async () => {
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error('Failed to register commands:', res.status, body);
    process.exit(1);
  }
  console.log(`Registered ${body.length} command(s)${GUILD_ID ? ' for guild ' + GUILD_ID : ' globally'}:`);
  body.forEach((cmd) => console.log(`  /${cmd.name} - ${cmd.description}`));
})();
