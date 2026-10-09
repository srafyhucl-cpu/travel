import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, 'logo.svg'), 'utf8');
const outDir = join(here, 'dist');
mkdirSync(outDir, { recursive: true });

// ---- 硬校验：图形（不含底）必须完整落在微信裁圆 r=72 内，留 2px 余量 ----
const SIZE = 144;
const RADIUS = 72;
const MARGIN = 2;
const artwork = svg.replace(/<rect\b[^>]*\/>/, ''); // 去掉底色矩形，只看标志本身
const probe = new Resvg(artwork, { fitTo: { mode: 'width', value: SIZE } }).render();
const px = probe.pixels;
let maxR = 0;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (px[(y * SIZE + x) * 4 + 3] === 0) continue; // 透明像素
    const d = Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2);
    if (d > maxR) maxR = d;
  }
}
const margin = RADIUS - maxR;
if (margin < MARGIN) {
  throw new Error(
    `切角！图形最远点距中心 ${maxR.toFixed(1)}px，超过裁圆半径 ${RADIUS}px（余量 ${margin.toFixed(1)}px < ${MARGIN}px）`,
  );
}
console.log(`裁圆校验 OK：图形最远点 ${maxR.toFixed(1)}px，距裁圆边界余量 ${margin.toFixed(1)}px`);

// ---- 导出 ----
for (const width of [144, 288, 576]) {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'rgba(0,0,0,0)',
  })
    .render()
    .asPng();

  // IHDR 宽高在第 16/20 字节（大端）
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== width || h !== width) {
    throw new Error(`尺寸不对：期望 ${width}×${width}，实际 ${w}×${h}`);
  }

  const file = join(outDir, `logo-${width}.png`);
  writeFileSync(file, png);
  console.log(`OK ${file}  ${w}×${h}  ${(png.length / 1024).toFixed(1)} KB`);
}

// ---- 微信裁圆预览：圆内=logo，圆外灰=会被裁掉的区域 ----
const inner = svg
  .replace(/<svg[^>]*>/, '')
  .replace('</svg>', '')
  .replace(/<rect\b[^>]*\/>/, '');
const cropSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs><clipPath id="c"><circle cx="72" cy="72" r="72"/></clipPath></defs>
  <rect width="144" height="144" fill="#e5e7eb"/>
  <g clip-path="url(#c)"><rect width="144" height="144" fill="#F4F5F7"/>${inner}</g>
  <circle cx="72" cy="72" r="72" fill="none" stroke="#e2574c" stroke-width="2"/>
</svg>`;
const crop = new Resvg(cropSvg, { fitTo: { mode: 'width', value: 144 } }).render().asPng();
writeFileSync(join(outDir, 'logo-crop-check.png'), crop);
console.log(`OK ${join(outDir, 'logo-crop-check.png')}（微信裁圆模拟，红圈内不该有任何被切断的图形）`);
