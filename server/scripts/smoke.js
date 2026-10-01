/**
 * 后端接口冒烟测试。用法：先 node src/index.js，再 node scripts/smoke.js
 */
const BASE = process.env.BASE || 'http://127.0.0.1:7021';

// 每次跑用随机口令，这样可以对同一个数据库反复运行
const PASS = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let token = '';
let failures = 0;

async function api(method, path, body, isForm = false) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 200);
  }
  return { status: res.status, json, text };
}

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

console.log('\n== 健康检查 ==');
{
  const r = await api('GET', '/api/health');
  check('health 返回 ok', r.status === 200 && r.json.ok, JSON.stringify(r.json));
}

console.log('\n== 口令登录 ==');
{
  const r = await api('POST', '/api/auth/trips', {
passphrase: PASS,
    name: '我',
    tripName: '云南四日 · 丽江大理',
    startDate: '2026-10-01',
    endDate: '2026-10-04',
    destination: '丽江 · 大理',
    theme: 'plain',
  });
  check('创建旅行', r.status === 201, JSON.stringify(r.json).slice(0, 200));
  token = r.json.token;
  check('拿到 token', !!token);

const dup = await api('POST', '/api/auth/trips', { passphrase: PASS, name: '我', tripName: 'x', startDate: '2026-10-01' });
  check('重复口令被拒', dup.status === 409, JSON.stringify(dup.json).slice(0, 120));
}

{
  const r = await api('POST', '/api/auth/login', { passphrase: '不对的口令', name: '我' });
  check('错误口令被拒', r.status === 401, JSON.stringify(r.json).slice(0, 120));
}

{
const r = await api('POST', '/api/auth/login', { passphrase: PASS, name: '同伴' });
  check('正确口令加入', r.status === 200 && r.json.trip?.id, JSON.stringify(r.json).slice(0, 200));
  check('同伴自动建成员', r.json.member?.name === '同伴', JSON.stringify(r.json.member));
}

console.log('\n== 行程节点 ==');
let nodeIds = [];
{
  const r = await api('POST', '/api/nodes', {
    date: '2026-10-01',
    type: 'flight',
    title: '首都航空 JD5181 · 北京大兴 → 丽江三义',
    startTime: '19:50',
    endTime: '23:10',
    location: '丽江三义国际机场',
    navKeyword: '丽江三义国际机场',
    notes: '落地 23:10，记得提前确认酒店 late check-in',
    checklist: ['确认酒店 late check-in', '充电宝随身'],
    transportMinutes: 40,
  });
  check('创建航班节点', r.status === 201, JSON.stringify(r.json).slice(0, 200));
  nodeIds.push(r.json.id);

  const bad = await api('POST', '/api/nodes', { date: '10/1', title: 'x' });
  check('非法日期被拒', bad.status === 400, JSON.stringify(bad.json).slice(0, 120));
}

{
  const r = await api('POST', '/api/nodes', {
    date: '2026-10-02',
    type: 'spot',
    title: '玉龙雪山 · 云杉坪索道',
    startTime: '07:00',
    endTime: '13:00',
    location: '玉龙雪山',
    notes: '大索道不含在内，不需要抢限流票',
  });
  check('创建景点节点', r.status === 201);
  nodeIds.push(r.json.id);
}

{
  const r = await api('PATCH', `/api/nodes/${nodeIds[1]}`, { startTime: '07:30', status: 'planned' });
  check('修改时间', r.status === 200 && r.json.start_time === '07:30', JSON.stringify(r.json).slice(0, 150));

  const r2 = await api('POST', '/api/nodes/reorder', { orderedIds: [nodeIds[1], nodeIds[0]] });
  check('重排序', r2.status === 200, JSON.stringify(r2.json).slice(0, 120));
}

console.log('\n== 自动顺延 ==');
{
  const before = await api('GET', '/api/trip/snapshot');
  const n = before.json.nodes.find((x) => x.id === nodeIds[1]);
  check('顺延前是 07:30', n.start_time === '07:30', n.start_time);

  const r = await api('POST', '/api/nodes/shift', { fromNodeId: nodeIds[1], minutes: 90 });
  check('顺延 90 分钟', r.status === 200 && r.json.shifted === 1, JSON.stringify(r.json));

  const after = await api('GET', '/api/trip/snapshot');
  const n2 = after.json.nodes.find((x) => x.id === nodeIds[1]);
  check('顺延后是 09:00', n2.start_time === '09:00', n2.start_time);
check('结束时间同步顺延', n2.end_time === '14:30', n2.end_time);
}

console.log('\n== 打卡 ==');
{
  const r = await api('POST', '/api/checkins', { nodeId: nodeIds[1], action: 'arrived' });
  check('记录到达', r.status === 201, JSON.stringify(r.json).slice(0, 150));

  const r2 = await api('POST', '/api/checkins', { nodeId: nodeIds[1], action: 'done' });
  check('记录完成', r2.status === 201);

  const snap = await api('GET', '/api/trip/snapshot');
  const node = snap.json.nodes.find((x) => x.id === nodeIds[1]);
  check('节点状态变 done', node.status === 'done', node.status);
  check('打卡记录 2 条', snap.json.checkins.length === 2, String(snap.json.checkins.length));
}

console.log('\n== 预算与消费 ==');
{
  const b = await api('POST', '/api/money/budgets', { category: '包车', amount: 1400 });
  check('新增预算', b.status === 201, JSON.stringify(b.json).slice(0, 150));

  const e1 = await api('POST', '/api/money/expenses', { amount: 290, category: '门票', payer: '我', note: '玉龙雪山门票', nodeId: nodeIds[1], occurredAt: '2026-10-02T08:00:00+08:00' });
  check('新增消费(挂节点)', e1.status === 201 && e1.json.node_id === nodeIds[1], JSON.stringify(e1.json).slice(0, 200));

  const e2 = await api('POST', '/api/money/expenses', { amount: 120, category: '餐饮', payer: '同伴', occurredAt: '2026-10-02T12:30:00+08:00' });
  check('新增消费(同伴付)', e2.status === 201);

  const snap = await api('GET', '/api/trip/snapshot');
  const me = snap.json.expenses.find((x) => x.id === e1.json.id);
  check('参与者默认全员', Array.isArray(me.participants) && me.participants.length === 2, JSON.stringify(me.participants));

  const neg = await api('POST', '/api/money/expenses', { amount: -5, category: '餐饮', payer: '我' });
  check('负数金额被拒', neg.status === 400, JSON.stringify(neg.json).slice(0, 120));
}

console.log('\n== 快照 ==');
{
  const r = await api('GET', '/api/trip/snapshot');
  check('快照返回', r.status === 200);
  check('节点 2 条', r.json.nodes.length === 2, String(r.json.nodes.length));
  check('成员 2 人', r.json.members.length === 2, JSON.stringify(r.json.members.map((m) => m.name)));
  check('checklist 已解析成数组', Array.isArray(r.json.nodes[0].checklist), JSON.stringify(r.json.nodes[0].checklist));
  check('有 days 分组', Array.isArray(r.json.days) && r.json.days.length === 2, JSON.stringify(r.json.days?.map((d) => d.date)));
}

console.log('\n== 日历导出 ==');
{
  const r = await api('GET', '/api/export/calendar.ics');
  check('ics 返回 200', r.status === 200, String(r.status));
  check('ics 含 VCALENDAR', r.text.includes('BEGIN:VCALENDAR'));
  check('ics 含 VALARM 提醒', r.text.includes('BEGIN:VALARM'));
  check('ics 航班提醒为 3 小时', r.text.includes('TRIGGER:-PT180M'), r.text.match(/TRIGGER:[^\r]*/)?.[0]);
  check('ics 有 CRLF', r.text.includes('\r\n'));
}

console.log('\n== 模板导出 ==');
{
  const r = await api('GET', '/api/export/template');
  check('模板返回', r.status === 200);
  check('模板有 days', Array.isArray(r.json.days) && r.json.days.length === 2, JSON.stringify(r.json.days?.length));
  check('模板节点无 id', r.json.days[0].nodes.every((n) => !n.id));
}

console.log('\n== 鉴权 ==');
{
  const saved = token;
  token = 'garbage.token';
  const r = await api('GET', '/api/trip/snapshot');
  check('坏 token 被拒', r.status === 401, String(r.status));

  const r2 = await fetch(`${BASE}/api/trip/snapshot`).then((x) => x.status);
  check('无 token 被拒', r2 === 401, String(r2));

  token = saved;
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
