import express from 'express';
import { db, nowISO, uid } from '../db.js';
import { hashPassphrase, signToken, touchKey, requireAuth } from '../auth.js';

const router = express.Router();

const PALETTE = ['#E2574C', '#2F80ED', '#27AE60', '#9B51E0', '#F2994A', '#00897B'];

/*
 * 登录/建旅行限速：单机内存表够用，重启即清零。
 * 挡的是拿脚本在线试口令 —— 这门唯一的东西就是口令本身，不设闸的话
 * 服务端哈希再抗爆破也没有意义。
 */
function makeLimiter(max, windowMs) {
  const map = new Map(); // ip -> { n, at }
  const ipOf = (req) => req.ip || req.socket?.remoteAddress || '?';
  return {
    blocked(req) {
      const e = map.get(ipOf(req));
      return !!e && Date.now() - e.at <= windowMs && e.n >= max;
    },
    hit(req) {
      const now = Date.now();
      const ip = ipOf(req);
      const e = map.get(ip);
      if (!e || now - e.at > windowMs) map.set(ip, { n: 1, at: now });
      else e.n += 1;
      // 表太大时清一遍过期的，别让陌生 IP 把它撑成内存泄漏
      if (map.size > 2000) {
        for (const [key, v] of map) if (now - v.at > windowMs) map.delete(key);
      }
    },
    clear(req) {
      map.delete(ipOf(req));
    },
  };
}
const loginLimit = makeLimiter(10, 15 * 60 * 1000);
const createLimit = makeLimiter(30, 15 * 60 * 1000);

/** 登录 / 加入：用口令打开某趟旅行，同时告诉服务器"你是谁" */
router.post('/login', (req, res) => {
  if (loginLimit.blocked(req)) {
    return res.status(429).json({ error: 'too_many', message: '试得太频繁了，过一刻钟再来' });
  }
  const passphrase = String(req.body?.passphrase || '').trim();
  const name = String(req.body?.name || '').trim().slice(0, 24) || '旅行者';

  if (!passphrase) return res.status(400).json({ error: 'bad_request', message: '请输入口令' });
  if (passphrase.length < 4) return res.status(400).json({ error: 'bad_request', message: '口令至少 4 位' });

  const key = db.prepare('SELECT * FROM trip_keys WHERE key_hash = ?').get(hashPassphrase(passphrase));
  if (!key) {
    loginLimit.hit(req);
    return res.status(401).json({ error: 'bad_passphrase', message: '口令不对，或者这趟旅行还没创建' });
  }

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(key.trip_id);
  if (!trip) {
    loginLimit.hit(req);
    return res.status(401).json({ error: 'bad_passphrase', message: '这趟旅行已被删除' });
  }

  // 同名成员复用，不同名则新建
  let member = db.prepare('SELECT * FROM members WHERE trip_id = ? AND name = ?').get(trip.id, name);
  if (!member) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM members WHERE trip_id = ?').get(trip.id).n;
    member = {
      id: uid(),
      trip_id: trip.id,
      name,
      color: PALETTE[count % PALETTE.length],
      created_at: nowISO(),
    };
    db.prepare('INSERT INTO members (id, trip_id, name, color, created_at) VALUES (@id, @trip_id, @name, @color, @created_at)').run(member);
  }

  loginLimit.clear(req);
  touchKey(key.id);
  // mid 是成员 id：改过名以后，光凭名字认不出「我」是谁（见 trip.js 快照里的 meId）
  const token = signToken({ tid: trip.id, kid: key.id, mid: member.id, name: member.name });
  res.json({ token, trip, member });
});

/** 创建新旅行。口令若已存在则直接返回对应旅行，避免误建重复数据 */
router.post('/trips', (req, res) => {
  if (createLimit.blocked(req)) {
    return res.status(429).json({ error: 'too_many', message: '建得太频繁了，过一刻钟再来' });
  }
  createLimit.hit(req);

  const passphrase = String(req.body?.passphrase || '').trim();
  const name = String(req.body?.name || '').trim().slice(0, 24) || '旅行者';
  const tripName = String(req.body?.tripName || '').trim().slice(0, 60) || '新的旅行';
  const startDate = String(req.body?.startDate || '').trim();
  const destination = String(req.body?.destination || '').trim().slice(0, 60);
  const theme = String(req.body?.theme || '').trim().slice(0, 20);
  const fromTemplateId = req.body?.fromTemplateId ? String(req.body.fromTemplateId) : null;

  // 新库新口令从 6 位起步；老库 4 位的口令照样能登录（登录侧不卡这个）
  if (!passphrase || passphrase.length < 6) {
    return res.status(400).json({ error: 'bad_request', message: '口令至少 6 位' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: 'bad_request', message: '请填写出发日期' });
  }

  const hash = hashPassphrase(passphrase);
  const existing = db.prepare('SELECT * FROM trip_keys WHERE key_hash = ?').get(hash);
  if (existing) {
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(existing.trip_id);
    return res.status(409).json({
      error: 'passphrase_taken',
      message: '这个口令已经有一趟旅行了，直接用它登录就行',
      trip,
    });
  }

  const now = nowISO();
  const tripId = uid();
  // keyId / memberId 要进 token：以后改口令、认「我」都靠它们，不能等插完再回头猜
  const keyId = uid();
  const memberId = uid();
  const endDate = String(req.body?.endDate || '').trim() || startDate;

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO trips (id, name, destination, start_date, end_date, theme, is_template, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(tripId, tripName, destination, startDate, endDate, theme || 'plain', now, now);

    db.prepare('INSERT INTO trip_keys (id, trip_id, key_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(keyId, tripId, hash, name, now, now);

    db.prepare('INSERT INTO members (id, trip_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(memberId, tripId, name, PALETTE[0], now);

    if (fromTemplateId) {
      copyTemplate(fromTemplateId, tripId, startDate, now);
    }
  });

  create();

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  const member = db.prepare('SELECT * FROM members WHERE trip_id = ? ORDER BY created_at LIMIT 1').get(tripId);
  const token = signToken({ tid: tripId, kid: keyId, mid: memberId, name: member.name });
  res.status(201).json({ token, trip, member });
});

/** 复制某趟旅行的行程结构（用于"以此为模板开新旅行"） */
function copyTemplate(srcTripId, destTripId, newStartDate, now) {
  const srcNodes = db.prepare('SELECT * FROM nodes WHERE trip_id = ? ORDER BY sort_order').all(srcTripId);
  if (srcNodes.length === 0) return;

  const src = db.prepare('SELECT start_date FROM trips WHERE id = ?').get(srcTripId);
  const dayShift = daysBetween(src.start_date, newStartDate);

  const dates = [...new Set(srcNodes.map((n) => n.date))].sort();
  const dateMap = new Map();
  for (const d of dates) dateMap.set(d, addDays(d, dayShift));

  const ins = db.prepare(
    `INSERT INTO nodes (id, trip_id, day_index, date, type, title, start_time, end_time, location,
                        nav_keyword, notes, checklist, transport_minutes, sort_order, status,
                        actual_start, actual_end, created_at, updated_at)
     VALUES (@id, @trip_id, @day_index, @date, @type, @title, @start_time, @end_time, @location,
             @nav_keyword, @notes, @checklist, @transport_minutes, @sort_order, 'planned',
             NULL, NULL, @created_at, @updated_at)`
  );

  for (const n of srcNodes) {
    const newId = uid();
    ins.run({
      ...n,
      id: newId,
      trip_id: destTripId,
      date: dateMap.get(n.date) ?? n.date,
      status: 'planned',
      actual_start: null,
      actual_end: null,
      created_at: now,
      updated_at: now,
    });
  }

}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 改口令：口令是这趟旅行唯一的门，用久了想换就得能换。
 * 只认当前口令；改完已登录的设备不受影响（签名 token 里不含口令），
 * 同伴下次登录用新口令即可。
 */
router.post('/passphrase', requireAuth, (req, res) => {
  const tripId = req.auth.tid;
  const current = String(req.body?.current || '').trim();
  const next = String(req.body?.next || '').trim();
  if (next.length < 6) return res.status(400).json({ error: 'too_short', message: '新口令至少 6 位' });
  if (next === current) return res.status(400).json({ error: 'same', message: '新口令和当前口令一样' });

  const currentHash = hashPassphrase(current);
  let key = req.auth.kid
    ? db.prepare('SELECT * FROM trip_keys WHERE id = ? AND trip_id = ?').get(req.auth.kid, tripId)
    : null;
  // 老 token 没带 kid（早期建完旅行签的那批）：按当前口令反查
  if (!key) key = db.prepare('SELECT * FROM trip_keys WHERE trip_id = ? AND key_hash = ?').get(tripId, currentHash);
  if (!key || key.key_hash !== currentHash) {
    return res.status(401).json({ error: 'bad_passphrase', message: '当前口令不对' });
  }

  const nextHash = hashPassphrase(next);
  const taken = db.prepare('SELECT 1 FROM trip_keys WHERE key_hash = ? AND id != ?').get(nextHash, key.id);
  if (taken) return res.status(409).json({ error: 'passphrase_taken', message: '这个口令已经被另一趟旅行用了' });

  db.prepare('UPDATE trip_keys SET key_hash = ? WHERE id = ?').run(nextHash, key.id);
  res.json({ ok: true });
});

export default router;
export { copyTemplate, daysBetween, addDays };
