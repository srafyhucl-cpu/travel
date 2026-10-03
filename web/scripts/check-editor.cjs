/**
 * 编辑器回归：卡片类型色、代办逐条输入、必填标注、日期自动、新建保存。
 *
 * 这几条是一起改的（见 git log「卡片按类型区分、去掉提示、代办改成逐条输入、
 * 日期自动与必填标注、新建保存」），所以放一个脚本里一起验。中间挖过一个隐蔽的 bug：
 * 代办组件被写在 NodeEditor 的函数体内部，每次渲染都是新的函数身份，
 * React 判定类型变了把整棵子树重挂载，useRef 活不过那次重挂，回车加行成功
 * 但光标永远送不出去。盯「回车后焦点在新行 + 新行能打字」这两条就够。
 *
 * 会改表单，但跑在一次性副本上（见 _harness），真库不受影响。
 *
 * 跑法：node web/scripts/check-editor.cjs
 * 退出码：0 = 全通，1 = 有。
 */
const h = require('./_harness.cjs');

(async () => {
  const t = await h.begin();
  const { page } = t;
  await t.login();

  // ---- 1. 卡片类型色：类型之间一眼能分出来 ----
  const cards = await page.$$eval('.tl-card', (els) => els.slice(0, 6).map((el) => ({
    type: el.querySelector('.tl-meta span')?.textContent?.trim() || '(无类型)',
    color: getComputedStyle(el).getPropertyValue('--tc').trim() || '(空)',
    leftBar: getComputedStyle(el).boxShadow.includes('inset'),
  })));
  const dots = await page.$$eval('.tl-dot', (els) => els.slice(0, 6)
    .map((el) => getComputedStyle(el).backgroundColor));
  for (const c of cards) console.log(`  · ${c.type.padEnd(6)} 色=${c.color} 左色条=${c.leftBar}`);
  t.check('每张卡片都有类型色', cards.every((c) => c.color !== '(空)' && c.color !== '(无类型)'));
  t.check('每张卡片都有左侧色条', cards.every((c) => c.leftBar));
  t.check('时间轴圆点也是彩色的', dots.every((d) => d && d !== 'rgba(0, 0, 0, 0)'));
  await t.shot('时间线');

  // ---- 2. 页面上不该再有「提示」那套东西 ----
  const bodyText = await page.innerText('body');
  const gone = ['展开写', '下面还有', '关键提示'].filter((s) => bodyText.includes(s));
  t.check('界面不含已删除的提示字段', gone.length === 0, gone.length ? `还看得到：${gone.join('、')}` : '');

  // ---- 3. 打开编辑器：有代办，没提示 ----
  await page.locator('.tl-head').first().click();
  await page.waitForSelector('.sheet', { timeout: 10000 });
  await h.sleep(700);
  const sheetText = await page.locator('.sheet').innerText();
  t.check('编辑器里没有提示字段', !sheetText.includes('展开写') && !sheetText.includes('下面还有'));
  t.check('编辑器里有代办', (await page.locator('.cklist').count()) > 0);

  // ---- 4. 代办：回车加一行并自动聚焦、打字进得去、✕ 删得掉 ----
  const rows0 = await page.locator('.cklist-row').count();
  const firstCk = page.locator('.cklist-input').first();
  await firstCk.click();
  await firstCk.press('End');
  await firstCk.press('Enter');
  await h.sleep(350);
  const rowsAfterEnter = await page.locator('.cklist-row').count();
  t.check('回车加一行', rowsAfterEnter === rows0 + 1, `${rows0} → ${rowsAfterEnter}`);

  const focusedIsNew = await page.evaluate(() => document.activeElement?.classList.contains('cklist-input'));
  t.check('回车后焦点在新行', focusedIsNew);
  await page.keyboard.type('临时加的一条');
  await h.sleep(250);
  const typed = await page.locator('.cklist-input').nth(1).inputValue();
  t.check('新行能打字（重挂载会吃掉光标）', typed === '临时加的一条', `写进去的是「${typed}」`);
  await t.shot('代办');

  await page.locator('.cklist-del').last().click();
  await h.sleep(300);
  t.check('✕ 能删掉一行', (await page.locator('.cklist-row').count()) === rows0);

  // ---- 5. 必填标注 + 保存键 ----
  const reqMarks = await page.locator('.req-star').count();
  t.check('标题和日期都有必填红标', reqMarks >= 2, `${reqMarks} 个`);
  const titleInput = page.locator('.sheet input').first();
  await titleInput.fill('');
  await h.sleep(350);
  const missing = await page.locator('.req-missing').textContent().catch(() => '');
  t.check('清空标题后说清楚还差什么', missing.includes('标题'), `「${missing}」`);
  t.check('缺必填时保存键禁用', await page.locator('.sheet .btn.primary').isDisabled());
  await t.shot('必填');

  // ---- 6. 日期自动：在行程里就填今天，否则接最后一天之后 ----
  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(1500);
  await page.locator('.icon-btn.accent').click();
  await h.sleep(700);
  await page.getByText('加一项', { exact: true }).click();
  await h.sleep(1000);
  const dateVal = await page.locator('.sheet input[type=date]').inputValue().catch(() => '');
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  t.check('日期已自动填好', dateVal === today, `填了 ${dateVal || '(空)'}，今天 ${today}`);
  await t.shot('日期自动');

  // ---- 7. 保存：真的存得下来 ----
  // 上一节打开「加一项」看完日期就收了手，从来没点过保存 —— 所以新增接口的 INSERT
  // 把列名和值错开一位这种错，整套回归一次也没碰到过。
  await page.locator('.sheet input').first().fill('回归新建的一项');
  await h.sleep(300);
  await page.locator('.sheet .btn.primary').click();
  await h.sleep(1600);
  t.check('保存后弹层关掉了', (await page.locator('.sheet').count()) === 0);
  t.check('新的一项出现在时间线上', (await page.locator('.tl-card').filter({ hasText: '回归新建的一项' }).count()) === 1);
  t.check('保存没有报错', (await page.locator('.toast.error').count()) === 0);

  // 直接查快照：列和值错位的时候，节点要么根本存不进来，要么 status 串成别的列
  const saved = await page.evaluate(async () => {
    const token = localStorage.getItem('travel.token');
    const resp = await fetch('/api/trip/snapshot', { headers: { Authorization: 'Bearer ' + token } });
    const snap = await resp.json();
    const n = (snap.nodes || []).find((x) => x.title === '回归新建的一项');
    return n ? { status: n.status, sort: n.sort_order, role: n.role ?? null } : null;
  });
  t.check('新节点字段各归各位', !!saved && saved.status === 'planned' && typeof saved.sort === 'number', JSON.stringify(saved));
  await t.shot('新建保存后');

  process.exit(await t.end());
})().catch(async (e) => { console.error('脚本自己炸了:', e.message); process.exit(2); });
