/**
 * 照片文件（微信实现）：wx.downloadFile 取服务端的派生图，交本地路径给 <image>。
 *
 * 服务端备了三档：
 *   variant=thumb    时间线缩略图（长边 320，约 20KB）——落盘持久化。列表每次
 *                    进出/同步都会重渲染，持久化后下次启动不用重下，断网也还能看；
 *   variant=display  查看器大图（长边 2048，服务端已把 HEIC 转成 JPEG）——只留
 *                    临时文件。看完就 forget 释放，不占用户目录空间；
 *   （无 variant）    原图，只在「保存到相册」时现取，不缓存（几 MB 一张，没必要留）。
 *
 * 约定：网络失败 / 404 / 落盘失败一律返回 null，不抛 —— 调用方只关心「有图/没图」。
 */
import { session } from './session.js';
import { baseUrl } from './net.js';

// 内存缓存：`<id>:thumb` / `<id>:display` -> 本地路径。避免每轮补图都去文件系统探测
const cache = new Map();
// 同一张图并发只下一次：sync 每 20 秒一轮，回填时很容易对同一 id 重复排队
const pending = new Map();

const fsm = () => wx.getFileSystemManager();

/* 缩略图落盘位置：固定文件名，drop(id) 时按同一规则删得掉 */
const thumbFile = (id) => `${wx.env.USER_DATA_PATH}/img-thumb-${id}.jpg`;

function fileExists(path) {
  try {
    fsm().accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function variantUrl(id, variant) {
  const q = variant ? `?variant=${variant}` : '';
  return `${baseUrl()}/api/photos/${encodeURIComponent(id)}/file${q}`;
}

/* wx.downloadFile 无论 200 还是 404 都会走 success，必须自己判状态码。
   再给一个超时：个别请求会既不 success 也不 fail（弱网/被系统掐掉），
   不兜住的话 pending 里这条永远不释放，后面同 id 的调用会一直等它。 */
function download(url, timeoutMs = 30000) {
  const token = session.getToken();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    wx.downloadFile({
      url,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success: (res) => {
        clearTimeout(timer);
        finish(res.statusCode === 200 && res.tempFilePath ? res.tempFilePath : null);
      },
      fail: () => {
        clearTimeout(timer);
        finish(null);
      },
    });
  });
}

/**
 * 本地路径；拿不到返回 null。
 * thumb=true 会尽量持久化（下次启动直接命中文件，不重下）。
 */
async function url(id, { thumb = false } = {}) {
  if (!id) return null;
  const key = `${id}:${thumb ? 'thumb' : 'display'}`;
  if (cache.has(key)) return cache.get(key);

  if (thumb) {
    const saved = thumbFile(id);
    if (fileExists(saved)) {
      cache.set(key, saved);
      return saved;
    }
  }

  if (pending.has(key)) return pending.get(key);

  const task = (async () => {
    const temp = await download(variantUrl(id, thumb ? 'thumb' : 'display'));
    if (!temp || !thumb) return temp; // display 用完即弃，不落盘
    try {
      const saved = thumbFile(id);
      // 注意：saveFileSync 成功后临时文件会被移走，之后只能用 saved
      fsm().saveFileSync(temp, saved);
      return saved;
    } catch {
      return temp; // 落盘失败（空间/权限）：本次先显示，下次同步再试
    }
  })();

  pending.set(key, task);
  try {
    const path = await task;
    if (path) cache.set(key, path); // 失败不缓存，给下一轮同步留重试的机会
    return path;
  } catch {
    return null;
  } finally {
    pending.delete(key);
  }
}

/** 原图：给「保存到相册」用。不缓存不落盘，避免几 MB 的图长期占空间 */
async function original(id) {
  if (!id) return null;
  return download(variantUrl(id));
}

/** 大图看完了：只释放 display。缩略图缓存留着，回到列表不用重下 */
function forget(id) {
  if (!id) return;
  cache.delete(`${id}:display`);
}

/** 照片删掉了：内存缓存清干净，持久化的缩略图文件也删掉（没下过就删失败，忽略） */
function drop(id) {
  if (!id) return;
  cache.delete(`${id}:thumb`);
  cache.delete(`${id}:display`);
  try {
    fsm().unlinkSync(thumbFile(id));
  } catch {
    /* 文件不存在最正常不过，忽略 */
  }
}

/* 平台接口：与 web 的 platform/web/files.js 同名同形（platform/index.js 按对象取用） */
export const files = { url, original, forget, drop };
