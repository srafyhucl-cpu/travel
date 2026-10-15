import express from 'express';
import { db } from '../db.js';
import { requireAuth, requireTripAccess } from '../auth.js';
import { addVocab, updateVocab, deleteVocab, vocabFor } from '../vocab.js';
import { broadcast } from '../events.js';

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  const minRole = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'viewer' : 'editor';
  requireTripAccess(minRole)(req, res, next);
});

const KINDS = new Set(['node_type', 'expense_category']);

/** 本趟旅行生效的词汇表（全局默认 + 自定义） */
router.get('/', (req, res) => {
  res.json(vocabFor(req.auth.tid));
});

/** 新增自定义项 */
router.post('/', (req, res) => {
  const kind = String(req.body?.kind || '');
  if (!KINDS.has(kind)) return res.status(400).json({ error: 'bad_kind', message: 'kind 必须是 node_type 或 expense_category' });

  const result = addVocab(req.auth.tid, kind, req.body);
  if (result.error) return res.status(400).json({ error: 'bad_request', message: result.error });

  broadcast(req.auth.tid, { type: 'vocab' });
  res.status(201).json(result.item);
});

router.patch('/:id', (req, res) => {
  const result = updateVocab(req.auth.tid, req.params.id, req.body || {});
  if (result.error) return res.status(400).json({ error: 'bad_request', message: result.error });
  broadcast(req.auth.tid, { type: 'vocab' });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const result = deleteVocab(req.auth.tid, req.params.id);
  if (result.error) return res.status(400).json({ error: 'bad_request', message: result.error });
  broadcast(req.auth.tid, { type: 'vocab' });
  res.json({ ok: true });
});

/** 这个 key 还有多少节点/消费在用——删之前给个提醒 */
router.get('/:id/usage', (req, res) => {
  const row = db.prepare('SELECT * FROM vocab WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.kind === 'node_type') {
    const n = db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE trip_id = ? AND type = ?').get(req.auth.tid, row.key).n;
    return res.json({ nodes: n });
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE trip_id = ? AND category = ?').get(req.auth.tid, row.key).n;
  res.json({ expenses: n });
});

export default router;
