/**
 * 行程长图：设置页 →「生成 vlog 图」→ 长图模式。
 *
 * 验三件事：
 *   1. 默认长图能渲出来：1080 宽、明显比一屏高、画面不是空白；
 *   2. 「带照片」开关有效：传两张图进去，打开比关掉更高；
 *   3. 保存按钮在。
 *
 * 测试照片是浏览器里现画的 8×8 纯色图，直接传给一次性后端，跑完连数据一起删。
 *
 * 跑法：node web/scripts/check-vlog.cjs
 * 退出码：0 = 全通，1 = 有失败，2 = 脚本自己炸了。
 */
const h = require('./_harness.cjs');

(async () => {
  const t = await h.begin();
  await t.login();
  const page = t.page;

  // 先往第一张卡上塞两张纯色小图，这样能同时测「带照片」这条路径
  const uploaded = await page.evaluate(async () => {
    const token = localStorage.getItem('travel.token');
    const snap = await (await fetch('/api/trip/snapshot', { headers: { Authorization: `Bearer ${token}` } })).json();
    const node = snap.nodes.find((n) => n.role !== 'module') || snap.nodes[0];
    const make = async (color) => {
      const c = document.createElement('canvas');
      c.width = 8;
      c.height = 8;
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, 8, 8);
      return await new Promise((r) => c.toBlob(r, 'image/png'));
    };
    const fd = new FormData();
    fd.append('photos', new File([await make('#e2574c')], 'a.png', { type: 'image/png' }));
    fd.append('photos', new File([await make('#2f80ed')], 'b.png', { type: 'image/png' }));
    fd.append('nodeId', node.id);
    const res = await fetch('/api/photos', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
    return { ok: res.ok, status: res.status };
  });
  t.check('测试照片已上传', uploaded.ok, `HTTP ${uploaded.status}`);

  await page.reload({ waitUntil: 'networkidle' });
  await h.sleep(900);

  await page.locator('.icon-btn').last().click();
  await page.waitForSelector('.sheet', { timeout: 8000 });
  await h.sleep(400);
  await page.locator('.sheet button:has-text("生成 vlog 图")').click();
  await page.waitForSelector('.sheet button:has-text("行程长图")', { timeout: 8000 });
  await h.sleep(400);

  const modeText = (await page.locator('.sheet .pill-row .pill').allInnerTexts()).join(' / ');
  t.check('两种模式都在', modeText.includes('行程长图') && modeText.includes('照片拼图'), modeText);

  const readPreview = () =>
    page.evaluate(() => {
      const img = document.querySelector('.vlog-scroll img.vlog-preview') || document.querySelector('img.vlog-preview');
      if (!img) return null;
      return { w: img.naturalWidth, h: img.naturalHeight };
    });

  const waitPreview = async (pred, tries = 40) => {
    let meta = null;
    for (let i = 0; i < tries; i++) {
      meta = await readPreview();
      if (meta && pred(meta)) return meta;
      await h.sleep(300);
    }
    return meta;
  };

  const base = await waitPreview((m) => m.h > 1000);
  t.check('长图渲出来了', !!base && base.w === 1080 && base.h > 1080, base ? `${base.w}×${base.h}` : '没等到');

  const ink = await page.evaluate(async () => {
    const img = document.querySelector('.vlog-scroll img.vlog-preview');
    if (!img) return { colors: 0 };
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 120;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 120, 120);
    const data = g.getImageData(0, 0, 120, 120).data;
    const set = new Set();
    for (let i = 0; i < data.length; i += 4) set.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { colors: set.size };
  });
  t.check('长图不是空白', ink.colors > 8, `颜色 ${ink.colors} 种`);

  const h1 = base ? base.h : 0;
  await page.locator('.sheet button:has-text("带照片")').click();
  const withPhoto = await waitPreview((m) => m.h !== h1);
  t.check('带照片比不带高', !!withPhoto && withPhoto.h > h1, `${h1} → ${withPhoto ? withPhoto.h : '?'}`);

  t.check('保存按钮在', (await page.locator('.sheet button:has-text("保存到相册")').count()) > 0);
  await t.shot('行程长图');

  process.exit(await t.end());
})().catch(async (e) => {
  console.error('脚本自己炸了:', e.message);
  process.exit(2);
});
