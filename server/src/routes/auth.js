import express from 'express';
import { db, nowISO, uid } from '../db.js';
import { hashPassphrase, signToken, touchKey } from '../auth.js';

const router = express.Router();

const PALETTE = ['#E2574C', '#2F80ED', '#27AE60', '#9B51E0', '#F2994A', '#00897B'];

/** 登录 / 加入：用口令打开某趟旅行，同时告诉服务器"你是谁" */
router.post('/login', (req, res) => {
  const passphrase = String(req.body?.passphrase || '').trim();
  const name = String(req.body?.name || '').trim().slice(0, 24) || '旅行者';

  if (!passphrase) return res.status(400).json({ error: 'bad_request', message: '请输入口令' });
  if (passphrase.length < 4) return res.status(400).json({ error: 'bad_request', message: '口令至少 4 位' });

  const key = db.prepare('SELECT * FROM trip_keys WHERE key_hash = ?').get(hashPassphrase(passphrase));
  if (!key) return res.status(401).json({ error: 'bad_passphrase', message: '口令不对，或者这趟旅行还没创建' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(key.trip_id);
  if (!trip) return res.status(401).json({ error: 'bad_passphrase', message: '这趟旅行已被删除' });

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

  touchKey(key.id);
  const token = signToken({ tid: trip.id, kid: key.id, name: member.name });
  res.json({ token, trip, member });
});

/** 创建新旅行。口令若已存在则直接返回对应旅行，避免误建重复数据 */
router.post('/trips', (req, res) => {
  const passphrase = String(req.body?.passphrase || '').trim();
  const name = String(req.body?.name || '').trim().slice(0, 24) || '旅行者';
  const tripName = String(req.body?.tripName || '').trim().slice(0, 60) || '新的旅行';
  const startDate = String(req.body?.startDate || '').trim();
  const destination = String(req.body?.destination || '').trim().slice(0, 60);
  const theme = String(req.body?.theme || '').trim().slice(0, 20);
  const fromTemplateId = req.body?.fromTemplateId ? String(req.body.fromTemplateId) : null;

  if (!passphrase || passphrase.length < 4) {
    return res.status(400).json({ error: 'bad_request', message: '口令至少 4 位' });
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
  const endDate = String(req.body?.endDate || '').trim() || startDate;

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO trips (id, name, destination, start_date, end_date, theme, is_template, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(tripId, tripName, destination, startDate, endDate, theme || 'plain', now, now);

    db.prepare('INSERT INTO trip_keys (id, trip_id, key_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uid(), tripId, hash, name, now, now);

    db.prepare('INSERT INTO members (id, trip_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uid(), tripId, name, PALETTE[0], now);

    if (fromTemplateId) {
      copyTemplate(fromTemplateId, tripId, startDate, now);
    }
  });

  create();

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  const member = db.prepare('SELECT * FROM members WHERE trip_id = ? ORDER BY created_at LIMIT 1').get(tripId);
  const token = signToken({ tid: tripId, kid: null, name: member.name });
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

export default router;
export { copyTemplate, daysBetween, addDays };
