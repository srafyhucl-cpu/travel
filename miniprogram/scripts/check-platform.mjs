/**
 * 在 Node 里把 platform/wx + 共享 store 跑一遍：wx 用内存/ fetch mock，
 * 验证小程序侧平台实现与共享代码的链路 —— 不用打开开发者工具。
 *
 * 只读：登录 + 拉快照 + 本地队列读写；不发任何写请求
 * （登录本身会更新一次 last_used_at，和 web 的 check:order 一样）。
 *
 * 跑法：PASS=你的口令 [NAME=龙哥] node scripts/check-platform.mjs
 * 默认用生产已有成员「龙哥」；别的旅行用 NAME 指定既有成员名，避免登录时新建成员。
 * 退出码：0 = 全通，1 = 有失败，2 = 脚本自己炸了。
 */
const PASS = process.env.PASS;
if (!PASS) {
  console.error('缺少 PASS 环境变量：PASS=你的口令 node scripts/check-platform.mjs');
  process.exit(2);
}
const NAME = (process.env.NAME || '龙哥').trim() || '龙哥';

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

  uploadFile: ({ fail }) => fail({ errMsg: 'uploadFile:fail mock offline' }),

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

  const { createApi, api } = await import('../store/api.js');
  const replayQueue = [{ seq: 1, method: 'POST', path: '/replay', body: { a: 1 } }];
  let failReplay = true;
  const fakeApi = createApi({
    net: {
      send: async () => {
        if (failReplay) {
          failReplay = false;
          throw new Error('offline');
        }
        return { status: 200, ok: true, text: async () => '{}' };
      },
    },
    queue: {
      list: async () => replayQueue.slice(),
      push: async (item) => replayQueue.push({ ...item, seq: replayQueue.length + 1 }),
      remove: async (itemSeq) => {
        const i = replayQueue.findIndex((x) => x.seq === itemSeq);
        if (i >= 0) replayQueue.splice(i, 1);
      },
    },
  });
  const firstReplay = await fakeApi.flushQueue();
  check('离线补传失败不复制队列', replayQueue.length === 1 && firstReplay.done === 0, `queue=${replayQueue.length}`);
  const secondReplay = await fakeApi.flushQueue();
  check('网络恢复后补传并清队列', replayQueue.length === 0 && secondReplay.done === 1, `done=${secondReplay.done}`);

  const { iconDataUri } = await import('../platform/wx/icons.js');
  const icon = iconDataUri('pin', '#F2994A');
  check('图标 data URI 生成', icon.startsWith('data:image/svg+xml;base64,'), icon.slice(0, 42));
  const svg = Buffer.from(icon.split(',')[1], 'base64').toString('utf8');
  check('图标内容正确（颜色+图形）', svg.includes('#F2994A') && svg.includes('<path'), svg.slice(0, 70));
  check('自写 base64 与标准一致', icon.split(',')[1] === Buffer.from(svg, 'utf8').toString('base64'));

  const { renderPoster } = await import('../platform/wx/canvas.js');
  const fills = [];
  const ctx = {
    font: '',
    textAlign: 'left',
    fillStyle: '',
    setTransform() {},
    fillRect() {},
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    closePath() {},
    clip() {},
    measureText: (s) => ({ width: [...String(s)].length * 62 }),
    fillText(text, x, y) {
      fills.push({ text, y, font: this.font });
    },
  };
  await renderPoster({
    canvas: { width: 0, height: 0, getContext: () => ctx },
    template: 'minimal',
    title: '云南四日丽江大理旅行记录完整版纪念',
    location: '丽江',
    accent: '#2F80ED',
    photoSrcs: [],
  });
  const titleFills = fills.filter((f) => f.font.startsWith('500 62px'));
  const locationFill = fills.find((f) => f.font.startsWith('400 28px') && f.text === '◎ 丽江');
  const locationGap = locationFill ? locationFill.y - titleFills[titleFills.length - 1].y : 0;
  check('海报单图两行标题与地点不重叠', titleFills.length === 2 && locationGap >= 80, `lines=${titleFills.length} gap=${locationGap}`);

  let uploadMessage = '';
  try {
    await api.uploadPhotos({ files: [{ filePath: 'mock.png' }] });
  } catch (e) {
    uploadMessage = e.message;
  }
  check('照片上传断网提示可读', uploadMessage === '网络不可用，照片要联网才能传', uploadMessage);

  console.log('\n== 登录 + 快照（真实服务器） ==');
  const res = await actions.login(PASS, NAME);
  check('登录成功', !!res?.token, res?.trip?.name || '');
  check('本地会话说 token 已存', !!platform.session.getToken());
  check('本地会话说 tripId 已存', !!platform.session.getTripId());

  const data = getState().data;
  check('快照到位', !!data?.trip?.id);
  check(
    '节点 / 成员 / 词汇表齐全',
    (data?.nodes?.length || 0) > 0 && (data?.members?.length || 0) > 0 && !!data?.vocab?.byKey
  );
  check(`${NAME} 的身份字段贯通`, !!data?.meId && data?.me === NAME, String(data?.meId || data?.me || ''));

  if (lastToast) console.log(`  （期间有 toast：${lastToast}）`);

  console.log(failures ? `\n${failures} 项失败 ❌\n` : '\n全部通过 ✅\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('脚本自己炸了:', e.message);
  process.exit(2);
});
