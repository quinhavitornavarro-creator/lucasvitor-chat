const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { initDatabase, getDb, saveDatabase } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10e6 });

const JWT_SECRET = process.env.JWT_SECRET || 'discord_clone_secret_key_2024_' + Date.now();
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'discord_clone_refresh_secret_2024_' + Date.now();
const PORT = process.env.PORT || 3000;

// ─── Security ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const chatLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 10,
  message: { error: 'Você está enviando mensagens rápido demais.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const avatarsDir = path.join(uploadsDir, 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false, lastModified: false }));

// ─── File Upload ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|webm|pdf|txt|zip/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype.split('/')[1]) || file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/') || file.mimetype === 'application/pdf';
    cb(null, ext || mime);
  }
});

// ─── DB Helpers ──────────────────────────────────────────────────────────────
function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function queryOne(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function queryAll(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  const db = getDb();
  db.run(sql, params);
  saveDatabase();
}

function findByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = ?', [email]);
}

function findByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = ?', [username]);
}

function findById(id) {
  return queryOne('SELECT * FROM users WHERE id = ?', [id]);
}

function insertUser(username, email, passwordHash, avatarSeed) {
  const db = getDb();
  db.run('INSERT INTO users (username, email, password_hash, avatar_seed) VALUES (?, ?, ?, ?)',
    [username, email, passwordHash, avatarSeed]);
  const result = db.exec('SELECT last_insert_rowid() as id');
  saveDatabase();
  return result[0].values[0][0];
}

function generateAccessToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

function generateRefreshToken(userId) {
  const token = jwt.sign({ userId, jti: uuidv4() }, JWT_REFRESH_SECRET, { expiresIn: '30d' });
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  run('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)', [userId, token, expiresAt]);
  return token;
}

function removeRefreshToken(token) {
  run('DELETE FROM refresh_tokens WHERE token = ?', [token]);
}

function generateAvatarSeed() {
  return Math.random().toString(36).substring(2, 10);
}

function sanitizeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getUserServers(userId) {
  return queryAll(`
    SELECT s.*, sm.joined_at, sm.role
    FROM servers s
    INNER JOIN server_members sm ON s.id = sm.server_id
    WHERE sm.user_id = ?
    ORDER BY sm.joined_at ASC
  `, [userId]);
}

function getServerChannels(serverId) {
  return queryAll('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, created_at ASC', [serverId]);
}

function getChannelMessages(channelId, limit = 50, before = null) {
  if (before) {
    return queryAll(`
      SELECT m.*, u.username, u.avatar_seed
      FROM messages m
      INNER JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ? AND m.id < ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `, [channelId, before, limit]).reverse();
  }
  return queryAll(`
    SELECT m.*, u.username, u.avatar_seed
    FROM messages m
    INNER JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `, [channelId, limit]).reverse();
}

function getReactionsForMessages(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = queryAll(`
    SELECT r.message_id, r.emoji, COUNT(*) as count, GROUP_CONCAT(u.username) as users
    FROM reactions r
    INNER JOIN users u ON r.user_id = u.id
    WHERE r.message_id IN (${placeholders})
    GROUP BY r.message_id, r.emoji
  `, messageIds);
  const reactions = {};
  for (const row of rows) {
    if (!reactions[row.message_id]) reactions[row.message_id] = [];
    reactions[row.message_id].push({ emoji: row.emoji, count: row.count, users: (row.users || '').split(',') });
  }
  return reactions;
}

function isServerMember(serverId, userId) {
  return queryOne('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
}

function getMemberRole(serverId, userId) {
  const member = queryOne('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, userId]);
  return member ? member.role : null;
}

function isModerator(serverId, userId) {
  const role = getMemberRole(serverId, userId);
  return role === 'owner' || role === 'admin' || role === 'moderator';
}

function extractMentions(content) {
  const mentionRegex = /@(\w+)/g;
  const mentions = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const user = findByUsername(match[1]);
    if (user) mentions.push({ id: user.id, username: user.username });
  }
  return mentions;
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  try {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    req.user = { id: user.id, username: user.username, email: user.email, avatarSeed: user.avatar_seed };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ─── REST API ────────────────────────────────────────────────────────────────

app.post('/api/register', (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    if (username.length < 3 || username.length > 20)
      return res.status(400).json({ error: 'Nome de usuário deve ter entre 3 e 20 caracteres' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
      return res.status(400).json({ error: 'Email inválido' });
    if (findByEmail(email))
      return res.status(400).json({ error: 'Email já cadastrado' });
    if (findByUsername(username))
      return res.status(400).json({ error: 'Nome de usuário já existe' });

    const salt = bcrypt.genSaltSync(12);
    const passwordHash = bcrypt.hashSync(password, salt);
    const avatarSeed = generateAvatarSeed();
    const userId = insertUser(sanitizeHtml(username), email, passwordHash, avatarSeed);

    const defaultServer = queryOne('SELECT id FROM servers LIMIT 1');
    if (defaultServer && !isServerMember(defaultServer.id, userId)) {
      run('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)', [defaultServer.id, userId]);
    }

    const accessToken = generateAccessToken(userId);
    const refreshToken = generateRefreshToken(userId);
    res.cookie('token', accessToken, { httpOnly: true, maxAge: 60 * 60 * 1000, sameSite: 'lax' });
    res.cookie('refreshToken', refreshToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ success: true, user: { id: userId, username, email, avatarSeed }, token: accessToken });
  } catch (error) {
    console.error('Erro no registro:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    const user = findByEmail(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Email ou senha inválidos' });

    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);
    res.cookie('token', accessToken, { httpOnly: true, maxAge: 60 * 60 * 1000, sameSite: 'lax' });
    res.cookie('refreshToken', refreshToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({
      success: true,
      user: { id: user.id, username: user.username, email: user.email, avatarSeed: user.avatar_seed },
      token: accessToken
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/refresh', (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token necessário' });
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const stored = queryOne('SELECT * FROM refresh_tokens WHERE token = ? AND user_id = ?', [refreshToken, decoded.userId]);
    if (!stored) return res.status(401).json({ error: 'Refresh token inválido' });

    removeRefreshToken(refreshToken);
    const newAccessToken = generateAccessToken(decoded.userId);
    const newRefreshToken = generateRefreshToken(decoded.userId);
    res.cookie('token', newAccessToken, { httpOnly: true, maxAge: 60 * 60 * 1000, sameSite: 'lax' });
    res.cookie('refreshToken', newRefreshToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ success: true, token: newAccessToken });
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

app.post('/api/logout', (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) removeRefreshToken(refreshToken);
  res.clearCookie('token');
  res.clearCookie('refreshToken');
  res.json({ success: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/servers', authMiddleware, (req, res) => {
  try {
    const servers = getUserServers(req.user.id);
    const serversWithChannels = servers.map(s => ({
      id: s.id, name: s.name, iconUrl: s.icon_url, role: s.role,
      inviteCode: s.invite_code, ownerId: s.owner_id,
      channels: getServerChannels(s.id)
    }));
    res.json({ servers: serversWithChannels });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/servers', authMiddleware, (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.length < 2 || name.length > 50)
      return res.status(400).json({ error: 'Nome do servidor deve ter entre 2 e 50 caracteres' });

    let inviteCode = generateInviteCode();
    while (queryOne('SELECT id FROM servers WHERE invite_code = ?', [inviteCode]))
      inviteCode = generateInviteCode();

    const db = getDb();
    db.run('INSERT INTO servers (name, invite_code, owner_id) VALUES (?, ?, ?)', [sanitizeHtml(name), inviteCode, req.user.id]);
    const result = db.exec('SELECT last_insert_rowid() as id');
    const serverId = result[0].values[0][0];
    db.run('INSERT INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)', [serverId, req.user.id, 'owner']);
    db.run('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, 0)', [serverId, 'geral', 'text']);
    db.run('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, 1)', [serverId, 'ajuda', 'text']);
    db.run('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, 2)', [serverId, 'Voz Geral', 'voice']);
    saveDatabase();

    const newServer = queryOne('SELECT * FROM servers WHERE id = ?', [serverId]);
    const channels = getServerChannels(serverId);
    res.json({ success: true, server: { id: newServer.id, name: newServer.name, inviteCode: newServer.invite_code, channels } });
  } catch (error) {
    console.error('Erro ao criar servidor:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/servers/join', authMiddleware, (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: 'Código de convite é obrigatório' });
    const srv = queryOne('SELECT * FROM servers WHERE invite_code = ?', [inviteCode]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado. Verifique o código.' });
    if (isServerMember(srv.id, req.user.id))
      return res.status(400).json({ error: 'Você já faz parte deste servidor' });

    const banned = queryOne('SELECT * FROM moderation WHERE server_id = ? AND user_id = ? AND action = ?', [srv.id, req.user.id, 'ban']);
    if (banned) return res.status(403).json({ error: 'Você foi banido deste servidor' });

    run('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)', [srv.id, req.user.id]);
    const channels = getServerChannels(srv.id);
    res.json({ success: true, server: { id: srv.id, name: srv.name, inviteCode: srv.invite_code, channels } });
  } catch (error) {
    console.error('Erro ao entrar no servidor:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/servers/:serverId/channels', authMiddleware, (req, res) => {
  try {
    const { serverId } = req.params;
    const { name, type } = req.body;
    if (!name || name.length < 2 || name.length > 30)
      return res.status(400).json({ error: 'Nome do canal deve ter entre 2 e 30 caracteres' });
    const srv = queryOne('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (!isModerator(parseInt(serverId), req.user.id))
      return res.status(403).json({ error: 'Sem permissão para criar canais' });

    const channelType = (type === 'voice') ? 'voice' : 'text';
    const maxPos = queryOne('SELECT MAX(position) as pos FROM channels WHERE server_id = ?', [serverId]);
    const pos = (maxPos?.pos || 0) + 1;
    run('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, ?)', [serverId, sanitizeHtml(name), channelType, pos]);
    const channels = getServerChannels(parseInt(serverId));
    res.json({ success: true, channels });
  } catch (error) {
    console.error('Erro ao criar canal:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/servers/:serverId/invite', authMiddleware, (req, res) => {
  try {
    const srv = queryOne('SELECT * FROM servers WHERE id = ?', [req.params.serverId]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado' });
    res.json({ inviteCode: srv.invite_code });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/channels/:channelId/messages', authMiddleware, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before ? parseInt(req.query.before) : null;
    const messages = getChannelMessages(channelId, limit, before);
    const messageIds = messages.map(m => m.id);
    const reactions = getReactionsForMessages(messageIds);
    const messagesWithReactions = messages.map(m => ({ ...m, reactions: reactions[m.id] || [] }));
    res.json({ messages: messagesWithReactions, hasMore: messages.length === limit });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/channels/:channelId/search', authMiddleware, (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const q = req.query.q;
    if (!q || q.length < 2) return res.json({ messages: [] });
    const messages = queryAll(`
      SELECT m.*, u.username, u.avatar_seed
      FROM messages m
      INNER JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ? AND m.content LIKE ?
      ORDER BY m.created_at DESC
      LIMIT 50
    `, [channelId, `%${q}%`]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/channels/:channelId/messages/:messageId/reactions', authMiddleware, (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji obrigatório' });
    const existing = queryOne('SELECT * FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, req.user.id, emoji]);
    if (existing) {
      run('DELETE FROM reactions WHERE id = ?', [existing.id]);
      res.json({ success: true, action: 'removed' });
    } else {
      run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [messageId, req.user.id, emoji]);
      res.json({ success: true, action: 'added' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.put('/api/messages/:messageId', authMiddleware, (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const msg = queryOne('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Sem permissão' });
    const { content } = req.body;
    if (!content || content.trim().length === 0) return res.status(400).json({ error: 'Conteúdo obrigatório' });
    run('UPDATE messages SET content = ?, edited = 1, edited_at = datetime("now") WHERE id = ?', [sanitizeHtml(content), messageId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.delete('/api/messages/:messageId', authMiddleware, (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const msg = queryOne('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.user_id !== req.user.id && !isModerator(msg.channel_id, req.user.id)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    run('DELETE FROM messages WHERE id = ?', [messageId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const url = `/uploads/${req.file.filename}`;
    const db = getDb();
    db.run('INSERT INTO file_uploads (user_id, filename, original_name, mime_type, size, url) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, url]);
    const result = db.exec('SELECT last_insert_rowid() as id');
    const fileId = result[0].values[0][0];
    saveDatabase();
    res.json({ success: true, file: { id: fileId, url, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size } });
  } catch (error) {
    res.status(500).json({ error: 'Erro no upload' });
  }
});

// ─── Avatar Upload ────────────────────────────────────────────────────────────
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `avatar_${req.user.id}_${Date.now()}${ext}`);
  }
});
const avatarUpload = multer({
  storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|jpg|png|gif|webp)$/.test(file.mimetype));
  }
});

app.post('/api/avatar', authMiddleware, avatarUpload.single('avatar'), (req, res) => {
  try {
    console.log('[AVATAR] Upload recebido:', req.file ? req.file.filename : 'NENHUM ARQUIVO');
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada. Formato aceito: JPEG, PNG, GIF, WebP' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    const db = getDb();
    db.run('UPDATE users SET avatar_seed = ? WHERE id = ?', [avatarUrl, req.user.id]);
    saveDatabase();
    console.log('[AVATAR] Atualizado usuario', req.user.id, 'para', avatarUrl);

    const sockets = userSockets.get(req.user.id);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.user) s.user.avatarSeed = avatarUrl;
      }
    }

    res.json({ success: true, avatarUrl });
  } catch (error) {
    console.error('[AVATAR] Erro:', error);
    res.status(500).json({ error: 'Erro ao atualizar avatar' });
  }
});

app.delete('/api/avatar', authMiddleware, (req, res) => {
  try {
    const db = getDb();
    const user = queryOne('SELECT avatar_seed FROM users WHERE id = ?', [req.user.id]);
    if (user && user.avatar_seed && user.avatar_seed.startsWith('/uploads/avatars/')) {
      const filePath = path.join(__dirname, 'public', user.avatar_seed);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    const newSeed = 'avatar_' + Date.now();
    db.run('UPDATE users SET avatar_seed = ? WHERE id = ?', [newSeed, req.user.id]);
    saveDatabase();

    const sockets = userSockets.get(req.user.id);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.user) s.user.avatarSeed = newSeed;
      }
    }

    res.json({ success: true, avatarUrl: null });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao remover avatar' });
  }
});

app.get('/api/servers/:serverId/members', authMiddleware, (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const members = queryAll(`
      SELECT u.id, u.username, u.avatar_seed, u.status, sm.role, sm.nickname
      FROM server_members sm
      INNER JOIN users u ON sm.user_id = u.id
      WHERE sm.server_id = ?
    `, [serverId]);
    res.json({ members });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/servers/:serverId/moderate', authMiddleware, (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const { targetUserId, action, reason, duration } = req.body;
    if (!isModerator(serverId, req.user.id))
      return res.status(403).json({ error: 'Sem permissão de moderação' });
    if (action === 'ban' || action === 'kick') {
      const targetRole = getMemberRole(serverId, targetUserId);
      if (targetRole === 'owner') return res.status(403).json({ error: 'Não pode moderar o dono do servidor' });
    }
    if (action === 'ban') {
      run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, targetUserId]);
    } else if (action === 'kick') {
      run('DELETE FROM server_members WHERE server_id = ? AND user_id = ?', [serverId, targetUserId]);
    }
    run('INSERT INTO moderation (server_id, user_id, moderator_id, action, reason, duration) VALUES (?, ?, ?, ?, ?, ?)',
      [serverId, targetUserId, req.user.id, action, reason || '', duration || null]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.put('/api/servers/:serverId/members/:userId/role', authMiddleware, (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const userId = parseInt(req.params.userId);
    const { role } = req.body;
    if (getMemberRole(serverId, req.user.id) !== 'owner')
      return res.status(403).json({ error: 'Apenas o dono pode alterar roles' });
    if (!['admin', 'moderator', 'member'].includes(role))
      return res.status(400).json({ error: 'Role inválida' });
    run('UPDATE server_members SET role = ? WHERE server_id = ? AND user_id = ?', [role, serverId, userId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.put('/api/users/status', authMiddleware, (req, res) => {
  try {
    const { status, customStatus } = req.body;
    if (status && ['online', 'idle', 'dnd', 'offline'].includes(status)) {
      run('UPDATE users SET status = ?, updated_at = datetime("now") WHERE id = ?', [status, req.user.id]);
    }
    if (customStatus !== undefined) {
      run('UPDATE users SET custom_status = ?, updated_at = datetime("now") WHERE id = ?', [sanitizeHtml(customStatus), req.user.id]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.put('/api/users/password', authMiddleware, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senhas obrigatórias' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
    const user = findById(req.user.id);
    if (!bcrypt.compareSync(currentPassword, user.password_hash))
      return res.status(401).json({ error: 'Senha atual incorreta' });
    const salt = bcrypt.genSaltSync(12);
    run('UPDATE users SET password_hash = ?, updated_at = datetime("now") WHERE id = ?', [bcrypt.hashSync(newPassword, salt), req.user.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

const connectedUsers = new Map();
const voiceUsers = new Map();
const userSockets = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Autenticação necessária'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = findById(decoded.userId);
    if (!user) return next(new Error('Usuário não encontrado'));
    socket.user = { id: user.id, username: user.username, avatarSeed: user.avatar_seed };
    next();
  } catch (err) {
    next(new Error('Token inválido'));
  }
});

io.on('connection', (socket) => {
  console.log(`${socket.user.username} conectou (id: ${socket.id})`);

  connectedUsers.set(socket.id, {
    id: socket.user.id,
    username: socket.user.username,
    avatarSeed: socket.user.avatarSeed,
    currentRoom: null
  });

  if (!userSockets.has(socket.user.id)) userSockets.set(socket.user.id, new Set());
  userSockets.get(socket.user.id).add(socket.id);

  run('UPDATE users SET status = "online", updated_at = datetime("now") WHERE id = ?', [socket.user.id]);
  io.emit('user-presence', { userId: socket.user.id, status: 'online' });

  socket.emit('userInfo', {
    id: socket.user.id,
    username: socket.user.username,
    avatarSeed: socket.user.avatarSeed
  });

  const userServers = getUserServers(socket.user.id);
  for (const srv of userServers) {
    socket.join(`server:${srv.id}`);
  }

  // ─── Chat ──────────────────────────────────────────────────────────────────

  socket.on('joinRoom', (roomName) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    if (user.currentRoom) socket.leave(user.currentRoom);
    user.currentRoom = roomName;
    connectedUsers.set(socket.id, user);
    socket.join(roomName);
    const channelMatch = roomName.match(/^channel:(\d+)$/);
    if (channelMatch) {
      const messages = getChannelMessages(parseInt(channelMatch[1]), 50);
      const messageIds = messages.map(m => m.id);
      const reactions = getReactionsForMessages(messageIds);
      const enriched = messages.map(m => ({ ...m, reactions: reactions[m.id] || [] }));
      socket.emit('channelHistory', enriched);
    }
  });

  socket.on('leaveRoom', (roomName) => {
    socket.leave(roomName);
    const user = connectedUsers.get(socket.id);
    if (user && user.currentRoom === roomName) {
      user.currentRoom = null;
      connectedUsers.set(socket.id, user);
    }
  });

  socket.on('chatMessage', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;
    const channelMatch = user.currentRoom.match(/^channel:(\d+)$/);
    if (!channelMatch) return;
    const channelId = parseInt(channelMatch[1]);

    const content = sanitizeHtml(data.text?.trim());
    if (!content || content.length === 0 || content.length > 2000) return;

    let replyTo = null;
    if (data.replyTo) {
      const replyMsg = queryOne('SELECT id FROM messages WHERE id = ? AND channel_id = ?', [data.replyTo, channelId]);
      if (replyMsg) replyTo = data.replyTo;
    }

    const db = getDb();
    if (replyTo) {
      db.run('INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, ?, ?, ?)', [channelId, user.id, content, replyTo]);
    } else {
      db.run('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)', [channelId, user.id, content]);
    }
    const result = db.exec('SELECT last_insert_rowid() as id');
    const messageId = result[0].values[0][0];
    saveDatabase();

    const msg = {
      id: messageId, channel_id: channelId, user_id: user.id,
      username: user.username, avatar_seed: user.avatarSeed,
      content, created_at: new Date().toISOString(), reactions: []
    };

    io.to(user.currentRoom).emit('chatMessage', msg);

    const mentions = extractMentions(data.text);
    for (const mention of mentions) {
      const targetSockets = userSockets.get(mention.id);
      if (targetSockets) {
        for (const targetSocketId of targetSockets) {
          io.to(targetSocketId).emit('mention', {
            from: user.username, channel: channelId, serverId: channelId, message: content
          });
        }
      }
    }
  });

  socket.on('typing', () => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;
    socket.to(user.currentRoom).emit('userTyping', { username: user.username });
  });

  socket.on('stopTyping', () => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;
    socket.to(user.currentRoom).emit('userStopTyping', { username: user.username });
  });

  socket.on('reaction', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const { messageId, emoji } = data;
    if (!messageId || !emoji) return;
    const existing = queryOne('SELECT * FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [messageId, user.id, emoji]);
    if (existing) {
      run('DELETE FROM reactions WHERE id = ?', [existing.id]);
    } else {
      run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [messageId, user.id, emoji]);
    }
    const reactions = getReactionsForMessages([messageId]);
    io.to(user.currentRoom).emit('reactions-update', { messageId, reactions: reactions[messageId] || [] });
  });

  // ─── Presence ──────────────────────────────────────────────────────────────

  socket.on('set-status', (data) => {
    const { status, customStatus } = data;
    if (status && ['online', 'idle', 'dnd', 'offline'].includes(status)) {
      run('UPDATE users SET status = ?, updated_at = datetime("now") WHERE id = ?', [status, socket.user.id]);
      io.emit('user-presence', { userId: socket.user.id, status });
    }
    if (customStatus !== undefined) {
      run('UPDATE users SET custom_status = ?, updated_at = datetime("now") WHERE id = ?', [sanitizeHtml(customStatus), socket.user.id]);
    }
  });

  // ─── Voice (Full Mesh WebRTC) ──────────────────────────────────────────────

  socket.on('join-voice', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const { channelId, serverId } = data;
    const roomName = `voice:${channelId}`;

    if (voiceUsers.has(socket.id)) {
      const oldData = voiceUsers.get(socket.id);
      socket.to(oldData.roomName).emit('voice-user-left', { socketId: socket.id });
      socket.leave(oldData.roomName);
      voiceUsers.delete(socket.id);
      broadcastVoiceUsers(oldData.channelId);
    }

    socket.join(roomName);
    const existingUsers = [];
    const room = io.sockets.adapter.rooms.get(roomName);
    if (room) {
      for (const sid of room) {
        if (sid !== socket.id && voiceUsers.has(sid)) {
          const u = connectedUsers.get(sid);
          if (u) existingUsers.push({ socketId: sid, userId: u.id, username: u.username, avatarSeed: u.avatarSeed });
        }
      }
    }

    voiceUsers.set(socket.id, {
      userId: user.id, username: user.username,
      avatarSeed: user.avatarSeed, channelId, serverId,
      roomName, isMuted: false
    });

    socket.to(roomName).emit('voice-user-joined', {
      socketId: socket.id, userId: user.id, username: user.username, avatarSeed: user.avatarSeed
    });
    socket.emit('voice-connected', { channelId, existingUsers });
    broadcastVoiceUsers(channelId);
  });

  socket.on('leave-voice', () => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    socket.to(vd.roomName).emit('voice-user-left', { socketId: socket.id });
    socket.leave(vd.roomName);
    voiceUsers.delete(socket.id);
    socket.emit('voice-disconnected');
    broadcastVoiceUsers(vd.channelId);
  });

  socket.on('voice-offer', (data) => {
    io.to(data.targetSocketId).emit('voice-offer', {
      offer: data.offer, fromSocketId: socket.id,
      fromUser: connectedUsers.get(socket.id)
    });
  });

  socket.on('voice-answer', (data) => {
    io.to(data.targetSocketId).emit('voice-answer', { answer: data.answer, fromSocketId: socket.id });
  });

  socket.on('ice-candidate', (data) => {
    io.to(data.targetSocketId).emit('ice-candidate', { candidate: data.candidate, fromSocketId: socket.id });
  });

  socket.on('voice-mute', (data) => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    vd.isMuted = data.isMuted;
    voiceUsers.set(socket.id, vd);
    socket.to(vd.roomName).emit('voice-user-muted', { socketId: socket.id, isMuted: data.isMuted });
    broadcastVoiceUsers(vd.channelId);
  });

  socket.on('screen-share-started', () => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    socket.to(vd.roomName).emit('screen-share-started', { socketId: socket.id, username: vd.username });
  });

  socket.on('screen-share-stopped', () => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    socket.to(vd.roomName).emit('screen-share-stopped', { socketId: socket.id });
  });

  socket.on('camera-started', () => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    socket.to(vd.roomName).emit('camera-started', { socketId: socket.id });
  });

  socket.on('camera-stopped', () => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    socket.to(vd.roomName).emit('camera-stopped', { socketId: socket.id });
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    const vd = voiceUsers.get(socket.id);

    if (vd) {
      socket.to(vd.roomName).emit('voice-user-left', { socketId: socket.id });
      voiceUsers.delete(socket.id);
      broadcastVoiceUsers(vd.channelId);
    }

    if (user) {
      const sockets = userSockets.get(user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(user.id);
          run('UPDATE users SET status = "offline", updated_at = datetime("now") WHERE id = ?', [user.id]);
          io.emit('user-presence', { userId: user.id, status: 'offline' });
        }
      }
      if (user.currentRoom) socket.to(user.currentRoom).emit('userLeft', { username: user.username });
      connectedUsers.delete(socket.id);
      console.log(`${user.username} desconectou`);
    }
  });

  // ─── Helper ────────────────────────────────────────────────────────────────

  function broadcastVoiceUsers(channelId) {
    const roomName = `voice:${channelId}`;
    const users = [];
    const room = io.sockets.adapter.rooms.get(roomName);
    if (room) {
      for (const sid of room) {
        const vd = voiceUsers.get(sid);
        if (vd && vd.channelId === channelId) {
          users.push({
            socketId: sid, userId: vd.userId, username: vd.username,
            avatarSeed: vd.avatarSeed, isMuted: vd.isMuted
          });
        }
      }
    }
    io.to(roomName).emit('voice-users-list', { channelId, users });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  await initDatabase();

  const existingServers = queryOne('SELECT id FROM servers LIMIT 1');
  if (!existingServers) {
    console.log('Nenhum servidor encontrado. Criando servidor padrão...');
    const db = getDb();
    const inviteCode = generateInviteCode();
    db.run('INSERT INTO servers (name, invite_code, owner_id) VALUES (?, ?, ?)',
      ['Comunidade Geral', inviteCode, 1]);
    const result = db.exec('SELECT last_insert_rowid() as id');
    const serverId = result[0].values[0][0];
    db.run('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, 0)', [serverId, 'geral', 'text']);
    db.run('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, 1)', [serverId, 'ajuda', 'text']);
    db.run('INSERT INTO channels (server_id, name, type, position) VALUES (?, ?, ?, 2)', [serverId, 'Voz Geral', 'voice']);
    saveDatabase();
    console.log(`Servidor padrão criado (ID: ${serverId})`);
  }

  // Cleanup expired refresh tokens periodically
  setInterval(() => {
    run("DELETE FROM refresh_tokens WHERE expires_at < datetime('now')");
  }, 60 * 60 * 1000);

  // Error handler for multer
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      console.error('[MULTER ERROR]', err.code, err.message);
      return res.status(400).json({ error: 'Erro no upload: ' + err.message });
    }
    if (err) {
      console.error('[MIDDLEWARE ERROR]', err.message);
      return res.status(500).json({ error: err.message });
    }
    next();
  });

  server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

start();
