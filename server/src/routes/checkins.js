import express from 'express';
import { db, nowISO, uid } from '../db.js';
import { requireAuth } from '../auth.js';
import { broadcast } from '../events.js';

const router = express.Router();
router.use(requireAuth);

const ACTIONS = new Set(['arrived', 'departed', 'done']);

/**
 * 打卡：这是"我现在该在哪"的唯一真实来源。
 * arrived / departed → 记录 actual_start
 * done              → 节点标记完成，并记下 actual_end
 */
router.post('/', (req, res) => {
  const tripId = req.auth.tid;
  const nodeId = String(req.body?.nodeId || '');
  const action = String(req.body?.action || '');

  if (!ACTIONS.has(action)) return res.status(400).json({ error: 'bad_request', message: 'action 必须是 arrived / departed / done' });

  const node = db.prepare('SELECT * FROM nodes WHERE id = ? AND trip_id = ?').get(nodeId, tripId);
  if (!node) return res.status(404).json({ error: 'not_found', message: '行程项不存在' });

  const at = req.body?.at && !Number.isNaN(Date.parse(req.body.at)) ? new Date(req.body.at).toISOString() : nowISO();
  const row = { id: uid(), trip_id: tripId, node_id: nodeId, action, at_time: at, created_at: nowISO() };

  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO checkins (id, trip_id, node_id, action, at_time, created_at) VALUES (@id, @trip_id, @node_id, @action, @at_time, @created_at)'
    ).run(row);

    if (action === 'done') {
      db.prepare(`UPDATE nodes SET status = 'done', actual_end = ?, actual_start = COALESCE(actual_start, ?), updated_at = ? WHERE id = ?`)
        .run(at, at, nowISO(), nodeId);
    } else {
      db.prepare('UPDATE nodes SET actual_start = COALESCE(actual_start, ?), updated_at = ? WHERE id = ?')
        .run(at, nowISO(), nodeId);
      // 从"跳过"改回进行中
      if (node.status === 'skipped') {
        db.prepare(`UPDATE nodes SET status = 'planned', updated_at = ? WHERE id = ?`).run(nowISO(), nodeId);
      }
    }
  });
  tx();

  broadcast(tripId, { type: 'checkins' });
  res.status(201).json(row);
});

router.get('/', (req, res) => {
  res.json(
    db
      .prepare('SELECT c.*, n.title AS node_title, n.date AS node_date, n.start_time AS node_start FROM checkins c LEFT JOIN nodes n ON n.id = c.node_id WHERE c.trip_id = ? ORDER BY c.at_time')
      .all(req.auth.tid)
  );
});

router.delete('/:id', (req, res) => {
  const tripId = req.auth.tid;
  const row = db.prepare('SELECT * FROM checkins WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM checkins WHERE id = ?').run(row.id);
    // 撤销打卡后，若该节点已无任何打卡，把状态还原为未开始
    const left = db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE node_id = ?').get(row.node_id).n;
    if (left === 0) {
      db.prepare(`UPDATE nodes SET status = 'planned', actual_start = NULL, actual_end = NULL, updated_at = ? WHERE id = ?`)
        .run(nowISO(), row.node_id);
    }
  });
  tx();

  broadcast(tripId, { type: 'checkins' });
  res.json({ ok: true });
});

export default router;
