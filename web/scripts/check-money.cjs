/**
 * 总预算合并 + 身份贯通：
 *   1. 「改预算」把历史分类行合并成一条「总预算」——只留一行，金额就是新数；
 *   2. 快照带 meId，改名后前端还能认出「我」（改名这一步的 UI 回归在 smoke 里）。
 *
 * 跑法：PASS=你的口令 npm run check:money
 * 退出码：0 = 全通，1 = 有失败，2 = 脚本自己炸了。
 */
const h = require('./_harness.cjs');

(async () => {
  const t = await h.begin();
  await t.login();
  const page = t.page;

  // 先造两行旧式分类预算；顺便确认快照已经带上 meId
  const prepared = await page.evaluate(async () => {
    const token = localStorage.getItem('travel.token');
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const snap = await (await fetch('/api/trip/snapshot', { headers: auth })).json();
    for (const b of snap.budgets) {
      await fetch(`/api/money/budgets/${b.id}`, { method: 'DELETE', headers: auth });
    }
    for (const row of [
      { category: '机票·去程', amount: 1200 },
      { category: '住宿', amount: 800 },
    ]) {
      await fetch('/api/money/budgets', { method: 'POST', headers: auth, body: JSON.stringify(row) });
    }
    return { meId: snap.meId };
  });
  t.check('快照带 meId', !!prepared.meId, String(prepared.meId));

  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(1200);

  // 已花 → 改预算 → 填 5000 → 保存
  await page.locator('.money-seg').click();
  await h.sleep(600);
  await page.locator('.dk-panel .chip-btn:has-text("改预算")').click();
  await page.waitForSelector('.sheet input[type="number"]', { timeout: 8000 });
  await page.locator('.sheet input[type="number"]').fill('5000');
  await page.locator('.sheet button:has-text("保存")').click();
  await h.sleep(1400);

  const after = await page.evaluate(async () => {
    const token = localStorage.getItem('travel.token');
    const snap = await (await fetch('/api/trip/snapshot', {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    return snap.budgets;
  });
  t.check('只剩一条预算', after.length === 1, `实际 ${after.length} 条`);
  t.check('金额改成 5000', after[0]?.planned_amount === 5000, String(after[0]?.planned_amount));
  t.check('类别是总预算', after[0]?.category === '总预算', String(after[0]?.category));

  // 再开一次，输入框应预填 5000（读回来的数和刚存的是一回事）
  await page.locator('.dk-panel .chip-btn:has-text("改预算")').click();
  await page.waitForSelector('.sheet input[type="number"]', { timeout: 8000 });
  const val = await page.locator('.sheet input[type="number"]').inputValue();
  t.check('再次打开预填 5000', val === '5000', val);
  await h.sleep(300);
  await t.shot('总预算');
  await page.keyboard.press('Escape');
  await h.sleep(500);

  // 改口令走一遍 UI：新口令能用、旧口令失效
  const NEW_PASS = `${h.PASS}-ui`;
  await page.locator('.icon-btn').last().click();
  await page.waitForSelector('.sheet', { timeout: 8000 });
  await h.sleep(600);
  await page.locator('.sheet button:has-text("修改旅行口令")').click();
  await page.waitForSelector('.sheet input[type="password"]', { timeout: 8000 });
  await h.sleep(400);
  const passSheet = page.locator('.sheet').last();
  const passInputs = passSheet.locator('input[type="password"]');
  await passInputs.nth(0).fill(h.PASS);
  await passInputs.nth(1).fill(NEW_PASS);
  await passInputs.nth(2).fill(NEW_PASS);
  await page.locator('.sheet button:has-text("更新口令")').click();
  await h.sleep(1400);
  await t.shot('改口令');

  const tryLogin = async (passphrase) =>
    (await fetch(`${t.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase, name: '我' }),
    })).status;
  const oldStatus = await tryLogin(h.PASS);
  const newStatus = await tryLogin(NEW_PASS);
  t.check('改口令后旧口令失效', oldStatus === 401, String(oldStatus));
  t.check('改口令后新口令能用', newStatus === 200, String(newStatus));

  process.exit(await t.end());
})().catch(async (e) => {
  console.error('脚本自己炸了:', e.message);
  process.exit(2);
});
