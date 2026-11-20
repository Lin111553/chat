const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'chat.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL CHECK(length(text) <= 4000),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_pair ON messages(sender_id, receiver_id, id);
  CREATE INDEX IF NOT EXISTS messages_receiver ON messages(receiver_id, sender_id, id);
`);
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.get('host')) return res.status(403).json({ error: '请求来源不匹配' });
    } catch { return res.status(403).json({ error: '请求来源无效' }); }
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const COOKIE_NAME = 'xiaoju_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_MS });
function readCookie(header, name) {
  const item = (header || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return null; }
}
function getUserFromToken(token) {
  if (!token || token.length > 200) return null;
  const row = db.prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hashToken(token), Date.now());
  return row || null;
}
function issueSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token), userId, Date.now() + SESSION_MS, new Date().toISOString());
  res.cookie(COOKIE_NAME, token, cookieOptions());
}
function requireAuth(req, res, next) {
  const user = getUserFromToken(readCookie(req.headers.cookie, COOKIE_NAME));
  if (!user) return res.status(401).json({ error: '请先登录' });
  req.user = user;
  next();
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '操作太频繁，请稍后再试' } });
const publicUser = row => ({ id: row.id, username: row.username });
const getMessage = db.prepare(`SELECT id, sender_id AS senderId, receiver_id AS receiverId, text, created_at AS createdAt FROM messages WHERE id=?`);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(username)) return res.status(400).json({ error: '昵称需为 2–24 个中英文、数字、下划线或连字符' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: '密码长度需为 8–72 个字符' });
  try {
    const result = db.prepare('INSERT INTO users(username,username_key,password_hash,created_at) VALUES(?,?,?,?)').run(username, username.toLocaleLowerCase(), await bcrypt.hash(password, 12), new Date().toISOString());
    issueSession(Number(result.lastInsertRowid), res);
    res.status(201).json({ user: { id: Number(result.lastInsertRowid), username } });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: '这个昵称已被注册' });
    console.error(error); res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT id,username,password_hash FROM users WHERE username_key=?').get(username.toLocaleLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: '昵称或密码不正确' });
  issueSession(user.id, res);
  res.json({ user: publicUser(user) });
});
app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = readCookie(req.headers.cookie, COOKIE_NAME);
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));
app.get('/api/users/search', requireAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';
  if (!q) return res.json({ users: [] });
  const users = db.prepare(`SELECT id,username FROM users WHERE id<>? AND username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 30`).all(req.user.id, `%${q.replace(/[\\%_]/g, '\\$&')}%`);
  res.json({ users: users.map(publicUser) });
});
app.get('/api/conversations', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id,u.username,
      (SELECT text FROM messages m WHERE (m.sender_id=? AND m.receiver_id=u.id) OR (m.sender_id=u.id AND m.receiver_id=?) ORDER BY m.id DESC LIMIT 1) AS lastMessage,
      (SELECT created_at FROM messages m WHERE (m.sender_id=? AND m.receiver_id=u.id) OR (m.sender_id=u.id AND m.receiver_id=?) ORDER BY m.id DESC LIMIT 1) AS lastMessageAt
    FROM users u
    WHERE u.id IN (SELECT CASE WHEN sender_id=? THEN receiver_id ELSE sender_id END FROM messages WHERE sender_id=? OR receiver_id=?)
    ORDER BY lastMessageAt DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.json({ conversations: rows });
});
app.get('/api/messages/:userId', requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  if (!Number.isSafeInteger(otherId) || otherId < 1 || otherId === req.user.id) return res.status(400).json({ error: '联系人无效' });
  if (!db.prepare('SELECT id FROM users WHERE id=?').get(otherId)) return res.status(404).json({ error: '没有找到该用户' });
  const rows = db.prepare(`SELECT id,sender_id AS senderId,receiver_id AS receiverId,text,created_at AS createdAt FROM (SELECT id,sender_id,receiver_id,text,created_at FROM messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?) ORDER BY id DESC LIMIT ?) ORDER BY id ASC`).all(req.user.id, otherId, otherId, req.user.id, limit);
  res.json({ messages: rows });
});

function socketUser(socket, next) {
  const user = getUserFromToken(readCookie(socket.handshake.headers.cookie, COOKIE_NAME));
  if (!user) return next(new Error('请先登录'));
  socket.user = user;
  next();
}
io.use(socketUser);
io.on('connection', socket => {
  socket.join(`user:${socket.user.id}`);
  socket.on('message:send', (payload, acknowledge = () => {}) => {
    const to = Number(payload?.to);
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!Number.isSafeInteger(to) || to < 1 || to === socket.user.id) return acknowledge({ error: '联系人无效' });
    if (!text || [...text].length > 4000) return acknowledge({ error: '消息不能为空，且不能超过 4000 个字符' });
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(to)) return acknowledge({ error: '没有找到该用户' });
    const createdAt = new Date().toISOString();
    const result = db.prepare('INSERT INTO messages(sender_id,receiver_id,text,created_at) VALUES(?,?,?,?)').run(socket.user.id, to, text, createdAt);
    const message = getMessage.get(Number(result.lastInsertRowid));
    io.to(`user:${socket.user.id}`).to(`user:${to}`).emit('message:new', message);
    acknowledge({ ok: true, message });
  });
});

const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.listen(PORT, () => console.log(`小聚服务器已启动：http://localhost:${PORT}`));
