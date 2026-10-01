/**
 * 冒烟：把每个能进的界面都走一遍，收集控制台报错。
 *
 * 「有报错」不等于「坏了」——所以这里对每一屏都留截图，出问题时能对着看。
 * 截图目录由 SHOTS 环境变量决定，默认 <仓库盘>\Temp\travel-shots。
 *
 * 拖拽不在这里测：它是手写的长按手势，鼠标事件测不出来，
 * 由 verify-drag.cjs 单独用触摸事件验。
 *
 * 跑法：
 *   node web/scripts/smoke.cjs
 *   SHOTS=D:\x\shots node web/scripts/smoke.cjs
 *
 * 退出码：0 = 全通且无报错，1 = 有。
 */
const h = require('./_harness.cjs');

(async () => {
  const t = await h.begin();
  const { page } = t;
  await t.login();

  // 1 首页
  const cards = await page.locator('.tl-item').count();
  t.check('首页卡片数 > 0', cards > 0, `${cards} 张`);
  await t.shot('首页');

  // 2 预算明细展开
  // 2 预算明细展开（现在合并在顶部常驻块里，点「已花」那格展开）
  await page.locator('.money-seg').click();
  await h.sleep(700);
  const detail = await page.locator('.dk-panel').count();
  t.check('预算明细能展开', detail > 0);
  await t.shot('预算明细');
  await page.locator('.money-seg').click();
  await h.sleep(400);

  // 3 记账弹层（从卡片进）
  await page.locator('.tl-item .chip-btn[aria-label="记一笔"]').first().click();
  await page.waitForSelector('.sheet', { timeout: 8000 });
  await h.sleep(700);
  const sheetTitle = (await page.locator('.sheet').innerText()).split('\n')[0];
  t.check('记账弹层打开了', sheetTitle.includes('记一笔'), `标题「${sheetTitle}」`);
  await t.shot('记账弹层');
  await page.keyboard.press('Escape');
  await h.sleep(600);

  // 4 设置页
  await page.locator('.icon-btn').last().click();
  await page.waitForSelector('.sheet', { timeout: 8000 });
  await h.sleep(800);
  const settingsLen = (await page.locator('.sheet').innerText()).length;
  t.check('设置页有内容', settingsLen > 50, `${settingsLen} 字`);
  await t.shot('设置页');
  await page.keyboard.press('Escape');
  await h.sleep(600);

  // 5 加一笔（照片）
  await page.locator('.icon-btn.accent').click();
  await h.sleep(700);
  t.check('加一笔能打开', (await page.locator('.sheet, .sheet-title').count()) > 0);
  await t.shot('加一笔');
  await page.keyboard.press('Escape');
  await h.sleep(500);

  // 6 节点编辑
  await page.locator('.tl-head').first().click();
  await page.waitForSelector('.sheet', { timeout: 8000 });
  await h.sleep(700);
  t.check('节点编辑器能打开', (await page.locator('.field').count()) > 0);
  await t.shot('节点编辑');
  await page.keyboard.press('Escape');
  await h.sleep(600);

  // 7 整页高度 + 下半屏（掏完提示字段以后整页明显矮了，值得盯住别反弹）
  await page.evaluate(() => window.scrollTo(0, 0));
  await h.sleep(400);
  const H = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = await page.evaluate(() => window.innerHeight);
  t.info('整页高', `${H}px = ${(H / vh).toFixed(2)} 屏`);
  for (const [i, f] of [0.4, 0.7, 1].entries()) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(H * f));
    await h.sleep(500);
    await t.shot(`下半屏-${i + 1}`);
  }

  process.exit(await t.end());
})().catch(async (e) => { console.error('脚本自己炸了:', e.message); process.exit(2); });
