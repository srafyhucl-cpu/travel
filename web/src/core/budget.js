/**
 * 总预算对照。纯逻辑，可直接复用到小程序。
 */

/**
 * 总预算对照。
 *
 * 预算是整趟旅行一个总数，不再按类别分行；「已花」直接按实际记账的类别汇总，
 * 跟预算行没有关系。记的是什么类别就显示什么类别，不会被硬塞进别的预算行。
 */
export function computeBudget({ budgets = [], expenses = [] }) {
  const plannedTotal = budgets.reduce((s, b) => s + (+b.planned_amount || 0), 0);
  const actualTotal = expenses.reduce((s, e) => s + (+e.amount || 0), 0);

  const map = new Map();
  for (const e of expenses) {
    const key = String(e.category || 'misc');
    if (!map.has(key)) map.set(key, { category: key, actual: 0, count: 0 });
    const row = map.get(key);
    row.actual = round2(row.actual + (+e.amount || 0));
    row.count += 1;
  }

  const spent = [...map.values()].sort(
    (a, b) => b.actual - a.actual || a.category.localeCompare(b.category)
  );

  const paidMap = new Map();
  for (const e of expenses) {
    const name = String(e.payer || '').trim() || '未记';
    if (!paidMap.has(name)) paidMap.set(name, { name, paid: 0, count: 0 });
    const row = paidMap.get(name);
    row.paid = round2(row.paid + (+e.amount || 0));
    row.count += 1;
  }
  const paid = [...paidMap.values()].sort((a, b) => b.paid - a.paid);

  return {
    plannedTotal,
    actualTotal,
    remaining: round2(plannedTotal - actualTotal),
    rate: plannedTotal > 0 ? actualTotal / plannedTotal : null,
    over: plannedTotal > 0 && actualTotal > plannedTotal,
    spent,
    paid,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

