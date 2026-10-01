/**
 * 词汇表解析：全局默认 + 本趟旅行的自定义。
 * 行程类型、消费类别都从这里来，所以加「露营」「油费」不用改代码。
 */
import { db } from './db.js';

const PALETTE = ['#2F80ED', '#E2574C', '#27AE60', '#F2994A', '#9B51E0', '#00897B', '#EB5757', '#7B61FF'];

function slugify(label, fallback = 'custom') {
  const s = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w一-龥-]/g, '');
  return s || `${fallback}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 某趟旅行最终生效的词汇表 */
export function vocabFor(tripId) {
  const all = db
    .prepare(
      `SELECT * FROM vocab
       WHERE trip_id IS NULL OR trip_id = ?
       ORDER BY sort_order, created_at`
    )
    .all(tripId);

  const byKey = new Map();
  for (const row of all) {
    // 本趟自定义覆盖全局默认
    if (!byKey.has(row.key) || row.trip_id === tripId) byKey.set(row.key, row);
  }

  const list = [...byKey.values()];
  return {
    nodeTypes: list.filter((v) => v.kind === 'node_type').map(shape),
    categories: list.filter((v) => v.kind === 'expense_category').map(shape),
    byKey: Object.fromEntries(list.map((v) => [v.key, shape(v)])),
  };
}

function shape(v) {
  return {
    key: v.key,
    label: v.label,
    icon: v.icon || '📌',
    color: v.color || '#6B7280',
    soft: v.soft || '#F1F3F5',
    leadMinutes: v.lead_minutes ?? 30,
    custom: !!v.trip_id,
  };
}

/** 取一个类型的展示信息；不在表里也照样能显示（用 key 当名字） */
export function typeInfo(vocab, key) {
  return (
    vocab.byKey[key] || {
      key,
      label: key || '其他',
      icon: '📌',
      color: '#6B7280',
      soft: '#F1F3F5',
      leadMinutes: 30,
      custom: false,
    }
  );
}

/** 新增自定义类型；label 重名时自动加后缀 */
export function addVocab(tripId, kind, input) {
  const label = String(input?.label || '').trim().slice(0, 20);
  if (!label) return { error: '请填写名称' };

  let key = String(input?.key || '').trim() || slugify(label, kind);
  if (!/^[\w一-龥-]+$/.test(key)) key = slugify(label, kind);

  const exists = db
    .prepare('SELECT id FROM vocab WHERE IFNULL(trip_id, \'\') = ? AND kind = ? AND key = ?')
    .get(tripId || '', kind, key);
  if (exists) {
    key = `${key}-${Math.random().toString(36).slice(2, 5)}`;
  }

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM vocab WHERE IFNULL(trip_id, \'\') = ? AND kind = ?')
    .get(tripId || '', kind).n;

  const id = crypto.randomUUID();
  const color = input?.color || PALETTE[count % PALETTE.length];
  db.prepare(
    `INSERT INTO vocab (id, trip_id, kind, key, label, icon, color, soft, lead_minutes, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tripId,
    kind,
    key,
    label,
    input?.icon || (kind === 'node_type' ? '📍' : '💰'),
    color,
    `${color}18`,
    Number.isFinite(+input?.leadMinutes) ? Math.max(0, Math.min(1440, +input.leadMinutes)) : kind === 'node_type' ? 30 : 0,
    count * 10,
    new Date().toISOString()
  );

  return { ok: true, item: shape(db.prepare('SELECT * FROM vocab WHERE id = ?').get(id)) };
}

export function updateVocab(tripId, id, patch) {
  const row = db.prepare('SELECT * FROM vocab WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!row) return { error: '只能修改本趟旅行自定义的项' };

  db.prepare('UPDATE vocab SET label = ?, icon = ?, color = ?, soft = ?, lead_minutes = ? WHERE id = ?').run(
    patch?.label !== undefined ? String(patch.label).trim().slice(0, 20) || row.label : row.label,
    patch?.icon !== undefined ? String(patch.icon).slice(0, 4) : row.icon,
    patch?.color !== undefined ? String(patch.color).slice(0, 20) : row.color,
    patch?.soft !== undefined ? String(patch.soft).slice(0, 20) : row.soft,
    Number.isFinite(+patch?.leadMinutes) ? Math.max(0, Math.min(1440, +patch.leadMinutes)) : row.lead_minutes,
    id
  );
  return { ok: true };
}

export function deleteVocab(tripId, id) {
  const row = db.prepare('SELECT * FROM vocab WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!row) return { error: '只能删除本趟旅行自定义的项' };
  // 用到这个 key 的历史数据保留原样，只是失去展示配置
  db.prepare('DELETE FROM vocab WHERE id = ?').run(id);
  return { ok: true };
}
