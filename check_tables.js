const db = require('./src/db');
db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name")
  .then(r => { console.log(r.rows.map(r => r.table_name).join('\n')); process.exit(); })
  .catch(e => { console.error(e); process.exit(1); });
