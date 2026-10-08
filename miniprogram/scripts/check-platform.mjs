/**
 * 在 Node 里把 platform/wx + 共享 store 跑一遍：wx 用内存/ fetch mock，
 * 验证小程序侧平台实现与共享代码的链路 —— 不用打开开发者工具。
 *
 * 只读：登录 + 拉快照 + 本地队列读写；不发任何写请求
 * （登录本身会更新一次 last_used_at，和 web 的 check:order 一样）。
 *
 * 跑法：PASS=你的口令 node scripts/check-platform.mjs
 * 退出码：0 = 全通，1 = 有失败，2 = 脚本自己炸了。
 */
const PASS = process.env.PASS;
if (!PASS) {
  console.error('缺少 PASS 环境变量：PASS=你的口令 node scripts/check-platform.mjs');
  process.exit(2);
}

/* ---------------- wx mock：只实现 store/platform 用到的部分 ---------------- */
const kv = new Map();
let lastToast = '';

globalThis.wx = {
  getStorageSync: (k) => (kv.has(k) ? kv.get(k) : ''),
  setStorageSync: (k, v) => kv.set(k, v),
  removeStorageSync: (k) => kv.delete(k),

  request: ({ url, method = 'GET', header = {}, data, success, fail }) => {
    fetch(url, {
      method,
      headers: header,
      body: data === undefined ? undefined : JSON.stringify(data),
    })
      .then(async (res) => {
        const text = await res.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        success({ statusCode: res.status, data: parsed });
      })
      .catch((e) => fail({ errMsg: String(e?.message || e) }));
  },

  showToast: ({ title }) => {
    lastToast = title;
  },
  onNetworkStatusChange: () => {},
  offNetworkStatusChange: () => {},
  onAppShow: () => {},
  offAppShow: () => {},
  vibrateShort: () => {},
  setClipboardData: ({ success } = {}) => success?.(),
};

/* ---------------- 断言 ---------------- */
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}${extra ? '  —— ' + extra : ''}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}  ${extra}`);
  }
};

(async () => {
  const { platform } = await import('../platform/index.js');
  const { actions, getState } = await import('../store/store.js');

  console.log('\n== platform/wx 基础 ==');
  platform.session.setToken('t1');
  check('session 读写', platform.session.getToken() === 't1');
  platform.session.clear();
  check('session clear', platform.session.getToken() === null);

  await platform.storage.saveSnapshot('trip-x', { hello: 'world' });
  check('快照写入/读回', (await platform.storage.loadSnapshot('trip-x'))?.hello === 'world');
  await platform.storage.dropSnapshot('trip-x');
  check('快照删除', (await platform.storage.loadSnapshot('trip-x')) === null);

  const seq = await platform.queue.push({ method: 'POST', path: '/x', body: { a: 1 } });
  check('队列写入', (await platform.queue.size()) === 1);
  const list = await platform.queue.list();
  check('队列带 seq', list[0]?.seq === seq);
  await platform.queue.remove(seq);
  check('队列删除', (await platform.queue.size()) === 0);

  const { iconDataUri } = await import('../platform/wx/icons.js');
  const icon = iconDataUri('pin', '#F2994A');
  check('图标 data URI 生成', icon.startsWith('data:image/svg+xml;base64,'), icon.slice(0, 42));
  const svg = Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  check('图标内容正确（颜色+图形）', svg.includes('#F2994A') && svg.includes('<path'), svg.slice(0, 70));
  check('自写 base64 与标准一致', icon.split(',')[1] === Buffer.from(svg, 'utf8').toString('base64'));

  console.log('\n== 登录 + 快照（真实服务器） ==');
  const res = await actions.login(PASS, '我');
  check('登录成功', !!res?.token, res?.trip?.name || '');
  check('本地会话说 token 已存', !!platform.session.getToken());
  check('本地会话说 tripId 已存', !!platform.session.getTripId());

  const data = getState().data;
  check('快照到位', !!data?.trip?.id);
  check(
    '节点 / 成员 / 词汇表齐全',
    (data?.nodes?.length || 0) > 0 && (data?.members?.length || 0) > 0 && !!data?.vocab?.byKey
  );
  check('「我」的身份字段贯通', !!data?.meId || !!data?.me, String(data?.meId || data?.me));

  if (lastToast) console.log(`  （期间有 toast：${lastToast}）`);

  console.log(failures ? `\n${failures} 项失败 ❌\n` : '\n全部通过 ✅\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('脚本自己炸了:', e.message);
  process.exit(2);
});
