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
const { initDatabase, query, queryOne, run, runReturningId } = require('./database');

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
app.use('/api/forgot-password', authLimiter);
app.use('/api/reset-password', authLimiter);

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

async function findByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = $1', [email]);
}

async function findByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = $1', [username]);
}

async function findById(id) {
  return queryOne('SELECT * FROM users WHERE id = $1', [id]);
}

async function insertUser(username, email, passwordHash, avatarSeed) {
  const result = await runReturningId('INSERT INTO users (username, email, password_hash, avatar_seed) VALUES ($1, $2, $3, $4) RETURNING id', [username, email, passwordHash, avatarSeed]);
  return result.id;
}

function generateAccessToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

async function generateRefreshToken(userId) {
  const token = jwt.sign({ userId, jti: uuidv4() }, JWT_REFRESH_SECRET, { expiresIn: '30d' });
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await run('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)', [userId, token, expiresAt]);
  return token;
}

async function removeRefreshToken(token) {
  await run('DELETE FROM refresh_tokens WHERE token = $1', [token]);
}

function generateAvatarSeed() {
  return Math.random().toString(36).substring(2, 10);
}

function sanitizeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function getUserServers(userId) {
  return query(`
    SELECT s.*, sm.joined_at, sm.role
    FROM servers s
    INNER JOIN server_members sm ON s.id = sm.server_id
    WHERE sm.user_id = $1
    ORDER BY sm.joined_at ASC
  `, [userId]);
}

async function getServerChannels(serverId) {
  return query('SELECT * FROM channels WHERE server_id = $1 ORDER BY position ASC, created_at ASC', [serverId]);
}

async function getChannelMessages(channelId, limit = 50, before = null) {
  if (before) {
    return (await query(`
      SELECT m.*, u.username, u.avatar_seed
      FROM messages m
      INNER JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = $1 AND m.id < $2
      ORDER BY m.created_at DESC
      LIMIT $3
    `, [channelId, before, limit])).reverse();
  }
  return (await query(`
    SELECT m.*, u.username, u.avatar_seed
    FROM messages m
    INNER JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = $1
    ORDER BY m.created_at DESC
    LIMIT $2
  `, [channelId, limit])).reverse();
}

async function getReactionsForMessages(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(',');
  const rows = await query(`
    SELECT r.message_id, r.emoji, COUNT(*) as count, STRING_AGG(u.username, ',') as users
    FROM reactions r
    INNER JOIN users u ON r.user_id = u.id
    WHERE r.message_id IN (${placeholders})
    GROUP BY r.message_id, r.emoji
  `, messageIds);
  const reactions = {};
  for (const row of rows) {
    if (!reactions[row.message_id]) reactions[row.message_id] = [];
    reactions[row.message_id].push({ emoji: row.emoji, count: parseInt(row.count), users: (row.users || '').split(',') });
  }
  return reactions;
}

async function isServerMember(serverId, userId) {
  return queryOne('SELECT * FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
}

async function getMemberRole(serverId, userId) {
  const member = await queryOne('SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
  return member ? member.role : null;
}

async function isModerator(serverId, userId) {
  const role = await getMemberRole(serverId, userId);
  return role === 'owner' || role === 'admin' || role === 'moderator';
}

async function extractMentions(content) {
  const mentionRegex = /@(\w+)/g;
  const mentions = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const user = await findByUsername(match[1]);
    if (user) mentions.push({ id: user.id, username: user.username });
  }
  return mentions;
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────
async function authMiddleware(req, res, next) {
  try {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    req.user = { id: user.id, username: user.username, email: user.email, avatarSeed: user.avatar_seed, status: user.status, customStatus: user.custom_status, bio: user.bio, profileColor: user.profile_color, created_at: user.created_at };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ─── REST API ────────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
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
    if (await findByEmail(email))
      return res.status(400).json({ error: 'Email já cadastrado' });
    if (await findByUsername(username))
      return res.status(400).json({ error: 'Nome de usuário já existe' });

    const salt = bcrypt.genSaltSync(12);
    const passwordHash = bcrypt.hashSync(password, salt);
    const avatarSeed = generateAvatarSeed();
    const userId = await insertUser(sanitizeHtml(username), email, passwordHash, avatarSeed);

    const defaultServer = await queryOne('SELECT id FROM servers LIMIT 1');
    if (defaultServer && !(await isServerMember(defaultServer.id, userId))) {
      await run('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [defaultServer.id, userId]);
    }

    const accessToken = generateAccessToken(userId);
    const refreshToken = await generateRefreshToken(userId);
    res.cookie('token', accessToken, { httpOnly: true, maxAge: 60 * 60 * 1000, sameSite: 'lax' });
    res.cookie('refreshToken', refreshToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ success: true, user: { id: userId, username, email, avatarSeed }, token: accessToken });
  } catch (error) {
    console.error('Erro no registro:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    console.log('[LOGIN] Tentativa para email:', email);
    const user = await findByEmail(email);
    if (!user) {
      console.log('[LOGIN] Usuário não encontrado para email:', email);
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }
    console.log('[LOGIN] Usuário encontrado (id:', user.id, 'username:', user.username, ')');
    const passwordMatch = bcrypt.compareSync(password, user.password_hash);
    console.log('[LOGIN] Senha confere:', passwordMatch);
    if (!passwordMatch)
      return res.status(401).json({ error: 'Email ou senha inválidos' });

    const accessToken = generateAccessToken(user.id);
    const refreshToken = await generateRefreshToken(user.id);
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

// ─── Password Recovery ────────────────────────────────────────────────────────
const crypto = require('crypto');

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email é obrigatório' });

    const user = await findByEmail(email);
    if (!user) {
      return res.json({ success: true, message: 'Se o email estiver cadastrado, um código de recuperação foi gerado.' });
    }

    await run('DELETE FROM password_resets WHERE user_id = $1', [user.id]);

    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await run('INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)', [user.id, token, expiresAt]);

    console.log(`[PASSWORD RESET] User: ${user.username} | Token: ${token} | Expires: ${expiresAt}`);
    console.log(`[PASSWORD RESET] URL: ${req.protocol}://${req.get('host')}/reset-password?token=${token}`);

    res.json({ success: true, message: 'Se o email estiver cadastrado, um código de recuperação foi gerado.', resetToken: token });
  } catch (error) {
    console.error('Erro no forgot-password:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token e nova senha são obrigatórios' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });

    const resetRecord = await queryOne('SELECT * FROM password_resets WHERE token = $1 AND used = 0', [token]);
    if (!resetRecord) return res.status(400).json({ error: 'Token inválido ou já utilizado' });

    if (new Date(resetRecord.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token expirado. Solicite uma nova recuperação.' });
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await run('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, resetRecord.user_id]);
    await run('UPDATE password_resets SET used = 1 WHERE id = $1', [resetRecord.id]);
    await run('DELETE FROM refresh_tokens WHERE user_id = $1', [resetRecord.user_id]);

    console.log(`[PASSWORD RESET] Senha alterada com sucesso para user_id: ${resetRecord.user_id}`);

    res.json({ success: true, message: 'Senha alterada com sucesso. Faça login com a nova senha.' });
  } catch (error) {
    console.error('Erro no reset-password:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token necessário' });
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const stored = await queryOne('SELECT * FROM refresh_tokens WHERE token = $1 AND user_id = $2', [refreshToken, decoded.userId]);
    if (!stored) return res.status(401).json({ error: 'Refresh token inválido' });

    await removeRefreshToken(refreshToken);
    const newAccessToken = generateAccessToken(decoded.userId);
    const newRefreshToken = await generateRefreshToken(decoded.userId);
    res.cookie('token', newAccessToken, { httpOnly: true, maxAge: 60 * 60 * 1000, sameSite: 'lax' });
    res.cookie('refreshToken', newRefreshToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
    res.json({ success: true, token: newAccessToken });
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

app.post('/api/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) await removeRefreshToken(refreshToken);
  res.clearCookie('token');
  res.clearCookie('refreshToken');
  res.json({ success: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/servers', authMiddleware, async (req, res) => {
  try {
    const servers = await getUserServers(req.user.id);
    const serversWithChannels = [];
    for (const s of servers) {
      const channels = await getServerChannels(s.id);
      serversWithChannels.push({
        id: s.id, name: s.name, iconUrl: s.icon_url, role: s.role,
        inviteCode: s.invite_code, ownerId: s.owner_id,
        channels
      });
    }
    res.json({ servers: serversWithChannels });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/servers', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.length < 2 || name.length > 50)
      return res.status(400).json({ error: 'Nome do servidor deve ter entre 2 e 50 caracteres' });

    let inviteCode = generateInviteCode();
    while (await queryOne('SELECT id FROM servers WHERE invite_code = $1', [inviteCode]))
      inviteCode = generateInviteCode();

    const serverResult = await runReturningId('INSERT INTO servers (name, invite_code, owner_id) VALUES ($1, $2, $3) RETURNING id', [sanitizeHtml(name), inviteCode, req.user.id]);
    const serverId = serverResult.id;
    await run('INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, $3)', [serverId, req.user.id, 'owner']);
    await run('INSERT INTO channels (server_id, name, type, position) VALUES ($1, $2, $3, $4)', [serverId, 'geral', 'text', 0]);
    await run('INSERT INTO channels (server_id, name, type, position) VALUES ($1, $2, $3, $4)', [serverId, 'ajuda', 'text', 1]);
    await run('INSERT INTO channels (server_id, name, type, position) VALUES ($1, $2, $3, $4)', [serverId, 'Voz Geral', 'voice', 2]);

    const newServer = await queryOne('SELECT * FROM servers WHERE id = $1', [serverId]);
    const channels = await getServerChannels(serverId);
    res.json({ success: true, server: { id: newServer.id, name: newServer.name, inviteCode: newServer.invite_code, channels } });
  } catch (error) {
    console.error('Erro ao criar servidor:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/servers/join', authMiddleware, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ error: 'Código de convite é obrigatório' });
    const srv = await queryOne('SELECT * FROM servers WHERE invite_code = $1', [inviteCode]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado. Verifique o código.' });
    if (await isServerMember(srv.id, req.user.id))
      return res.status(400).json({ error: 'Você já faz parte deste servidor' });

    const banned = await queryOne('SELECT * FROM moderation WHERE server_id = $1 AND user_id = $2 AND action = $3', [srv.id, req.user.id, 'ban']);
    if (banned) return res.status(403).json({ error: 'Você foi banido deste servidor' });

    await run('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [srv.id, req.user.id]);
    const channels = await getServerChannels(srv.id);
    res.json({ success: true, server: { id: srv.id, name: srv.name, inviteCode: srv.invite_code, channels } });
  } catch (error) {
    console.error('Erro ao entrar no servidor:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/servers/:serverId/channels', authMiddleware, async (req, res) => {
  try {
    const { serverId } = req.params;
    const { name, type } = req.body;
    if (!name || name.length < 2 || name.length > 30)
      return res.status(400).json({ error: 'Nome do canal deve ter entre 2 e 30 caracteres' });
    const srv = await queryOne('SELECT * FROM servers WHERE id = $1', [serverId]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (!(await isModerator(parseInt(serverId), req.user.id)))
      return res.status(403).json({ error: 'Sem permissão para criar canais' });

    const channelType = (type === 'voice') ? 'voice' : 'text';
    const maxPos = await queryOne('SELECT MAX(position) as pos FROM channels WHERE server_id = $1', [serverId]);
    const pos = (maxPos?.pos || 0) + 1;
    await run('INSERT INTO channels (server_id, name, type, position) VALUES ($1, $2, $3, $4)', [serverId, sanitizeHtml(name), channelType, pos]);
    const channels = await getServerChannels(parseInt(serverId));
    res.json({ success: true, channels });
  } catch (error) {
    console.error('Erro ao criar canal:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/servers/:serverId/invite', authMiddleware, async (req, res) => {
  try {
    const srv = await queryOne('SELECT * FROM servers WHERE id = $1', [req.params.serverId]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado' });
    res.json({ inviteCode: srv.invite_code });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/channels/:channelId/messages', authMiddleware, async (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const before = req.query.before ? parseInt(req.query.before) : null;
    const messages = await getChannelMessages(channelId, limit, before);
    const messageIds = messages.map(m => m.id);
    const reactions = await getReactionsForMessages(messageIds);
    const messagesWithReactions = messages.map(m => ({ ...m, reactions: reactions[m.id] || [] }));
    res.json({ messages: messagesWithReactions, hasMore: messages.length === limit });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/channels/:channelId/search', authMiddleware, async (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const q = req.query.q;
    if (!q || q.length < 2) return res.json({ messages: [] });
    const messages = await query(`
      SELECT m.*, u.username, u.avatar_seed
      FROM messages m
      INNER JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = $1 AND m.content LIKE $2
      ORDER BY m.created_at DESC
      LIMIT 50
    `, [channelId, `%${q}%`]);
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/channels/:channelId/messages/:messageId/reactions', authMiddleware, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Emoji obrigatório' });
    const existing = await queryOne('SELECT * FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [messageId, req.user.id, emoji]);
    if (existing) {
      await run('DELETE FROM reactions WHERE id = $1', [existing.id]);
      res.json({ success: true, action: 'removed' });
    } else {
      await run('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [messageId, req.user.id, emoji]);
      res.json({ success: true, action: 'added' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.put('/api/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const msg = await queryOne('SELECT * FROM messages WHERE id = $1', [messageId]);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Sem permissão' });
    const { content } = req.body;
    if (!content || content.trim().length === 0) return res.status(400).json({ error: 'Conteúdo obrigatório' });
    await run('UPDATE messages SET content = $1, edited = 1, edited_at = NOW() WHERE id = $2', [sanitizeHtml(content), messageId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const msg = await queryOne('SELECT * FROM messages WHERE id = $1', [messageId]);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.user_id !== req.user.id && !(await isModerator(msg.channel_id, req.user.id))) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    await run('DELETE FROM messages WHERE id = $1', [messageId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const url = `/uploads/${req.file.filename}`;
    const result = await runReturningId('INSERT INTO file_uploads (user_id, filename, original_name, mime_type, size, url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [req.user.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, url]);
    res.json({ success: true, file: { id: result.id, url, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size } });
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

app.post('/api/avatar', authMiddleware, avatarUpload.single('avatar'), async (req, res) => {
  try {
    console.log('[AVATAR] Upload recebido:', req.file ? req.file.filename : 'NENHUM ARQUIVO');
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada. Formato aceito: JPEG, PNG, GIF, WebP' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    await run('UPDATE users SET avatar_seed = $1 WHERE id = $2', [avatarUrl, req.user.id]);

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

app.delete('/api/avatar', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne('SELECT avatar_seed FROM users WHERE id = $1', [req.user.id]);
    if (user && user.avatar_seed && user.avatar_seed.startsWith('/uploads/avatars/')) {
      const filePath = path.join(__dirname, 'public', user.avatar_seed);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    const newSeed = 'avatar_' + Date.now();
    await run('UPDATE users SET avatar_seed = $1 WHERE id = $2', [newSeed, req.user.id]);

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

// ─── User Profile Routes ───────────────────────────────────────────────────

app.post('/api/users/avatar', authMiddleware, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada' });
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    await run('UPDATE users SET avatar_seed = $1 WHERE id = $2', [avatarUrl, req.user.id]);
    const sockets = userSockets.get(req.user.id);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.user) s.user.avatarSeed = avatarUrl;
      }
    }
    res.json({ success: true, avatarUrl });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar avatar' });
  }
});

app.delete('/api/users/avatar', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne('SELECT avatar_seed FROM users WHERE id = $1', [req.user.id]);
    if (user && user.avatar_seed && user.avatar_seed.startsWith('/uploads/avatars/')) {
      const filePath = path.join(__dirname, 'public', user.avatar_seed);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    const newSeed = 'avatar_' + Date.now();
    await run('UPDATE users SET avatar_seed = $1 WHERE id = $2', [newSeed, req.user.id]);
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

app.put('/api/users/username', authMiddleware, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || username.trim().length < 2) {
      return res.status(400).json({ error: 'Nome de usuário deve ter pelo menos 2 caracteres' });
    }
    const existing = await queryOne('SELECT id FROM users WHERE username = $1 AND id != $2', [username.trim(), req.user.id]);
    if (existing) return res.status(400).json({ error: 'Nome de usuário já está em uso' });
    await run('UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2', [username.trim(), req.user.id]);
    const sockets = userSockets.get(req.user.id);
    if (sockets) {
      for (const sid of sockets) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.user) s.user.username = username.trim();
      }
    }
    res.json({ success: true, user: { username: username.trim() } });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar nome de usuário' });
  }
});

app.put('/api/users/profile', authMiddleware, async (req, res) => {
  try {
    const { bio, profileColor } = req.body;
    if (bio !== undefined) {
      await run('UPDATE users SET bio = $1, updated_at = NOW() WHERE id = $2', [sanitizeHtml(bio).substring(0, 500), req.user.id]);
    }
    if (profileColor !== undefined) {
      await run('UPDATE users SET profile_color = $1, updated_at = NOW() WHERE id = $2', [profileColor, req.user.id]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

app.get('/api/servers/:serverId/members', authMiddleware, async (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const members = await query(`
      SELECT u.id, u.username, u.avatar_seed, u.status, u.bio, u.profile_color, sm.role, sm.nickname
      FROM server_members sm
      INNER JOIN users u ON sm.user_id = u.id
      WHERE sm.server_id = $1
    `, [serverId]);
    res.json({ members });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/servers/:serverId/moderate', authMiddleware, async (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const { targetUserId, action, reason, duration } = req.body;
    if (!(await isModerator(serverId, req.user.id)))
      return res.status(403).json({ error: 'Sem permissão de moderação' });
    if (action === 'ban' || action === 'kick') {
      const targetRole = await getMemberRole(serverId, targetUserId);
      if (targetRole === 'owner') return res.status(403).json({ error: 'Não pode moderar o dono do servidor' });
    }
    if (action === 'ban') {
      await run('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, targetUserId]);
    } else if (action === 'kick') {
      await run('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, targetUserId]);
    }
    await run('INSERT INTO moderation (server_id, user_id, moderator_id, action, reason, duration) VALUES ($1, $2, $3, $4, $5, $6)',
      [serverId, targetUserId, req.user.id, action, reason || '', duration || null]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.put('/api/servers/:serverId/members/:userId/role', authMiddleware, async (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const userId = parseInt(req.params.userId);
    const { role } = req.body;
    if ((await getMemberRole(serverId, req.user.id)) !== 'owner')
      return res.status(403).json({ error: 'Apenas o dono pode alterar roles' });
    if (!['admin', 'moderator', 'member'].includes(role))
      return res.status(400).json({ error: 'Role inválida' });
    await run('UPDATE server_members SET role = $1 WHERE server_id = $2 AND user_id = $3', [role, serverId, userId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.put('/api/users/status', authMiddleware, async (req, res) => {
  try {
    const { status, customStatus } = req.body;
    if (status && ['online', 'idle', 'dnd', 'offline'].includes(status)) {
      await run('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [status, req.user.id]);
    }
    if (customStatus !== undefined) {
      await run('UPDATE users SET custom_status = $1, updated_at = NOW() WHERE id = $2', [sanitizeHtml(customStatus), req.user.id]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ─── Message Pins ─────────────────────────────────────────────────────────
app.post('/api/channels/:channelId/messages/:messageId/pin', authMiddleware, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const channelId = parseInt(req.params.channelId);
    const existing = await queryOne('SELECT * FROM message_pins WHERE message_id = $1', [messageId]);
    if (existing) {
      await run('DELETE FROM message_pins WHERE message_id = $1', [messageId]);
      return res.json({ success: true, action: 'unpinned' });
    }
    await run('INSERT INTO message_pins (message_id, pinned_by) VALUES ($1, $2)', [messageId, req.user.id]);
    res.json({ success: true, action: 'pinned' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao fixar mensagem' });
  }
});

app.get('/api/channels/:channelId/pins', authMiddleware, async (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const pins = await query(`
      SELECT m.*, u.username, u.avatar_seed, mp.created_at as pinned_at, p.username as pinned_by_username
      FROM message_pins mp
      INNER JOIN messages m ON mp.message_id = m.id
      INNER JOIN users u ON m.user_id = u.id
      INNER JOIN users p ON mp.pinned_by = p.id
      WHERE m.channel_id = $1
      ORDER BY mp.created_at DESC
    `, [channelId]);
    res.json({ pins });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar pins' });
  }
});

// ─── Server Settings ─────────────────────────────────────────────────────
app.put('/api/servers/:serverId', authMiddleware, async (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const srv = await queryOne('SELECT * FROM servers WHERE id = $1', [serverId]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (srv.owner_id !== req.user.id) return res.status(403).json({ error: 'Apenas o dono pode alterar configurações' });
    const { name, description } = req.body;
    if (name && (name.length < 2 || name.length > 50))
      return res.status(400).json({ error: 'Nome deve ter entre 2 e 50 caracteres' });
    if (name) await run('UPDATE servers SET name = $1 WHERE id = $2', [sanitizeHtml(name), serverId]);
    if (description !== undefined) await run('UPDATE servers SET description = $1 WHERE id = $2', [sanitizeHtml(description), serverId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar servidor' });
  }
});

app.delete('/api/servers/:serverId', authMiddleware, async (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const srv = await queryOne('SELECT * FROM servers WHERE id = $1', [serverId]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (srv.owner_id !== req.user.id) return res.status(403).json({ error: 'Apenas o dono pode deletar o servidor' });
    await run('DELETE FROM servers WHERE id = $1', [serverId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar servidor' });
  }
});

app.delete('/api/servers/:serverId/leave', authMiddleware, async (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const srv = await queryOne('SELECT * FROM servers WHERE id = $1', [serverId]);
    if (!srv) return res.status(404).json({ error: 'Servidor não encontrado' });
    if (srv.owner_id === req.user.id) return res.status(400).json({ error: 'Dono não pode sair. Transfira a propriedade ou delete o servidor.' });
    await run('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, req.user.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao sair do servidor' });
  }
});

app.delete('/api/servers/:serverId/channels/:channelId', authMiddleware, async (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId);
    const channelId = parseInt(req.params.channelId);
    if (!(await isModerator(serverId, req.user.id)))
      return res.status(403).json({ error: 'Sem permissão' });
    await run('DELETE FROM channels WHERE id = $1 AND server_id = $2', [channelId, serverId]);
    const channels = await getServerChannels(serverId);
    res.json({ success: true, channels });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar canal' });
  }
});

app.put('/api/users/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senhas obrigatórias' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Nova senha deve ter pelo menos 6 caracteres' });
    const user = await findById(req.user.id);
    if (!bcrypt.compareSync(currentPassword, user.password_hash))
      return res.status(401).json({ error: 'Senha atual incorreta' });
    const salt = bcrypt.genSaltSync(12);
    await run('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [bcrypt.hashSync(newPassword, salt), req.user.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

const connectedUsers = new Map();
const voiceUsers = new Map();
const userSockets = new Map();

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Autenticação necessária'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await findById(decoded.userId);
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

  (async () => {
    try {
      await run('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', ['online', socket.user.id]);
      io.emit('user-presence', { userId: socket.user.id, status: 'online' });

      const userServers = await getUserServers(socket.user.id);
      for (const srv of userServers) {
        socket.join(`server:${srv.id}`);
      }
    } catch (err) {
      console.error('Erro na inicialização do socket:', err);
    }
  })();

  socket.emit('userInfo', {
    id: socket.user.id,
    username: socket.user.username,
    avatarSeed: socket.user.avatarSeed
  });

  // ─── Chat ──────────────────────────────────────────────────────────────────

  socket.on('joinRoom', (roomName) => {
    (async () => {
      try {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        if (user.currentRoom) socket.leave(user.currentRoom);
        user.currentRoom = roomName;
        connectedUsers.set(socket.id, user);
        socket.join(roomName);
        const channelMatch = roomName.match(/^channel:(\d+)$/);
        if (channelMatch) {
          const messages = await getChannelMessages(parseInt(channelMatch[1]), 50);
          const messageIds = messages.map(m => m.id);
          const reactions = await getReactionsForMessages(messageIds);
          const enriched = messages.map(m => ({ ...m, reactions: reactions[m.id] || [] }));
          socket.emit('channelHistory', enriched);
        }
      } catch (err) {
        console.error('Erro no joinRoom:', err);
      }
    })();
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
    (async () => {
      try {
        const user = connectedUsers.get(socket.id);
        if (!user || !user.currentRoom) return;
        const channelMatch = user.currentRoom.match(/^channel:(\d+)$/);
        if (!channelMatch) return;
        const channelId = parseInt(channelMatch[1]);

        const content = sanitizeHtml(data.text?.trim());
        if (!content || content.length === 0 || content.length > 2000) return;

        let replyTo = null;
        if (data.replyTo) {
          const replyMsg = await queryOne('SELECT id FROM messages WHERE id = $1 AND channel_id = $2', [data.replyTo, channelId]);
          if (replyMsg) replyTo = data.replyTo;
        }

        let messageId;
        if (replyTo) {
          const result = await runReturningId('INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES ($1, $2, $3, $4) RETURNING id', [channelId, user.id, content, replyTo]);
          messageId = result.id;
        } else {
          const result = await runReturningId('INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3) RETURNING id', [channelId, user.id, content]);
          messageId = result.id;
        }

        const msg = {
          id: messageId, channel_id: channelId, user_id: user.id,
          username: user.username, avatar_seed: user.avatarSeed,
          content, created_at: new Date().toISOString(), reactions: []
        };

        io.to(user.currentRoom).emit('chatMessage', msg);

        const mentions = await extractMentions(data.text);
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
      } catch (err) {
        console.error('Erro no chatMessage:', err);
      }
    })();
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
    (async () => {
      try {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const { messageId, emoji } = data;
        if (!messageId || !emoji) return;
        const existing = await queryOne('SELECT * FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [messageId, user.id, emoji]);
        if (existing) {
          await run('DELETE FROM reactions WHERE id = $1', [existing.id]);
        } else {
          await run('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)', [messageId, user.id, emoji]);
        }
        const reactions = await getReactionsForMessages([messageId]);
        io.to(user.currentRoom).emit('reactions-update', { messageId, reactions: reactions[messageId] || [] });
      } catch (err) {
        console.error('Erro no reaction:', err);
      }
    })();
  });

  socket.on('message-edited', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;
    socket.to(user.currentRoom).emit('message-edited', { messageId: data.messageId, content: data.content });
  });

  socket.on('message-deleted', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;
    socket.to(user.currentRoom).emit('message-deleted', { messageId: data.messageId });
  });

  socket.on('message-pinned', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !user.currentRoom) return;
    socket.to(user.currentRoom).emit('message-pinned', { messageId: data.messageId, action: data.action });
  });

  // ─── Presence ──────────────────────────────────────────────────────────────

  socket.on('set-status', (data) => {
    (async () => {
      try {
        const { status, customStatus } = data;
        if (status && ['online', 'idle', 'dnd', 'offline'].includes(status)) {
          await run('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [status, socket.user.id]);
          io.emit('user-presence', { userId: socket.user.id, status });
        }
        if (customStatus !== undefined) {
          await run('UPDATE users SET custom_status = $1, updated_at = NOW() WHERE id = $2', [sanitizeHtml(customStatus), socket.user.id]);
        }
      } catch (err) {
        console.error('Erro no set-status:', err);
      }
    })();
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
      roomName, isMuted: false, isScreenSharing: false
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

  socket.on('user-speaking', (data) => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    socket.to(vd.roomName).emit('user-speaking', { socketId: socket.id, speaking: data.speaking });
  });

  socket.on('screen-share-started', () => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    vd.isScreenSharing = true;
    socket.to(vd.roomName).emit('screen-share-started', { socketId: socket.id, username: vd.username });
    broadcastVoiceUsers(vd.channelId);
  });

  socket.on('screen-share-stopped', () => {
    const vd = voiceUsers.get(socket.id);
    if (!vd) return;
    vd.isScreenSharing = false;
    socket.to(vd.roomName).emit('screen-share-stopped', { socketId: socket.id });
    broadcastVoiceUsers(vd.channelId);
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
          (async () => {
            try {
              await run('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', ['offline', user.id]);
              io.emit('user-presence', { userId: user.id, status: 'offline' });
            } catch (err) {
              console.error('Erro no disconnect update:', err);
            }
          })();
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
            avatarSeed: vd.avatarSeed, isMuted: vd.isMuted, isScreenSharing: vd.isScreenSharing
          });
        }
      }
    }
    io.to(roomName).emit('voice-users-list', { channelId, users });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  try {
    console.log('Iniciando banco de dados...');
    await initDatabase();
    console.log('Banco de dados inicializado com sucesso');
  } catch (err) {
    console.error('Erro ao inicializar banco:', err.message);
  }

  // Cleanup expired refresh tokens periodically
  setInterval(async () => {
    try {
      await run("DELETE FROM refresh_tokens WHERE expires_at < NOW()::text");
    } catch (err) {
      console.error('Erro na limpeza de tokens:', err.message);
    }
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

start().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
