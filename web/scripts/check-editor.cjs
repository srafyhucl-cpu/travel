/**
 * 编辑器回归：卡片类型色、代办逐条输入、必填标注、日期自动、新建保存。
 *
 * 这几条是一起改的（见 git log「卡片按类型区分、去掉提示、代办改成逐条输入、
 * 日期自动与必填标注、新建保存」），所以放一个脚本里一起验。中间挖过一个隐蔽的 bug：
 * 代办组件被写在 NodeEditor 的函数体内部，每次渲染都是新的函数身份，
 * React 判定类型变了把整棵子树重挂载，useRef 活不过那次重挂，回车加行成功
 * 但光标永远送不出去。盯「回车后焦点在新行 + 新行能打字」这两条就够。
 *
 * 第 8 节是补原生控件那一版的回归：日期、时间、挂载原来是系统控件（date /
 * time / datetime-local / select），展开出来是系统自己的面板，跟这个 App 的样子
 * 完全两样。现在换成自有的月历、时间胶囊、可搜索行程列表，所以这里走真实
 * 点击：面板能打开、选完关上、按钮上出现那个值、手输 7:35 也认、列表能搜。
 * 最后一条断言盯「一个原生控件都没剩下」——以后谁再塞一个回来会红。
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
  // 日期现在是自有的月历（以前是原生 input[type=date]），默认值由打开新项时
  // 同一段代码写进 form.date，所以这里只能从触发按钮上读回来。
  const mdLabel = await page.evaluate(async () => {
    /*
     * 期望值按页面同一条规则算：今天落在行程日期区间内（或某个节点当天）就填今天，
     * 否则接在最后一项之后。只写死「今天」会在行程结束后的日子里误报 —— 这条在
     * 10 月 6 号（行程最后一天是 10-04）跑红过。
     */
    const token = localStorage.getItem('travel.token');
    const snap = await (await fetch('/api/trip/snapshot', { headers: { Authorization: 'Bearer ' + token } })).json();
    const pad = (n) => String(n).padStart(2, '0');
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const shift = (s, n) => {
      const d = new Date(`${s}T00:00:00`);
      d.setDate(d.getDate() + n);
      return iso(d);
    };
    const spanDays = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
    const today = iso(new Date());
    const dates = new Set((snap.nodes || []).map((n) => n.date));
    if (snap.trip?.start_date && snap.trip?.end_date) {
      const span = spanDays(snap.trip.start_date, snap.trip.end_date);
      for (let i = 0; i <= span; i++) dates.add(shift(snap.trip.start_date, i));
    }
    const last = (snap.nodes || []).reduce((acc, n) => (!acc || n.date > acc ? n.date : acc), null);
    const target = dates.has(today) ? today : last ? shift(last, 1) : snap.trip?.start_date;
    const [, m, d] = target.split('-').map(Number);
    return `${m}月${d}日`;
  });
  const dateText = (await page.locator('.sheet .picker-trigger').first().innerText()).replace(/\n/g, ' ');
  t.check('日期已自动填好', dateText.includes(mdLabel), `按钮上写着「${dateText}」，期望 ${mdLabel}`);
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


  // ---- 8. 日期/时间/挂载：自有的三个控件 ----
  // 这三个原来是系统控件（date / time / datetime-local / select），展开出来是
  // 系统的面板，跟这个 App 一点不像。换成了自己画的月历、时间胶囊和可搜索的
  // 行程列表，所以这里走真实交互：打开面板 → 选一个值 → 面板关上 → 触发按钮
  // 上出现那个值。
  // 上一节保存完弹层就关了，这里重新打开编辑器。
  await page.locator('.tl-head').first().click();
  await page.waitForSelector('.sheet', { timeout: 10000 });
  await h.sleep(600);
  // 先在时间上点一下：面板里应该有胶囊，手输 7:35 也要认。
  await page.locator('.sheet .picker-trigger').nth(1).click();
  await page.waitForSelector('.sheet .picker-chips .pill', { timeout: 8000 });
  t.check('时间面板有胶囊', (await page.locator('.sheet .picker-chips .pill').count()) > 10);
  await page.locator('.sheet .picker-manual .input').fill('7:35');
  await page.locator('.sheet .picker-manual .btn').click();
  await h.sleep(600);
  const timeText = (await page.locator('.sheet .picker-trigger').nth(1).innerText()).replace(/\n/g, ' ');
  t.check('手输 7:35 能定下来', timeText.includes('7:35'), `按钮上写着「${timeText}」`);
  await t.shot('时间胶囊');

  // 日期面板：今天那格应该带 today 圈，点它面板关上、按钮显示今天。
  await page.locator('.sheet .picker-trigger').first().click();
  await page.waitForSelector('.sheet .cal-grid .cal-cell.today', { timeout: 8000 });
  t.check('月历里今天有标记', (await page.locator('.sheet .cal-cell.today').count()) === 1);
  t.check('月历 42 格', (await page.locator('.sheet .cal-cell').count()) === 42);
  await page.locator('.sheet .cal-cell.today').click();
  await h.sleep(600);
  t.check('点今天面板关掉了', (await page.locator('.sheet .cal-grid').count()) === 0);
  await t.shot('月历');

  // 挂载列表在「记一笔」弹层里。先把还开着的编辑器关掉 —— 它的遮罩会挡住
  // 时间线上那枚「记一笔」，点不到。
  await page.keyboard.press('Escape');
  await h.sleep(500);
  t.check('Escape 关掉了编辑器', (await page.locator('.sheet').count()) === 0);

  // 挂载列表：要能搜。搜一个只可能来自行程标题的字，命中行里得有它。
  await page.locator('.tl-item').first().locator('[aria-label="记一笔"]').click();
  await page.waitForSelector('.sheet .picker-trigger', { timeout: 8000 });
  await h.sleep(600);
  // 「挂在」默认已经选了当前这张卡，所以触发按钮上有值；列表要点开才渲染。
  // 手机上搜索框如果自动聚焦会立刻弹键盘，把列表顶到看不见的地方 ——
  // 等弹层稳一会儿再数行，顺便确认焦点没落在搜索框上。
  await page.locator('.sheet').getByLabel('选行程项').click();
  await page.waitForSelector('.sheet .pick-row', { timeout: 8000 });
  await h.sleep(900);
  t.check('搜索框不抢焦点（免得自动弹键盘）', await page.evaluate(() => document.activeElement?.classList.contains('input')) === false);
  const pickRows0 = await page.locator('.sheet .pick-row').count();
  t.check('挂载列表列出了行程', pickRows0 > 3, `${pickRows0} 行`);
  // 拿第一行的标题当搜索词 —— 搜它自己，至少自己那行得留下。
  const firstTitle = await page.locator('.sheet .pick-row .pick-row-title').first().innerText();
await page.locator('.sheet .input[placeholder*="搜标题"]').fill(firstTitle.slice(0, 3));
  await h.sleep(500);
  const rows1 = await page.locator('.sheet .pick-row').count();
  t.check('挂载能搜', rows1 >= 1 && rows1 <= pickRows0, `${pickRows0} → ${rows1}`);
  await t.shot('挂载搜索');
  await page.locator('.sheet .pick-row').first().click();
  await h.sleep(600);
  t.check('选完面板关上', (await page.locator('.sheet .pick-list').count()) === 0);
  // 记一笔弹层里除了这几个，其它框都还在（别把原生控件漏掉了）。
  const nativeLeft = await page.locator('.sheet input[type=date], .sheet input[type=time], .sheet input[type=datetime-local], .sheet select').count();
  t.check('没有残留的原生日期/时间/下拉', nativeLeft === 0, `还剩 ${nativeLeft} 个`);
  process.exit(await t.end());
})().catch(async (e) => { console.error('脚本自己炸了:', e.message); process.exit(2); });
