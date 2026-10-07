/**
 * 暗色模式回归：
 *   1. 跟随系统：深色偏好下打开，html[data-theme]=dark、底色与 theme-color 都变
 *   2. 设置页手动切：浅色 / 深色 实时生效
 *   3. 手动选择记住：系统调回浅色、刷新后仍是深色
 *   4. 深色下关键元素可读（卡片底色 ≠ 页面底色，顶栏半透明底是深色）
 *
 * 跑法：PASS=你的口令 npm run check:theme
 * 退出码：0 = 全通，1 = 有失败，2 = 脚本自己炸了。
 */
const h = require('./_harness.cjs');

const RGB_DARK_BG = 'rgb(15, 17, 21)';
const RGB_LIGHT_BG = 'rgb(244, 245, 247)';

(async () => {
  const t = await h.begin();
  await t.login();
  const page = t.page;

  // ---- 1. 跟随系统（深色） ----
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => localStorage.removeItem('travel.theme'));
  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(1000);
  const sysDark = await page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    meta: document.querySelector('meta[name=theme-color]')?.content,
  }));
  t.check('深色系统偏好 → data-theme=dark', sysDark.attr === 'dark', JSON.stringify(sysDark));
  t.check('页面底色变深', sysDark.bg === RGB_DARK_BG, sysDark.bg);
  t.check('theme-color 跟着换', sysDark.meta === '#0F1115', String(sysDark.meta));
  await t.shot('暗色-行程');

  // ---- 2. 设置页手动切 ----
  await page.locator('.icon-btn').last().click();
  await page.waitForSelector('.sheet', { timeout: 8000 });
  await h.sleep(700);
  await page.locator('.sheet button:has-text("浅色")').click();
  await h.sleep(400);
  const manualLight = await page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  t.check('手动切浅色即时生效', manualLight.attr === 'light' && manualLight.bg === RGB_LIGHT_BG, JSON.stringify(manualLight));
  await t.shot('浅色-设置');

  await page.locator('.sheet button:has-text("深色")').click();
  await h.sleep(400);
  const manualDark = await page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    hud: getComputedStyle(document.querySelector('.hud')).backgroundColor,
    card: getComputedStyle(document.querySelector('.tl-card')).backgroundColor,
    sheet: getComputedStyle(document.querySelector('.sheet')).backgroundColor,
  }));
  t.check('手动切深色即时生效', manualDark.attr === 'dark' && manualDark.bg === RGB_DARK_BG, JSON.stringify(manualDark));
  t.check('深色下卡片与页面分层', manualDark.card !== manualDark.bg, `card=${manualDark.card}`);
  t.check('顶栏磨砂底是深色', /rgba\(15, 17, 21/.test(manualDark.hud), manualDark.hud);
  t.check('弹层也是深色（不是白板）', manualDark.sheet === RGB_DARK_BG, `sheet=${manualDark.sheet}`);
  await t.shot('暗色-设置');

  // ---- 3. 手动选择记住：系统回到浅色，刷新后仍是深色 ----
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(900);
  const kept = await page.evaluate(() => document.documentElement.dataset.theme);
  t.check('手动深色压过系统浅色（刷新后仍深）', kept === 'dark', String(kept));

  // 清掉手动选择，别把状态留给下一个脚本（各自独立 context，其实也无碍）
  await page.evaluate(() => localStorage.removeItem('travel.theme'));

  process.exit(await t.end());
})().catch(async (e) => {
  console.error('脚本自己炸了:', e.message);
  process.exit(2);
});
