import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, db, nowISO, uid } from './db.js';

// 服务端 pepper：即使数据库泄露，攻击者也无法离线爆破口令
const PEPPER_FILE = path.join(DATA_DIR, '.pepper');

function loadPepper() {
  if (process.env.AUTH_PEPPER) return process.env.AUTH_PEPPER;
  if (fs.existsSync(PEPPER_FILE)) return fs.readFileSync(PEPPER_FILE, 'utf8').trim();
  const p = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(PEPPER_FILE, p, { mode: 0o600 });
  return p;
}

const PEPPER = loadPepper();

const SECRET_FILE = path.join(DATA_DIR, '.session-secret');

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

const SECRET = loadSecret();

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 365; // 一年

export function hashPassphrase(passphrase) {
  return crypto.createHash('sha256').update(`${PEPPER}:${passphrase}`, 'utf8').digest('hex');
}

export function verifyPassphrase(passphrase) {
  const hash = hashPassphrase(passphrase);
  const key = db.prepare('SELECT * FROM trip_keys WHERE key_hash = ?').get(hash);
  return key || null;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function signToken(payload) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!body.exp || body.exp < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

/** Express 中间件：解析 Bearer token，注入 req.auth */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const body = verifyToken(token);
  if (!body || !body.tid) {
    return res.status(401).json({ error: 'unauthorized', message: '口令无效或登录已过期' });
  }
  req.auth = body;
  next();
}

/** 确保 trips 表里这个 trip 仍然存在 */
export function tripExists(tripId) {
  return !!db.prepare('SELECT 1 FROM trips WHERE id = ?').get(tripId);
}

export function touchKey(keyId) {
  db.prepare('UPDATE trip_keys SET last_used_at = ? WHERE id = ?').run(nowISO(), keyId);
}

/**
 * 请求属于哪个成员：token 里的 mid 优先（验一下确实在这趟旅行里），
 * 老 token 没 mid 的按名字反查；都认不出来就返回 null
 * （启动时的追认逻辑会把 null 的行填给创建者，见 db.js）。
 */
export function memberIdOf(req) {
  const auth = req.auth || {};
  if (auth.mid && db.prepare('SELECT 1 FROM members WHERE id = ? AND trip_id = ?').get(auth.mid, auth.tid)) {
    return auth.mid;
  }
  if (auth.name) {
    const m = db.prepare('SELECT id FROM members WHERE trip_id = ? AND name = ?').get(auth.tid, auth.name);
    if (m) return m.id;
  }
  return null;
}

export { uid };
