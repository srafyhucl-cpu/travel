/**
 * PWA 主屏长按的三个快捷方式（?tab=）现在真的各走各的路。
 *
 * 这是修过的真 bug：manifest 里定义了今天 / 记账 / 照片三个快捷方式，
 * 代码却从来没读过这个参数，长按图标三个入口全开首页。
 *
 * 照片那一路现在直接开 vlog 面板：长图不带照片也能出，不必再退回「加一笔」。
 *
 * 跑法：node web/scripts/check-shortcuts.cjs
 * 退出码：0 = 三条都对，1 = 有。
 */
const h = require('./_harness.cjs');

const PW7 = require('playwright').devices['Pixel 7'];

/** 开一个全新会话（等于刚点开图标），走 ?tab= 进首页，登录。 */
async function fresh(browser, base, q) {
  const ctx = await browser.newContext({ ...PW7 });
  const page = await ctx.newPage();
  await page.goto(`${base}/${q}`, { waitUntil: 'networkidle' });
  await h.sleep(400);
  await h.login(page);
  return { ctx, page };
}

(async () => {
  const t = await h.begin();
  const base = t.base;

  // ---- 1. ?tab=money：登录页 → 登录完自动开「记一笔」 ----
  {
    const { ctx, page } = await fresh(t.browser, base, '?tab=money');
    await h.sleep(900);
    const sheets = await page.locator('.sheet').count();
    const isExpense = await page.locator('.sheet', { hasText: '记一笔' }).count();
    t.check('money 登录后自动打开记一笔', isExpense > 0, `面板数 ${sheets}`);
    t.check('money 用掉后地址栏被抹干净', !page.url().includes('tab='), page.url());
    await t.page.goto(page.url()); // 把截图留在同一个标签上
    await ctx.close();
  }

  // ---- 2. ?tab=money：已经是登录状态（不经过登录页） ----
  {
    const ctx = await t.browser.newContext({ ...PW7 });
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'networkidle' });
    await h.login(page);
    await page.goto(`${base}/?tab=money`, { waitUntil: 'networkidle' });
    await h.sleep(1200);
    const isExpense = await page.locator('.sheet', { hasText: '记一笔' }).count();
    t.check('money 已登录时也打开记一笔', isExpense > 0);
    await ctx.close();
  }

  // ---- 3. ?tab=photos：直接开 vlog 面板（长图不带照片也能出） ----
  {
    const { ctx, page } = await fresh(t.browser, base, '?tab=photos');
    await h.sleep(1000);
    const isPoster = await page.locator('.sheet', { hasText: '生成 vlog 图' }).count();
    t.check('photos 直接打开 vlog 面板', isPoster > 0, `面板数 ${await page.locator('.sheet').count()}`);
    t.check('photos 首页还在（没有白屏）', (await page.locator('.tl-item').count()) > 0);
    await ctx.close();
  }

  // ---- 4. ?tab=today：干净的首页，不该弹任何东西 ----
  {
    const { ctx, page } = await fresh(t.browser, base, '?tab=today');
    await h.sleep(800);
    t.check('today 不弹任何面板', (await page.locator('.sheet').count()) === 0);
    t.check('today 地址栏被抹干净', !page.url().includes('tab='), page.url());
    await ctx.close();
  }

  process.exit(await t.end());
})().catch(async (e) => { console.error('脚本自己炸了:', e.message); process.exit(2); });
