/**
 * 冒烟：把每个能进的界面都走一遍，收集控制台报错。
*
* 开场先验「打开就落在现在这格」：这是 App 打开后的第一眼，也是最近刚加的行为，
* 跟真实使用最相关的一条。
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

/*
* 0 打开就落在「现在这格」。
*
* 这条天生依赖「今天」：行程过了、或者还没开始，焦点就不在今天，页面上也就没
* 有「现在这格」可跳。所以先把行程日期拉到今天前后，再搬一条节点到今天 —— 今天
* 必定有一格待办，.tl-item.is-now 也就必定存在，跟日历无关。
*/
const setup = await page.evaluate(async () => {
const token = localStorage.getItem('travel.token');
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const day = (delta) => { const x = new Date(); x.setDate(x.getDate() + delta); return iso(x); };
// 挂载在 /api/trip 上的路由自己又叫 /trip，所以完整路径是 /api/trip/trip
const tripRes = await fetch('/api/trip/trip', {
method: 'PATCH',
headers: auth,
body: JSON.stringify({ startDate: day(-2), endDate: day(2) }),
});
const snap = await (await fetch('/api/trip/snapshot', { headers: auth })).json();
const n = snap.nodes.find((x) => x.role !== 'module' && x.status !== 'done');
const r = await fetch(`/api/nodes/${n.id}`, {
method: 'PATCH',
headers: auth,
body: JSON.stringify({ date: day(0), status: 'planned' }),
});
// 顺手清掉离线快照：重新加载时它会先拿旧快照渲染，那样这一下就落在旧数据上
await new Promise((res) => {
const del = indexedDB.deleteDatabase('travel-companion');
del.onsuccess = del.onerror = del.onblocked = () => res();
});
return { ok: tripRes.ok && r.ok, title: n.title, today: day(0) };
});
t.check('已布置出「今天」', setup.ok, `节点「${setup.title}」搬到 ${setup.today}`);
await page.reload({ waitUntil: 'networkidle' });
await h.sleep(1400);

const landing = await page.evaluate(() => {
const now = document.querySelector('.tl-item.is-now');
if (!now) return { found: false };
const r = now.getBoundingClientRect();
return {
found: true,
top: Math.round(r.top),
bottom: Math.round(r.bottom),
hudH: document.querySelector('.hud')?.offsetHeight || 0,
y: Math.round(window.scrollY),
maxY: Math.round(document.documentElement.scrollHeight - window.innerHeight),
vh: Math.round(window.innerHeight),
};
});
t.check('页面上有「现在这格」', landing.found);
t.check('确实往下滚了', landing.y > 0, `scrollY=${landing.y}`);
/*
 * 理想落点是贴在常驻块下沿 10px，但页面已经滚到底时办不到：scrollTo 会被
 * 浏览器钳在最大滚动位置，这时候卡片只要在可视区里就算落对了，不能按“没贴住”
 * 算失败。两种都收：要么贴住，要么已到底且卡片可见。
 */
const pinned = landing.found && landing.top >= landing.hudH - 2 && landing.top <= landing.hudH + 48;
const clamped = landing.found && landing.y >= landing.maxY - 2 && landing.top > 0 && landing.bottom > landing.hudH && landing.top < landing.vh;
t.check('现在这格贴在常驻块下面', pinned || clamped, `top=${landing.top} hud=${landing.hudH}${clamped && !pinned ? '（已滚到底，落点受页面高度限制）' : ''}`);
await t.shot('打开落在现在这格');

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

  /*
   * 4.1 改名之后「我」还认得出来。
   * token 里存的是登录时的旧名字，快照得靠 meId 反查成员表才能对上；
   * 只按名字认「我」的实现，这一步标签会消失。
   */
  await page.locator('.sheet button:has-text("改名 / 颜色")').click();
  await page.waitForSelector('.sheet .field input', { timeout: 8000 });
  await h.sleep(500);
  const memberSheet = page.locator('.sheet').last();
  await memberSheet.locator('.field input').first().fill('我·改名');
  await memberSheet.locator('button:has-text("保存")').click();
  await h.sleep(1400);
  const renamed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.cat-row')];
    return rows.some((r) => r.textContent.includes('我·改名') && r.querySelector('.me-tag'));
  });
  t.check('改名后「我」跟着新名字走', renamed);
  await t.shot('改名之后');

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
