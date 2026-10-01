/**
 * 量记账弹层里的输入框：内容是不是真的塞不下。
 *
 * 用 canvas 按同样的字体量一遍文字实际需要多宽，跟框宽比。
 * 当初「时间」字段被 datetime-local 的图标压在底下就是这么发现的：
 * 显示的是 2026/10/01 18:45，实际要 197px，框只有 185px。
 *
 * 原生 <select> 不算失败 —— 它会省略号截断，点开又是完整列表，
 * 那是标准行为。所以「挂在」这种长选项只报数、不判成败。
 *
 * 跑法：node web/scripts/check-fields.cjs
 * 退出码：0 = 没有输入框被挤爆，1 = 有。
 */
const h = require('./_harness.cjs');

(async () => {
  const t = await h.begin();
  await t.login();

  await t.page.locator('.tl-item').first().locator('[aria-label="记一笔"]').click();
  await t.page.waitForSelector('.sheet', { timeout: 8000 });
  await h.sleep(600);

  const fields = await t.page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.sheet-body input, .sheet-body select, .sheet-body textarea')) {
      const box = el.getBoundingClientRect();
      const label = el.closest('.field')?.querySelector('label')?.textContent?.trim() || el.type;
      const cs = getComputedStyle(el);
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const shown = el.tagName === 'SELECT'
        ? (el.selectedOptions[0]?.textContent || '')
        : (el.value || el.placeholder || '');
      const need = Math.round(probe.measureText(shown).width
        + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 34);
      out.push({
        label,
        type: el.tagName === 'SELECT' ? 'select' : (el.type || el.tagName.toLowerCase()),
        box: Math.round(box.width),
        need,
        shown: shown.slice(0, 30),
      });
    }
    return out;
  });

  for (const f of fields) {
    const isSelect = f.type === 'select';
    const clipped = f.need > f.box;
    const line = `${isSelect ? '·' : (clipped ? '✗' : '·')} ${f.label.padEnd(8)} ${f.type.padEnd(12)} `
      + `框${String(f.box).padStart(4)} / 需${String(f.need).padStart(4)}  「${f.shown}」`;
    console.log(clipped && !isSelect ? `${line} 装不下` : line);
    if (!isSelect) t.check(`${f.label} 放得下`, !clipped, `需 ${f.need} / 框 ${f.box}`);
  }

  await t.shot('记账弹层');
  process.exit(await t.end());
})().catch(async (e) => { console.error('脚本自己炸了:', e.message); process.exit(2); });
