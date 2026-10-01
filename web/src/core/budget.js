/**
 * 预算对照与 AA 分摊。纯逻辑，可直接复用到小程序。
 */
import { formatMoney } from './format.js';

/**
 * 预算对照。
 *
 * 预算行的 category 是自由名称（「机票·去程」），而消费的 category 是词汇表 key
 * （「flightfee」），靠 budgets.vocab_key 桥接。一笔消费按时间顺序依次冲抵到还剩
 * 额度的同 key 预算行——去程填满了就自动落到返程，账才对得上。抵不完的归到「未计划」。
 */
export function computeBudget({ budgets = [], expenses = [], members = [] }) {
  const plannedTotal = budgets.reduce((s, b) => s + (+b.planned_amount || 0), 0);
  const actualTotal = expenses.reduce((s, e) => s + (+e.amount || 0), 0);

  const lines = budgets.map((b) => ({
    category: b.category,
    vocabKey: b.vocab_key ?? null,
    planned: +b.planned_amount || 0,
    actual: 0,
    count: 0,
  }));

  const orphans = new Map();
  const ordered = [...expenses].sort((a, b) =>
    String(a.occurred_at || '').localeCompare(String(b.occurred_at || ''))
  );

  for (const e of ordered) {
    const key = String(e.category || '');
    let remaining = +e.amount || 0;

    for (const line of lines) {
      if (remaining <= 0.005) break;
      if (!line.vocabKey || line.vocabKey !== key) continue;
      const room = line.planned - line.actual;
      if (room <= 0.005) continue;
      const take = Math.min(room, remaining);
      line.actual = round2(line.actual + take);
      line.count += 1;
      remaining = round2(remaining - take);
    }

    if (remaining > 0.005) {
      if (!orphans.has(key)) orphans.set(key, { category: key, actual: 0, count: 0 });
      const o = orphans.get(key);
      o.actual = round2(o.actual + remaining);
      o.count += 1;
    }
  }

  const byCategory = [
    ...lines.map((l) => ({
      category: l.category,
      vocabKey: l.vocabKey,
      planned: l.planned,
      actual: l.actual,
      count: l.count,
      remaining: round2(l.planned - l.actual),
      rate: l.planned > 0 ? l.actual / l.planned : null,
      over: l.planned > 0 && l.actual > l.planned,
      unplanned: false,
    })),
    ...[...orphans.values()].map((o) => ({
      category: o.category,
      vocabKey: o.category,
      planned: 0,
      actual: o.actual,
      count: o.count,
      remaining: round2(-o.actual),
      rate: null,
      over: false,
      unplanned: true,
    })),
  ].sort((a, b) => {
    if (a.planned > 0 && b.planned > 0) return a.category.localeCompare(b.category, 'zh');
    return b.planned - a.planned || b.actual - a.actual;
  });

  return {
    plannedTotal,
    actualTotal,
    remaining: round2(plannedTotal - actualTotal),
    rate: plannedTotal > 0 ? actualTotal / plannedTotal : null,
    over: plannedTotal > 0 && actualTotal > plannedTotal,
    byCategory,
  };
}

/**
 * AA 分摊：每笔消费在参与者之间均分。
 * 返回每个人的「垫付额 / 应分摊 / 净额」以及最简转账方案。
 */
export function computeSplit({ expenses = [], members = [] }) {
  const names = [];
  const push = (n) => {
    const name = String(n || '').trim();
    if (name && !names.includes(name)) names.push(name);
  };
  members.forEach((m) => push(m.name));
  expenses.forEach((e) => {
    push(e.payer);
    (Array.isArray(e.participants) ? e.participants : []).forEach(push);
  });

  const stat = new Map(names.map((n) => [n, { name: n, paid: 0, share: 0 }]));

  for (const e of expenses) {
    const amount = +e.amount || 0;
    const payer = String(e.payer || '').trim();
    let parts = Array.isArray(e.participants) ? e.participants.map(String).filter(Boolean) : [];
    if (parts.length === 0) parts = payer ? [payer] : names.slice();
    if (parts.length === 0) continue;

    if (stat.has(payer)) stat.get(payer).paid += amount;

    const each = amount / parts.length;
    for (const p of parts) {
      if (stat.has(p)) stat.get(p).share += each;
    }
  }

  const rows = [...stat.values()].map((s) => ({
    name: s.name,
    paid: round2(s.paid),
    share: round2(s.share),
    net: round2(s.paid - s.share), // 正数 = 别人欠他
  }));

  const creditors = rows.filter((r) => r.net > 0.009).map((r) => ({ name: r.name, amount: r.net })).sort((a, b) => b.amount - a.amount);
  const debtors = rows.filter((r) => r.net < -0.009).map((r) => ({ name: r.name, amount: -r.net })).sort((a, b) => b.amount - a.amount);

  // 最少转账笔数：大的先配对
  const settlement = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const amt = round2(Math.min(c.amount, d.amount));
    if (amt > 0.009) settlement.push({ from: d.name, to: c.name, amount: amt });
    c.amount = round2(c.amount - amt);
    d.amount = round2(d.amount - amt);
    if (c.amount <= 0.009) ci++;
    if (d.amount <= 0.009) di++;
  }

  return {
    rows: rows.sort((a, b) => b.paid - a.paid),
    settlement,
    totalPaid: round2(rows.reduce((s, r) => s + r.paid, 0)),
    settled: settlement.length === 0 && rows.length > 1,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 按天汇总消费，用于记账页的小柱状图 */
export function spendingByDay({ expenses = [] }) {
  const map = new Map();
  for (const e of expenses) {
    const d = String(e.occurred_at || '').slice(0, 10);
    if (!d) continue;
    map.set(d, round2((map.get(d) || 0) + (+e.amount || 0)));
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, amount]) => ({ date, amount }));
}

/** 消费挂在哪个行程节点上，用于"账单自动归到景点" */
export function expensesByNode({ expenses = [] }) {
  const map = new Map();
  for (const e of expenses) {
    if (!e.node_id) continue;
    if (!map.has(e.node_id)) map.set(e.node_id, []);
    map.get(e.node_id).push(e);
  }
  return map;
}

export function describeMoney(n) {
  return `¥${formatMoney(n)}`;
}
