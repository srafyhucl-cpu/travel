/**
 * 给存量照片预热派生图（缩略图 + 展示图）。
 * 部署后按需跑一次；平时新照片由上传后的后台预热负责。
 *
 *   node src/tools/warm-derivatives.js
 *
 * 串行执行（HEIC 解码峰值内存高，见 src/derivatives.js），已有派生会直接跳过。
 */
import { db } from '../db.js';
import { ensureDerivative } from '../derivatives.js';

const rows = db.prepare('SELECT * FROM photos ORDER BY created_at').all();
console.log(`共 ${rows.length} 张，开始预热派生图（串行，已存在的会跳过）…`);

let ok = 0;
let failed = 0;
let done = 0;
for (const photo of rows) {
  const started = Date.now();
  const thumb = await ensureDerivative(photo, 'thumb');
  const display = await ensureDerivative(photo, 'display');
  done += 1;
  if (thumb && display) ok += 1;
  else failed += 1;
  console.log(`  [${done}/${rows.length}] ${photo.id.slice(0, 8)} ${Date.now() - started}ms${thumb && display ? '' : '  ✗'}`);
}

console.log(`预热完成：成功 ${ok}，失败 ${failed}。`);
db.close();
