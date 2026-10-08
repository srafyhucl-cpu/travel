/**
 * 开发者工具自动化检查：把「拉起 IDE → 登录 → 行程页渲染」固化成一条命令。
 *
 * 两种模式：
 *
 *   默认（只读，打生产）：
 *     PASS=你的口令 node scripts/check-devtools.mjs
 *     - 先连已开着的自动化桥（ws://127.0.0.1:9420），连不上再让 automator 拉起；
 *     - 等 3 秒；如果落在登录页，用 PASS +「龙哥」登录后点「进入这趟旅行」；
 *     - 断言：当前页是行程页、data.ready === true、days.length > 0；
 *     - 全程收集 console(type=error) 与 exception，有报错或断言失败 → 退出码 1。
 *     ★ 默认模式只能用「龙哥」：生产库用「我」会凭空多出一个空壳成员（历史教训）。
 *
 *   --local（全链路，不碰生产）：
 *     PASS=你的口令 node scripts/check-devtools.mjs --local
 *     - 把 server/data 整份复制到临时目录，另起 7042 端口的后端；
 *     - 小程序里把 travel.base 指向它，登录随便建成员（副本库）；
 *     - 行程页断言同上；再验证照片数据层：上传 1×1 PNG → 快照 photos +1 →
 *       删除 → 数量复原 → 清掉 travel.base（App 下次启动回生产）；
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
const LOCAL = process.argv.includes('--local');

// 上传用：1×1 的合法 PNG（服务端要过魔数校验，大小无所谓）
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

async function connectOrLaunch() {
  // 1) 已开着的自动化桥优先（IDE 开着这个项目、开过自动化端口时）
  try {
    const mp = await automator.connect({ wsEndpoint: WS_ENDPOINT });
    console.log(`已连接运行中的自动化桥：${WS_ENDPOINT}`);
    return mp;
  } catch (e) {
    console.log(`连接 ${WS_ENDPOINT} 失败：${e.message}`);
  }

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
    try {
      const mp = await automator.connect({ wsEndpoint: WS_ENDPOINT });
      console.log(`手动拉起后连接成功（等了 ${(i + 1) * 2}s）`);
      return mp;
    } catch {
      /* 继续轮询 */
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
 * 轮询等第一张缩略图拿到本地路径 —— fillThumbs 是异步逐张补的。
 * 这条断言抓过真问题：files 导入缝隙会让有照片的页面在渲染时直接抛错。
 */
async function waitThumbSrc(page, tries = 12, gap = 800) {
  let count = 0;
  for (let i = 0; i < tries; i++) {
    const els = await page.$$('.shot-thumb');
    count = els.length;
    for (const el of els) {
      const src = await el.attribute('src');
      if (src) return { count, src };
    }
    if (i < tries - 1) await sleep(gap);
  }
  return { count, src: '' };
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

function uploadTinyPng(mp, base, nodeId) {
  return mp.evaluate(
    (b, b64, nid) =>
      new Promise((resolve) => {
        const filePath = `${wx.env.USER_DATA_PATH}/wx-check.png`;
        try {
          wx.getFileSystemManager().writeFileSync(filePath, b64, 'base64');
        } catch (e) {
          resolve({ status: 0, error: `writeFile: ${e.errMsg || e}` });
          return;
        }
        wx.uploadFile({
          url: `${b}/api/photos`,
          filePath,
          name: 'photos',
          header: { Authorization: `Bearer ${wx.getStorageSync('travel.token')}` },
          formData: { nodeId: String(nid) },
          success: (r) => resolve({ status: r.statusCode, data: r.data }),
          fail: (e) => resolve({ status: 0, error: `uploadFile: ${e.errMsg || e}` }),
        });
      }),
    base,
    TINY_PNG_B64,
    nodeId
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

  let page = await mp.currentPage();
  console.log(`当前页：${page?.path || '（读不到）'}`);
  if (page?.path === 'pages/login/index') {
    console.log('在登录页：用口令 +「龙哥」登录（只登录，不新建成员）…');
    await loginOnPage(mp, '龙哥');
    await sleep(5000); // 登录 + 拉快照 + reLaunch
  }

  const t = await waitTimeline(mp);
  check('当前页是行程页 pages/timeline/index', t.page?.path === 'pages/timeline/index', t.page?.path || '（读不到）');
  check('行程页 data.ready === true', t.data?.ready === true, `ready=${t.data?.ready}`);
  check('days.length > 0', toCount(t.data?.days) > 0, `days=${toCount(t.data?.days)}`);

  // 生产数据有照片时：缩略图必须真的补出本地路径（异步逐张拉，等一等）
  const photos = photoCountOf(t.data);
  if (photos > 0) {
    const thumb = await waitThumbSrc(t.page);
    check(
      '时间线渲染出缩略图（本地路径）',
      thumb.count > 0 && !!thumb.src,
      `photos=${photos} thumbs=${thumb.count} src=${(thumb.src || '').slice(0, 60)}`
    );
  } else {
    console.log(`  · 生产数据当前没有照片，跳过缩略图断言`);
  }
}

async function runLocalFlow(mp) {
  console.log('\n== --local 模式：本机临时后端，全链路 ==');

  // 防呆：必须连的是 travel 小程序，别把 travel.base 写进别的项目
  const p0 = await mp.currentPage();
  const known = ['pages/timeline/index', 'pages/login/index'];
  if (!p0 || !known.includes(p0.path)) {
    throw new Error(`当前页不是 travel 小程序（${p0?.path || '读不到页面'}）；--local 会写小程序存储，请先把本项目切到前台`);
  }

  // 指向本机后端并回行程页（App 不重启；结尾会清掉 travel.base）。
  // 注意：reLaunch 不要塞进 evaluate —— 路由切换会拆掉小程序上下文，evaluate 的
  // 响应就此丢失（automator 侧表现为 "timeout waiting for automator response"）。
  // 用 SDK 自带的 reLaunch：它把 {url} 包好、等路由切换、再返回新页面。
  await mp.evaluate((base) => {
    wx.setStorageSync('travel.base', base);
  }, LOCAL_BASE);
  await mp.reLaunch('/pages/timeline/index');
  await sleep(2000); // 给重定向/首拉快照留时间

  const page = await mp.currentPage();
  if (page?.path === 'pages/login/index') {
    console.log('在登录页：用副本库的口令 +「我」登录（副本库，随便建成员）…');
    await loginOnPage(mp, '我');
    await sleep(5000);
  }

  const t = await waitTimeline(mp);
  check('当前页是行程页 pages/timeline/index', t.page?.path === 'pages/timeline/index', t.page?.path || '（读不到）');
  check('行程页 ready（数据来自本机临时库）', t.data?.ready === true, `ready=${t.data?.ready}`);
  check('days.length > 0', toCount(t.data?.days) > 0, `days=${toCount(t.data?.days)}`);

  // —— 照片链路：只测接口与数据（UI 由另一路同学做） ——
  console.log('\n== 照片链路（数据层） ==');
  const before = await snapshotInApp(mp, LOCAL_BASE);
  check('快照可拉取', before.status === 200 && !!before.data?.trip, `status=${before.status}`);
  const beforeCount = toCount(before.data?.photos);
  const nodeId = before.data?.nodes?.[0]?.id;
  check('快照里有节点可挂照片', !!nodeId, nodeId || '（没有节点）');

  let uploadedId = null;
  if (before.status === 200 && nodeId) {
    const up = await uploadTinyPng(mp, LOCAL_BASE, nodeId);
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
    await mp.reLaunch('/pages/timeline/index');
    await sleep(4000);

    // UI 层：新照片的缩略图要真的补出本地路径（files.url → fillThumbs → image src）
    const localThumb = await waitThumbSrc(await mp.currentPage());
    check(
      '时间线渲染出缩略图（本地路径）',
      localThumb.count > 0 && !!localThumb.src,
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

    const del = await deletePhotoInApp(mp, LOCAL_BASE, uploadedId);
    check('删除照片', del.status === 200, `status=${del.status}`);

    await mp.reLaunch('/pages/timeline/index');
    await sleep(2000);

    const back = await snapshotInApp(mp, LOCAL_BASE);
    check('删除后 photos 回到原值', toCount(back.data?.photos) === beforeCount, `${afterPhotos.length} → ${toCount(back.data?.photos)}`);
  }

  // —— 记一笔链路：进记账页 → 填金额 → 提交 → 临时库账目 +1 → 自动回时间线 ——
  console.log('\n== 记一笔链路 ==');
  {
    const beforeExp = toCount((await snapshotInApp(mp, LOCAL_BASE)).data?.expenses);
    const url = `/pages/expense/index${nodeId ? `?nodeId=${nodeId}` : ''}`;
    await mp.reLaunch(url);
    await sleep(2500);
    const expPage = await mp.currentPage();
    check('记账页打开', expPage?.path === 'pages/expense/index', expPage?.path || '（读不到）');
    if (expPage?.path === 'pages/expense/index') {
      const amountInput = await expPage.$('.amount-input');
      if (amountInput) await amountInput.input('12.5');
      await sleep(500);
      const saveBtn = await expPage.$('.btn-primary');
      if (saveBtn) await saveBtn.tap();
      await sleep(4500); // 提交 + 快照刷新 + 自动回时间线
      const afterExp = toCount((await snapshotInApp(mp, LOCAL_BASE)).data?.expenses);
      check('记一笔后临时库账目 +1', afterExp === beforeExp + 1, `${beforeExp} → ${afterExp}`);
      const backPage = await mp.currentPage();
      check('记完回到时间线', backPage?.path === 'pages/timeline/index', backPage?.path || '（读不到）');
    } else {
      check('记一笔后临时库账目 +1', false, '记账页没打开，跳过');
      check('记完回到时间线', false, '记账页没打开，跳过');
    }
  }

  // 收尾：让 App 下次启动回生产
  await mp.evaluate(() => {
    wx.removeStorageSync('travel.base');
  });
  const leftover = await mp.evaluate(() => wx.getStorageSync('travel.base') || '');
  check('travel.base 已清掉（下次启动回生产）', leftover === '', String(leftover || '（空）'));
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
      if (mp) mp.disconnect(); // 只断开自动化连接，不 close —— 别把用户的 IDE 关掉
      if (mp) console.log('已断开自动化连接（IDE 窗口保持原样）');
    } catch {
      /* 断不干净也不影响退出码 */
    }
    if (server) await shutdownLocalServer(server);
  }
}

main().then((code) => process.exit(code));
