import express from 'express';
import { db, nowISO, uid } from '../db.js';
import { requireAuth, requireTripAccess } from '../auth.js';
import { broadcast } from '../events.js';
import { parseChecklist, sanitizeChecklist } from '../checklist.js';

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  const minRole = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'viewer' : 'editor';
  requireTripAccess(minRole)(req, res, next);
});

// 类型不是写死的枚举：只要是安全的标识符就接受，展示信息去 vocab 表里查。
function sanitizeKey(v) {
const s = String(v ?? '').trim().slice(0, 40);
return /^[\w一-龥-]+$/.test(s) ? s : null;
}

/**
 * 经纬度（GCJ-02，地图选点存的）：空值 → null；非有限数、0 或超范围 → null。
 * 宁可存 null（前端走复制地名回退）也不落一个坏坐标，不然点「导航」会打开一个错地方。
 * 0 一律当无效：退化坐标（尤其 (0,0)）会让人打开一片海面。
 * 与客户端同一取舍 —— 赤道/格林尼治这类恰好为 0 的合法点会被一起拒掉，本行程用不到。
 */
function coord(v, limit) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > limit) return null;
  return n;
}
const STATUSES = new Set(['planned', 'done', 'skipped']);

function timeToMinutes(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [h, m] = t.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function minutesToTime(v) {
  const wrapped = ((v % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 「作为模块置顶显示」全局就一个位置：新的顶上来了，原来那条自动落回时间线。
 *
 * 前端只把第一条模块节点放进顶部那块卡，时间线上显示的是其余的 —— 同时挂两个，
 * 后一个既不在卡里也不在行程里，看着像凭空没了。离线队列重放旧请求也可能把两个
 * 标记一起送上来，服务端收一道最稳。
 */
function clearOtherModules(tripId, keepId) {
  db.prepare("UPDATE nodes SET role = NULL, updated_at = ? WHERE trip_id = ? AND id != ? AND role = 'module'")
    .run(nowISO(), tripId, keepId);
}

function nextSortOrder(tripId, date) {
  // sort_order 是一条贯穿整趟行程的全局序列，新项落在当天这一段的末尾。
  const sameDay = db.prepare('SELECT MAX(sort_order) AS m FROM nodes WHERE trip_id = ? AND date = ?').get(tripId, date);
  if (sameDay?.m != null) return sameDay.m + 10;
  const before = db.prepare('SELECT MAX(sort_order) AS m FROM nodes WHERE trip_id = ? AND date < ?').get(tripId, date);
  return (before?.m ?? -10) + 10;
}

/** 一天的时长：只有开始时间就按默认一小时算，都没有就返回 null（表示还没排期） */
const DEFAULT_SPAN = 60;

function spanOf(row) {
  const s = timeToMinutes(row.start_time);
  if (s === null) return null;
  const e = timeToMinutes(row.end_time);
  if (e === null || e <= s) return DEFAULT_SPAN;
  return e - s;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 节点被拖到行程范围外时，把行程的起止日期撑开，不然那天会变成没有第 N 天的孤儿日期 */
function expandTripRange(tripId, date) {
  const t = db.prepare('SELECT start_date, end_date FROM trips WHERE id = ?').get(tripId);
  if (!t) return;
  const start = date < t.start_date ? date : t.start_date;
  const end = date > t.end_date ? date : t.end_date;
  if (start === t.start_date && end === t.end_date) return;
  db.prepare('UPDATE trips SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?').run(start, end, nowISO(), tripId);
}

function orderedRows(tripId) {
  return db.prepare('SELECT * FROM nodes WHERE trip_id = ? ORDER BY sort_order, date, start_time').all(tripId);
}

/**
 * 纯计算：一天按当前顺序「顺延」后的时间（不落库）。
 *   · 从当天原本最早的开始时间起步，依次往后接，每项保持自己的时长；
 *   · 被拖过来的那一项（movedId）可以提前，好落进它的新位置；
 *   · 其它项不会比原计划更早 —— 航班、火车这种固定时间的项不该被压实提前；
 *   · 碰到没有排期的项，它后面的接不上、保持原样；挤不进 24 小时就停在那儿。
 * 返回 Map<id,{start_time,end_time,changed}> 和 overflow 数。
 */
function planDayTimes(dayRows, movedId) {
  let cursor = anchorOf(dayRows);
  const out = new Map();
  let overflow = 0;
  for (const r of dayRows) {
    const span = spanOf(r);
    const own = timeToMinutes(r.start_time);
    if (span === null || own === null) {
      cursor = null; // 碰到没排期的，它后面的接不上，保持原样
      continue;
    }
    if (cursor === null) continue;
    const s = r.id === movedId ? cursor : Math.max(cursor, own);
    if (s >= 1440) {
      overflow += 1;
      break;
    }
    const e = s + span;
    out.set(r.id, {
      start_time: minutesToTime(s),
      end_time: minutesToTime(e),
      changed: s !== own || timeToMinutes(r.end_time) !== e,
    });
    cursor = e;
  }
  return { times: out, overflow };
}

/** 把 node 插到 toDate 这天、beforeNodeId 前面，返回新的全局顺序（不落库） */
function planMoveOrder(tripId, node, toDate, beforeNodeIdRaw) {
  const beforeId = beforeNodeIdRaw ? String(beforeNodeIdRaw) : null;
  const all = orderedRows(tripId);
  const order0 = all.map((r) => r.id).join(',');
  const rows = all.filter((r) => r.id !== node.id);

  let at = beforeId ? rows.findIndex((r) => r.id === beforeId) : -1;
  /*
   * 「放回它自己前面那个空位」就是放回原位，不是落点丢了。
   * 手指拖出去又拖回来、或者只是往上挪了一点点，都会正好命中这里 ——
   * 以前一律报 400，在手机上就表现为「怎么都放不下去」。
   */
  if (at < 0 && beforeId === node.id) at = all.findIndex((r) => r.id === node.id);
  if (at < 0) {
    if (beforeId) return { error: 'bad_target' };
    at = rows.length;
  }

  rows.splice(at, 0, { ...node, date: toDate });
  return { rows, moved: rows.map((r) => r.id).join(',') !== order0 };
}

/** 某天的起步时间：当天所有有时间的节点里最早的那个 */
function anchorOf(dayRows) {
  let best = null;
  for (const r of dayRows) {
    const s = timeToMinutes(r.start_time);
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

function getNode(id, tripId) {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!row) return row;
  // checklist 出去一律是对象数组（老数据里的纯字符串在 parseChecklist 里补齐），
  // 不然同一个字段一会儿是数组一会儿是对象，前端每处都得先猜一遍。
  return { ...row, checklist: parseChecklist(row.checklist) };
}

router.post('/', (req, res) => {
  const tripId = req.auth.tid;
  const b = req.body || {};
  const date = String(b.date || '');
  const title = String(b.title || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad_date', message: '日期格式应为 YYYY-MM-DD' });
  if (!title) return res.status(400).json({ error: 'bad_title', message: '请填写标题' });

  const startTime = b.startTime && /^\d{1,2}:\d{2}$/.test(b.startTime) ? b.startTime : null;
  const now = nowISO();
  const node = {
    id: uid(),
    trip_id: tripId,
    day_index: 0,
    date,
type: sanitizeKey(b.type) || 'other',
    title: title.slice(0, 80),
    start_time: startTime,
    end_time: b.endTime && /^\d{1,2}:\d{2}$/.test(b.endTime) ? b.endTime : null,
    location: b.location ? String(b.location).slice(0, 120) : null,
    nav_keyword: b.navKeyword ? String(b.navKeyword).slice(0, 120) : null,
    lat: coord(b.lat, 90),
    lng: coord(b.lng, 180),
    notes: b.notes ? String(b.notes).slice(0, 2000) : null,
    checklist: Array.isArray(b.checklist) ? sanitizeChecklist(b.checklist) : null,
    role: b.role === 'module' ? 'module' : null,
    transport_minutes: Number.isFinite(+b.transportMinutes) ? Math.max(0, Math.min(600, +b.transportMinutes)) : null,
    sort_order: Number.isFinite(+b.sortOrder) ? +b.sortOrder : nextSortOrder(tripId, date),
    status: 'planned',
    actual_start: null,
    actual_end: null,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO nodes (id, trip_id, day_index, date, type, title, start_time, end_time, location, nav_keyword,
                        lat, lng, notes, checklist, role, transport_minutes, sort_order, status, actual_start, actual_end,
                        created_at, updated_at)
     VALUES (@id, @trip_id, @day_index, @date, @type, @title, @start_time, @end_time, @location, @nav_keyword,
             @lat, @lng, @notes, @checklist, @role, @transport_minutes, @sort_order, @status, @actual_start, @actual_end,
             @created_at, @updated_at)`
  ).run(node);
  if (node.role === 'module') clearOtherModules(tripId, node.id);

  broadcast(tripId, { type: 'nodes' });
  res.status(201).json(getNode(node.id, tripId));
});

const EDITABLE = {
  date: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null),
type: (v) => sanitizeKey(v),
  title: (v) => (String(v).trim().slice(0, 80) || null),
  startTime: (v) => (v === null || v === '' ? null : /^\d{1,2}:\d{2}$/.test(v) ? v : null),
  endTime: (v) => (v === null || v === '' ? null : /^\d{1,2}:\d{2}$/.test(v) ? v : null),
  location: (v) => (v ? String(v).slice(0, 120) : null),
  navKeyword: (v) => (v ? String(v).slice(0, 120) : null),
  lat: (v) => coord(v, 90),
  lng: (v) => coord(v, 180),
  notes: (v) => (v ? String(v).slice(0, 2000) : null),
  role: (v) => (v === 'module' ? 'module' : null),
  transportMinutes: (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(600, Math.round(+v))) : null),
  status: (v) => (STATUSES.has(v) ? v : null),
  sortOrder: (v) => (Number.isFinite(+v) ? Math.round(+v) : null),
};

const COLUMN = {
  date: 'date',
  type: 'type',
  title: 'title',
  startTime: 'start_time',
  endTime: 'end_time',
  location: 'location',
  navKeyword: 'nav_keyword',
  lat: 'lat',
  lng: 'lng',
  notes: 'notes',
  role: 'role',
  transportMinutes: 'transport_minutes',
  status: 'status',
  sortOrder: 'sort_order',
};

router.patch('/:id', (req, res) => {
  const tripId = req.auth.tid;
  const node = getNode(req.params.id, tripId);
  if (!node) return res.status(404).json({ error: 'not_found' });

  const sets = [];
  const params = { id: node.id, updated_at: nowISO() };

  for (const [key, sanitize] of Object.entries(EDITABLE)) {
    if (req.body?.[key] === undefined) continue;
    const value = sanitize(req.body[key]);
    if (value === null && req.body[key] !== null && req.body[key] !== '') continue;
    sets.push(`${COLUMN[key]} = @${COLUMN[key]}`);
    params[COLUMN[key]] = value;
  }

  if (Array.isArray(req.body?.checklist)) {
    sets.push('checklist = @checklist');
    params.checklist = sanitizeChecklist(req.body.checklist);
  }

  if (sets.length === 0) return res.json(node);

  db.prepare(`UPDATE nodes SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  if (params.role === 'module') clearOtherModules(tripId, node.id);
  broadcast(tripId, { type: 'nodes' });
  res.json(getNode(node.id, tripId));
});

router.delete('/:id', (req, res) => {
  const tripId = req.auth.tid;
  const node = getNode(req.params.id, tripId);
  if (!node) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
  broadcast(tripId, { type: 'nodes' });
  res.json({ ok: true, id: node.id });
});

/*
 * 勾一条待办。请求体是 {done: true/false}，不是「翻一下」：
 * 写操作会进离线队列、断网重连后重放，幂等的「设值」重放几次结果都一样，
 * toggle 会被重放反噬（勾完又自己弹回来）。
 */
router.post('/:id/checklist/:itemId', (req, res) => {
  const tripId = req.auth.tid;
  const node = getNode(req.params.id, tripId);
  if (!node) return res.status(404).json({ error: 'not_found' });
  const items = parseChecklist(node.checklist);
const done = req.body?.done === true;

/*
* 先按 id 找，找不到再按文案找。
*
* 库里没升级过的待办就是一列纯字符串，parseChecklist 每次读都现摇一个 id（uid 是
* 随机 UUID），上一轮发给客户端的 id 这一轮已经对不上了 —— 老数据上勾任何一条都
* 会撞 404「这条待办已经不在了」。文案兜底：勾完这一行整个被改写成带 id 的新
* 格式，客户端拿到响应里的 id，之后就都按 id 走了。同文案重复时先挑「状态正好相反」
* 的那条，不会去动已经勾好的。
*/
let item = items.find((i) => i.id === req.params.itemId);
if (!item && typeof req.body?.text === 'string' && req.body.text) {
item = items.find((i) => i.text === req.body.text && i.done !== done)
|| items.find((i) => i.text === req.body.text);
}
if (!item) return res.status(404).json({ error: 'no_item', message: '这条待办已经不在了' });
  item.done = done;
  item.done_at = done ? item.done_at || nowISO() : null;
  db.prepare('UPDATE nodes SET checklist = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(items), nowISO(), node.id
  );
  broadcast(tripId, { type: 'nodes' });
  res.json({ checklist: items });
});

/** 拖拽排序：前端传当天节点的顺序 id 数组 */
router.post('/reorder', (req, res) => {
  const tripId = req.auth.tid;
  const ids = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (ids.length === 0) return res.status(400).json({ error: 'bad_request' });

  const upd = db.prepare('UPDATE nodes SET sort_order = ?, updated_at = ? WHERE id = ? AND trip_id = ?');
  const tx = db.transaction(() => {
    ids.forEach((id, i) => upd.run(i * 10, nowISO(), id, tripId));
  });
  tx();
  broadcast(tripId, { type: 'nodes' });
  res.json({ ok: true });
});

/**
 * 拖拽落位：把 nodeId 插到 beforeNodeId 之前（beforeNodeId 为空则落到当天最后）。
 * 不是交换，是插入 —— 插进去之后按它自己的时长把后面的整体往后推。
 * 自己还没排期（没时间）的直接拦下来，让前端先去填时间段。
 */
router.post('/move', (req, res) => {
  const tripId = req.auth.tid;
  const node = getNode(String(req.body?.nodeId || ''), tripId);
  if (!node) return res.status(404).json({ error: 'not_found' });

  const toDate = String(req.body?.toDate || node.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return res.status(400).json({ error: 'bad_date' });

  if (spanOf(node) === null) {
    return res.status(422).json({ error: 'need_time', message: '这一项还没有时间，先填上开始和结束时间再拖' });
  }

  const plan = planMoveOrder(tripId, node, toDate, req.body?.beforeNodeId);
  if (plan.error === 'bad_target') return res.status(400).json({ error: 'bad_target', message: '落点已经不存在了' });

  // 时间只重排「下手的那一天」：源天的时间保持不动（不早于原计划的原则）
  const dayRows = plan.rows.filter((r) => r.date === toDate);
  const { times, overflow } = planDayTimes(dayRows, node.id);

  const updSort = db.prepare('UPDATE nodes SET sort_order = ?, date = ?, updated_at = ? WHERE id = ? AND trip_id = ?');
  const updTime = db.prepare('UPDATE nodes SET start_time = ?, end_time = ?, updated_at = ? WHERE id = ? AND trip_id = ?');
  const now = nowISO();
  let changed = 0;
  const tx = db.transaction(() => {
    plan.rows.forEach((r, i) => updSort.run(i * 10, r.date, now, r.id, tripId));
    for (const [id, t] of times) {
      if (!t.changed) continue;
      updTime.run(t.start_time, t.end_time, now, id, tripId);
      changed += 1;
    }
  });
  tx();

  expandTripRange(tripId, toDate);
  broadcast(tripId, { type: 'nodes' });
  // 顺序到底变没变，和时间有没有跟着挪是两回事 —— 放回原位时后者是 0，
  // 但前端得知道「这一下等于没动」，不然用户以为又是没放进去
  res.json({ ok: true, date: toDate, moved: plan.moved, changed, overflow });
});

/** 试算：同样的移动，算出目标天重排后的顺序与时间，不落库（确认页用） */
router.post('/move-preview', (req, res) => {
  const tripId = req.auth.tid;
  const node = getNode(String(req.body?.nodeId || ''), tripId);
  if (!node) return res.status(404).json({ error: 'not_found' });

  const toDate = String(req.body?.toDate || node.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return res.status(400).json({ error: 'bad_date' });

  if (spanOf(node) === null) {
    return res.status(422).json({ error: 'need_time', message: '这一项还没有时间，先填上开始和结束时间再拖' });
  }

  const plan = planMoveOrder(tripId, node, toDate, req.body?.beforeNodeId);
  if (plan.error === 'bad_target') return res.status(400).json({ error: 'bad_target', message: '落点已经不存在了' });

  const dayRows = plan.rows.filter((r) => r.date === toDate);
  const { times, overflow } = planDayTimes(dayRows, node.id);
  res.json({
    ok: true,
    dry: true,
    date: toDate,
    moved: plan.moved,
    overflow,
    day: {
      date: toDate,
      nodes: dayRows.map((r) => {
        const t = times.get(r.id);
        return {
          id: r.id,
          title: r.title,
          start_time: t ? t.start_time : r.start_time,
          end_time: t ? t.end_time : r.end_time,
          time_changed: !!(t && t.changed),
        };
      }),
    },
  });
});

/** 整天顺延：把 fromDate 及之后的每一项整体挪 days 天，顺序不变 */
router.post('/shift-days', (req, res) => {
  const tripId = req.auth.tid;
  const fromDate = String(req.body?.fromDate || '');
  const days = Math.round(Number(req.body?.days));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !Number.isFinite(days) || days === 0) {
    return res.status(400).json({ error: 'bad_request', message: '参数无效' });
  }
  const rows = db.prepare('SELECT id, date FROM nodes WHERE trip_id = ? AND date >= ?').all(tripId, fromDate);
  if (rows.length === 0) return res.json({ ok: true, moved: 0 });

  const upd = db.prepare('UPDATE nodes SET date = ?, updated_at = ? WHERE id = ? AND trip_id = ?');
  const now = nowISO();
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(addDays(r.date, days), now, r.id, tripId);
  });
  tx();

  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
  expandTripRange(tripId, addDays(last, days));
  expandTripRange(tripId, addDays(fromDate, days));

  broadcast(tripId, { type: 'nodes' });
  res.json({ ok: true, moved: rows.length, days });
});
/**
 * 自动顺延：从指定节点开始，把当天（或从该节点往后跨天）所有带时间的节点整体平移 minutes 分钟。
 * 打卡后发现晚了 90 分钟 → minutes = 90
 */
router.post('/shift', (req, res) => {
  const tripId = req.auth.tid;
  const minutes = Math.round(+req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes === 0) {
    return res.status(400).json({ error: 'bad_request', message: 'minutes 无效' });
  }
  const fromId = req.body?.fromNodeId ? String(req.body.fromNodeId) : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '') ? req.body.date : null;

  let rows;
  if (fromId) {
    const anchor = getNode(fromId, tripId);
    if (!anchor) return res.status(404).json({ error: 'not_found' });
    rows = db
      .prepare(
        `SELECT * FROM nodes
         WHERE trip_id = ? AND status = 'planned' AND start_time IS NOT NULL
           AND (date > ? OR (date = ? AND sort_order >= ?))
         ORDER BY date, sort_order`
      )
      .all(tripId, anchor.date, anchor.date, anchor.sort_order);
  } else if (date) {
    rows = db
      .prepare(`SELECT * FROM nodes WHERE trip_id = ? AND date = ? AND status = 'planned' AND start_time IS NOT NULL ORDER BY sort_order`)
      .all(tripId, date);
  } else {
    return res.status(400).json({ error: 'bad_request', message: '需要 fromNodeId 或 date' });
  }

  const upd = db.prepare('UPDATE nodes SET start_time = ?, end_time = ?, updated_at = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      const s = timeToMinutes(r.start_time);
      if (s === null) continue;
      const e = timeToMinutes(r.end_time);
      upd.run(minutesToTime(s + minutes), e === null ? null : minutesToTime(e + minutes), nowISO(), r.id);
    }
  });
  tx();

  broadcast(tripId, { type: 'nodes' });
  res.json({ ok: true, shifted: rows.length, minutes });
});

export default router;
