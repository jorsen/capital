const app = require('./lib/app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Capital Records running at http://localhost:${PORT}`);
});
