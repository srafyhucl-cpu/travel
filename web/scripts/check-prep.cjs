/**
 * 顶部常驻块（Deck）回归：现在 / 前置 / 钱 合并在一张卡里、跟顶栏一起常驻、
 * 前置默认收起、时间线上不重复显示、勾选落库、刷新后还在、全勾完自动折起、
 * ✎ 打开的就是现成的节点编辑器、两个面板一次只开一个、
 * 面板再长也不会把常驻块顶出屏幕（明细自己滚、标题和「改预算」留在滚动区外）、
 * 第二个模块节点不会凭空消失。
 *
 * 本地库里没有打过 role='module' 的节点（生产上「前置准备」那条才有），
 * 所以脚本先在一次性副本上用 API 把第一条标成模块、塞三条待办，再验 UI。
 * 副本机制见 _harness：真库一个字节都不会动。
 *
 * 跑法：node web/scripts/check-prep.cjs
 * 退出码：0 = 全通，1 = 有。
 */
const h = require('./_harness.cjs');

(async () => {
  const t = await h.begin();
  const { page } = t;
  await t.login();

  // ---- 0. 布置：把第一条节点标成模块，并给它三条待办 ----
  const setup = await page.evaluate(async () => {
    const token = localStorage.getItem('travel.token');
    const auth = { Authorization: `Bearer ${token}` };
    const snap = await (await fetch('/api/trip/snapshot', { headers: auth })).json();
    const n = snap.nodes[0];
    const res = await fetch(`/api/nodes/${n.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'module',
        checklist: ['购买去程机票', '预定机场附近民宿', '预约顺风车酒店到茶马客栈'],
      }),
    });
    return { id: n.id, title: n.title, ok: res.ok };
  });
  t.check('副本上已打好模块标记', setup.ok, `节点「${setup.title}」`);
  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(1300);

  // ---- 1. 三块合并成一张卡，且跟顶栏一起常驻 ----
  const shape = await page.evaluate(() => {
    const hud = document.querySelector('.hud');
    const deck = document.querySelector('.deck');
    return {
      hud: !!hud,
      sticky: hud ? getComputedStyle(hud).position : '',
      deckInHud: !!deck && !!hud?.contains(deck),
      now: !!deck?.querySelector('.dk-now'),
      segs: deck?.querySelectorAll('.dk-seg').length || 0,
      prepSeg: !!deck?.querySelector('.prep-seg'),
      moneySeg: !!deck?.querySelector('.money-seg'),
      oldCards: document.querySelectorAll('.nowstrip, .moneystrip, .prepm').length,
    };
  });
  t.check('有一块常驻 HUD', shape.hud && shape.sticky === 'sticky', `position=${shape.sticky}`);
  t.check('合并后的卡在 HUD 里', shape.deckInHud);
  t.check('卡里有「现在」和两格（前置/钱）', shape.now && shape.prepSeg && shape.moneySeg, `${shape.segs} 格`);
  t.check('三块老卡片都没了', shape.oldCards === 0, `还剩 ${shape.oldCards} 张`);
  t.check('顶栏和卡是挨着的', await page.evaluate(() => {
    const tb = document.querySelector('.topbar');
    const deck = document.querySelector('.deck');
    return !!tb && !!deck && Math.abs(tb.getBoundingClientRect().bottom - deck.getBoundingClientRect().top) < 2;
  }));

  // 时间线上不显示这条（顶部已经有一份了）
  const onTimeline = await page.locator('.tl-card').filter({ hasText: setup.title }).count();
  t.check('时间线上不再显示这条', onTimeline === 0, `${onTimeline} 张卡`);

  // ---- 2. 前置默认收起：一行进度，不铺开清单 ----
  t.check('前置默认收起（没有面板）', (await page.locator('.dk-panel').count()) === 0);
  t.check('收起时显示 0/3', (await page.locator('.prep-seg .ds-num').textContent()).trim() === '0/3');
  t.check('收起时箭头不朝下', (await page.locator('.prep-seg .dk-caret.open').count()) === 0);
  await t.shot('常驻块-收起');

  // ---- 3. 展开后勾一条：落库、进度更新 ----
  await page.locator('.prep-seg').click();
  await h.sleep(400);
  t.check('点前置能展开面板', (await page.locator('.dk-panel').count()) === 1);
  t.check('展开后有三条待办', (await page.locator('.dk-panel .tl-check').count()) === 3);
  t.check('展开时箭头朝下', (await page.locator('.prep-seg .dk-caret.open').count()) === 1);

  // 一次只开一个：这时点「钱」，前置面板要让位
  await page.locator('.money-seg').click();
  await h.sleep(400);
  t.check('两个面板一次只开一个（点钱后前置让位）', (await page.locator('.dk-panel').count()) === 1);
  t.check('打开的是预算面板', (await page.locator('.money-seg .dk-caret.open').count()) === 1);
  await page.locator('.money-seg').click();
  await h.sleep(400);

  await page.locator('.prep-seg').click();
  await h.sleep(400);
  await page.locator('.dk-panel .tl-check').first().click();
  await h.sleep(900);
  t.check('勾上第一条', (await page.locator('.dk-panel .tl-check.on').count()) === 1);
  t.check('进度字变成 1/3', (await page.locator('.prep-seg .ds-num').textContent()).trim() === '1/3');
  await t.shot('勾一条');

  // ---- 4. 刷新后还在（落库了，不是内存状态），且默认仍是收起 ----
  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(1300);
  t.check('刷新后默认收起', (await page.locator('.dk-panel').count()) === 0);
  t.check('刷新后进度还是 1/3', (await page.locator('.prep-seg .ds-num').textContent()).trim() === '1/3');
  await page.locator('.prep-seg').click();
  await h.sleep(400);
  t.check('刷新后展开看，勾选还在', (await page.locator('.dk-panel .tl-check.on').count()) === 1);

  // 取消：再点一次就回来了
  await page.locator('.dk-panel .tl-check.on').first().click();
  await h.sleep(900);
  t.check('再点一次能取消', (await page.locator('.dk-panel .tl-check.on').count()) === 0);
  t.check('进度回到 0/3', (await page.locator('.prep-seg .ds-num').textContent()).trim() === '0/3');

  // ---- 5. 全勾完：面板自动折起，但格子不消失 ----
  for (let i = 3; i > 0; i -= 1) {
    await page.locator('.dk-panel .tl-check').nth(i - 1).click();
    await h.sleep(700);
  }
  await h.sleep(600);
  t.check('全勾完面板自动折起', (await page.locator('.dk-panel').count()) === 0);
  t.check('格子没有消失', (await page.locator('.prep-seg').count()) === 1);
  t.check('显示「✓ 完成」', (await page.locator('.prep-seg .ds-num').textContent()).includes('完成'));
  t.check('格子进入完成态', (await page.locator('.prep-seg.ok').count()) === 1);
  await t.shot('完成');

  // 折起以后还能再展开看清单
  await page.locator('.prep-seg').click();
  await h.sleep(400);
  t.check('折起后还能再展开看清单', (await page.locator('.dk-panel .tl-check').count()) === 3);
  t.check('展开后三条都是勾上的', (await page.locator('.dk-panel .tl-check.on').count()) === 3);
  await page.locator('.prep-seg').click();
  await h.sleep(300);

  // ---- 6. ✎ 打开的是现成的节点编辑器，开关是开的 ----
  await page.locator('.prep-seg').click();
  await h.sleep(400);
  await page.locator('.dk-panel-head .chip-btn').click();
  await page.waitForSelector('.sheet', { timeout: 10000 });
  await h.sleep(700);
  const sheetText = await page.locator('.sheet').innerText();
  t.check('编辑器里有「作为模块置顶显示」', sheetText.includes('作为模块置顶显示'));
  t.check('模块节点打开时开关是开的', (await page.locator('.sheet .switch.on').count()) === 1);
  t.check('编辑器里能看到那三条待办', (await page.locator('.sheet .cklist-row').count()) === 3);
  await t.shot('模块编辑器');
  await page.locator('.sheet .icon-btn[aria-label=关闭]').click();
  await h.sleep(500);

  // ---- 7. 普通节点的同一个开关是关的（别把谁都顶上去）----
  const otherCard = page.locator('.tl-card').first();
  await otherCard.locator('.tl-head').click();
  await page.waitForSelector('.sheet', { timeout: 10000 });
  await h.sleep(700);
  t.check('普通节点也有这个开关', (await page.locator('.sheet .switch').count()) === 1);
  t.check('普通节点打开时开关是关的', (await page.locator('.sheet .switch.on').count()) === 0);
  await page.locator('.sheet .icon-btn[aria-label=关闭]').click();
  await h.sleep(400);

  // ---- 8. 面板封顶：清单/类别再多也不能把常驻块顶出屏幕 ----
  // 服务端一条待办最多收 20 条，正好用来试「长到必须滚」的情况
  await page.evaluate(async () => {
    const token = localStorage.getItem('travel.token');
    const auth = { Authorization: `Bearer ${token}` };
    const snap = await (await fetch('/api/trip/snapshot', { headers: auth })).json();
    const mod = snap.nodes.find((n) => n.role === 'module');
    await fetch(`/api/nodes/${mod.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checklist: Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 件要办的事：把这一项写长一点看看会不会撑破面板`),
      }),
    });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(1300);
  await page.locator('.prep-seg').click();
  await h.sleep(400);
  t.check('长清单全部渲染', (await page.locator('.dk-panel .tl-check').count()) === 20);
  t.check('进度字变成 0/20', (await page.locator('.prep-seg .ds-num').textContent()).trim() === '0/20');

  const box = await page.evaluate(() => {
    const hud = document.querySelector('.hud').getBoundingClientRect();
    const body = document.querySelector('.dk-panel-body');
    const head = document.querySelector('.dk-panel-head').getBoundingClientRect();
    return {
      hudH: hud.height,
      vh: window.innerHeight,
      overflowY: getComputedStyle(body).overflowY,
      scrollable: body.scrollHeight > body.clientHeight + 1,
      headTop: head.top,
    };
  });
  t.check('明细在面板里自己滚', box.overflowY === 'auto' && box.scrollable, `overflow-y=${box.overflowY}`);
  t.check('常驻块不超过 6 成屏', box.hudH <= box.vh * 0.62, `${Math.round(box.hudH)} / ${box.vh}`);

  // 滚到清单底部：标题和 ✎ 不能被顶走（它们在滚动区外面）
  await page.evaluate(() => {
    const body = document.querySelector('.dk-panel-body');
    body.scrollTop = body.scrollHeight;
  });
  await h.sleep(300);
  const after = await page.evaluate(() => {
    const head = document.querySelector('.dk-panel-head').getBoundingClientRect();
    const edit = document.querySelector('.dk-panel-head .chip-btn').getBoundingClientRect();
    return { headTop: head.top, editVisible: edit.top >= 0 && edit.bottom <= window.innerHeight };
  });
  t.check('滚到底后标题和 ✎ 还在', Math.abs(after.headTop - box.headTop) < 2 && after.editVisible, `head ${Math.round(box.headTop)} → ${Math.round(after.headTop)}`);
  await t.shot('长清单-滚到底');

  // 预算面板：它不长，但常驻块照样得留出下面的行程
  await page.locator('.money-seg').click();
  await h.sleep(400);
  const money = await page.evaluate(() => {
    const hud = document.querySelector('.hud').getBoundingClientRect();
    const foot = document.querySelector('.dk-panel-foot')?.getBoundingClientRect();
    return { hudH: hud.height, vh: window.innerHeight, footIn: !!foot && foot.bottom <= window.innerHeight };
  });
  t.check('展开预算时常驻块有界', money.hudH <= money.vh * 0.62, `${Math.round(money.hudH)} / ${money.vh}`);
  t.check('「还剩 / 改预算」留在可视区里', money.footIn);
  await t.shot('预算展开-封顶');

  // ---- 9. 第二个模块节点：服务端只留一个，前端也不许把它凭空吃掉 ----
  const swap = await page.evaluate(async () => {
    const token = localStorage.getItem('travel.token');
    const auth = { Authorization: `Bearer ${token}` };
    const snap = await (await fetch('/api/trip/snapshot', { headers: auth })).json();
    const other = snap.nodes.find((n) => n.role !== 'module');
    const res = await fetch(`/api/nodes/${other.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'module' }),
    });
    const after = await (await fetch('/api/trip/snapshot', { headers: auth })).json();
    return {
      ok: res.ok,
      other: other.title,
      modules: after.nodes.filter((n) => n.role === 'module').map((n) => n.id),
      newModule: other.id,
    };
  });
  t.check('新的模块标记打上了', swap.ok);
  t.check('库里只剩一个模块', swap.modules.length === 1 && swap.modules[0] === swap.newModule, `${swap.modules.length} 个`);
  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(1300);
  await page.locator('.prep-seg').click();
  await h.sleep(400);
  t.check('顶部换成新的那条', (await page.locator('.dk-panel-head').innerText()).trim() === swap.other);
  t.check('原来的模块回到时间线上', (await page.locator('.tl-card').filter({ hasText: setup.title }).count()) === 1);
  await t.shot('换模块后');

  process.exit(await t.end());
})().catch((e) => { console.error('脚本自己炸了:', e.message); process.exit(2); });
