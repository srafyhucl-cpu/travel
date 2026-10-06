/**
 * 平台照片文件（Web 实现）：鉴权取回 → 本地缓存 → 可显示 URL。
 *
 * 时间线要的是缩略图（thumb:true）：首次由原图在本地生成 320px JPEG 存进
 * IndexedDB，之后不再碰网络；查看器和长图用原图。小程序实现换成
 * wx.downloadFile / FileSystemManager，返回本地临时路径即可。
 */
import { storage } from './persist.js';
import { session } from './session.js';

const THUMB_MAX = 320;
const THUMB_QUALITY = 0.72;

const urlCache = new Map(); // `${id}:f|t` -> objectURL

function authHeaders() {
  const token = session.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 原图：先本地缓存，没有再下载；下载成功顺手存缓存 */
async function fullBlob(id) {
  const cached = await storage.loadBlob(id).catch(() => null);
  if (cached) return cached;
  const res = await fetch(`/api/photos/${id}/file`, { headers: authHeaders() });
  if (!res.ok) return null;
  const blob = await res.blob();
  storage.saveBlob(id, blob).catch(() => {});
  return blob;
}

/** 本地生成缩略图；失败返回 null（调用方用原图顶） */
async function makeThumb(blob) {
  const src = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = src;
    });
    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;
    const scale = Math.min(1, THUMB_MAX / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', THUMB_QUALITY));
  } finally {
    URL.revokeObjectURL(src);
  }
}

async function url(id, { thumb = false } = {}) {
  if (!id) return null;
  const key = thumb ? `${id}:t` : `${id}:f`;
  if (urlCache.has(key)) return urlCache.get(key);

  let blob = null;
  if (thumb) {
    blob = await storage.loadBlob(`thumb:${id}`).catch(() => null);
    if (!blob) {
      const full = await fullBlob(id);
      if (!full) return null;
      blob = (await makeThumb(full).catch(() => null)) || full;
      if (blob !== full) storage.saveBlob(`thumb:${id}`, blob).catch(() => {});
    }
  } else {
    blob = await fullBlob(id);
  }
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urlCache.set(key, u);
  return u;
}

/** 大图看完了：释放原图（内存 URL + 本地缓存），缩略图留着 */
function forget(id) {
  const key = `${id}:f`;
  const u = urlCache.get(key);
  if (u) {
    URL.revokeObjectURL(u);
    urlCache.delete(key);
  }
  storage.dropBlob(id).catch(() => {});
}

/** 照片删除了：连同缩略图一起清干净 */
function drop(id) {
  for (const k of [`${id}:f`, `${id}:t`]) {
    const u = urlCache.get(k);
    if (u) {
      URL.revokeObjectURL(u);
      urlCache.delete(k);
    }
  }
  storage.dropBlob(id).catch(() => {});
  storage.dropBlob(`thumb:${id}`).catch(() => {});
}

export const files = { url, forget, drop };
