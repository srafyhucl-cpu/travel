/**
 * 平台照片文件（Web 实现）：鉴权取回 → 本地缓存 → 可显示 URL。
 *
 * 图源是服务端的两个派生变体（缓存键 thumb:<id> / display:<id>）：
 *   thumb    时间线用，长边 320（约 20KB）
 *   display  查看器/长图用，长边 2048（HEIC 已在服务端转成 JPEG）
 * 原图不进这里 ——「存原图」走 net.url 的下载链接。小程序版换成 wx.downloadFile，
 * 请求同样的变体即可。
 */
import { storage } from './persist.js';
import { session } from './session.js';

const urlCache = new Map(); // `${id}:f|t` -> objectURL

function authHeaders() {
  const token = session.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function variantBlob(id, variant) {
  const key = variant === 'thumb' ? `thumb:${id}` : `display:${id}`;
  const cached = await storage.loadBlob(key).catch(() => null);
  if (cached) return cached;
  const res = await fetch(`/api/photos/${id}/file?variant=${variant}`, { headers: authHeaders() });
  if (!res.ok) return null;
  const blob = await res.blob();
  storage.saveBlob(key, blob).catch(() => {});
  return blob;
}

async function url(id, { thumb = false } = {}) {
  if (!id) return null;
  const key = `${id}:${thumb ? 't' : 'f'}`;
  if (urlCache.has(key)) return urlCache.get(key);

  let blob = await variantBlob(id, thumb ? 'thumb' : 'display');
  if (!blob && !thumb) {
    // 旧版本把原图缓存在 id 键下：断网时，看过的照片还能显示
    blob = await storage.loadBlob(id).catch(() => null);
  }
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urlCache.set(key, u);
  return u;
}

/**
 * 大图看完了：只释放内存里的 URL。展示图很小（~400KB），
 * 缓存留在 IndexedDB 里，断网还能看。
 */
function forget(id) {
  const key = `${id}:f`;
  const u = urlCache.get(key);
  if (u) {
    URL.revokeObjectURL(u);
    urlCache.delete(key);
  }
}

/** 照片删除了：变体与旧缓存一并清干净 */
function drop(id) {
  for (const k of [`${id}:f`, `${id}:t`]) {
    const u = urlCache.get(k);
    if (u) {
      URL.revokeObjectURL(u);
      urlCache.delete(k);
    }
  }
  storage.dropBlob(`thumb:${id}`).catch(() => {});
  storage.dropBlob(`display:${id}`).catch(() => {});
  storage.dropBlob(id).catch(() => {}); // 旧版本的原图缓存
}

export const files = { url, forget, drop };
