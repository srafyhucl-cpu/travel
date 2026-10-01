/**
 * 验证「换一条完全不同的路线，不改任何代码」能不能走通。
 * 模拟：新建一趟川西环线自助，全程只用 API，不碰任何硬编码。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:7021';

async function call(method, path, body, token = '') {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  let j = null;
  try { j = JSON.parse(t); } catch { j = t; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

const PASS = `chuanxi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

console.log('1) 用一个从未见过的口令创建新旅行');
const created = await call('POST', '/api/auth/trips', {
  passphrase: PASS,
  name: '自驾',
  tripName: '川西环线 7 日自驾',
  startDate: '2027-06-10',
  endDate: '2027-06-16',
  destination: '成都 · 甘孜 · 稻城',
});
const token = created.token;
console.log(`   ok  ${created.trip.name}  id=${created.trip.id}`);

console.log('\n2) 加一堆这条路线独有的行程类型（露营/徒步/补给/修车…）');
const plan = [
  { date: '2027-06-10', type: 'car',    title: '成都提车 · 装物资',      startTime: '09:00', endTime: '11:00', location: '成都', transportMinutes: 30 },
  { date: '2027-06-10', type: 'other',   title: '采购：气罐+折叠桌',     startTime: '14:00', location: '成都', notes: '县城超市比成都便宜' },
  { date: '2027-06-11', type: 'spot',   title: '都江堰 → 四姑娘山',      startTime: '08:30', endTime: '16:00', location: '四姑娘山', transportMinutes: 300 },
  { date: '2027-06-11', type: 'other',   title: '露营 · 长坪沟口',        startTime: '18:00', location: '长坪沟', notes: '海拔 3200，注意高反' },
  { date: '2027-06-12', type: 'spot',   title: '徒步 长坪沟到木骡子',    startTime: '07:00', endTime: '15:00', location: '木骡子', transportMinutes: 10 },
  { date: '2027-06-12', type: 'other',   title: '车辆保养（高海拔山路）',  startTime: '17:00', location: '日隆镇', notes: '检查刹车和胎压' },
  { date: '2027-06-13', type: 'car',    title: '翻折多山 · 垭口 4685',   startTime: '08:00', endTime: '12:00', location: '折多山', transportMinutes: 180 },
  { date: '2027-06-14', type: 'spot',   title: '理塘 · 午餐补给',        startTime: '12:30', location: '理塘' },
  { date: '2027-06-14', type: 'hotel',  title: '住宿 理塘',              startTime: '19:00', location: '理塘' },
  { date: '2027-06-15', type: 'spot',   title: '稻城亚丁 · 长线',        startTime: '06:00', endTime: '19:00', location: '稻城亚丁', notes: '海拔 4700，量力而行' },
  { date: '2027-06-16', type: 'flight', title: '成都天府 → 回家',        startTime: '15:00', location: '成都天府国际机场', transportMinutes: 300 },
];
for (const n of plan) await call('POST', '/api/nodes', n, token);
console.log(`   ok  ${plan.length} 条节点全部写入`);

console.log('\n3) 加这条路线独有的预算类别');
for (const b of [
  { category: '车辆租赁', amount: 6800 },
  { category: '油费', amount: 2200 },
  { category: '露营装备', amount: 1500 },
  { category: '高原餐食', amount: 1800 },
]) {
  await call('POST', '/api/money/budgets', b, token);
}
console.log('   ok  车辆租赁 / 油费 / 露营装备 / 高原餐食');

console.log('\n4) 记两笔账并 AA 分摊');
await call('POST', '/api/money/expenses', { amount: 486, category: '油费', payer: '我', occurredAt: '2027-06-12T10:00:00+08:00' }, token);
await call('POST', '/api/money/expenses', { amount: 128, category: '露营装备', payer: '同伴', occurredAt: '2027-06-11T15:00:00+08:00' }, token);
console.log('   ok  两笔消费');

console.log('\n5) 打卡 + 自动顺延');
const snap = await call('GET', '/api/trip/snapshot', null, token);
const hike = snap.nodes.find((n) => n.title.includes('长坪沟到木骡子'));
await call('POST', '/api/checkins', { nodeId: hike.id, action: 'departed' }, token);
await call('POST', '/api/checkins', { nodeId: hike.id, action: 'done' }, token);
await call('POST', '/api/nodes/shift', { fromNodeId: snap.nodes.find((n) => n.title.includes('保养')).id, minutes: 120 }, token);
const after = await call('GET', '/api/trip/snapshot', null, token);
const fixed = after.nodes.find((n) => n.title.includes('保养'));
const hikeAfter = after.nodes.find((n) => n.id === hike.id);
console.log(`   ok  打卡后状态 ${hikeAfter.status} ；后续「车辆保养」顺延到 ${fixed.start_time}`);

console.log('\n6) 导出模板（应能反过来复用到云南那趟）');
const tpl = await call('GET', '/api/export/template?token=' + encodeURIComponent(token));
console.log(`   ok  模板 ${tpl.days.length} 天 / ${tpl.days.reduce((s, d) => s + d.nodes.length, 0)} 个节点`);

console.log(`\n结论：全程 0 处代码改动，「川西环线」这趟已经建好并可正常使用。\n`);
