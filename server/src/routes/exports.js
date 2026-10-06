import express from 'express';
import { db, nowISO, uid } from '../db.js';
import { verifyToken } from '../auth.js';
import { addDays } from './auth.js';
import { broadcast } from '../events.js';
import { vocabFor, typeInfo } from '../vocab.js';

const router = express.Router();

/**
 * 日历订阅走 .ics URL，由系统日历直接拉取。
 * 日历应用没法带 Authorization 头，所以这个路由允许 ?token= 传令牌。
 */
function authFromQuery(req, res, next) {
  const header = req.get('authorization') || '';
  let body = header.startsWith('Bearer ') ? verifyToken(header.slice(7)) : null;
  if (!body && req.query.token) body = verifyToken(String(req.query.token));
  if (!body || !body.tid) return res.status(401).json({ error: 'unauthorized', message: '令牌无效' });
  req.auth = body;
  next();
}

/* ------------------------------ 日历订阅 ------------------------------ */


function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// ICS 规范：每行不超过 75 字节，超长要折行
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let current = '';
  let currentLen = 0;
  const limit = () => (out.length === 0 ? 74 : 73);
  for (const ch of line) {
    const chLen = Buffer.byteLength(ch, 'utf8');
    if (currentLen + chLen > limit()) {
      out.push(current);
      current = ' ';
      currentLen = 1;
    }
    current += ch;
    currentLen += chLen;
  }
  out.push(current);
  return out.join('\r\n');
}

function localDT(dateStr, timeStr) {
  return `${dateStr.replace(/-/g, '')}T${timeStr.replace(':', '')}00`;
}

function buildICS(trip, nodes, vocab) {
  const stamp = nowISO().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Travel Companion//CN//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(trip.name)}`,
    `X-WR-TIMEZONE:Asia/Shanghai`,
  ];

  for (const n of nodes) {
    if (!n.start_time) continue;
    if (n.status === 'skipped') continue;

    const startMin = toMin(n.start_time);
    const endMin = n.end_time ? toMin(n.end_time) : startMin + defaultDuration(n.type);
const info = typeInfo(vocab, n.type);
const summary = `${info.label}｜${n.title}`;
    const descParts = [];
    if (n.location) descParts.push(`📍 ${n.location}`);
    if (n.transport_minutes) descParts.push(`🚗 距上一站车程约 ${n.transport_minutes} 分钟`);
    if (n.notes) descParts.push(n.notes);
    const checklist = safeParse(n.checklist);
    if (checklist.length) descParts.push('待办：' + checklist.map((c) => `□ ${c}`).join('\n'));

    lines.push(
      'BEGIN:VEVENT',
      `UID:${n.id}@travel.hclstudio.cn`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Shanghai:${localDT(n.date, n.start_time)}`,
      `DTEND;TZID=Asia/Shanghai:${localDT(n.date, minutesToTime(endMin))}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(descParts.join('\n'))}`,
      `LOCATION:${icsEscape(n.location || '')}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
`TRIGGER:-PT${info.leadMinutes}M`,
      `DESCRIPTION:${icsEscape(summary)}`,
      'END:VALARM',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n');
}

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(v) {
  const w = ((Math.round(v) % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}`;
}
// 没填结束时间时的一个兜底时长，不是类型枚举
function defaultDuration(type) {
return type === 'flight' ? 210 : 60;
}
function safeParse(v) {
  if (!v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

router.get('/calendar.ics', authFromQuery, (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.auth.tid);
  if (!trip) return res.status(404).json({ error: 'not_found' });

  const nodes = db
    .prepare('SELECT * FROM nodes WHERE trip_id = ? AND start_time IS NOT NULL ORDER BY date, sort_order')
    .all(req.auth.tid);

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(trip.name)}.ics"`);
  res.setHeader('Cache-Control', 'no-cache');
res.send(buildICS(trip, nodes, vocabFor(req.auth.tid)));
});

/* ------------------------------ 行程模板 ------------------------------ */

router.get('/template', authFromQuery, (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.auth.tid);
  if (!trip) return res.status(404).json({ error: 'not_found' });

  const nodes = db.prepare('SELECT * FROM nodes WHERE trip_id = ? ORDER BY date, sort_order').all(req.auth.tid);
  const budgets = db.prepare('SELECT category, planned_amount, sort_order FROM budgets WHERE trip_id = ? ORDER BY sort_order').all(req.auth.tid);

  // 按"第几天"归一化，去掉具体日期，这样导入到任何一趟新旅行都能用
  const byDay = new Map();
  for (const n of nodes) {
    if (!byDay.has(n.date)) byDay.set(n.date, []);
    byDay.get(n.date).push(n);
  }
  const dates = [...byDay.keys()].sort();

  res.json({
    kind: 'travel-template',
    version: 1,
    exportedAt: nowISO(),
    name: trip.name,
    destination: trip.destination,
    days: dates.map((d, i) => ({
      dayIndex: i,
      theme: `Day ${i + 1}`,
      nodes: byDay.get(d).map((n) => ({
        type: n.type,
        title: n.title,
        startTime: n.start_time,
        endTime: n.end_time,
        location: n.location,
        navKeyword: n.nav_keyword,
        notes: n.notes,
        checklist: safeParse(n.checklist),
        transportMinutes: n.transport_minutes,
      })),
    })),
    budgets: budgets.map((b) => ({ category: b.category, plannedAmount: b.planned_amount })),
  });
});

/** 导出完整备份（含消费与打卡），用于迁移或存档 */
router.get('/backup', authFromQuery, (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.auth.tid);
  if (!trip) return res.status(404).json({ error: 'not_found' });

  res.json({
    kind: 'travel-backup',
    version: 1,
    exportedAt: nowISO(),
    trip,
    members: db.prepare('SELECT name, color FROM members WHERE trip_id = ?').all(req.auth.tid),
    nodes: db.prepare('SELECT * FROM nodes WHERE trip_id = ? ORDER BY date, sort_order').all(req.auth.tid),
    budgets: db.prepare('SELECT * FROM budgets WHERE trip_id = ? ORDER BY sort_order').all(req.auth.tid),
    expenses: db.prepare('SELECT * FROM expenses WHERE trip_id = ? ORDER BY occurred_at').all(req.auth.tid),
    checkins: db.prepare('SELECT * FROM checkins WHERE trip_id = ? ORDER BY at_time').all(req.auth.tid),
  });
});

/**
 * 导入模板到当前旅行：把模板的"第 N 天结构"铺到这趟旅行的真实日期上。
 * 只新增节点，不动已有数据，方便"边走边加"。
 */
router.post('/import-template', authFromQuery, (req, res) => {
  const tripId = req.auth.tid;
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return res.status(404).json({ error: 'not_found' });

  const tpl = req.body?.template;
  if (!tpl || tpl.kind !== 'travel-template' || !Array.isArray(tpl.days)) {
    return res.status(400).json({ error: 'bad_request', message: '模板格式不正确' });
  }

  const offsetStart = req.body?.startDate && /^\d{4}-\d{2}-\d{2}$/.test(req.body.startDate)
    ? req.body.startDate
    : trip.start_date;

  const now = nowISO();
  const ins = db.prepare(
    `INSERT INTO nodes (id, trip_id, day_index, date, type, title, start_time, end_time, location, nav_keyword,
                        notes, checklist, transport_minutes, sort_order, status, actual_start, actual_end,
                        created_at, updated_at)
     VALUES (@id, @trip_id, @day_index, @date, @type, @title, @start_time, @end_time, @location, @nav_keyword,
             @notes, @checklist, @transport_minutes, @sort_order, 'planned', NULL, NULL, @created_at, @updated_at)`
  );

  let created = 0;
  const tx = db.transaction(() => {
    for (const day of tpl.days) {
      const date = addDays(offsetStart, Number(day.dayIndex) || 0);
      let order = 0;
      for (const n of day.nodes || []) {
        ins.run({
          id: uid(),
          trip_id: tripId,
          day_index: Number(day.dayIndex) || 0,
          date,
          type: n.type || 'other',
          title: String(n.title || '未命名').slice(0, 80),
          start_time: n.startTime || null,
          end_time: n.endTime || null,
          location: n.location || null,
          nav_keyword: n.navKeyword || null,
          notes: n.notes || null,
          checklist: Array.isArray(n.checklist) && n.checklist.length ? JSON.stringify(n.checklist) : null,
          transport_minutes: Number.isFinite(+n.transportMinutes) ? +n.transportMinutes : null,
          sort_order: (order += 10),
          created_at: now,
          updated_at: now,
        });
        created++;
      }
    }
  });
  tx();

  // 导进来的节点别的端也得看到，不然要等下一次手动刷新
  broadcast(tripId, { type: 'nodes' });
  res.json({ ok: true, created });
});

export default router;
