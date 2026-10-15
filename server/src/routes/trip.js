import express from 'express';
import { db, nowISO, uid } from '../db.js';
import { requireAuth, requireTripAccess, verifyToken } from '../auth.js';
import { addClient, broadcast, currentRev } from '../events.js';
import { addDays } from './auth.js';
import { vocabFor } from '../vocab.js';
import { parseChecklist } from '../checklist.js';

const router = express.Router();

/**
 * SSE：任何一端改了数据，这趟旅行的其他端都会收到通知，然后重新拉快照。
 *
 * 浏览器的 EventSource 不能自定义请求头，所以令牌只能从 ?token= 取。
 * 其它接口仍然只认 Authorization 头，免得令牌落到 nginx 访问日志里。
 *
 * 这个路由必须注册在 router.use(requireAuth) 之前，否则会先被它拒掉。
 */
function streamAuth(req, res, next) {
  const body = verifyToken(String(req.query.token || ''));
  if (!body) return res.status(401).json({ error: 'unauthorized', message: '令牌无效' });
  if (body.uid) {
    const tid = req.query.tripId;
    if (!tid) return res.status(400).json({ error: 'MISSING_TRIP_ID', message: '缺少 tripId' });
    const m = db.prepare('SELECT 1 FROM members WHERE trip_id = ? AND user_id = ?').get(tid, body.uid);
    if (!m) return res.status(403).json({ error: 'NOT_TRIP_MEMBER', message: '无权订阅该行程' });
    req.auth = { tid, uid: body.uid };
  } else if (body.tid) {
    req.auth = body;
  } else {
    return res.status(401).json({ error: 'unauthorized', message: '令牌格式无效' });
  }
  next();
}

router.get('/stream', streamAuth, (req, res) => {
  const tripId = req.auth.tid;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 让 nginx 不缓冲，否则事件会被攒住
  });
  res.write(`data: ${JSON.stringify({ type: 'hello', at: nowISO() })}\n\n`);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25000);

  req.on('close', () => clearInterval(ping));
  addClient(tripId, res);
});

router.use(requireAuth);
router.use(requireTripAccess('viewer'));

function parseJSON(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** 一次性拉取整趟旅行的全部数据（离线优先的"快照"） */
router.get('/snapshot', (req, res) => {
  const tripId = req.auth.tid;
  // 版本号在读数之前取：数据只会比它更新，客户端据它决定下次要不要再拉（宁可多拉一次）
  const rev = currentRev(tripId);
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return res.status(404).json({ error: 'not_found', message: '旅行不存在' });

  const members = db
    .prepare('SELECT id, name, color, avatar_url, user_id, role FROM members WHERE trip_id = ? ORDER BY created_at')
    .all(tripId);

  const rawNodes = db
    .prepare('SELECT * FROM nodes WHERE trip_id = ? ORDER BY date, sort_order, start_time')
    .all(tripId);

  const nodes = rawNodes.map((n) => ({
    ...n,
    checklist: parseChecklist(n.checklist),
  }));

  const budgets = db.prepare('SELECT * FROM budgets WHERE trip_id = ? ORDER BY sort_order').all(tripId);
  const expenses = db.prepare('SELECT * FROM expenses WHERE trip_id = ? ORDER BY occurred_at DESC').all(tripId)
    .map((e) => ({ ...e, participants: parseJSON(e.participants, members.map((m) => m.name)) }));
  const checkins = db.prepare('SELECT * FROM checkins WHERE trip_id = ? ORDER BY at_time').all(tripId);
  const photos = db
    .prepare('SELECT id, node_id, member_id, filename, mime, size, width, height, caption, taken_at, created_at FROM photos WHERE trip_id = ? ORDER BY created_at DESC')
    .all(tripId);

  // 按日期分组，并补出没有行程的日子（空白日也要显示，不然"第几天"会错位）
  const days = [];
  if (nodes.length) {
    const first = nodes[0].date;
    const last = nodes.reduce((acc, n) => (n.date > acc ? n.date : acc), nodes[0].date);
    let cursor = first;
    let guard = 0;
    while (cursor <= last && guard++ < 60) {
      days.push({ date: cursor, nodeIds: nodes.filter((n) => n.date === cursor).map((n) => n.id) });
      cursor = addDays(cursor, 1);
    }
  }

  const myRole =
    req.tripMember?.role ||
    (req.auth.uid ? members.find((m) => m.user_id === req.auth.uid)?.role || 'editor' : 'editor');

  res.json({
    trip: { ...trip, role: myRole },
    myRole,
    members,
    nodes,
    days,
    budgets,
    expenses,
    checkins,
    photos,
    vocab: vocabFor(tripId),
    serverTime: nowISO(),
    // 轻量版本号：轮询端对比它决定要不要重新拉快照（见 events.js）
    rev,
    me: req.auth.name,
    // 「我是谁」不能只看名字：改名之后 token 里的旧名字就对不上了
    meId: req.auth.mid || null,
  });
});

/** 轻量数据版本号：轮询端对比它决定要不要拉全量快照（任何写操作都会让它自增） */
router.get('/rev', (req, res) => {
  res.json({ rev: currentRev(req.auth.tid) });
});

/** 更新旅行基本信息（名称、目的地、日期、主题色） */
router.patch('/trip', requireTripAccess('editor'), (req, res) => {
  const tripId = req.auth.tid;
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return res.status(404).json({ error: 'not_found' });

  const next = {
    name: req.body?.name !== undefined ? String(req.body.name).slice(0, 60) : trip.name,
    destination:
      req.body?.destination !== undefined ? String(req.body.destination).slice(0, 60) : trip.destination,
    start_date:
      req.body?.startDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(req.body.startDate)
        ? req.body.startDate
        : trip.start_date,
    end_date:
      req.body?.endDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(req.body.endDate) ? req.body.endDate : trip.end_date,
    theme: req.body?.theme !== undefined ? String(req.body.theme).slice(0, 20) : trip.theme,
    updated_at: nowISO(),
  };

  db.prepare(
    `UPDATE trips SET name = @name, destination = @destination, start_date = @start_date,
                      end_date = @end_date, theme = @theme, updated_at = @updated_at WHERE id = @id`
  ).run({ ...next, id: tripId });

  broadcast(tripId, { type: 'trip' });
  res.json(db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId));
});

/** 成员改名 / 改色 */
router.patch('/members/:id', requireTripAccess('editor'), (req, res) => {
  const tripId = req.auth.tid;
  const m = db.prepare('SELECT * FROM members WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!m) return res.status(404).json({ error: 'not_found' });

  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 24) : m.name;
  const color = req.body?.color !== undefined ? String(req.body.color).slice(0, 20) : m.color;
  db.prepare('UPDATE members SET name = ?, color = ? WHERE id = ?').run(name || m.name, color, m.id);

  broadcast(tripId, { type: 'members' });
  res.json(db.prepare('SELECT * FROM members WHERE id = ?').get(m.id));
});

/** 添加虚拟同伴（用于离线/线下同伴记账分摊） */
router.post('/members', requireTripAccess('editor'), (req, res) => {
  const tripId = req.auth.tid;
  const name = String(req.body?.name || '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: 'bad_request', message: '同伴姓名不能为空' });

  const color = String(req.body?.color || '').slice(0, 20);
  const PALETTE = ['#E2574C', '#2F80ED', '#27AE60', '#9B51E0', '#F2994A', '#00897B'];
  const count = db.prepare('SELECT COUNT(*) as c FROM members WHERE trip_id = ?').get(tripId)?.c || 0;
  const member = {
    id: uid(),
    trip_id: tripId,
    name,
    color: color || PALETTE[count % PALETTE.length],
    created_at: nowISO(),
    user_id: null,
    role: 'editor',
    avatar_url: '',
  };

  db.prepare(
    `INSERT INTO members (id, trip_id, name, color, created_at, user_id, role, avatar_url)
     VALUES (@id, @trip_id, @name, @color, @created_at, @user_id, @role, @avatar_url)`
  ).run(member);

  broadcast(tripId, { type: 'members' });
  res.status(201).json({
    member: {
      id: member.id,
      name: member.name,
      color: member.color,
      role: 'editor',
      userId: null,
      isVirtual: true,
    },
  });
});

/** 移除成员（若存在账单关联则 409 拦截） */
router.delete('/members/:id', requireTripAccess('editor'), (req, res) => {
  const tripId = req.auth.tid;
  const m = db.prepare('SELECT * FROM members WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!m) return res.status(404).json({ error: 'not_found', message: '成员不存在' });

  const hasExpense = db
    .prepare(
      `SELECT 1 FROM expenses
       WHERE trip_id = ? AND (payer = ? OR participants LIKE ?)
       LIMIT 1`
    )
    .get(tripId, m.name, '%' + m.name + '%');

  if (hasExpense) {
    return res.status(409).json({
      error: 'MEMBER_HAS_EXPENSES',
      message: '该成员名下已有记账记录，无法直接移除',
    });
  }

  db.prepare('DELETE FROM members WHERE id = ? AND trip_id = ?').run(m.id, tripId);
  broadcast(tripId, { type: 'members' });
  res.json({ ok: true });
});

export default router;
