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
 * 日期/时间/挂载现在是自己画的触发按钮（.picker-trigger），不是原生 input，
 * 内容分主值（.picker-trigger-main）和右端副值（.picker-trigger-sub，固定宽）
 * 两段，副值挤掉主值也要算「装不下」，所以 need 改成两段宽度相加。
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
for (const el of document.querySelectorAll('.sheet-body input, .sheet-body select, .sheet-body textarea, .sheet-body .picker-trigger')) {
      const box = el.getBoundingClientRect();
      const label = el.closest('.field')?.querySelector('label')?.textContent?.trim() || el.type;
      const cs = getComputedStyle(el);
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
// 自有控件的触发按钮不是 input：内容分主值（.picker-trigger-main）和
// 右端副值（.picker-trigger-sub，副值是 flex:none 固定宽），右端还有 chevron。
// need 要把主值+副值+gap+padding+chevron 全算上 —— 只量主值会漏掉「副值把
// 主值挤到只剩省略号」这种情况（trigger 的 34 里就有 chevron+两段 gap）。
const isTrigger = el.classList.contains('picker-trigger');
const mainText = isTrigger ? el.querySelector('.picker-trigger-main')?.textContent ?? '' : null;
const subEl = isTrigger ? el.querySelector('.picker-trigger-sub') : null;
const shown = isTrigger ? mainText : (el.tagName === 'SELECT'
? (el.selectedOptions[0]?.textContent || '')
: (el.value || el.placeholder || ''));
const subNeed = subEl
? Math.round(probe.measureText(subEl.textContent).width) + 6 // + 主副值之间的 gap
: 0;
const need = Math.round(probe.measureText(shown).width + subNeed
+ parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 34);
      out.push({
        label,
type: isTrigger ? 'trigger' : (el.tagName === 'SELECT' ? 'select' : (el.type || el.tagName.toLowerCase())),
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
