/**
 * 照片派生图：缩略图（时间线）与展示图（查看器/长图）。
 *
 * 原图永远保留；HEIC 在这里转成 JPEG，安卓和桌面也能看。
 *
 * 几点约束都是量出来的，改之前先读：
 * - sharp 的预编译包解不了 HEVC 的 HEIC（iPhone 拍的正是这种），
 *   所以 HEIC 先用 heic-convert（WASM libheif + libde265）解成 JPEG buffer，
 *   再交给 sharp 缩放编码。
 * - 12MP 的 HEIC 解码峰值 RSS ~400MB，服务器只有 1.6G —— 所有生成串行执行。
 * - 落盘走 tmp + rename，半截文件永远不会被当成成品发出去。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { PHOTO_DIR } from './db.js';

export const DERIVED_DIR = path.join(PHOTO_DIR, 'derived');
fs.mkdirSync(DERIVED_DIR, { recursive: true });

const VARIANTS = {
  thumb: { long: 320, quality: 78 },
  display: { long: 2048, quality: 85 },
};

export function isVariant(name) {
  return Object.prototype.hasOwnProperty.call(VARIANTS, name);
}

function derivativePath(photoId, variant) {
  return path.join(DERIVED_DIR, `${photoId}-${variant}.jpg`);
}

function isHeic(mime, filename) {
  const m = String(mime || '').toLowerCase();
  return m.includes('heic') || m.includes('heif') || /\.(heic|heif)$/i.test(filename || '');
}

/* 串行队列：跑完一个再跑下一个，无论上一个成功还是失败 */
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

const inflight = new Map(); // `${id}:${variant}` -> Promise

/** 把输入（原图路径或解码后的 buffer）渲染成一个变体并落盘 */
async function renderTo(input, photo, variant) {
  const cfg = VARIANTS[variant];
  const out = derivativePath(photo.id, variant);
  const tmp = `${out}.tmp-${process.pid}`;
  await sharp(input)
    .rotate() // EXIF 方向；heic-convert 的产物一般已转正，这里是兜底
    .resize({ width: cfg.long, height: cfg.long, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }) // PNG 透明平铺白底，别糊成黑
    .jpeg({ quality: cfg.quality, mozjpeg: true })
    .toFile(tmp);
  await fsp.rename(tmp, out);
  return out;
}

/** HEIC 用 heic-convert 解一次；其它格式直接把路径交给 sharp */
async function prepareInput(photo) {
  const src = path.join(PHOTO_DIR, photo.filename);
  if (!fs.existsSync(src)) return null;
  if (isHeic(photo.mime, photo.filename)) {
    return heicConvert({ buffer: await fsp.readFile(src), format: 'JPEG', quality: 0.92 });
  }
  return src;
}

async function generate(photo, variant) {
  const input = await prepareInput(photo);
  if (!input) return null;
  return renderTo(input, photo, variant);
}

/** 确保某变体存在；返回可发送的路径（失败返回 null，调用方兜底发原图） */
export function ensureDerivative(photo, variant) {
  if (!isVariant(variant)) return Promise.resolve(null);
  const key = `${photo.id}:${variant}`;
  const running = inflight.get(key);
  if (running) return running;

  const task = enqueue(async () => {
    const out = derivativePath(photo.id, variant);
    if (fs.existsSync(out)) return out;
    try {
      return await generate(photo, variant);
    } catch (e) {
      console.error(`[derivative] ${photo.id} ${variant} 生成失败:`, e.message);
      return null;
    }
  }).finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/**
 * 上传后台预热：一次解码出两个变体（12MP HEIC 解码 ~2s，解两遍纯浪费），
 * 等线上下次打开时直接命中。
 */
export function warmPhoto(photo) {
  return enqueue(async () => {
    const missing = Object.keys(VARIANTS).filter((v) => !fs.existsSync(derivativePath(photo.id, v)));
    if (!missing.length) return true;
    try {
      const input = await prepareInput(photo);
      if (!input) return false;
      for (const variant of missing) await renderTo(input, photo, variant);
      return true;
    } catch (e) {
      console.error(`[derivative] ${photo.id} 预热失败:`, e.message);
      return false;
    }
  });
}

/** 照片删除时清掉派生文件（原图由调用方删） */
export function removeDerivatives(photoId) {
  for (const variant of Object.keys(VARIANTS)) {
    fsp.unlink(derivativePath(photoId, variant)).catch(() => {});
  }
}
