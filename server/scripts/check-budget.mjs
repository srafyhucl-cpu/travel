/** 用真实快照跑一遍 computeBudget，确认消费到底冲抵到哪一行。 */
import { computeBudget } from '../../web/src/core/budget.js';

const login = await fetch('http://127.0.0.1:7020/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ passphrase: 'yunnan2026', name: '我' }),
}).then((r) => r.json());

const snap = await fetch('http://127.0.0.1:7020/api/trip/snapshot', {
  headers: { Authorization: `Bearer ${login.token}` },
}).then((r) => r.json());

const b = computeBudget({ budgets: snap.budgets, expenses: snap.expenses, members: snap.members });

console.log(`总预算 ${b.plannedTotal}  已花 ${b.actualTotal}  剩余 ${b.remaining}\n`);
for (const c of b.byCategory) {
  const bar = c.planned > 0 ? `${Math.round((c.actual / c.planned) * 100)}%` : '—';
  console.log(
    `  ${String(c.category).padEnd(14)} key=${String(c.vocabKey).padEnd(10)} ` +
      `${String(c.actual).padStart(7)} / ${String(c.planned).padEnd(7)} ${bar}` +
      (c.unplanned ? '  (未计划)' : '')
  );
}

const allocated = b.byCategory.filter((c) => c.planned > 0).reduce((s, c) => s + c.actual, 0);
console.log(`\n归入预算行的消费合计 ${allocated} / 实际消费 ${b.actualTotal}`);
