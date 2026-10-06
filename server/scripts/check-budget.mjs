/**
 * 用真实快照跑一遍 computeBudget，看总预算和实际记账分类的汇总。
 *
 * 口令必须由 PASS 环境变量显式给（默认那组已经不再写进代码库）：
 *   PASS=你的口令 node scripts/check-budget.mjs
 * BASE 可以改成别的地址，默认本机 7020。
 */
import { computeBudget } from '../../web/src/core/budget.js';

const BASE = process.env.BASE || 'http://127.0.0.1:7020';
const PASS = process.env.PASS;
if (!PASS) {
  console.error('缺少 PASS 环境变量：PASS=你的口令 node scripts/check-budget.mjs');
  process.exit(2);
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ passphrase: PASS, name: '我' }),
}).then((r) => r.json());

if (!login.token) {
  console.error('登录失败：', JSON.stringify(login));
  process.exit(2);
}

const snap = await fetch(`${BASE}/api/trip/snapshot`, {
  headers: { Authorization: `Bearer ${login.token}` },
}).then((r) => r.json());

const b = computeBudget({ budgets: snap.budgets, expenses: snap.expenses });

console.log(`总预算 ${b.plannedTotal}  已花 ${b.actualTotal}  剩余 ${b.remaining}\n`);
for (const c of b.spent) {
  console.log(`  ${String(c.category).padEnd(12)} ${String(c.actual).padStart(8)}  ${c.count} 笔`);
}
