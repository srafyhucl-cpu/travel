/**
 * 验证「轻量版本号 rev」：写操作自增、快照携带、SSE 广播携带。
 * 轮询端（小程序 20s 轮询）靠它决定要不要拉全量快照。
 *
 * 用法：先起本地后端（默认 127.0.0.1:7021），然后
 *   node scripts/test-rev.js
 *   BASE=http://127.0.0.1:7045 node scripts/test-rev.js
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
  try {
    return { status: res.status, json: JSON.parse(t) };
  } catch {
    return { status: res.status, json: t };
  }
}
function check(name, ok, extra = '') {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    fails++;
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

const PASS = `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

console.log('\n== 建一趟新旅行（不碰任何既有数据） ==');
{
  const r = await api('POST', '/api/auth/trips', {
    passphrase: PASS,
    name: '我',
    tripName: 'rev 测试',
    startDate: '2027-01-01',
    endDate: '2027-01-02',
  });
  token = r.json.token;
  check('创建成功', r.status === 201, JSON.stringify(r.json).slice(0, 150));
}

console.log('\n== rev 基线 ==');
let rev0 = 0;
{
  const r = await api('GET', '/api/trip/rev');
  check('GET /api/trip/rev 返回数字', typeof r.json.rev === 'number', JSON.stringify(r.json));
  rev0 = r.json.rev;
}

console.log('\n== 写操作让 rev 自增，快照携带 ==');
{
  const c = await api('POST', '/api/nodes', { date: '2027-01-01', title: 'rev 测试项' });
  check('新建行程项', c.status === 201, JSON.stringify(c.json).slice(0, 150));

  const r = await api('GET', '/api/trip/rev');
  check('新建后 rev 自增', r.json.rev > rev0, `${rev0} -> ${r.json.rev}`);

  const s = await api('GET', '/api/trip/snapshot');
  check('快照携带 rev', s.json.rev === r.json.rev, `snapshot=${s.json.rev} rev=${r.json.rev}`);
  check('快照里有新项', (s.json.nodes || []).some((n) => n.title === 'rev 测试项'));

  await api('DELETE', `/api/nodes/${c.json.id}`);
  const r2 = await api('GET', '/api/trip/rev');
  check('删除也自增', r2.json.rev > r.json.rev, `${r.json.rev} -> ${r2.json.rev}`);
}

console.log('\n== SSE 广播携带 rev ==');
try {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/trip/stream?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  check('流连接成功', res.ok && (res.headers.get('content-type') || '').includes('text/event-stream'));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readEvent = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buf += dec.decode(value, { stream: true });
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
      }
    }
  };
  const hello = await readEvent();
  check('收到 hello', hello.type === 'hello', JSON.stringify(hello).slice(0, 100));

  const before = (await api('GET', '/api/trip/rev')).json.rev;
  const w = await api('POST', '/api/nodes', { date: '2027-01-02', title: 'rev 广播项' });
  const evt = await Promise.race([
    readEvent(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('等待广播超时')), 5000)),
  ]);
  check('广播事件携带新 rev', evt.rev === before + 1, `evt=${JSON.stringify(evt).slice(0, 100)} before=${before}`);
  ctrl.abort();
  await api('DELETE', `/api/nodes/${w.json.id}`);
} catch (e) {
  fails += 1;
  console.log(`  FAIL  SSE 检查异常  ${e.message}`);
}

console.log(fails === 0 ? '\nrev 全部通过 ✓' : `\n有 ${fails} 处失败 ✗`);
process.exit(fails === 0 ? 0 : 1);
