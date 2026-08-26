const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'discord_clone.db');
let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar_seed TEXT NOT NULL,
      status TEXT DEFAULT 'online' CHECK(status IN ('online','idle','dnd','offline')),
      custom_status TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon_url TEXT DEFAULT '',
      invite_code TEXT NOT NULL UNIQUE,
      owner_id INTEGER NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'text' CHECK(type IN ('text', 'voice')),
      topic TEXT DEFAULT '',
      position INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'member' CHECK(role IN ('owner','admin','moderator','member')),
      nickname TEXT DEFAULT '',
      joined_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (server_id, user_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      edited INTEGER DEFAULT 0,
      edited_at TEXT,
      reply_to INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(message_id, user_id, emoji),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS file_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER,
      user_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS moderation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      moderator_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('ban','kick','mute','warn')),
      reason TEXT DEFAULT '',
      duration INTEGER,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (moderator_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_moderation_server ON moderation(server_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_moderation_user ON moderation(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_file_uploads_message ON file_uploads(message_id)`);

  saveDatabase();
  return db;
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

function getDb() {
  return db;
}

module.exports = { initDatabase, getDb, saveDatabase };
