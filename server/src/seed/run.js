/**
 * 预填云南这趟行程。
 *   node src/seed/run.js [口令]
 * 口令不传则默认 yunnan2026（可用 SEED_PASSPHRASE 环境变量覆盖）。
 * 已经存在同口令的旅行时会直接退出，不会重复写入。
 */
import { db, nowISO, uid } from '../db.js';
import { hashPassphrase } from '../auth.js';
import { TRIP, NODES, BUDGETS, EXPENSES } from './yunnan.js';

const PASSPHRASE = (process.argv[2] || process.env.SEED_PASSPHRASE || 'yunnan2026').trim();
const OWNER = (process.argv[3] || process.env.SEED_OWNER || '我').trim();

if (PASSPHRASE.length < 4) {
  console.error('口令至少 4 位');
  process.exit(1);
}

const hash = hashPassphrase(PASSPHRASE);
const existing = db.prepare('SELECT * FROM trip_keys WHERE key_hash = ?').get(hash);
if (existing) {
  const trip = db.prepare('SELECT name FROM trips WHERE id = ?').get(existing.trip_id);
  console.log(`口令已存在，对应旅行「${trip?.name ?? '未知'}」。要重新预填请先在 App 里删掉，或换一个口令。`);
  process.exit(0);
}

const now = nowISO();
const tripId = uid();

// 按日期分组排序，保证 sort_order 在天内连续
const byDate = new Map();
for (const n of NODES) {
  if (!byDate.has(n.date)) byDate.set(n.date, []);
  byDate.get(n.date).push(n);
}

const seed = db.transaction(() => {
  db.prepare(
    `INSERT INTO trips (id, name, destination, start_date, end_date, theme, is_template, created_at, updated_at)
     VALUES(?,?,?,?,?,?,0,?,?)`
  ).run(tripId, TRIP.name, TRIP.destination, TRIP.startDate, TRIP.endDate, TRIP.theme, now, now);

  db.prepare('INSERT INTO trip_keys (id, trip_id, key_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid(), tripId, hash, OWNER, now, now);

  db.prepare('INSERT INTO members (id, trip_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uid(), tripId, OWNER, '#E2574C', now);

  const ins = db.prepare(
    `INSERT INTO nodes (id, trip_id, day_index, date, type, title, start_time, end_time, location, nav_keyword,
                        notes, checklist, transport_minutes, sort_order, status, actual_start, actual_end,
                        created_at, updated_at)
     VALUES (@id, @trip_id, @day_index, @date, @type, @title, @start_time, @end_time, @location, @nav_keyword,
             @notes, @checklist, @transport_minutes, @sort_order, 'planned', NULL, NULL, @created_at, @updated_at)`
  );

  const dates = [...byDate.keys()].sort();
  const idByTitle = new Map();
  let total = 0;

  dates.forEach((date, dayIndex) => {
    byDate.get(date).forEach((n, i) => {
      const id = uid();
      idByTitle.set(n.title, id);
      ins.run({
        id,
        trip_id: tripId,
        day_index: dayIndex,
        date,
        type: n.type,
        title: n.title,
        start_time: n.startTime ?? null,
        end_time: n.endTime ?? null,
        location: n.location ?? null,
        nav_keyword: n.navKeyword ?? null,
        notes: n.notes ?? null,
        checklist: n.checklist?.length ? JSON.stringify(n.checklist) : null,
        transport_minutes: n.transportMinutes ?? null,
        sort_order: i * 10,
        created_at: now,
        updated_at: now,
      });
      total++;
    });
  });

  const insBudget = db.prepare(
    'INSERT INTO budgets (id, trip_id, category, vocab_key, planned_amount, sort_order) VALUES (@id, @trip_id, @category, @vocab_key, @planned_amount, @sort_order)'
  );
  BUDGETS.forEach((b, i) => {
    insBudget.run({ id: uid(), trip_id: tripId, category: b.category, vocab_key: b.vocabKey ?? null, planned_amount: b.amount, sort_order: i * 10 });
  });

  const members = db.prepare('SELECT name FROM members WHERE trip_id = ?').all(tripId).map((m) => m.name);
  const insExpense = db.prepare(
    `INSERT INTO expenses (id, trip_id, node_id, category, amount, payer, participants, occurred_at, note, created_at, updated_at)
     VALUES (@id, @trip_id, @node_id, @category, @amount, @payer, @participants, @occurred_at, @note, @created_at, @updated_at)`
  );
  for (const e of EXPENSES) {
    insExpense.run({
      id: uid(),
      trip_id: tripId,
      node_id: e.nodeTitle ? idByTitle.get(e.nodeTitle) ?? null : null,
      category: e.category,
      amount: e.amount,
      payer: e.payer,
      participants: JSON.stringify(members),
      occurred_at: new Date(e.occurredAt).toISOString(),
      note: e.note ?? null,
      created_at: now,
      updated_at: now,
    });
  }

  return total;
});

const nodeCount = seed();
const budgetTotal = BUDGETS.reduce((s, b) => s + b.amount, 0);

console.log(`
已预填旅行「${TRIP.name}」
  行程节点   ${nodeCount} 条（${[...byDate.keys()].sort().join(' / ')}）
  预算类别   ${BUDGETS.length} 项，合计 ¥${budgetTotal}
  初始消费   ${EXPENSES.length} 条

登录口令   ${PASSPHRASE}
  （同伴在 App 里输入同一个口令，输入的名字就是他的成员身份）
`);

process.exit(0);
