/**
 * 开发者工具自动化检查：把「拉起 IDE → 登录 → 行程页渲染」固化成一条命令。
 *
 * 两种模式：
 *
 *   默认（只读，打生产）：
 *     PASS=你的口令 node scripts/check-devtools.mjs
 *     - 先连已开着的自动化桥（ws://127.0.0.1:9420），连不上再让 automator 拉起；
 *     - 等 3 秒；确认会话真能打通生产（必要时用 PASS +「龙哥」登录，只登录不建成员）；
 *     - 断言：当前页是行程页、data.ready === true、days.length > 0；
 *     - 全程收集 console(type=error) 与 exception，有报错或断言失败 → 退出码 1。
 *     ★ 默认模式只能用「龙哥」：生产库用「我」会凭空多出一个空壳成员（历史教训）。
 *
 *   --local（全链路，不碰生产）：
 *     PASS=你的口令 node scripts/check-devtools.mjs --local
 *     - 把 server/data 整份复制到临时目录，另起 7042 端口的后端；
 *     - 小程序里把 travel.base 指向它，登录随便建成员（副本库）；
 *     - 行程页断言；打卡（checkins +1）；行程编辑（改标题/新建/删除/上移）；
 *     - 照片数据层：上传 1×1 PNG → 快照 photos +1 → 删除 → 数量复原；
 *     - 记账闭环：新增 → 时间线账目行 → 编辑（预填/改金额）→ 删除；
 *     - 预算（总预算 5000）；设置页（旅行信息改名）；成就页（徽章网格）；
 *     - 海报（行程长图 + 照片海报出图）；口令（新口令能登、旧口令失效）；
 *     - 若 scripts/fixtures/ 里有 HEIC 样本（或设 HEIC_SAMPLE=<路径>），
 *       追加 HEIC 全链路：上传 → 类型按魔数归一 → 服务端派生 JPEG → 缩略图渲染；
 *     - 跑完还原你原来的会话与 base（IDE 里重启小程序即回原会话）；
 *     - 结束时关掉临时后端、删掉临时数据；真库一个字节都不动。
 *
 * 环境变量：CLI_PATH 覆盖 cli.bat 路径；PROJECT 覆盖小程序工程路径。
 * 退出码：0 全通 / 1 有失败（含连不上开发者工具）/ 2 脚本自己炸了（用法、缺依赖等）。
 *
 * 依赖：miniprogram-automator 装在 web/node_modules（web/package.json 的 devDependency），
 * 与 sync-shared.mjs 加载 esbuild 的方式一致，用 createRequire 过去拿，这里不另装一份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_PATH = path.resolve(process.env.PROJECT || path.join(HERE, '..'));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WEB_ROOT = path.join(REPO_ROOT, 'web');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const SRC_DATA = path.join(SERVER_DIR, 'data');

// 临时数据放仓库所在的盘（和 web/scripts/_harness.cjs 一个做法）
const TEMP_DATA = path.join(path.parse(REPO_ROOT).root.replace(/[\\/]$/, ''), 'Temp', 'wx-devtools-testdata');

const CLI_PATH = process.env.CLI_PATH || 'D:\\微信web开发者工具\\cli.bat';
const WS_PORT = 9420;
const WS_ENDPOINT = `ws://127.0.0.1:${WS_PORT}`;
const LOCAL_PORT = 7042;
const LOCAL_BASE = `http://127.0.0.1:${LOCAL_PORT}`;
const PROD_BASE = 'https://travel.hclstudio.cn'; // 和 platform/wx/net.js 里的生产地址一致
const LOCAL = process.argv.includes('--local');

// 上传用：1×1 的合法 PNG（服务端要过魔数校验，大小无所谓）
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// HEIC 全链路验证用的样本：版权原因不入库，放一张到 fixtures/（或 HEIC_SAMPLE 指路径）
const FIXTURES_DIR = path.join(HERE, 'fixtures');
function findHeicSample() {
  if (process.env.HEIC_SAMPLE && fs.existsSync(process.env.HEIC_SAMPLE)) return process.env.HEIC_SAMPLE;
  try {
    const hit = fs.readdirSync(FIXTURES_DIR).find((f) => /\.hei[cf]$/i.test(f));
    if (hit) return path.join(FIXTURES_DIR, hit);
  } catch {
    /* 目录不存在就跳过 */
  }
  return null;
}

const PASS = process.env.PASS;
if (!PASS) {
  console.error('缺少 PASS 环境变量：先设置这趟旅行的口令再跑，例如  PASS=你的口令 node scripts/check-devtools.mjs');
  process.exit(2);
}

const webRequire = createRequire(path.join(WEB_ROOT, 'package.json'));
let automator;
let automatorVersion = '';
try {
  automator = webRequire('miniprogram-automator');
  automatorVersion = webRequire('miniprogram-automator/package.json').version;
} catch {
  console.error(`没找到 miniprogram-automator。先在 web/ 里装：\n  cd "${WEB_ROOT}" && npm i -D miniprogram-automator`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
/** runLocalFlow 登记的收尾动作：无论跑成还是炸了，都把小程序存储还回去 */
let localRestore = null;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!ok) failures += 1;
  return !!ok;
}

const toCount = (v) => (Array.isArray(v) ? v.length : 0);

function parseMaybe(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function stringifyArg(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ------------------------------ 连接开发者工具 ------------------------------ */

function spawnCliAuto() {
  const child = spawn('cmd.exe', ['/c', CLI_PATH, 'auto', '--project', PROJECT_PATH, '--auto-port', String(WS_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = [];
  const collect = (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.trim()) lines.push(line.trim());
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.on('error', (e) => lines.push(`spawn error: ${e.message}`));
  return { child, lines };
}

/** 连上桥还不够：IDE 重启后 9420 会留一个僵尸监听 —— 连得上但背后没有活的调试会话 */
async function probeAlive(mp) {
  for (let i = 0; i < 3; i++) {
    try {
      await Promise.race([
        mp.currentPage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 5000)),
      ]);
      return true;
    } catch {
      await sleep(1200);
    }
  }
  return false;
}

/** 连一次桥并探活；不活就断开返回 null（quiet 时少打日志，轮询用） */
async function tryConnect(quiet = false) {
  let mp;
  try {
    // timeout 调大：IDE 刚冷启动时，第一条命令（编译 + 首屏）经常超过默认的 30 秒
    mp = await automator.connect({ wsEndpoint: WS_ENDPOINT, timeout: 90000 });
  } catch (e) {
    if (!quiet) console.log(`连接 ${WS_ENDPOINT} 失败：${e.message}`);
    return null;
  }
  if (await probeAlive(mp)) {
    console.log(`已连接运行中的自动化桥：${WS_ENDPOINT}`);
    return mp;
  }
  if (!quiet) console.log('桥连上了，但背后没有活的调试会话（IDE 可能刚重启过）');
  try {
    mp.disconnect();
  } catch {
    /* 忽略 */
  }
  return null;
}

async function connectOrLaunch() {
  // 1) 已开着的自动化桥优先（IDE 开着这个项目、开过自动化端口时）
  const live = await tryConnect();
  if (live) return live;

  // 2) 规格要求的 automator.launch
  try {
    const mp = await automator.launch({ cliPath: CLI_PATH, projectPath: PROJECT_PATH, timeout: 120000 });
    console.log('automator.launch 成功');
    return mp;
  } catch (e) {
    console.log(`automator.launch 失败：${e.message}`);
  }

  // 3) 兜底：Node 18.20+/20.12+/22 出于安全修复，直接 spawn 一个 .bat 会 EINVAL，
  //    而 automator.launch 内部就是这么 spawn 的，所以它在这类 Node 上会秒败。
  //    等价地自己拉一次：cmd /c cli.bat auto --project … --auto-port 9420，再连回来。
  console.log('改用 cmd /c 手动拉起 cli auto…（等价于 launch 内部那条命令）');
  const cli = spawnCliAuto();
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const mp = await tryConnect(true);
    if (mp) {
      console.log(`手动拉起后连接成功（等了 ${(i + 1) * 2}s）`);
      return mp;
    }
  }
  const tail = cli.lines.slice(-12).map((l) => `    ${l}`).join('\n');
  throw new Error(
    `拉起开发者工具后仍然连不上 ${WS_ENDPOINT}。\n` +
      `  cliPath：${CLI_PATH}\n  projectPath：${PROJECT_PATH}\n  cli 输出：\n${tail || '    （无输出）'}`
  );
}

/* ------------------------------ 页面操作 ------------------------------ */

/** 在登录页时：口令 + 名字 → 点提交。返回是否真的登录了。 */
async function loginOnPage(mp, name) {
  const page = await mp.currentPage();
  if (page?.path !== 'pages/login/index') return false;
  const inputs = await page.$$('.field .input');
  if (inputs.length < 2) {
    throw new Error(`登录页只找到 ${inputs.length} 个 .field .input，选择器和页面结构对不上了`);
  }
  await inputs[0].input(PASS);
  await inputs[1].input(name);
  const btn = await page.$('.btn-primary');
  if (!btn) throw new Error('登录页找不到 .btn-primary 按钮');
  await btn.tap();
  return true;
}

/** 轮询到行程页 ready 且 days 有内容（最多 ~10 秒），返回最终页面与数据。 */
async function waitTimeline(mp, tries = 10, gap = 1000) {
  let page = null;
  let data = null;
  for (let i = 0; i < tries; i++) {
    page = await mp.currentPage();
    data = page?.path === 'pages/timeline/index' ? await page.data() : null;
    if (data?.ready === true && toCount(data.days) > 0) break;
    if (i < tries - 1) await sleep(gap);
  }
  return { page, data };
}

/** 页面数据里一共有多少张照片（按卡片 + 随手记数） */
function photoCountOf(data) {
  const onNodes = (data?.days || []).reduce(
    (s, d) => s + (d.nodes || []).reduce((x, n) => x + toCount(n.photos), 0),
    0
  );
  return onNodes + toCount(data?.loose);
}

/**
 * 轮询等缩略图拿到本地路径 —— fillThumbs 是异步逐张补的。
 * 这条断言抓过真问题：files 导入缝隙会让有照片的页面在渲染时直接抛错。
 * needle 非空时只认 src 里带这段文字的那张（本地文件名带照片 id，用来避免
 * 抓到 store 里旧数据残留的缩略图 —— 它看起来"渲染成功"，其实张冠李戴）。
 * 每轮都重新取栈顶页：路由刚切过去时，缓存的 page 对象可能还不是栈顶，
 * 对它查元素会直接报 "page is not on top of page stack"。
 */
async function waitThumbSrc(mp, tries = 12, gap = 800, needle = '') {
  let count = 0;
  for (let i = 0; i < tries; i++) {
    try {
      const page = await mp.currentPage();
      const els = await page.$$('.shot-thumb');
      count = els.length;
      for (const el of els) {
        const src = await el.attribute('src');
        if (src && (!needle || src.includes(needle))) return { count, src };
      }
    } catch {
      /* 页面还在切换：下一轮再取栈顶页 */
    }
    if (i < tries - 1) await sleep(gap);
  }
  return { count, src: '' };
}

/** 催一次 store 刷新（下拉刷新走 refresh；不依赖 20 秒轮询） */
async function nudgeRefresh(mp) {
  try {
    const page = await mp.currentPage();
    await page?.callMethod?.('onPullDownRefresh');
  } catch {
    /* 没有 callMethod 也不怕：后面的等待循环能兜住一次 20 秒轮询 */
  }
}

/** 等某个元素出现（面板/路由出现有延迟） */
async function waitForSelector(mp, selector, tries = 16, gap = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const page = await mp.currentPage();
      const el = await page.$(selector);
      if (el) return el;
    } catch {
      /* 切换中 */
    }
    await sleep(gap);
  }
  return null;
}

/** 等栈顶页变成期望的页面：路由切换比 sleep 慢、currentPage 还可能短暂滞后（新版 IDE） */
async function waitPage(mp, expectPath, tries = 12, gap = 500) {
  for (let i = 0; i < tries; i++) {
    try {
      const page = await mp.currentPage();
      if (page?.path === expectPath) return page;
    } catch {
      /* 路由切换中 */
    }
    await sleep(gap);
  }
  return null;
}

/**
 * 确保存储里的令牌真能打通 base —— 页面上可能是上一次会话/副本的旧数据，
 * 「看到行程页」不等于会话有效。四种状态都会收敛：
 *   · 已通 → 直接返回；
 *   · 落在登录页 → 走一次真实 UI 登录；
 *   · 有令牌但打不通 → 催 store 刷新，401 会把页面顶回登录页（下一轮走 UI 登录）；
 *   · 没有令牌 → refresh 会直接早退、等不到 401，直接打登录接口写入会话。
 */
async function ensureSession(mp, { base, name, hint }) {
  const snapOk = async () => {
    try {
      return (await snapshotInApp(mp, base)).status === 200;
    } catch {
      return false; // 连不上也算没对齐，交给循环和最后的断言
    }
  };
  let ok = await snapOk();
  let rawTried = 0;
  for (let i = 0; !ok && i < 10; i++) {
    const page = await mp.currentPage();
    if (page?.path === 'pages/login/index') {
      console.log(`在登录页：用口令 +「${name}」登录（${hint}）…`);
      await loginOnPage(mp, name);
      await sleep(5000);
      ok = await snapOk();
      break;
    }
    const hasToken = await mp.evaluate(() => !!wx.getStorageSync('travel.token'));
    if (hasToken) {
      await nudgeRefresh(mp);
    } else if (rawTried < 2) {
      rawTried += 1;
      const raw = await rawLoginInApp(mp, base, PASS, name);
      if (raw.status === 200 && raw.token) {
        await mp.evaluate(
          (s) => {
            wx.setStorageSync('travel.token', s.token);
            if (s.tripId) wx.setStorageSync('travel.tripId', s.tripId);
            if (s.memberName) wx.setStorageSync('travel.memberName', s.memberName);
          },
          { token: raw.token, tripId: raw.tripId, memberName: raw.memberName }
        );
        console.log('  · 存储里没有令牌，已直接登录并写入会话');
        await nudgeRefresh(mp); // 让 store 用新令牌把页面数据刷成这个库的
      } else {
        console.log(`  · 直接登录失败：status=${raw.status}${raw.error ? ` ${raw.error}` : ''}`);
      }
    }
    await sleep(2500);
    ok = await snapOk(); // 每轮收尾都重查一次（之前漏了这行：令牌写进去了也没人复查）
    if (!ok) console.log(`  · 还没打通（第 ${i + 1} 轮），继续等`);
  }
  return ok;
}

/* ------------------------------ 控制台报错收集 ------------------------------ */

function watchErrors(mp) {
  const errors = [];
  mp.on('console', (msg) => {
    if (msg?.type !== 'error') return;
    errors.push(`console: ${(msg.args || []).map(stringifyArg).join(' ')}`.slice(0, 400));
  });
  // 未捕获异常（也会以 console error 的形式再报一条，这里保留独立的异常信息）
  mp.on('exception', (err) => {
    errors.push(`exception: ${String(err?.message ?? err)}`.slice(0, 400));
  });
  return errors;
}

/* ------------------------------ 小程序内取数（evaluate 里走 wx.request） ------------------------------ */

function snapshotInApp(mp, base) {
  return mp.evaluate(
    (b) =>
      new Promise((resolve, reject) => {
        wx.request({
          url: `${b}/api/trip/snapshot`,
          header: { Authorization: `Bearer ${wx.getStorageSync('travel.token')}` },
          success: (r) => resolve({ status: r.statusCode, data: r.data }),
          fail: (e) => reject(new Error(e.errMsg || 'request failed')),
        });
      }),
    base
  );
}

function patchNodeInApp(mp, base, id, payload) {
  return mp.evaluate(
    (b, nodeId, body) =>
      new Promise((resolve, reject) => {
        wx.request({
          method: 'PATCH',
          url: `${b}/api/nodes/${nodeId}`,
          header: {
            Authorization: `Bearer ${wx.getStorageSync('travel.token')}`,
            'content-type': 'application/json',
          },
          data: body,
          success: (r) => resolve({ status: r.statusCode, data: r.data }),
          fail: (e) => reject(new Error(e.errMsg || 'request failed')),
        });
      }),
    base,
    id,
    payload
  );
}

/** 用 automator 的元素 API 拿一批元素的位置/尺寸（顺序与 page.$$ 一致；避开 evaluate 的序列化坑） */
async function rectsOfElements(els) {
  const out = [];
  for (const el of els) {
    let top = 0;
    let left = 0;
    let w = 0;
    let h = 0;
    try {
      const o = (await el.offset()) || {};
      top = Number(o.top) || 0;
      left = Number(o.left) || 0;
    } catch {
      /* 单个失败给零 */
    }
    try {
      const s = (await el.size()) || {};
      w = Number(s.width) || 0;
      h = Number(s.height) || 0;
    } catch {
      /* 同上 */
    }
    out.push({ top, left, w, h });
  }
  return out;
}

/** 把一段 base64 写进小程序用户目录并上传（wx.uploadFile 的真实链路） */
function uploadBytesInApp(mp, base, { name, b64, nodeId }) {
  return mp.evaluate(
    (b, o) =>
      new Promise((resolve) => {
        const filePath = `${wx.env.USER_DATA_PATH}/${o.name}`;
        try {
          wx.getFileSystemManager().writeFileSync(filePath, o.b64, 'base64');
        } catch (e) {
          resolve({ status: 0, error: `writeFile: ${e.errMsg || e}` });
          return;
        }
        wx.uploadFile({
          url: `${b}/api/photos`,
          filePath,
          name: 'photos',
          header: { Authorization: `Bearer ${wx.getStorageSync('travel.token')}` },
          formData: { nodeId: String(o.nodeId) },
          success: (r) => resolve({ status: r.statusCode, data: r.data }),
          fail: (e) => resolve({ status: 0, error: `uploadFile: ${e.errMsg || e}` }),
        });
      }),
    base,
    { name, b64, nodeId }
  );
}

/** 直接打登录接口拿会话（存储里没有令牌、等不到 401 顶回登录页时的兜底） */
function rawLoginInApp(mp, base, passphrase, name) {
  return mp.evaluate(
    (b, p, n) =>
      new Promise((resolve) => {
        wx.request({
          method: 'POST',
          url: `${b}/api/auth/login`,
          header: { 'content-type': 'application/json' },
          data: { passphrase: p, name: n },
          success: (r) =>
            resolve({
              status: r.statusCode,
              token: r.data?.token || '',
              tripId: r.data?.trip?.id || '',
              memberName: r.data?.member?.name || '',
            }),
          fail: (e) => resolve({ status: 0, error: e.errMsg || 'request failed' }),
        });
      }),
    base,
    passphrase,
    name
  );
}

/** 请求某个变体，返回状态 / Content-Type / 字节数（验证服务端派生图） */
function variantInApp(mp, base, photoId, variant) {
  return mp.evaluate(
    (b, pid, v) =>
      new Promise((resolve) => {
        wx.request({
          url: `${b}/api/photos/${pid}/file?variant=${v}`,
          responseType: 'arraybuffer',
          header: { Authorization: `Bearer ${wx.getStorageSync('travel.token')}` },
          success: (r) =>
            resolve({
              status: r.statusCode,
              type: (r.header && (r.header['Content-Type'] || r.header['content-type'])) || '',
              bytes: r.data ? r.data.byteLength || 0 : 0,
            }),
          fail: (e) => resolve({ status: 0, error: e.errMsg || 'request failed' }),
        });
      }),
    base,
    photoId,
    variant
  );
}

function deletePhotoInApp(mp, base, id) {
  return mp.evaluate(
    (b, pid) =>
      new Promise((resolve, reject) => {
        wx.request({
          method: 'DELETE',
          url: `${b}/api/photos/${pid}`,
          header: { Authorization: `Bearer ${wx.getStorageSync('travel.token')}` },
          success: (r) => resolve({ status: r.statusCode, data: r.data }),
          fail: (e) => reject(new Error(e.errMsg || 'request failed')),
        });
      }),
    base,
    id
  );
}

/** 把跑测试前存的会话与 base 写回去（正常收尾和中断兜底共用） */
function restoreSessionInApp(mp, saved) {
  return mp.evaluate((s) => {
    if (s.base) wx.setStorageSync('travel.base', s.base);
    else wx.removeStorageSync('travel.base');
    if (s.token) wx.setStorageSync('travel.token', s.token);
    else wx.removeStorageSync('travel.token');
    if (s.tripId) wx.setStorageSync('travel.tripId', s.tripId);
    else wx.removeStorageSync('travel.tripId');
    if (s.memberName) wx.setStorageSync('travel.memberName', s.memberName);
    else wx.removeStorageSync('travel.memberName');
  }, saved);
}

/* ------------------------------ 临时后端 ------------------------------ */

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function bootLocalServer() {
  console.log('\n== 准备本机临时后端 ==');
  if (!fs.existsSync(path.join(SRC_DATA, 'travel.db'))) {
    throw new Error(`没找到 ${SRC_DATA}\\travel.db，先确认 server/data 是否完整`);
  }
  fs.rmSync(TEMP_DATA, { recursive: true, force: true });
  copyDir(SRC_DATA, TEMP_DATA);
  console.log(`数据副本：${TEMP_DATA}`);

  const child = spawn('node', ['src/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATA_DIR: TEMP_DATA, PORT: String(LOCAL_PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) {
        throw new Error(`临时后端进程已退出（code ${child.exitCode}）——先确认 ${LOCAL_PORT} 端口没被别的服务占着`);
      }
      let ok = false;
      try {
        ok = (await fetch(`${LOCAL_BASE}/api/health`)).ok;
      } catch {
        /* 还没起来 */
      }
      if (ok) {
        await sleep(200);
        if (child.exitCode !== null) {
          throw new Error(`${LOCAL_PORT} 端口上已有别的服务；临时后端起不来，也不该复用别人的`);
        }
        console.log(`临时后端就绪：${LOCAL_BASE}`);
        return child;
      }
      await sleep(250);
    }
    throw new Error('临时后端 15 秒内没有就绪');
  } catch (e) {
    try {
      child.kill();
    } catch {
      /* 可能已经退了 */
    }
    await sleep(600);
    try {
      fs.rmSync(TEMP_DATA, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 留着也不影响结果 */
    }
    throw e;
  }
}

/** 收尾：等进程真的退出再删数据目录（better-sqlite3 退出前还攥着 -shm，删早了 EBUSY）。 */
async function shutdownLocalServer(child) {
  const exited = new Promise((r) => child.once('exit', r));
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
  await Promise.race([exited, sleep(4000)]);
  let cleaned = false;
  for (let i = 0; i < 6 && !cleaned; i++) {
    try {
      fs.rmSync(TEMP_DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      cleaned = true;
    } catch {
      await sleep(400);
    }
  }
  console.log(
    cleaned ? `临时后端已关闭，数据副本已删（${TEMP_DATA}）` : `临时后端已关闭，但副本没删干净：${TEMP_DATA}（不影响结果，可手动删）`
  );
}

/* ------------------------------ 两种流程 ------------------------------ */

async function runDefaultFlow(mp) {
  console.log('\n== 默认模式：只读打生产 ==');
  await sleep(3000); // 等首页编译 + 首屏渲染

  const page = await mp.currentPage();
  console.log(`当前页：${page?.path || '（读不到）'}`);

  // 会话防呆：页面上的数据可能是上一次 --local 留下的副本旧数据 —— 先确认
  // 令牌真能打通生产，再往下断言（跑完 --local 会把会话还原成你原来的状态）
  const ok = await ensureSession(mp, { base: PROD_BASE, name: '龙哥', hint: '只登录，不新建成员' });
  check('会话有效（生产快照 200）', ok, ok ? '快照 200' : '没打通生产');
  await mp.reLaunch('/pages/timeline/index'); // 可能停在设置/海报等页，先回行程页
  await nudgeRefresh(mp); // 把页面数据也刷成生产的，别让断言落在旧数据上
  await sleep(1500);

  const t = await waitTimeline(mp);
  check('当前页是行程页 pages/timeline/index', t.page?.path === 'pages/timeline/index', t.page?.path || '（读不到）');
  check('行程页 data.ready === true', t.data?.ready === true, `ready=${t.data?.ready}`);
  check('days.length > 0', toCount(t.data?.days) > 0, `days=${toCount(t.data?.days)}`);

  // 生产数据有照片时：缩略图必须真的补出本地路径（异步逐张拉，等一等）
  const photos = photoCountOf(t.data);
  if (photos > 0) {
    const thumb = await waitThumbSrc(mp);
    check(
      '时间线渲染出缩略图（本地路径）',
      thumb.count > 0 && !!thumb.src,
      `photos=${photos} thumbs=${thumb.count} src=${(thumb.src || '').slice(0, 60)}`
    );
  } else {
    console.log(`  · 生产数据当前没有照片，跳过缩略图断言`);
  }

  // 清单渲染完整：有清单的卡都该渲染出清单块（「前置」已从时间线移除，模块卡的待办也回到卡上）
  const allNodes = (t.data?.days || []).flatMap((d) => d.nodes || []);
  const expect = allNodes.filter((n) => (n.checklist || []).length).length;
  const blocks = await (await mp.currentPage()).$$('.checks');
  check('时间线清单渲染完整', blocks.length === expect, `checks=${blocks.length} 应有=${expect}`);
}

async function runLocalFlow(mp) {
  console.log('\n== --local 模式：本机临时后端，全链路 ==');

  // 防呆：必须连的是 travel 小程序，别把 travel.base 写进别的项目
  const p0 = await mp.currentPage();
  const known = [
    'pages/timeline/index',
    'pages/login/index',
    'pages/expense/index',
    'pages/node/index',
    'pages/budget/index',
    'pages/achievements/index',
    'pages/settings/index',
    'pages/poster/index',
  ];
  if (!p0 || !known.includes(p0.path)) {
    throw new Error(`当前页不是 travel 小程序（${p0?.path || '读不到页面'}）；--local 会写小程序存储，请先把本项目切到前台`);
  }

  // 先存下你原来的会话：本机开发库和生产库的密钥不同（各自的 pepper/secret），
  // 切到本机后端后生产会话必然 401；跑完要原样还回去。
  const saved = await mp.evaluate((localBase) => {
    const b = wx.getStorageSync('travel.base') || '';
    return {
      base: b === localBase ? '' : b, // 上次中断可能漏下本机地址，当成没有
      token: wx.getStorageSync('travel.token') || '',
      tripId: wx.getStorageSync('travel.tripId') || '',
      memberName: wx.getStorageSync('travel.memberName') || '',
    };
  }, LOCAL_BASE);
  localRestore = () => restoreSessionInApp(mp, saved); // 中途炸了由 main 的 finally 兜底

  // 指向本机后端并回行程页（App 不重启；结尾还原）。
  // 注意：reLaunch 不要塞进 evaluate —— 路由切换会拆掉小程序上下文，evaluate 的
  // 响应就此丢失（automator 侧表现为 "timeout waiting for automator response"）。
  // 用 SDK 自带的 reLaunch：它把 {url} 包好、等路由切换、再返回新页面。
  await mp.evaluate((base) => {
    wx.setStorageSync('travel.base', base);
  }, LOCAL_BASE);
  await mp.reLaunch('/pages/timeline/index');
  await sleep(1500);

  // 会话对齐：看到行程页不等于会话有效 —— 页面上可能还挂着上一次的旧数据
  const sessionReady = await ensureSession(mp, { base: LOCAL_BASE, name: '我', hint: '副本库，随便建成员' });
  check('会话已对齐到本机后端', sessionReady, sessionReady ? '快照 200' : '30 秒内没对齐');

  // 对齐后再刷一次，确保页面数据也来自本机库（旧数据可能是上一次会话的）
  await nudgeRefresh(mp);
  await sleep(1500);

  const t = await waitTimeline(mp);
  check('当前页是行程页 pages/timeline/index', t.page?.path === 'pages/timeline/index', t.page?.path || '（读不到）');
  check('行程页 ready（数据来自本机临时库）', t.data?.ready === true, `ready=${t.data?.ready}`);
  check('days.length > 0', toCount(t.data?.days) > 0, `days=${toCount(t.data?.days)}`);

  const expectedDriveHints = (t.data?.days || []).reduce(
    (sum, day) => sum + (day.nodes || []).filter((n, i) => i > 0 && !n.done && Number(n.driveMinutes) > 0).length,
    0
  );
  const driveHints = await t.page.$$('.drive-hint');
  check(
    '时间线车程提示渲染完整',
    expectedDriveHints > 0 && driveHints.length === expectedDriveHints,
    `hints=${driveHints.length} 应有=${expectedDriveHints}`
  );

  // —— 打卡链路：找一张还没出发的卡，点「出发」→ 临时库 checkins +1 ——
  console.log('\n== 打卡链路 ==');
  {
    const beforeCk = toCount((await snapshotInApp(mp, LOCAL_BASE)).data?.checkins);
    await nudgeRefresh(mp);
    await mp.reLaunch('/pages/timeline/index');
    await sleep(2500);
    const ckPage = await mp.currentPage();
    const acts = await ckPage.$$('.act-btn');
    let dep = null;
    for (const el of acts) {
      const txt = (await el.text()).trim();
      if (txt === '出发' || txt === '✓ 完成' || txt === '完成') {
        dep = el;
        break;
      }
    }
    check('找到可打卡的行程卡', !!dep, `按钮 ${acts.length} 个`);
    if (dep) {
      await dep.tap();
      await sleep(3000);
      const afterCk = toCount((await snapshotInApp(mp, LOCAL_BASE)).data?.checkins);
      check('打卡后临时库 checkins +1', afterCk === beforeCk + 1, `${beforeCk} → ${afterCk}`);
    } else {
      check('打卡后临时库 checkins +1', false, '没有可点的打卡按钮，跳过');
    }
  }

  // —— 行程编辑链路：预填 → 改标题 → 新建 → 删除 → 上移 ——
  console.log('\n== 行程编辑链路 ==');
  {
    const snap = await snapshotInApp(mp, LOCAL_BASE);
    const first = (snap.data?.nodes || [])[0];
    check('快照里有节点可编辑', !!first, first?.id || '（没有节点）');
    if (first) {
      await mp.reLaunch(`/pages/node/index?id=${encodeURIComponent(first.id)}`);
      await sleep(2000);
      const page = await mp.currentPage();
      check('行程编辑页打开', page?.path === 'pages/node/index', page?.path || '（读不到）');
      const titleInput = await page.$('.form .input');
      const val = titleInput ? await titleInput.value() : '';
      check('标题已预填', val === first.title, `value=${val}`);

      const nextTitle = '检查-改标题';
      if (titleInput) {
        await titleInput.input(nextTitle);
        await sleep(300);
        const saveBtn = await page.$('.form .btn-primary');
        if (saveBtn) await saveBtn.tap();
        await sleep(3500);
      }
      const after = await snapshotInApp(mp, LOCAL_BASE);
      const hit = (after.data?.nodes || []).find((n) => n.id === first.id);
      check('改标题保存成功', hit?.title === nextTitle, `title=${hit?.title || '（没找到）'}`);
    } else {
      check('改标题保存成功', false, '没有节点，跳过');
    }
  }

  {
    // 新建：带日期进新建页 → 填标题 → 添加
    const beforeNodes = toCount((await snapshotInApp(mp, LOCAL_BASE)).data?.nodes);
    const anyNode = (await snapshotInApp(mp, LOCAL_BASE)).data?.nodes?.[0];
    const date = anyNode?.date || '';
    await mp.reLaunch(`/pages/node/index${date ? `?date=${encodeURIComponent(date)}` : ''}`);
    await sleep(1800);
    const page = await mp.currentPage();
    const titleInput = await page.$('.form .input');
    if (titleInput) {
      await titleInput.input('检查-新增项');
      await sleep(300);
      const addBtn = await page.$('.form .btn-primary');
      if (addBtn) await addBtn.tap();
      await sleep(3500);
    }
    const after = await snapshotInApp(mp, LOCAL_BASE);
    const nodes = after.data?.nodes || [];
    const created = nodes.find((n) => n.title === '检查-新增项');
    check('新建行程成功', nodes.length === beforeNodes + 1 && !!created, `${beforeNodes} → ${nodes.length}`);

    if (created) {
      // 删除（mock 掉原生确认框）
      await mp.mockWxMethod('showModal', { confirm: true });
      await mp.reLaunch(`/pages/node/index?id=${encodeURIComponent(created.id)}`);
      await sleep(1800);
      const p2 = await mp.currentPage();
      const delBtn = await p2.$('.btn-danger');
      if (delBtn) await delBtn.tap();
      await sleep(3000);
      await mp.restoreWxMethod('showModal');
      const back = toCount((await snapshotInApp(mp, LOCAL_BASE)).data?.nodes);
      check('删除行程成功', back === beforeNodes, `${nodes.length} → ${back}`);
    } else {
      check('删除行程成功', false, '新建失败，跳过');
    }
  }

  {
    // 上移/下移按钮已移除（排序统一走时间线长按拖动，见下一节）——这里只留个提示
    console.log('  · 编辑页的上移/下移已移除，排序由拖动链路覆盖');
  }

  // —— 拖动排序链路：长按卡片拖到前一张上沿，松手后顺序变化；另有取消与「没时间不起拖」 ——
  console.log('\n== 拖动排序链路 ==');
  {
    const snap = await snapshotInApp(mp, LOCAL_BASE);
    const byDate = new Map();
    for (const n of snap.data?.nodes || []) {
      if (!byDate.has(n.date)) byDate.set(n.date, []);
      byDate.get(n.date).push(n);
    }
    await nudgeRefresh(mp);
    await mp.reLaunch('/pages/timeline/index');
    await sleep(2500);
    const page = await mp.currentPage();
    // DOM 顺序 = 页面数据顺序：元素与节点一一对应（用元素 API 拿位置，避开 evaluate 的序列化坑）
    const els = await page.$$('.node');
    const rects = await rectsOfElements(els);
    const flat = ((await page.data())?.days || []).flatMap((d) => d.nodes || []);
    const idxOf = (id) => flat.findIndex((n) => n.id === id);

    // 找相邻两张卡：b 有起止时间（move 的硬性要求），且尽量在视口内（离边缘远一点，别触发自动滚动）
    let pair = null;
    for (const list of byDate.values()) {
      list.sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0));
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1];
        const b = list[i];
        if (!(b.start_time && b.end_time)) continue;
        const ia = idxOf(a.id);
        const ib = idxOf(b.id);
        if (ia < 0 || ib < 0 || !rects[ia] || !rects[ib]) continue;
        const cand = { a, b, ia, ib, ra: rects[ia], rb: rects[ib] };
        const comfy = cand.ra.top >= 150 && cand.rb.top <= 480;
        if (comfy) {
          pair = cand;
          break;
        }
        if (!pair) pair = cand; // 放宽的候选：位置不理想也先留着
      }
      if (pair && pair.ra.top >= 150 && pair.rb.top <= 480) break;
    }
    check('拖动：找到可拖的相邻两项', !!pair, pair ? `b=${pair.b.title}` : '没有');
    if (pair) {
      const { a, b, ib, ra, rb } = pair;
      const cx = Math.round(ra.left + ra.w / 2);
      const cy = Math.round(rb.top + rb.h / 2);
      const ty = Math.max(140, Math.round(ra.top - 8));
      const touch = (x, y) => ({ pageX: x, pageY: y, clientX: x, clientY: y, identifier: 1 });
      const dayOrder = async () => {
        const s = await snapshotInApp(mp, LOCAL_BASE);
        return (s.data?.nodes || [])
          .filter((n) => n.date === b.date)
          .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
          .map((n) => n.id)
          .join(',');
      };

      // —— 第一次：拖上去 → 落点确认面板 → 取消（顺序不变、不落库） ——
      const beforeOrder = await dayOrder();
      await els[ib].touchstart({ touches: [touch(cx, cy)] });
      await sleep(500); // 让 350ms 的长按判定过
      const mid = await page.data();
      check('拖动：长按进入拖动模式', mid?.dragging === true && mid?.dragId === b.id, `dragging=${mid?.dragging} dragId命中=${mid?.dragId === b.id}`);

      // 拖动期间后台快照变化：数据先记住，UI 不能被重画 / 手势不能被作废
      await patchNodeInApp(mp, LOCAL_BASE, a.id, { notes: `拖动刷新检查-${Date.now()}` });
      await nudgeRefresh(mp);
      await sleep(1200);
      const midAfterRefresh = await page.data();
      check(
        '拖动：后台刷新不打断手势',
        midAfterRefresh?.dragging === true && midAfterRefresh?.dragId === b.id,
        `dragging=${midAfterRefresh?.dragging} dragId命中=${midAfterRefresh?.dragId === b.id}`
      );

      await els[ib].touchmove({ touches: [touch(cx, ty)] });
      await sleep(150);
      await els[ib].touchend({ changedTouches: [touch(cx, ty)] });

      const sheet = await waitForSelector(mp, '.drop-sheet', 24, 500);
      check('拖动：松手弹出落点确认', !!sheet, sheet ? 'ok' : '（等不到 .drop-sheet）');
      if (sheet) {
        const rows = await sheet.$$('.drop-row');
        const onRow = await sheet.$('.drop-row.on');
        check('确认面板：新顺序列表 + 被拖项高亮', rows.length >= 2 && !!onRow, `rows=${rows.length}`);
        const cancelBtn = await sheet.$('.drop-cancel');
        if (cancelBtn) await cancelBtn.tap();
        await sleep(1500);
        const orderAfterCancel = await dayOrder();
        const sheetGone = await (await mp.currentPage()).$('.drop-sheet');
        check('拖动：取消后不弹面板、顺序不变', !sheetGone && orderAfterCancel === beforeOrder, `面板关=${!sheetGone} ${orderAfterCancel === beforeOrder ? '顺序未变' : '顺序被改了'}`);
      } else {
        check('确认面板：新顺序列表 + 被拖项高亮', false, '跳过');
        check('拖动：取消后不弹面板、顺序不变', false, '跳过');
      }

      // —— 第二次：同样的手势 → 确认放入（顺序变化） ——
      const els2 = await page.$$('.node');
      const flat2 = ((await page.data())?.days || []).flatMap((d) => d.nodes || []);
      const rects2 = await rectsOfElements(els2);
      const idxA2 = flat2.findIndex((n) => n.id === a.id);
      const idxB2 = flat2.findIndex((n) => n.id === b.id);
      const elB2 = els2[idxB2];
      if (elB2 && rects2[idxB2] && rects2[idxA2]) {
        const cx2 = Math.round(rects2[idxB2].left + rects2[idxB2].w / 2);
        const cy2 = Math.round(rects2[idxB2].top + rects2[idxB2].h / 2);
        const ty2 = Math.max(140, Math.round(rects2[idxA2].top - 8));
        await elB2.touchstart({ touches: [touch(cx2, cy2)] });
        await sleep(500);
        await elB2.touchmove({ touches: [touch(cx2, ty2)] });
        await sleep(150);
        await elB2.touchend({ changedTouches: [touch(cx2, ty2)] });
        const sheet2 = await waitForSelector(mp, '.drop-sheet', 24, 500);
        const okBtn = sheet2 ? await sheet2.$('.drop-ok') : null;
        check('拖动：确认面板可放入', !!okBtn, okBtn ? 'ok' : '（没有 .drop-ok）');
        if (okBtn) await okBtn.tap();
        await sleep(4000); // move 请求 + store 刷新

        const list = (await dayOrder()).split(',');
        const posA = list.indexOf(a.id);
        const posB = list.indexOf(b.id);
        check(
          '拖动：确认后 b 排到 a 前面',
          posB >= 0 && posA >= 0 && posB === posA - 1,
          `顺序=${list.map((id) => (id === a.id ? 'a' : id === b.id ? 'b' : '·')).join('')}`
        );
      } else {
        check('拖动：确认面板可放入', false, '重新取卡片失败，跳过');
        check('拖动：确认后 b 排到 a 前面', false, '跳过');
      }

      // —— 原地松手：不弹面板、顺序不变 ——
      const before3 = await dayOrder();
      const els3 = await page.$$('.node');
      const flat3 = ((await page.data())?.days || []).flatMap((d) => d.nodes || []);
      const elB3 = els3[flat3.findIndex((n) => n.id === b.id)] || elB2;
      if (elB3) await elB3.longpress();
      await sleep(1800);
      const sheet3 = await (await mp.currentPage()).$('.drop-sheet');
      const after3 = await dayOrder();
      check('拖动：原地松手不弹面板、顺序不变', !sheet3 && after3 === before3, `面板=${!!sheet3} ${after3 === before3 ? '顺序未变' : '顺序被改了'}`);
    } else {
      check('拖动：长按进入拖动模式', false, '前置条件不满足，跳过');
      check('拖动：松手弹出落点确认', false, '跳过');
      check('确认面板：新顺序列表 + 被拖项高亮', false, '跳过');
      check('拖动：取消后不弹面板、顺序不变', false, '跳过');
      check('拖动：确认面板可放入', false, '跳过');
      check('拖动：确认后 b 排到 a 前面', false, '跳过');
      check('拖动：原地松手不弹面板、顺序不变', false, '跳过');
    }

    // 没有起止时间的卡：长按不起拖（服务器也不收这种移动）
    const noTime = (snap.data?.nodes || []).find((n) => !n.start_time || !n.end_time);
    if (noTime) {
      const els3 = await page.$$('.node');
      const rects3 = await rectsOfElements(els3);
      const flat3 = ((await page.data())?.days || []).flatMap((d) => d.nodes || []);
      const idx = flat3.findIndex((n) => n.id === noTime.id);
      const elN = idx >= 0 ? els3[idx] : null;
      if (elN && rects3[idx]) {
        const r = rects3[idx];
        const t = (x, y) => ({ pageX: x, pageY: y, clientX: x, clientY: y, identifier: 1 });
        const nx = Math.round(r.left + r.w / 2);
        const ny = Math.round(Math.max(140, r.top + r.h / 2));
        await elN.touchstart({ touches: [t(nx, ny)] });
        await sleep(500);
        const st = await page.data();
        check('拖动：没有时间的卡不起拖', st?.dragging !== true, `dragging=${st?.dragging}`);
        await elN.touchend({ changedTouches: [t(nx, ny)] });
        await sleep(600);
      } else {
        check('拖动：没有时间的卡不起拖', false, '没找到那张卡，跳过');
      }
    } else {
      console.log('  · 这趟没有缺时间的节点，跳过「没时间不起拖」');
    }
  }

  // —— 照片链路：只测接口与数据（UI 由另一路同学做） ——
  console.log('\n== 照片链路（数据层） ==');
  const before = await snapshotInApp(mp, LOCAL_BASE);
  check('快照可拉取', before.status === 200 && !!before.data?.trip, `status=${before.status}`);
  const beforeCount = toCount(before.data?.photos);
  const nodeId = before.data?.nodes?.[0]?.id;
  check('快照里有节点可挂照片', !!nodeId, nodeId || '（没有节点）');

  let uploadedId = null;
  if (before.status === 200 && nodeId) {
    const up = await uploadBytesInApp(mp, LOCAL_BASE, { name: 'wx-check.png', b64: TINY_PNG_B64, nodeId });
    const upData = parseMaybe(up.data);
    uploadedId = (Array.isArray(upData) ? upData[0]?.id : upData?.id) || null;
    check(
      '上传 1×1 PNG',
      (up.status === 200 || up.status === 201) && !!uploadedId,
      `status=${up.status} id=${uploadedId || ''}${up.error ? ` error=${up.error}` : ''}`
    );
  } else {
    check('上传 1×1 PNG', false, '前置条件不满足，跳过');
  }

  if (uploadedId) {
    await nudgeRefresh(mp); // 让 store 立刻看到新照片（不等 20 秒轮询）
    await mp.reLaunch('/pages/timeline/index');
    await sleep(1200);

    // UI 层：新照片的缩略图要真的补出本地路径（files.url → fillThumbs → image src），
    // 且必须就是刚传的那张（src 带照片 id），旧数据的缩略图不算数
    const localThumb = await waitThumbSrc(mp, 25, 800, uploadedId);
    check(
      '时间线渲染出缩略图（本地路径）',
      !!localThumb.src,
      `thumbs=${localThumb.count} src=${(localThumb.src || '').slice(0, 60)}`
    );

    const after = await snapshotInApp(mp, LOCAL_BASE);
    const afterPhotos = Array.isArray(after.data?.photos) ? after.data.photos : [];
    check('上传后快照 photos +1', afterPhotos.length === beforeCount + 1, `${beforeCount} → ${afterPhotos.length}`);
    check(
      '新照片在快照里（挂在节点上）',
      afterPhotos.some((p) => p.id === uploadedId && p.node_id === nodeId),
      `photo=${uploadedId}`
    );

    // 备注：长按照片 → 「编辑备注」→ mock 原生可编辑弹框 → 快照 caption 变化
    const captionText = `检查-照片备注-${Date.now()}`;
    await mp.mockWxMethod('showActionSheet', { tapIndex: 1 });
    await mp.mockWxMethod('showModal', { confirm: true, content: captionText });
    const captionThumb = await (await mp.currentPage()).$('.shot-thumb');
    if (captionThumb) {
      await captionThumb.longpress();
      await sleep(2500);
    }
    await mp.restoreWxMethod('showModal');
    const captionSnap = await snapshotInApp(mp, LOCAL_BASE);
    const captionRow = (captionSnap.data?.photos || []).find((p) => p.id === uploadedId);
    check('照片备注：编辑后写入快照', captionRow?.caption === captionText, `caption=${captionRow?.caption || '（空）'}`);

    // 清空备注：同一个入口返回空字符串，服务端要落成 null
    await mp.mockWxMethod('showModal', { confirm: true, content: '' });
    const clearThumb = await (await mp.currentPage()).$('.shot-thumb');
    if (clearThumb) {
      await clearThumb.longpress();
      await sleep(2500);
    }
    await mp.restoreWxMethod('showModal');
    await mp.restoreWxMethod('showActionSheet');
    const clearSnap = await snapshotInApp(mp, LOCAL_BASE);
    const clearRow = (clearSnap.data?.photos || []).find((p) => p.id === uploadedId);
    check('照片备注：清空后删除备注', clearRow?.caption === null, `caption=${String(clearRow?.caption)}`);

    // 归位：长按照片 → 「挂到某一项」（mock 掉原生菜单）→ 选「不指定」→ 快照 node_id 变 null
    await mp.mockWxMethod('showActionSheet', { tapIndex: 2 });
    const thumbEl = await (await mp.currentPage()).$('.shot-thumb');
    if (thumbEl) {
      await thumbEl.longpress();
      const pickPage = await waitPage(mp, 'pages/nodepick/index');
      check('照片归位：节点选择页打开', !!pickPage, pickPage ? 'ok' : '（等不到 nodepick）');
      const noneBtn = pickPage ? await pickPage.$('.pick-none') : null;
      if (noneBtn) await noneBtn.tap();
      await sleep(2500);
      const snapAfter = await snapshotInApp(mp, LOCAL_BASE);
      const row = (snapAfter.data?.photos || []).find((p) => p.id === uploadedId);
      check('照片归位：移到随手记', row?.node_id === null, `node_id=${row?.node_id === null ? 'null' : String(row?.node_id)}`);
    } else {
      check('照片归位：节点选择页打开', false, '没找到缩略图');
      check('照片归位：移到随手记', false, '跳过');
    }
    await mp.restoreWxMethod('showActionSheet');

    const del = await deletePhotoInApp(mp, LOCAL_BASE, uploadedId);
    check('删除照片', del.status === 200, `status=${del.status}`);

    await mp.reLaunch('/pages/timeline/index');
    await sleep(2000);

    const back = await snapshotInApp(mp, LOCAL_BASE);
    check('删除后 photos 回到原值', toCount(back.data?.photos) === beforeCount, `${afterPhotos.length} → ${toCount(back.data?.photos)}`);
  }

  // —— HEIC 链路（可选）：真样本走一遍 上传 → 类型归一 → 派生 JPEG → 缩略图渲染 ——
  console.log('\n== HEIC 链路（可选：有样本才跑） ==');
  const heicSample = findHeicSample();
  if (!heicSample) {
    console.log(`  · 没找到 HEIC 样本，跳过（放一张到 ${FIXTURES_DIR}，或设 HEIC_SAMPLE=<路径>）`);
  } else {
    const b64 = fs.readFileSync(heicSample).toString('base64');
    console.log(`  · 样本：${path.basename(heicSample)}（${Math.round(b64.length / 1024)}KB base64）`);
    const up = await uploadBytesInApp(mp, LOCAL_BASE, { name: 'check.heic', b64, nodeId });
    const upData = parseMaybe(up.data);
    const heicId = (Array.isArray(upData) ? upData[0]?.id : upData?.id) || null;
    check(
      'HEIC 上传',
      (up.status === 200 || up.status === 201) && !!heicId,
      `status=${up.status} id=${heicId || ''}${up.error ? ` error=${up.error}` : ''}`
    );
    if (heicId) {
      // 类型必须按魔数归一到 image/heic（客户端给的 mimetype 不可信）
      const snap = await snapshotInApp(mp, LOCAL_BASE);
      const row = (snap.data?.photos || []).find((p) => p.id === heicId);
      check('类型按魔数归一到 image/heic', row?.mime === 'image/heic', `mime=${row?.mime || '（没找到）'}`);

      // 服务端派生：HEIC → JPEG
      const thumb = await variantInApp(mp, LOCAL_BASE, heicId, 'thumb');
      check(
        'HEIC 派生缩略图是 JPEG',
        thumb.status === 200 && /image\/jpeg/i.test(thumb.type) && thumb.bytes > 500,
        `status=${thumb.status} type=${thumb.type} bytes=${thumb.bytes}`
      );

      // UI：缩略图真渲染（服务端转出的 JPEG 才能被 <image> 解码），
      // 且必须命中 HEIC 这张 —— 上一次这条断言抓到的其实是旧数据的缩略图
      await nudgeRefresh(mp);
      await mp.reLaunch('/pages/timeline/index');
      await sleep(1200);
      const heicThumb = await waitThumbSrc(mp, 25, 800, heicId);
      check(
        'HEIC 照片的缩略图渲染',
        !!heicThumb.src,
        `thumbs=${heicThumb.count} src=${(heicThumb.src || '').slice(0, 70)}`
      );

      const del = await deletePhotoInApp(mp, LOCAL_BASE, heicId);
      check('HEIC 照片删除', del.status === 200, `status=${del.status}`);
      await mp.reLaunch('/pages/timeline/index');
      await sleep(1500);
    } else {
      check('类型按魔数归一到 image/heic', false, '上传失败，跳过');
      check('HEIC 派生缩略图是 JPEG', false, '上传失败，跳过');
      check('HEIC 照片的缩略图渲染', false, '上传失败，跳过');
      check('HEIC 照片删除', false, '上传失败，跳过');
    }
  }

  // —— 记一笔 / 改一笔 / 删一笔：整条账目闭环 ——
  console.log('\n== 记账链路（新增 → 时间线展示 → 编辑 → 删除） ==');
  {
    const beforeSnap = await snapshotInApp(mp, LOCAL_BASE);
    const beforeExp = toCount(beforeSnap.data?.expenses);
    const beforeIds = new Set((beforeSnap.data?.expenses || []).map((e) => e.id));
    const url = `/pages/expense/index${nodeId ? `?nodeId=${nodeId}` : ''}`;
    await mp.reLaunch(url);
    await sleep(2500);
    const expPage = await mp.currentPage();
    check('记账页打开', expPage?.path === 'pages/expense/index', expPage?.path || '（读不到）');

    let addedId = null;
    if (expPage?.path === 'pages/expense/index') {
      const amountInput = await expPage.$('.amount-input');
      if (amountInput) await amountInput.input('12.5');
      await sleep(500);
      const saveBtn = await expPage.$('.btn-primary');
      if (saveBtn) await saveBtn.tap();
      await sleep(4500); // 提交 + 快照刷新 + 自动回时间线
      const afterSnap = await snapshotInApp(mp, LOCAL_BASE);
      const afterExp = toCount(afterSnap.data?.expenses);
      check('记一笔后临时库账目 +1', afterExp === beforeExp + 1, `${beforeExp} → ${afterExp}`);
      addedId = (afterSnap.data?.expenses || []).find((e) => !beforeIds.has(e.id))?.id || null;
      const backPage = await mp.currentPage();
      check('记完回到时间线', backPage?.path === 'pages/timeline/index', backPage?.path || '（读不到）');

      const addedRow = (afterSnap.data?.expenses || []).find((e) => e.id === addedId);
      check('新账挂在选中的行程上', addedRow?.node_id === nodeId, `node_id=${addedRow?.node_id || '（空）'}`);
      const dt = addedRow?.occurred_at ? Math.abs(Date.now() - new Date(addedRow.occurred_at).getTime()) : Infinity;
      check('新账时间默认「现在」', dt < 10 * 60 * 1000, `occurred_at=${addedRow?.occurred_at || ''}`);
    } else {
      check('记一笔后临时库账目 +1', false, '记账页没打开，跳过');
      check('记完回到时间线', false, '记账页没打开，跳过');
    }

    if (addedId) {
      // 时间线要能看到这笔账（卡片里的账目行）
      await nudgeRefresh(mp);
      await mp.reLaunch('/pages/timeline/index');
      await sleep(1200);
      const rows1 = await (await mp.currentPage()).$$('.mrow');
      let rowText = '';
      for (const el of rows1) {
        const t = await el.text();
        if (t.includes('12.50')) { rowText = t; break; }
      }
      check('时间线出现账目行（¥12.50）', !!rowText, `mrow=${rows1.length}${rowText ? ` text=${rowText.replace(/\s+/g, ' ').slice(0, 30)}` : ''}`);

      // 编辑：预填（金额 + 时间）→ 改金额/时间/挂靠 → 保存
      const beforeEdit = (await snapshotInApp(mp, LOCAL_BASE)).data?.expenses?.find((e) => e.id === addedId);
      const localDate = (iso) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const localTime = (iso) => {
        const d = new Date(iso);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      };
      await mp.reLaunch(`/pages/expense/index?id=${encodeURIComponent(addedId)}`);
      await sleep(2000);
      const editPage = await mp.currentPage();
      const editAmount = await editPage.$('.amount-input');
      const prefilled = editAmount ? await editAmount.value() : '';
      check('编辑页预填金额', String(prefilled) === '12.5', `value=${prefilled}`);

      // 时间预填必须与库里那条一致（本地墙钟）—— 这条抓 UTC/本地 8 小时偏移
      const dateEl = await editPage.$('.time-date');
      const timeEl = await editPage.$('.time-time');
      const shownDate = dateEl ? (await dateEl.text()).trim() : '';
      const shownTime = timeEl ? (await timeEl.text()).trim() : '';
      check(
        '编辑页预填日期',
        !!beforeEdit && shownDate === localDate(beforeEdit.occurred_at),
        `shown=${shownDate} 应为=${beforeEdit ? localDate(beforeEdit.occurred_at) : '（没拿到）'}`
      );
      check(
        '编辑页预填时间',
        !!beforeEdit && shownTime === localTime(beforeEdit.occurred_at),
        `shown=${shownTime} 应为=${beforeEdit ? localTime(beforeEdit.occurred_at) : '（没拿到）'}`
      );

      // 挂在：点开节点选择页 → 当前项打勾 → 选「不指定」→ 回填
      const nodeField = await editPage.$('.node-field');
      if (nodeField) {
        await nodeField.tap();
        const pickPage = await waitPage(mp, 'pages/nodepick/index');
        check('节点选择页打开', !!pickPage, pickPage ? 'ok' : '（等不到 nodepick）');
        const onRow = pickPage ? await pickPage.$('.pick-row.on') : null;
        check('当前挂靠项打勾', !!onRow, onRow ? 'ok' : '没有 .pick-row.on');
        const noneBtn = pickPage ? await pickPage.$('.pick-none') : null;
        if (noneBtn) await noneBtn.tap();
        const backPage = (await waitPage(mp, 'pages/expense/index')) || editPage;
        const backField = await backPage.$('.node-field');
        const fieldText = backField ? (await backField.text()).trim() : '';
        check('选「不指定」后回填', fieldText.includes('不指定'), `text=${fieldText}`);
      } else {
        check('节点选择页打开', false, '编辑页没有 .node-field');
        check('当前挂靠项打勾', false, '跳过');
        check('选「不指定」后回填', false, '跳过');
      }

      // 改金额 + 改时间（原生 picker 弹层自动化点不了，直接改页面数据）→ 保存
      const editPage2 = (await waitPage(mp, 'pages/expense/index')) || editPage;
      const editAmount2 = (await editPage2.$('.amount-input')) || editAmount;
      if (editAmount2) {
        await editAmount2.input('99');
        await sleep(300);
        await editPage2.setData({ time: '07:35' });
        await sleep(300);
        const save2 = await editPage2.$('.btn-primary');
        if (save2) await save2.tap();
        await sleep(4000);
      }
      const afterEdit = await snapshotInApp(mp, LOCAL_BASE);
      const edited = (afterEdit.data?.expenses || []).find((e) => e.id === addedId);
      check('改金额保存成功', Number(edited?.amount) === 99, `amount=${edited?.amount ?? '（没找到）'}`);
      check('改挂靠保存成功（不指定）', edited?.node_id === null, `node_id=${edited?.node_id === null ? 'null' : String(edited?.node_id)}`);
      const wantIso = beforeEdit ? new Date(`${localDate(beforeEdit.occurred_at)}T07:35:00`).toISOString() : '';
      check('改时间保存成功（本地 07:35）', !!wantIso && edited?.occurred_at === wantIso, `occurred_at=${edited?.occurred_at} 应为=${wantIso}`);

      // 时间线上的行跟着变
      await nudgeRefresh(mp);
      await mp.reLaunch('/pages/timeline/index');
      await sleep(1200);
      const rows2 = await (await mp.currentPage()).$$('.mrow');
      let rowText2 = '';
      for (const el of rows2) {
        const t = await el.text();
        if (t.includes('99')) { rowText2 = t; break; }
      }
      check('时间线账目行金额已更新', !!rowText2, `mrow=${rows2.length}`);

      // 删除：mock 掉原生确认框 → 点「删掉」→ 快照里没了
      await mp.mockWxMethod('showModal', { confirm: true });
      await mp.reLaunch(`/pages/expense/index?id=${encodeURIComponent(addedId)}`);
      await sleep(2000);
      const delPage = await mp.currentPage();
      const delBtn = await delPage.$('.btn-danger');
      if (delBtn) await delBtn.tap();
      await sleep(3500);
      await mp.restoreWxMethod('showModal');
      const afterDel = await snapshotInApp(mp, LOCAL_BASE);
      const stillThere = (afterDel.data?.expenses || []).some((e) => e.id === addedId);
      check('删掉这笔成功', !stillThere && toCount(afterDel.data?.expenses) === beforeExp, `expenses=${toCount(afterDel.data?.expenses)}`);
    } else {
      check('时间线出现账目行（¥12.50）', false, '新增失败，跳过');
      check('编辑页预填金额', false, '新增失败，跳过');
      check('改金额保存成功', false, '新增失败，跳过');
      check('时间线账目行金额已更新', false, '新增失败，跳过');
      check('删掉这笔成功', false, '新增失败，跳过');
    }
  }

  // —— 预算链路：进预算页 → 填 5000 → 快照 budgets 合计 5000 ——
  console.log('\n== 预算链路 ==');
  {
    await mp.reLaunch('/pages/budget/index');
    await sleep(1800);
    const page = await mp.currentPage();
    check('预算页打开', page?.path === 'pages/budget/index', page?.path || '（读不到）');
    const input = await page.$('.amount-input');
    if (input) {
      await input.input('5000');
      await sleep(400);
      const save = await page.$('.btn-primary');
      if (save) await save.tap();
      await sleep(3000);
    }
    const snap = await snapshotInApp(mp, LOCAL_BASE);
    const total = (snap.data?.budgets || []).reduce((s, b) => s + (+b.planned_amount || 0), 0);
    check('总预算保存成功', total === 5000, `planned=${total}`);
  }

  // —— 设置链路：旅行信息改名（写的是临时库） ——
  console.log('\n== 设置链路 ==');
  {
    await mp.reLaunch('/pages/settings/index');
    await sleep(2200);
    const page = await mp.currentPage();
    check('设置页打开', page?.path === 'pages/settings/index', page?.path || '（读不到）');
    const chips = await page.$$('.chip');
    // 第一个 .chip 是旅行信息右上角的「编辑」
    if (chips[0]) {
      await chips[0].tap();
      await sleep(800);
      const nameInput = await page.$('.sub-form .input');
      if (nameInput) {
        await nameInput.input('检查-旅行');
        await sleep(400);
        const save = await page.$('.sub-form .btn-primary');
        if (save) await save.tap();
        await sleep(3500);
      }
    }
    const snap = await snapshotInApp(mp, LOCAL_BASE);
    check('旅行信息保存成功', snap.data?.trip?.name === '检查-旅行', `name=${snap.data?.trip?.name || ''}`);
  }

  // —— 成就链路：打开成就页，徽章网格有内容 ——
  console.log('\n== 成就链路 ==');
  {
    await mp.reLaunch('/pages/achievements/index');
    await sleep(2200);
    const page = await mp.currentPage();
    check('成就页打开', page?.path === 'pages/achievements/index', page?.path || '（读不到）');
    const cards = await page.$$('.ach-card');
    check('徽章网格有内容', cards.length > 0, `cards=${cards.length}`);
  }

  // —— 海报链路：长图 → 没照片时照片海报不可用 → 传两张后照片海报出图 + 张数边界 ——
  console.log('\n== 海报链路 ==');
  {
    await mp.reLaunch('/pages/poster/index');
    await sleep(2500);
    let page = await mp.currentPage();
    check('海报页打开', page?.path === 'pages/poster/index', page?.path || '（读不到）');
    let ready = false;
    for (let i = 0; i < 15; i++) {
      const d = await page.data();
      if (d?.previewPath) { ready = true; break; }
      await sleep(2000);
    }
    let d = await page.data();
    check('行程长图出图成功', ready, `previewPath=${(d?.previewPath || '').slice(0, 40)} busy=${d?.busy}`);
    const findPill = async (label) => {
      for (const el of await page.$$('.pill')) {
        if ((await el.text()).trim() === label) return el;
      }
      return null;
    };

    // 这一轮跑在照片链路之后：库里一张照片都没有，照片海报必须点不动
    if (ready) {
      const longPreview = (d?.previewPath || '').slice(0, 40);
      const photoPill = await findPill('照片海报');
      await photoPill?.tap();
      await sleep(1500);
      const dNone = await page.data();
      check(
        '没照片时照片海报不可用',
        !!photoPill && dNone?.photoCount === 0 && dNone?.mode === 'long' && (dNone?.previewPath || '').slice(0, 40) === longPreview,
        `mode=${dNone?.mode} photoCount=${dNone?.photoCount}`
      );
    } else {
      check('没照片时照片海报不可用', false, '长图没出来，跳过');
    }

    // 传两张照片：模式可用、张数选项不许超过现有张数、照片海报能出图
    const posterNodeId = (await snapshotInApp(mp, LOCAL_BASE)).data?.nodes?.[0]?.id || null;
    const posterIds = [];
    for (const name of ['wx-poster-1.png', 'wx-poster-2.png']) {
      const up = await uploadBytesInApp(mp, LOCAL_BASE, { name, b64: TINY_PNG_B64, nodeId: posterNodeId });
      const upData = parseMaybe(up.data);
      const id = (Array.isArray(upData) ? upData[0]?.id : upData?.id) || null;
      if (id) posterIds.push(id);
    }
    // 海报页自己没有下拉刷新：先回时间线把 store 拉新，再进海报
    await mp.reLaunch('/pages/timeline/index');
    await sleep(1200);
    await nudgeRefresh(mp);
    await sleep(1500);
    await mp.reLaunch('/pages/poster/index');
    await sleep(2500);
    page = await mp.currentPage();
    let posterReady = false;
    for (let i = 0; i < 12; i++) {
      const dd = await page.data();
      if (dd?.previewPath && dd?.photoCount === 2) { posterReady = true; break; }
      await sleep(2000);
    }
    const dTwo = await page.data();
    check(
      '只有两张时：张数选项收敛到两张',
      posterIds.length === 2 && dTwo?.photoCount === 2 && dTwo?.count === 2,
      `photos=${dTwo?.photoCount} count=${dTwo?.count} uploaded=${posterIds.length}`
    );

    const photoPill = await findPill('照片海报');
    await photoPill?.tap();
    let photoOut = false;
    for (let i = 0; i < 15; i++) {
      const dd = await page.data();
      if (dd?.mode === 'photo' && dd?.previewPath && !dd?.busy) { photoOut = true; break; }
      await sleep(2000);
    }
    const dPhoto = await page.data();
    check('照片海报出图成功', posterReady && photoOut, `previewPath=${(dPhoto?.previewPath || '').slice(0, 40)} mode=${dPhoto?.mode}`);

    const fourPill = await findPill('4 张');
    await fourPill?.tap();
    await sleep(1200);
    const dFour = await page.data();
    check(
      '张数选项不超过现有照片数',
      !!fourPill && dFour?.count === 2 && dFour?.mode === 'photo',
      `count=${dFour?.count} mode=${dFour?.mode}`
    );

    for (const id of posterIds) await deletePhotoInApp(mp, LOCAL_BASE, id);

    // 出图途中离开页面：在飞的出图/导出回调不许再碰已卸载的页面（控制台结论兑底）
    const longPill = await findPill('行程长图');
    await longPill?.tap();
    await sleep(600);
    await page.callMethod('onRegenerate');
    await sleep(150);
    await mp.reLaunch('/pages/timeline/index');
    await sleep(2000);
    const leftPage = await mp.currentPage();
    check('出图途中离开页面不报错', leftPage?.path === 'pages/timeline/index', leftPage?.path || '（读不到）');

    for (const id of posterIds) await deletePhotoInApp(mp, LOCAL_BASE, id);
  }

  // —— 口令链路（副本库上改，验证新口令能用、旧口令失效） ——
  console.log('\n== 口令链路 ==');
  {
    await mp.reLaunch('/pages/settings/index');
    await sleep(2200);
    const page = await mp.currentPage();
    const rows = await page.$$('.cat-row');
    let passRow = null;
    for (const el of rows) {
      if ((await el.text()).includes('修改旅行口令')) { passRow = el; break; }
    }
    check('找到修改口令入口', !!passRow, passRow ? 'ok' : `cat-row ${rows.length} 个`);
    if (passRow) {
      await passRow.tap();
      await sleep(800);
      const inputs = await page.$$('.sub-form .input');
      check('口令表单有三个输入框', inputs.length === 3, `inputs=${inputs.length}`);
      if (inputs.length === 3) {
        await inputs[0].input(PASS);
        await inputs[1].input(`${PASS}-x`);
        await inputs[2].input(`${PASS}-x`);
        await sleep(400);
        const save = await page.$('.sub-form .btn-primary');
        if (save) await save.tap();
        await sleep(3000);
      }
      const oldTry = await rawLoginInApp(mp, LOCAL_BASE, PASS, '我');
      const newTry = await rawLoginInApp(mp, LOCAL_BASE, `${PASS}-x`, '我');
      check('改口令后旧口令失效', oldTry.status === 401, `status=${oldTry.status}`);
      check('改口令后新口令能用', newTry.status === 200, `status=${newTry.status}`);
    } else {
      check('改口令后旧口令失效', false, '入口没找到，跳过');
      check('改口令后新口令能用', false, '入口没找到，跳过');
    }
  }

  // 收尾：把跑测试前的会话与 base 原样还回去（IDE 里重启小程序即可回到原会话）
  await restoreSessionInApp(mp, saved);
  const restored = await mp.evaluate(() => ({
    base: wx.getStorageSync('travel.base') || '',
    token: wx.getStorageSync('travel.token') || '',
  }));
  check('travel.base 已还原', restored.base === saved.base, `base=${restored.base || '（空）'}`);
  check('会话已还原', restored.token === saved.token, restored.token ? 'token 一致' : '保持未登录');
  localRestore = null; // 正常收尾完成，不需要兜底了
}

/* ------------------------------ main ------------------------------ */

async function main() {
  console.log(`== 开发者工具检查（${LOCAL ? '--local · 本机临时后端' : '默认 · 只读打生产'}）==`);
  console.log(`miniprogram-automator v${automatorVersion} · 工程 ${PROJECT_PATH}`);

  let mp = null;
  let server = null;
  try {
    if (LOCAL) server = await bootLocalServer();

    try {
      mp = await connectOrLaunch();
    } catch (e) {
      console.error(`连不上开发者工具：${e.message}`);
      return 1;
    }

    const errors = watchErrors(mp);
    if (LOCAL) await runLocalFlow(mp);
    else await runDefaultFlow(mp);

    // 汇总
    console.log('');
    if (errors.length) {
      console.log(`控制台报错 / 异常（${errors.length} 条）：`);
      for (const line of errors.slice(0, 12)) console.log(`  ! ${line}`);
      if (errors.length > 12) console.log(`  …… 还有 ${errors.length - 12} 条`);
    } else {
      console.log('控制台报错 / 异常：无');
    }
    const bad = failures + errors.length;
    console.log(bad ? `结论：${failures} 项断言失败${errors.length ? ` + ${errors.length} 条报错` : ''}` : '结论：全通');
    return bad ? 1 : 0;
  } catch (e) {
    console.error('脚本自己炸了：', e?.stack || e);
    return 2;
  } finally {
    try {
      if (localRestore) {
        // 流程中途炸了：存储里可能还留着 travel.base / 副本会话，尽力还回去
        await localRestore();
        console.log('（中断兜底）小程序会话与 base 已还原');
      }
    } catch {
      /* 连接可能已经断了，尽力而为 */
    }
    try {
      if (mp) mp.disconnect(); // 只断开自动化连接，不 close —— 别把用户的 IDE 关掉
      if (mp) console.log('已断开自动化连接（IDE 窗口保持原样）');
    } catch {
      /* 断不干净也不影响退出码 */
    }
    if (server) await shutdownLocalServer(server);
  }
}

main().then((code) => process.exit(code));
