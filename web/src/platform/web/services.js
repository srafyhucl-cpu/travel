/**
 * 平台服务（Web 实现）：导航、分享、复制。
 * 小程序对应 wx.openLocation（或地图插件）、onShareAppMessage、setClipboardData。
 */

/** 打开高德地图 App 搜地点。没有 App 时会跳到网页版 */
export function openMap(keyword) {
  const k = encodeURIComponent(keyword || '');
  const url = `https://uri.amap.com/search?keyword=${k}&city=&src=travel-hclstudio&view=map&callnative=1`;
  window.open(url, '_blank', 'noopener');
}

/** 复制文本；带降级方案，返回 'copied' | 'failed' */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    // 退化方案：临时 textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok ? 'copied' : 'failed';
  }
}

/** 优先系统分享，失败或取消再退回复制，返回 'shared' | 'copied' | 'failed' */
export async function shareText(text) {
  try {
    if (navigator.share) {
      await navigator.share({ text });
      return 'shared';
    }
  } catch {
    /* 用户取消分享，继续走复制 */
  }
  return copyText(text);
}
