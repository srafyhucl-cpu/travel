/**
 * 只读检查：每天内部的时间是不是顺着排的。绝不下任何写操作。
 *
 * 这个不是 UI 测试，走 API 就够，所以不起浏览器、也不复制数据 ——
 * 默认直接打生产（BASE 可以改）。当初 10-02「丽江古城」排在
 * 「玉龙雪山」后面那条时间倒流，就是它查出来的。
 *
 * 登录只许用「龙哥」：口令对了、名字不认识，服务端会顺手建一个新成员 ——
 * 用「我」会在真库留一个空壳成员（已经踩过两次，别再来第三次）。
 *
 * 跑法：
 *   node web/scripts/check-order.cjs                    # 打生产（只读）
 *   BASE=http://localhost:7031 node web/scripts/check-order.cjs
 *
 * 退出码：0 = 没有倒流，1 = 有。
 */
const BASE = process.env.BASE || 'https://travel.hclstudio.cn';
const PASS = process.env.PASS;
if (!PASS) {
  console.error('缺少 PASS 环境变量：先设置这趟旅行的口令再跑，例如  PASS=你的口令 npm run check:order');
  process.exit(2);
}

const toMin = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: PASS, name: '龙哥' }),
  });
  const auth = await login.json();
  if (!auth.token) {
    console.log('登录失败', JSON.stringify(auth));
    process.exit(2);
  }

  const snap = await (await fetch(`${BASE}/api/trip/snapshot`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  })).json();

  const byDay = new Map();
  for (const n of snap.nodes) {
    if (!byDay.has(n.date)) byDay.set(n.date, []);
    byDay.get(n.date).push(n);
  }

  let bad = 0;
  for (const [date, list] of byDay) {
    const sorted = [...list].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    let prev = null;
    for (const n of sorted) {
      const s = toMin(n.start_time);
      if (s === null) { prev = null; continue; }
      // 跨零点的行程（结束 < 开始）允许
      if (prev !== null && s < prev) {
        bad++;
        console.log(`  ✗ ${date}「${n.title}」 ${n.start_time}–${n.end_time} 排在 `
          + `${prev / 60 | 0}:${String(prev % 60).padStart(2, '0')} 之后 —— 时间倒流`);
      }
      const e = toMin(n.end_time);
      prev = e !== null && e > s ? e : s;
    }
  }

  console.log(`\n节点 ${snap.nodes.length} 个 / ${byDay.size} 天 —— ${bad ? `${bad} 处倒流` : '每天内部的时间都是顺的 ✓'}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('脚本自己炸了:', e.message); process.exit(2); });
