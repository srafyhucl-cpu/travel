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

  /*
   * 用界面自己的上传入口塞两张纯色小图（走真实的 File 上传路径，
   * 之前是直接 fetch，接口一改这里就漏测）。顺带验成功提示与缩略图。
   */
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  await page.locator('.tl-item input[type="file"]').first().setInputFiles([
    { name: 'check-vlog-a.png', mimeType: 'image/png', buffer: PNG_1PX },
    { name: 'check-vlog-b.png', mimeType: 'image/png', buffer: PNG_1PX },
  ]);
  await page.waitForSelector('.toast.success', { timeout: 15000 });
  const upToast = await page.locator('.toast.success').innerText();
  // 平台重构时这里漏过一步响应解析，提示会变成「已上传 undefined 张照片」
  t.check('上传成功提示带张数', upToast.includes('已上传 2 张照片'), upToast);

  await page.waitForSelector('.tl-item .tl-shots img', { timeout: 15000 });
  const thumb = await page.evaluate(() => {
    const img = document.querySelector('.tl-item .tl-shots img');
    return img && img.src.startsWith('blob:') ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  t.check('界面上传后时间线出现缩略图', !!thumb && thumb.w > 0, thumb ? `${thumb.w}×${thumb.h}` : '没等到');

  // 魔数对、内容坏的图：解不开时应该给一句说明，而不是摆一个破图
  const BAD_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 魔数
    Buffer.from('not really a png body'),
  ]);
  await page.locator('.tl-item input[type="file"]').first().setInputFiles([
    { name: 'check-vlog-bad.png', mimeType: 'image/png', buffer: BAD_PNG },
  ]);
  await page.waitForSelector('.tl-item .shot-bad', { timeout: 20000 });
  t.check('坏图解不开时给说明块', true);

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
