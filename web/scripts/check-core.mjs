/**
 * 纯逻辑自测：node 直接跑 core/，不需要浏览器、不需要后端。
 *
 * 护的是 core 这一层 —— 以后移植小程序时，这些文件要求原样可用，
 * 这里跑一遍能先确认它们真的没沾平台的东西。
 *
 * 跑法：node web/scripts/check-core.mjs
 * 退出码：0 = 全通，1 = 有失败。
 */
import { formatMoney, formatDate, addDays, daysBetween, relativeDay, toMinutes } from '../src/core/format.js';
import { normalizeItems, normalizeSnapshot, progress, CHECKLIST_MAX } from '../src/core/checklist.js';
import { computeBudget } from '../src/core/budget.js';
import { computeNow } from '../src/core/timeline.js';
import { buildLongImageModel, pickPhotosByNode } from '../src/core/vlog-model.js';
import { computeAchievements } from '../src/core/achievements.js';

let failures = 0;

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}  实际 ${a} / 期望 ${e}`);
  }
}

function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}${extra ? '  —— ' + extra : ''}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

console.log('\n== format ==');
eq('金额带角分', formatMoney(1234.5), '1,234.50');
eq('金额整数不带小数', formatMoney(1234), '1,234');
eq('浮点误差收敛', formatMoney(0.1 + 0.2), '0.30');
eq('负数金额', formatMoney(-3.5), '-3.50');
eq('日期格式', formatDate('2026-10-06'), '10月6日 周二');
eq('短日期', formatDate('2026-10-06', { short: true }), '10月6日');
eq('跨月加天', addDays('2026-09-30', 2), '2026-10-02');
eq('跨月天数差', daysBetween('2026-09-30', '2026-10-02'), 2);
eq('相对日期', relativeDay('2026-10-07', new Date('2026-10-06T10:00:00')), '明天');
eq('时间转分钟', toMinutes('07:35'), 455);
eq('非法时间', toMinutes('25:00'), null);

console.log('\n== checklist ==');
eq('常量与服务端一致', CHECKLIST_MAX, 20);
{
  const items = normalizeItems(['买机票', { id: 'keep', text: '订民宿', done: true }]);
  eq('纯字符串补成对象', items.length, 2);
  ok('老数据补 id', !!items[0].id && items[0].done === false);
  eq('对象保留 id 与勾选', [items[1].id, items[1].done], ['keep', true]);
  const p = progress(items);
  eq('进度统计', [p.total, p.done, p.allDone], [2, 1, false]);
}
{
  const snap = normalizeSnapshot({
    me: '旧名字',
    meId: 'm2',
    members: [{ id: 'm1', name: '小王' }, { id: 'm2', name: '新名字' }],
    nodes: [{ id: 'n1', checklist: ['临时'] }],
  });
  eq('改名后按 meId 认回「我」', snap.me, '新名字');
  eq('快照里的 checklist 已摊平', typeof snap.nodes[0].checklist[0], 'object');
}

console.log('\n== budget ==');
{
  const b = computeBudget({
    budgets: [{ id: 'b1', planned_amount: 5000 }],
    expenses: [
      { id: 'e1', amount: 120.5, category: 'food', payer: '我', node_id: null },
      { id: 'e2', amount: 80, category: 'food', payer: '同伴', node_id: null },
      { id: 'e3', amount: 300, category: 'ticket', payer: '我', node_id: null },
    ],
  });
  eq('总预算', b.plannedTotal, 5000);
  eq('已花', b.actualTotal, 500.5);
  eq('剩余', b.remaining, 4499.5);
  eq('按类别汇总排序', b.spent.map((r) => [r.category, r.actual]), [['ticket', 300], ['food', 200.5]]);
  eq('按付款人汇总排序', b.paid.map((r) => [r.name, r.paid]), [['我', 420.5], ['同伴', 80]]);
}

console.log('\n== timeline ==');
{
  const trip = { start_date: '2026-10-01', end_date: '2026-10-03' };
  const nodes = [
    { id: 'n1', date: '2026-10-02', start_time: '10:00', end_time: '11:00', status: 'planned', sort_order: 10, title: '古城' },
  ];
  const mid = computeNow({ trip, nodes, checkins: [] }, new Date('2026-10-02T10:30:00'));
  eq('行程中 · 当前项', mid.currentNode?.id, 'n1');
  const before = computeNow({ trip, nodes, checkins: [] }, new Date('2026-09-30T10:00:00'));
  eq('未出发 · 聚焦首日', [before.phase, before.focusDate], ['upcoming', '2026-10-01']);
  const after = computeNow({ trip, nodes, checkins: [] }, new Date('2026-10-04T10:00:00'));
  eq('已结束', after.phase, 'finished');
}

console.log('\n== vlog-model ==');
{
  const nodes = [
    { id: 'n1', date: '2026-10-01', title: 'A' },
    { id: 'n2', date: '2026-10-01', title: 'B' },
    { id: 'n3', date: '2026-10-02', title: 'C' },
  ];
  const photos = ['n1', 'n1', 'n1', 'n2', 'n2', 'n3', 'n3', 'n3'].map((node_id, i) => ({ id: `p${i}`, node_id }));
  const model = buildLongImageModel({
    trip: { start_date: '2026-10-01', end_date: '2026-10-02' },
    nodes,
    photos,
    expenses: [{ id: 'e1', amount: 10, category: 'food', payer: '我', node_id: 'n1' }, { id: 'e2', amount: 5, category: 'misc', payer: '我' }],
    checkins: [{ id: 'c1', node_id: 'n2', action: 'done' }],
    budgets: [{ id: 'b1', planned_amount: 100 }],
  });
  eq('按天分组', model.days.map((d) => [d.date, d.nodes.length]), [['2026-10-01', 2], ['2026-10-02', 1]]);
  eq('消费挂节点 / 不挂分开', [model.expenseByNode.get('n1').length, model.loose.length], [1, 1]);
  ok('完成集合', model.doneByNode.has('n2'));
  eq('预算贯通', [model.budget.plannedTotal, model.budget.actualTotal], [100, 15]);
  const picks = pickPhotosByNode(model);
  eq('单节点最多 2 张', picks.get('n1').length, 2);
  const total = [...picks.values()].reduce((s, v) => s + v.length, 0);
  ok('整趟最多 6 张', total === 6, `实际 ${total} 张`);
}

console.log('\n== achievements ==');
{
  // 用本地时间构造 ISO，早起鸟（7 点前）在任何时区都能稳定验证
  const mk = (y, m, d, h) => new Date(y, m - 1, d, h).toISOString();
  const data = {
    trip: { start_date: '2026-10-01', end_date: '2026-10-03' },
    members: [
      { id: 'm1', name: '我', created_at: mk(2026, 9, 20, 10) },
      { id: 'm2', name: '同伴', created_at: mk(2026, 9, 21, 10) },
    ],
    nodes: [
      { id: 'n1', date: '2026-10-01', status: 'done', checklist: [{ id: 'c1', text: '充电宝', done: true, done_at: mk(2026, 9, 30, 20) }] },
      { id: 'n2', date: '2026-10-01', status: 'done', checklist: [] },
      { id: 'n3', date: '2026-10-02', status: 'planned', role: 'module', checklist: [{ id: 'c2', text: '订票', done: false, done_at: null }] },
    ],
    checkins: [
      { id: 'k1', node_id: 'n1', member_id: 'm1', action: 'done', at_time: mk(2026, 10, 1, 6) },
      { id: 'k2', node_id: 'n2', member_id: 'm2', action: 'done', at_time: mk(2026, 10, 1, 20) },
      { id: 'k3', node_id: 'n1', member_id: 'm2', action: 'arrived', at_time: mk(2026, 10, 1, 9) },
    ],
    photos: [
      { id: 'p1', member_id: 'm1', created_at: mk(2026, 10, 1, 12) },
      { id: 'p2', member_id: 'm1', created_at: mk(2026, 10, 2, 12) },
    ],
    expenses: [{ id: 'e1', amount: 100, payer: '我', category: 'food' }],
    budgets: [{ id: 'b1', planned_amount: 500 }],
  };

  const a = computeAchievements(data, new Date(2026, 9, 5, 12));
  const find = (list, id) => list.find((b) => b.id === id);

  eq('个人：早起鸟解锁（本地 6 点打卡）', find(a.byMember.m1, 'me-early').done, true);
  eq('个人：第一张照片解锁', find(a.byMember.m1, 'me-photo-1').done, true);
  eq('个人：十张照片带进度', find(a.byMember.m1, 'me-photo-10').progress, { done: 2, total: 10 });
  eq('个人：同伴没有照片', find(a.byMember.m2, 'me-photo-1').done, false);
  eq('个人：同伴完成 1 项（五子登科进度）', find(a.byMember.m2, 'me-done-5').progress.done, 1);
  eq('个人：同伴到过 1 站（进度）', find(a.byMember.m2, 'me-stations-3').progress, { done: 1, total: 3 });
  eq('个人：解锁时间取首条打卡', find(a.byMember.m1, 'me-first-checkin').at, mk(2026, 10, 1, 6));

  eq('全队：完美一天解锁', find(a.team, 'team-perfect-day').done, true);
  eq('全队：结伴同行解锁', find(a.team, 'team-companion').done, true);
  eq('全队：一个不落未解锁（还有一条待办）', find(a.team, 'team-checklist').done, false);
  eq('全队：准备就绪未解锁', find(a.team, 'team-prep').done, false);
  eq('全队：全部完成未解锁（3 项完成 2）', find(a.team, 'team-all').done, false);
  eq('全队：量入为出在结束后判定', find(a.team, 'team-budget').done, true);
  eq('全队：旅行中不判量入为出', find(computeAchievements(data, new Date(2026, 9, 2, 12)).team, 'team-budget').done, false);
}

console.log(failures ? `\n${failures} 项失败 ❌\n` : '\n全部通过 ✅\n');
process.exit(failures ? 1 : 0);
