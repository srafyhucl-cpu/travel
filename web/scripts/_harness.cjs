/**
 * 本地回归测试的共用骨架。
 *
 * 每个脚本都是同一套流程，抄五遍只会抄出五个不一样的 bug：
 *   起一次性后端 → 打开 Pixel 7 模拟器 → 登录 → 收集控制台报错 → 逐项判定 → 收尾
 * 这套流程在这里写一次，各脚本只关心「查什么」。
 *
 * 为什么每次都起一次性后端：这些脚本里有一半会改数据（编辑器里敲字、拖拽、
 * 加行删行）。落点/表单这类操作没法靠「改完再改回去」复原，跑真库迟早
 * 被留在乱序状态。所以先把 server/data 整份复制到临时目录另起一个端口，
 * 测完连数据一起删 —— 真库一个字节都不会动。
 *
 * 唯一例外是 check-order：它是纯只读 API 检查，默认直接打生产，
 * 不需要也不应该起副本。
 *
 * 需要浏览器。playwright 是 web 的 devDependency，浏览器装在
 * PLAYWRIGHT_BROWSERS_PATH 指向的目录（用户级环境变量），别再下一份。
 */
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT, 'server');
const DIST_DIR = path.join(SERVER_DIR, 'frontend', 'dist');
const SRC_DATA = path.join(SERVER_DIR, 'data');

// 临时数据放仓库所在的盘（不是 C 盘），仓库挪到别的盘它也跟着走
const DRIVE = path.parse(ROOT).root.replace(/[\\/]$/, '');
const TEMP_DATA = process.env.DRAG_TEST_DATA || path.join(DRIVE, 'Temp', 'travel-testdata');
const SHOT_DIR = process.env.SHOTS || path.join(DRIVE, 'Temp', 'travel-shots');

const PASS = process.env.PASS || 'yunnan2026';
const PORT = Number(process.env.TEST_PORT || 7032);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 收尾要等子进程真的退出才能删数据目录。better-sqlite3 是同步 IO，
 * kill 发出去的那一刻它还攥着 travel.db-shm，这时候 rmSync 会 EBUSY。
 * 等 exit 事件，再删；万一还是撞上锁（杀毒软件之类）就重试几次。
 */
async function killServer(child) {
  if (!child) return;
  const exited = new Promise((r) => child.once('exit', r));
  try { child.kill(); } catch { /* 已经退了 */ }
  await Promise.race([exited, sleep(4000)]);
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(TEMP_DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return true;
    } catch {
      if (i === 5) return false;
      await sleep(400);
    }
  }
  return false;
}

function requireBuild() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error(`没找到前端构建产物（${DIST_DIR}\\index.html）。先 cd web && npm run build`);
  }
}

/** 开一份 server/data 的副本，另起一个端口的后端，返回 base 地址。 */
async function bootServer() {
  requireBuild();
  fs.rmSync(TEMP_DATA, { recursive: true, force: true });
  copyDir(SRC_DATA, TEMP_DATA);
  const child = spawn('node', ['src/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATA_DIR: TEMP_DATA, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      return { base: `http://127.0.0.1:${PORT}`, child };
    } catch { await sleep(250); }
  }
  await killServer(child);
  throw new Error('一次性后端没能在 15 秒内就绪');
}

function collectErrors(page, tag = '') {
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${tag}pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`${tag}console: ${m.text()}`); });
  return errs;
}

async function login(page, base) {
  await page.fill('#pass', PASS);
  if (await page.locator('#who').count()) await page.fill('#who', '我');
  await page.click('button[type=submit]');
  await page.waitForSelector('.tl-item', { timeout: 20000 });
  await sleep(900);
}

/**
 * 标准生命周期。返回 checks 收集器，交给脚本往里塞判定。
 *
 *   const h = await harness.begin();
 *   h.check('卡片数', n === 16, `实际 ${n}`);
 *   const code = await h.end();
 *
 * baseUrl 可以覆盖成别处（比如已经在跑的本地实例）；不给就起副本。
 */
async function begin({ baseUrl, tag = '' } = {}) {
  const results = [];
  let child = null;
  let base = baseUrl || process.env.BASE;

  if (!base) {
    const b = await bootServer();
    base = b.base;
    child = b.child;
    console.log(`一次性后端：${base}（数据 ${TEMP_DATA}）`);
  } else {
    console.log(`目标：${base}`);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const errors = collectErrors(page, tag);
  await page.goto(base, { waitUntil: 'networkidle' });

  let shotN = 0;
  const api = {
    base,
    page,
    browser,
    errors,
    sleep,
    /** 截图。目录由 SHOTS 环境变量决定，默认在仓库所在盘的 Temp 下。 */
    async shot(name) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      shotN += 1;
      const file = path.join(SHOT_DIR, `${String(shotN).padStart(2, '0')}-${name}.png`);
      await page.screenshot({ path: file });
      return file;
    },
    /** 记一条判定。detail 是给人看的，不影响成败。 */
    check(name, ok, detail) {
      results.push({ name, ok: !!ok, detail: detail ?? '' });
      console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`);
      return !!ok;
    },
    /** 直接记一条原始输出，不参与判定（用于排查时看现场）。 */
    info(name, value) {
      console.log(`  · ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    },
  };
  api.login = () => login(page, base);

  api.end = async () => {
    await browser.close().catch(() => {});
    const cleaned = await killServer(child);
    console.log('');
    if (!cleaned) console.log(`  （临时目录没删干净，剩 ${TEMP_DATA}，不影响结果）`);
    const bad = results.filter((r) => !r.ok);
    if (errors.length) console.log(`  控制台报错：${errors.slice(0, 5).join(' | ')}`);
    const pass = bad.length === 0 && errors.length === 0;
    console.log(pass ? '结论：全通' : `结论：${bad.length} 项失败${errors.length ? ` + ${errors.length} 条报错` : ''}`);
    return pass ? 0 : 1;
  };
  return api;
}

module.exports = { begin, login, ROOT, SERVER_DIR, SHOT_DIR, TEMP_DATA, PASS, sleep };
