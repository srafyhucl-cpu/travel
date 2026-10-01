/**
 * 验证「类型和类别是数据不是代码」：
 * 加几个这条路线独有的类型/类别，看能不能全程用上。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:7021';
let token = '';
let fails = 0;

async function api(method, path, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  try { return { status: res.status, json: JSON.parse(t) }; } catch { return { status: res.status, json: t }; }
}
function check(name, ok, extra = '') {
  if (ok) console.log(`  PASS  ${name}`);
  else { fails++; console.log(`  FAIL  ${name}  ${extra}`); }
}

const PASS = `vocab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

console.log('\n== 建一趟新旅行 ==');
{
  const r = await api('POST', '/api/auth/trips', {
    passphrase: PASS, name: '我', tripName: '川西环线', startDate: '2027-06-10', endDate: '2027-06-16',
  });
  token = r.json.token;
  check('创建成功', r.status === 201, JSON.stringify(r.json).slice(0, 150));
}

console.log('\n== 默认词汇表 ==');
{
  const r = await api('GET', '/api/vocab');
  check('拿到节点类型', r.json.nodeTypes.length >= 8, String(r.json.nodeTypes.length));
  check('拿到消费类别', r.json.categories.length >= 8, String(r.json.categories.length));
  check('航班提前量 180 分钟', r.json.byKey.flight?.leadMinutes === 180, String(r.json.byKey.flight?.leadMinutes));
}

console.log('\n== 加这条路线独有的类型 ==');
let campingId = null;
{
  const r = await api('POST', '/api/vocab', { kind: 'node_type', label: '露营', icon: '⛺', color: '#00897B', leadMinutes: 120 });
  check('新增「露营」类型', r.status === 201, JSON.stringify(r.json).slice(0, 150));
  campingId = r.json.key;
  check('自动生成 key', !!campingId, campingId);
}
{
  const r = await api('POST', '/api/vocab', { kind: 'node_type', label: '徒步', icon: '🥾', leadMinutes: 45 });
  check('新增「徒步」类型', r.status === 201);
}
{
  const r = await api('POST', '/api/vocab', { kind: 'expense_category', label: '车辆租赁', icon: '🚙' });
  check('新增「车辆租赁」类别', r.status === 201);
}
{
  const r = await api('POST', '/api/vocab', { kind: 'expense_category', label: '油费', icon: '⛽' });
  check('新增「油费」类别', r.status === 201);
}

console.log('\n== 用新类型建行程（关键：不能被降级成 other）==');
let nodeId = null;
{
  const r = await api('POST', '/api/nodes', {
    date: '2027-06-11', type: campingId, title: '露营 · 长坪沟口',
    startTime: '18:00', location: '长坪沟', notes: '海拔 3200',
  });
  check('用自定义类型建节点', r.status === 201, JSON.stringify(r.json).slice(0, 200));
  check('类型原样保存（没变成 other）', r.json.type === campingId, `存成了 "${r.json.type}"，期望 "${campingId}"`);
  nodeId = r.json.id;
}

console.log('\n== 用新类别记账 ==');
{
  const r = await api('POST', '/api/money/expenses', { amount: 6800, category: '车辆租赁-x8abc', payer: '我' });
  check('用自定义类别记账', r.status === 201 && r.json.category === '车辆租赁-x8abc', JSON.stringify(r.json).slice(0, 150));
}

console.log('\n== 快照里能拿到展示信息 ==');
{
  const r = await api('GET', '/api/trip/snapshot');
  const camping = r.json.vocab.byKey[campingId];
  check('快照带 vocab', !!camping, JSON.stringify(Object.keys(r.json.vocab || {})));
  check('露营的标签和颜色', camping?.label === '露营' && camping?.icon === '⛺', JSON.stringify(camping));
  check('露营提前量 120 分钟', camping?.leadMinutes === 120, String(camping?.leadMinutes));
  check('标记为自定义项', camping?.custom === true, String(camping?.custom));
  check('航班未被污染', r.json.vocab.byKey.flight?.label === '航班' && r.json.vocab.byKey.flight?.custom === false);
}

console.log('\n== 日历用 vocab 的标签和提醒提前量 ==');
{
  const r = await api('GET', `/api/export/calendar.ics?token=${encodeURIComponent(token)}`);
  const ics = typeof r.json === 'string' ? r.json : '';
  check('露营出现在日历里', ics.includes('露营'), ics.slice(0, 200));
  check('用自定义标签而非「其他」', !ics.includes('其他｜露营'));
  check('提醒提前量为 120 分钟', ics.includes('TRIGGER:-PT120M'), ics.match(/TRIGGER:[^\r]*/)?.[0]);
}

console.log('\n== 别的旅行不受影响 ==');
{
const first = token;
const other = await api('POST', '/api/auth/trips', {
passphrase: `${PASS}-other`, name: '别人', tripName: '另一趟旅行', startDate: '2028-01-01',
});
token = other.json.token;
const r = await api('GET', '/api/vocab');
const leaked = r.json.nodeTypes.find((t) => t.key === campingId);
check('自定义项不会泄漏到别的旅行', !leaked, JSON.stringify(leaked));
check('别的旅行仍能看到默认类型', r.json.nodeTypes.some((t) => t.key === 'flight'));
token = first;
}

console.log('\n== 非法 key 被净化（而不是原样入库）==');
{
const r = await api('POST', '/api/nodes', { date: '2027-06-11', type: '<script>alert(1)</script>', title: 'xss 尝试' });
check('请求本身不报错', r.status === 201, String(r.status));
check('类型被降级为 other 而非原样存下', r.json.type === 'other', `存成了 "${r.json.type}"`);
}

console.log(`\n${fails === 0 ? '全部通过 ✅' : `${fails} 项失败 ❌`}\n`);
process.exit(fails === 0 ? 0 : 1);
