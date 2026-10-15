import express from 'express';
import { db, nowISO, uid } from '../db.js';
import { requireAuth, requireTripAccess } from '../auth.js';
import { broadcast } from '../events.js';

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  const minRole = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'viewer' : 'editor';
  requireTripAccess(minRole)(req, res, next);
});

// 预算行映射到哪个消费类别（vocab key）。不填就只当一条独立额度，不会被消费冲抵。
function cleanVocabKey(v) {
  const s = String(v ?? '').trim().slice(0, 40);
  return /^[\w-]+$/.test(s) ? s : null;
}

// 消费类别同样来自 vocab 表，「车辆租赁」「油费」这类自定义项直接能用
function sanitizeCategory(v) {
const s = String(v ?? '').trim().slice(0, 40);
return /^[\w一-龥-]+$/.test(s) ? s : null;
}

function tripMemberNames(tripId) {
  return db.prepare('SELECT name FROM members WHERE trip_id = ? ORDER BY created_at').all(tripId).map((m) => m.name);
}

/* ------------------------------ 预算 ------------------------------ */

router.get('/budgets', (req, res) => {
  res.json(db.prepare('SELECT * FROM budgets WHERE trip_id = ? ORDER BY sort_order').all(req.auth.tid));
});

router.post('/budgets', (req, res) => {
  const tripId = req.auth.tid;
  const category = String(req.body?.category || '').trim().slice(0, 20);
  const amount = +req.body?.amount;
  if (!category) return res.status(400).json({ error: 'bad_request', message: '请填写预算类别' });
  if (!Number.isFinite(amount)) return res.status(400).json({ error: 'bad_request', message: '金额无效' });

  const m = db.prepare('SELECT MAX(sort_order) AS m FROM budgets WHERE trip_id = ?').get(tripId);
  const row = {
    id: uid(),
    trip_id: tripId,
    category,
    vocab_key: cleanVocabKey(req.body?.vocabKey),
    planned_amount: amount,
    sort_order: (m?.m ?? -10) + 10,
  };
  db.prepare(
    'INSERT INTO budgets (id, trip_id, category, vocab_key, planned_amount, sort_order) VALUES (@id, @trip_id, @category, @vocab_key, @planned_amount, @sort_order)'
  ).run(row);

  broadcast(tripId, { type: 'budgets' });
  res.status(201).json(row);
});

router.patch('/budgets/:id', (req, res) => {
  const tripId = req.auth.tid;
  const row = db.prepare('SELECT * FROM budgets WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const category = req.body?.category !== undefined ? String(req.body.category).trim().slice(0, 20) : row.category;
  const amount = req.body?.amount !== undefined && Number.isFinite(+req.body.amount) ? +req.body.amount : row.planned_amount;
  const vocabKey = req.body?.vocabKey !== undefined ? cleanVocabKey(req.body.vocabKey) : row.vocab_key;
  db.prepare('UPDATE budgets SET category = ?, vocab_key = ?, planned_amount = ? WHERE id = ?').run(category, vocabKey, amount, row.id);

  broadcast(tripId, { type: 'budgets' });
  res.json(db.prepare('SELECT * FROM budgets WHERE id = ?').get(row.id));
});

router.delete('/budgets/:id', (req, res) => {
  const tripId = req.auth.tid;
  const row = db.prepare('SELECT * FROM budgets WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM budgets WHERE id = ?').run(row.id);
  broadcast(tripId, { type: 'budgets' });
  res.json({ ok: true });
});

/* ------------------------------ 消费 ------------------------------ */

function cleanExpense(b, tripId) {
  const members = tripMemberNames(tripId);
  const amount = +b?.amount;
  if (!Number.isFinite(amount)) return { error: '消费金额无效' };
  if (amount <= 0) return { error: '消费金额要大于 0' };
  if (amount > 1000000) return { error: '金额太大了' };

  const payer = members.includes(String(b?.payer)) ? String(b.payer) : members[0] || String(b?.payer || '').slice(0, 24);
  if (!payer) return { error: '请先在成员里添加自己' };

  let participants = Array.isArray(b?.participants)
    ? b.participants.map(String).filter((n) => members.includes(n))
    : members;
  if (participants.length === 0) participants = [payer];

const category = sanitizeCategory(b?.category) || 'misc';
  const occurredAt = b?.occurredAt && !Number.isNaN(Date.parse(b.occurredAt))
    ? new Date(b.occurredAt).toISOString()
    : nowISO();

  let nodeId = null;
  if (b?.nodeId) {
    const n = db.prepare('SELECT id FROM nodes WHERE id = ? AND trip_id = ?').get(String(b.nodeId), tripId);
    nodeId = n?.id ?? null;
  }

  return {
    amount: Math.round(amount * 100) / 100,
    payer,
    participants,
    category,
    occurred_at: occurredAt,
    node_id: nodeId,
    note: b?.note ? String(b.note).slice(0, 200) : null,
  };
}

router.get('/expenses', (req, res) => {
  res.json(db.prepare('SELECT * FROM expenses WHERE trip_id = ? ORDER BY occurred_at DESC').all(req.auth.tid));
});

router.post('/expenses', (req, res) => {
  const tripId = req.auth.tid;
  const v = cleanExpense(req.body, tripId);
  if (v.error) return res.status(400).json({ error: 'bad_request', message: v.error });

  const now = nowISO();
  const row = {
    id: uid(),
    trip_id: tripId,
    node_id: v.node_id,
    category: v.category,
    amount: v.amount,
    payer: v.payer,
    participants: JSON.stringify(v.participants),
    occurred_at: v.occurred_at,
    note: v.note,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO expenses (id, trip_id, node_id, category, amount, payer, participants, occurred_at, note, created_at, updated_at)
     VALUES (@id, @trip_id, @node_id, @category, @amount, @payer, @participants, @occurred_at, @note, @created_at, @updated_at)`
  ).run(row);

  broadcast(tripId, { type: 'expenses' });
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(row.id));
});

router.patch('/expenses/:id', (req, res) => {
  const tripId = req.auth.tid;
  const row = db.prepare('SELECT * FROM expenses WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const v = cleanExpense({ ...row, ...req.body, participants: req.body?.participants ?? JSON.parse(row.participants || '[]') }, tripId);
  if (v.error) return res.status(400).json({ error: 'bad_request', message: v.error });

  db.prepare(
    `UPDATE expenses SET node_id = @node_id, category = @category, amount = @amount, payer = @payer,
            participants = @participants, occurred_at = @occurred_at, note = @note, updated_at = @updated_at
     WHERE id = @id`
  ).run({
    id: row.id,
    node_id: v.node_id,
    category: v.category,
    amount: v.amount,
    payer: v.payer,
    participants: JSON.stringify(v.participants),
    occurred_at: v.occurred_at,
    note: v.note,
    updated_at: nowISO(),
  });

  broadcast(tripId, { type: 'expenses' });
  res.json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(row.id));
});

router.delete('/expenses/:id', (req, res) => {
  const tripId = req.auth.tid;
  const row = db.prepare('SELECT * FROM expenses WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM expenses WHERE id = ?').run(row.id);
  broadcast(tripId, { type: 'expenses' });
  res.json({ ok: true });
});

export default router;
