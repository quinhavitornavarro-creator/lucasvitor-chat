const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const hash = bcrypt.hashSync('12345lucas', 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, 'quinhavitornavarro@gmail.com']);
  console.log('Senha atualizada!');
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = 1');
  console.log('Refresh tokens limpos!');
  await pool.query('DELETE FROM password_resets WHERE user_id = 1');
  console.log('Reset tokens limpos!');
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
