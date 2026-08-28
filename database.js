const { Pool } = require('pg');

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
};
const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err.message);
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar_seed TEXT DEFAULT '',
      status TEXT DEFAULT 'online' CHECK(status IN ('online','idle','dnd','offline')),
      custom_status TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      profile_color TEXT DEFAULT '#7c3aed',
      created_at TEXT DEFAULT NOW(),
      updated_at TEXT DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_color TEXT DEFAULT '#7c3aed'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      icon_url TEXT DEFAULT '',
      invite_code TEXT NOT NULL UNIQUE,
      owner_id INTEGER,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);
  await pool.query(`ALTER TABLE servers ALTER COLUMN owner_id DROP NOT NULL`).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'text' CHECK(type IN ('text', 'voice')),
      topic TEXT DEFAULT '',
      position INTEGER DEFAULT 0,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'member' CHECK(role IN ('owner','admin','moderator','member')),
      nickname TEXT DEFAULT '',
      joined_at TEXT DEFAULT NOW(),
      PRIMARY KEY (server_id, user_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      edited INTEGER DEFAULT 0,
      edited_at TEXT,
      reply_to INTEGER,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT DEFAULT NOW(),
      UNIQUE(message_id, user_id, emoji),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS file_uploads (
      id SERIAL PRIMARY KEY,
      message_id INTEGER,
      user_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS moderation (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      moderator_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('ban','kick','mute','warn')),
      reason TEXT DEFAULT '',
      duration INTEGER,
      expires_at TEXT,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (moderator_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_pins (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL UNIQUE,
      pinned_by INTEGER NOT NULL,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_moderation_server ON moderation(server_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_moderation_user ON moderation(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_file_uploads_message ON file_uploads(message_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_message_pins_message ON message_pins(message_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_message_pins_channel ON message_pins(message_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','blocked')),
      created_at TEXT DEFAULT NOW(),
      UNIQUE(from_user_id, to_user_id),
      FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_channels (
      id SERIAL PRIMARY KEY,
      is_group INTEGER DEFAULT 0,
      name TEXT DEFAULT '',
      created_at TEXT DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_members (
      dm_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT DEFAULT NOW(),
      PRIMARY KEY (dm_id, user_id),
      FOREIGN KEY (dm_id) REFERENCES dm_channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dm_messages (
      id SERIAL PRIMARY KEY,
      dm_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (dm_id) REFERENCES dm_channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS threads (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL,
      parent_message_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT NOW(),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_categories_server ON categories(server_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dm_messages_dm ON dm_messages(dm_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id)`);

  const defaultServer = await pool.query('SELECT id FROM servers LIMIT 1');
  if (defaultServer.rows.length === 0) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let inviteCode = '';
    for (let i = 0; i < 8; i++) inviteCode += chars.charAt(Math.floor(Math.random() * chars.length));
    const result = await pool.query('INSERT INTO servers (name, invite_code, owner_id) VALUES ($1, $2, NULL) RETURNING id', ['Comunidade Geral', inviteCode]);
    const serverId = result.rows[0].id;
    await pool.query('INSERT INTO channels (server_id, name, type, position) VALUES ($1, $2, $3, $4)', [serverId, 'geral', 'text', 0]);
    await pool.query('INSERT INTO channels (server_id, name, type, position) VALUES ($1, $2, $3, $4)', [serverId, 'ajuda', 'text', 1]);
    await pool.query('INSERT INTO channels (server_id, name, type, position) VALUES ($1, $2, $3, $4)', [serverId, 'Voz Geral', 'voice', 2]);
    console.log(`Servidor padrão criado (ID: ${serverId})`);
  }
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function run(sql, params = []) {
  const result = await pool.query(sql, params);
  return { rowCount: result.rowCount, rows: result.rows };
}

async function runReturningId(sql, params = []) {
  const result = await pool.query(sql, params);
  return { id: result.rows[0].id, rowCount: result.rowCount, rows: result.rows };
}

module.exports = { initDatabase, query, queryOne, run, runReturningId };
