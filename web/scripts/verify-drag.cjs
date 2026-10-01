/**
 * 时间线长按拖拽回归。
 *
 * 跑法（仓库根目录下）：
 *   cd server\frontend\dist 不存在的话先 cd web && npm run build
 *   node web/scripts/verify-drag.cjs
 *
 * 为什么必须用触摸而不是鼠标：拖拽是手写的 Pointer Events 长按手势
 * （web/src/ui/useDragSort.js，HOLD_MS=300），鼠标事件走的是另一条路径，
 * 测出来永远是「拖不动」。这里用 CDP 的 Input.dispatchTouchEvent 发真触摸，
 * 浏览器才会翻译成 pointerdown / pointermove / pointerup。
 *
 * 为什么自带后端：拖拽必然改数据顺序，而落点取的是「离卡片中心最近的空位」，
 * 没法精确拖回原来那一位（试过，会越拖越乱）。所以这个脚本先把 server/data
 * 整份复制到临时目录、另起一个端口的服务，测完连数据一起删 —— 真正的库
 * 一个字节都不会动，也就不需要「拖回原位」这种本身就不可靠的收尾。
 *
 * 分四段独立报告，任何一段断了都能立刻看出断在哪：
 *   1. 按住 300ms 以上，卡片进入 .dragging、body 上 is-dragging
 *   2. 移动过程中有空位亮起 .dropslot.on（落点判定有候选）
 *   3. 松手后提交了 /move
 *   4. 时间线顺序真的变了，并且收到回执
 * 往下拖、往上拖各走一遍。
 *
 * 环境变量：
 *   FROM=2 DOWN=4    从第几张（0 起）往下挪几格，默认 1 / 3
 *   PASS=xxxx        口令，默认 yunnan2026
 *   TEST_PORT=7032   一次性后端的口令端口
 *   SHOT=D:\x\drag   给就存一张拖拽中的截图
 *
 * 退出码：0 全通，1 有段落失败，2 脚本自己炸了。
 */
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 仓库根 = 本文件在 web/scripts/ 下，往上两级
const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT, 'server');
const DIST_DIR = path.join(SERVER_DIR, 'frontend', 'dist');

// 临时数据放在仓库所在的盘（不是 C 盘），仓库挪到别的盘它也跟着走
const DRIVE = path.parse(ROOT).root.replace(/[\\/]$/, '');
const TEMP_DATA = process.env.DRAG_TEST_DATA || path.join(DRIVE, 'Temp', 'travel-testdata');

const PORT = Number(process.env.TEST_PORT || 7032);
const PASS = process.env.PASS || 'yunnan2026';
const FROM = Number(process.env.FROM || 1);
const DOWN = Number(process.env.DOWN || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ' + a.join(' '));

let child = null;

// ---------------------------------------------------------------- 一次性后端

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function boot() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error(`没找到前端构建产物（${DIST_DIR}\\index.html）。先 cd web && npm run build`);
  }
  fs.rmSync(TEMP_DATA, { recursive: true, force: true });
  copyDir(path.join(SERVER_DIR, 'data'), TEMP_DATA);
  child = spawn('node', ['src/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATA_DIR: TEMP_DATA, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      log(`一次性后端起来了（端口 ${PORT}，数据 ${TEMP_DATA}）`);
      return;
    } catch { await sleep(250); }
  }
  throw new Error('一次性后端没能在 15 秒内就绪');
}

/*
 * 收尾要等子进程真的退出才能删数据目录。better-sqlite3 是同步 IO，
 * kill 发出去的那一刻它还攥着 travel.db-shm，这时候 rmSync 会 EBUSY。
 * 等 exit 事件，再删；万一还是撞上锁（杀毒软件之类）就重试几次。
 */
async function teardown() {
  if (child) {
    const c = child;
    child = null;
    const exited = new Promise((r) => c.once('exit', r));
    try { c.kill(); } catch { /* 已经退了 */ }
    await Promise.race([exited, sleep(4000)]);
  }
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(TEMP_DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      log(`已清理：停掉进程 + 删除 ${TEMP_DATA}`);
      return;
    } catch {
      if (i === 5) console.log(`  （临时目录没删干净，剩 ${TEMP_DATA}，不影响结果）`);
      else await sleep(400);
    }
  }
}

// ------------------------------------------------------------------ 拖一次

async function dragTo(page, cdp, touch, from, down, watch) {
  // 先把「出发点」和「目标点」的中点滚到屏幕中央，保证两个都在画面里。
  // 往回拖的时候出发点在下半屏，光把起点放上面会把目标顶出画面。
  const midDoc = await page.evaluate(([i, d]) => {
    const els = document.querySelectorAll('.tl-item');
    const a = els[i];
    const b = els[i + d];
    if (!a || !b) return null;
    return (a.getBoundingClientRect().top + b.getBoundingClientRect().top) / 2 + window.scrollY;
  }, [from, down]);
  if (midDoc == null) throw new Error(`第 ${from} 或第 ${from + down} 张不存在`);
  await page.evaluate((m) => window.scrollTo(0, Math.max(0, m - window.innerHeight / 2)), midDoc);
  await page.waitForTimeout(500);

  const box = await page.locator('.tl-item').nth(from).boundingBox();
  if (!box) throw new Error(`拿不到第 ${from} 张卡片的坐标`);
  // 按在卡片上半部分（标题那行），避开底部 .tl-acts 里的按钮 ——
  // 按钮上有自己的手势，onPointerDown 会直接 return，压根不开始拖
  const sx = box.x + Math.min(90, box.width * 0.4);
  const sy = box.y + 20;

  const dest = await page.locator('.tl-item').nth(from + down).boundingBox();
  if (!dest) throw new Error(`拿不到第 ${from + down} 张卡片的坐标`);
  let endY = dest.y + dest.height * 0.5;
  // 至少要挪出 10px，否则 useDragSort 当成「长按着看了看」，不提交；
  // 但也不能改方向 —— 往上拖就只能往上，不能因为「太近」又折回下方去。
  if (Math.abs(endY - sy) < 130) endY = sy + Math.sign(endY - sy || 1) * 130;
  // 留在安全区里（上下 76px 会触发自动滚页），别让自动滚动搅乱落点
  const h = await page.evaluate(() => window.innerHeight);
  endY = Math.max(130, Math.min(endY, h - 150));

  let moveCalls = null;
  const listener = (r) => { if (r.url().includes('/move')) moveCalls = r.status(); };
  page.on('response', listener);

  await touch('touchStart', sx, sy);
  await page.waitForTimeout(520); // > HOLD_MS(300)，留足余量

  const lifted = await page.locator('.tl-item.dragging').count();
  const bodyDragging = await page.evaluate(() => document.body.classList.contains('is-dragging'));

  // 分多步挪，每步之间给一点时间，让 nearestSlot 有机会算出落点并触发重渲染
  const steps = 14;
  let slotEverLit = false;
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', sx, sy + ((endY - sy) * i) / steps);
    await page.waitForTimeout(35);
    if (await page.locator('.dropslot.on').count()) {
      if (!slotEverLit) watch?.onSlotLit?.();
      slotEverLit = true;
    }
  }

  if (watch?.screenshot) await page.screenshot({ path: watch.screenshot });
  await touch('touchEnd', 0, 0);
  await page.waitForTimeout(2000);
  page.off('response', listener);

  return {
    lifted, bodyDragging, slotEverLit, moveCalls,
    flash: (await page.locator('.flashbar').count())
      ? (await page.locator('.flashbar').first().innerText()).trim()
      : '(无)',
  };
}

function report(title, r, orderChanged) {
  console.log(`\n=== ${title} ===`);
  log('1. 长按进入拖动态:', r.lifted ? '通过' : '失败（.tl-item.dragging 没出现）');
  log('   body.is-dragging:', r.bodyDragging ? '通过' : '失败');
  log('2. 落位高亮:', r.slotEverLit ? '通过（.dropslot.on 出现过）' : '失败（.dropslot.on 没出现）');
  log('3. /move 提交:', r.moveCalls === null ? '失败（接口没被调用）' : `通过（HTTP ${r.moveCalls}）`);
  log('4. 顺序变了:', orderChanged ? '通过' : '失败');
  log('   回执:', r.flash);
  return r.lifted && r.bodyDragging && r.slotEverLit && r.moveCalls !== null && orderChanged;
}

// -------------------------------------------------------------------- 主流程

(async () => {
  const browser = await chromium.launch();
  let ok = false;
  try {
    await boot();

    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? []
          : [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 12, radiusY: 12, force: 1 }],
      });

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.fill('#pass', PASS);
    if (await page.locator('#who').count()) await page.fill('#who', '我');
    await page.click('button[type=submit]');
    await page.waitForSelector('.tl-item', { timeout: 20000 });
    await page.waitForTimeout(900);

    const count = await page.locator('.tl-item').count();
    if (count < Math.abs(FROM + DOWN) + 2) {
      console.log(`卡片只有 ${count} 张，不够这次拖拽（从第 ${FROM} 张挪 ${DOWN} 格），跳过`);
      await browser.close();
      process.exit(0);
    }

    const titles = () => page.$$eval('.tl-item .tl-title', (els) => els.map((e) => e.innerText.split('\n')[0].trim()));
    const shot = process.env.SHOT ? `${process.env.SHOT}-drag.png` : null;

    // 第 1 段：往下拖
    const before = await titles();
    console.log(`\n=== 第 1 段：第 ${FROM} 张往下拖 ${DOWN} 格 ===`);
    log('拖之前:', JSON.stringify(before.slice(0, FROM + DOWN + 2)));
    const r1 = await dragTo(page, cdp, touch, FROM, DOWN, {
      onSlotLit: () => log('  （中途空位亮起，已产生候选落点）'),
      screenshot: shot,
    });
    const after1 = await titles();
    log('拖之后:', JSON.stringify(after1.slice(0, FROM + DOWN + 2)));
    const ok1 = report('第 1 段（往下）', r1, JSON.stringify(before) !== JSON.stringify(after1));

    // 第 2 段：往上拖回来 —— 落点逻辑是同一套，但落点在卡片上方，
    // 顺带把「往回拖」这条路径也走一遍
    const idx = after1.indexOf(before[FROM]);
    console.log(`\n=== 第 2 段：往回拖（那张卡现在在第 ${idx} 位，目标第 ${FROM} 位）===`);
    const r2 = await dragTo(page, cdp, touch, idx, FROM - idx, { screenshot: shot });
    const after2 = await titles();
    log('拖完:', JSON.stringify(after2.slice(0, FROM + DOWN + 2)));
    const ok2 = report('第 2 段（往上）', r2, JSON.stringify(after2) !== JSON.stringify(after1));

    console.log('\n=== 收尾 ===');
    log('页面报错:', errors.length ? errors.join(' | ') : '无');
    log('真库:', '未被触碰（跑的是一次性副本）');

    ok = ok1 && ok2 && errors.length === 0;
    console.log('\n结论:', ok ? '拖拽两向四段全通' : '拖拽有问题，见上面标失败的段');
  } finally {
    await browser.close().catch(() => {});
    await teardown();
  }
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  console.error('测试脚本自己炸了:', e.message);
  await teardown();
  process.exit(2);
});
