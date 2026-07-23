const { registerCommands } = require('../lib/discord');

registerCommands()
  .then((body) => {
    console.log(`Registered ${body.length} command(s):`);
    body.forEach((cmd) => console.log(`  /${cmd.name} - ${cmd.description}`));
  })
  .catch((err) => {
    console.error(err.message, err.details || '');
    process.exit(1);
  });
