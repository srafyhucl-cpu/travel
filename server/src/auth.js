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

export const ROLE_WEIGHT = { viewer: 1, editor: 2, owner: 3 };

export function extractBearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Express 中间件：解析 Bearer token，验证用户或兼容口令 Token */
export function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: '登录已过期，请重新登录' });
  }
  if (payload.uid) {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(payload.uid);
    if (!user) return res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    req.user = user;
  } else if (payload.tid && payload.mid) {
    // 兼容旧版口令登录签发的 Token
    req.legacyAuth = payload;
    req.auth = payload;
  } else {
    return res.status(401).json({ error: 'INVALID_TOKEN', message: '无效的凭证格式' });
  }
  next();
}

/** 行程级权限守卫：根据 Trip-Id 认行程并校验角色权限，回填 req.auth */
export function requireTripAccess(minRole = 'viewer') {
  return (req, res, next) => {
    const tid =
      req.get('Trip-Id') ||
      req.get('X-Trip-Id') ||
      req.query.tripId ||
      req.legacyAuth?.tid ||
      req.user?.last_trip_id;

    if (!tid) {
      return res.status(400).json({ error: 'MISSING_TRIP_ID', message: '请求未指定目标行程 Trip-Id' });
    }

    const trip = db.prepare(`SELECT id, status FROM trips WHERE id = ?`).get(tid);
    if (!trip) {
      return res.status(404).json({ error: 'TRIP_NOT_FOUND', message: '目标行程不存在或已被删除' });
    }

    let member = null;
    if (req.user) {
      member = db.prepare(`SELECT * FROM members WHERE trip_id = ? AND user_id = ?`).get(tid, req.user.id);
    } else if (req.legacyAuth && req.legacyAuth.tid === tid) {
      member = db.prepare(`SELECT * FROM members WHERE id = ? AND trip_id = ?`).get(req.legacyAuth.mid, tid);
    }

    if (!member) {
      return res.status(403).json({ error: 'NOT_TRIP_MEMBER', message: '您不在该行程的成员列表中' });
    }

    const userWeight = ROLE_WEIGHT[member.role || 'editor'] || 0;
    const reqWeight = ROLE_WEIGHT[minRole] || 1;
    if (userWeight < reqWeight) {
      return res.status(403).json({ error: 'READ_ONLY_ROLE', message: '当前为只读预览权限，无法执行修改操作' });
    }

    // 关键桥接：回填 req.auth，使所有现有业务路由零改动读取 req.auth.tid 和 req.auth.mid
    req.auth = {
      tid: tid,
      mid: member.id,
      name: member.name,
      role: member.role || 'editor',
      uid: req.user ? req.user.id : null,
      kid: req.legacyAuth?.kid || null,
    };

    if (req.user && req.user.last_trip_id !== tid) {
      db.prepare(`UPDATE users SET last_trip_id = ?, updated_at = ? WHERE id = ?`).run(tid, nowISO(), req.user.id);
      req.user.last_trip_id = tid;
    }

    next();
  };
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

