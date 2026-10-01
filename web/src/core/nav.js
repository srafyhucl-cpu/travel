/**
 * 一键唤起高德/百度导航。
 * 不内嵌地图——真要导航，高德 App 比网页版好用得多，而且能离线。
 */

const AMAP_SRC = 'travel-hclstudio';

function encodeCity(city) {
  return encodeURIComponent(city || '');
}

/** 打开高德地图 App 搜地点。没有 App 时会跳到网页版 */
export function openAmap(keyword, city) {
  const k = encodeURIComponent(keyword || '');
  const url = `https://uri.amap.com/search?keyword=${k}&city=${encodeCity(city)}&src=${AMAP_SRC}&view=map&callnative=1`;
  window.open(url, '_blank', 'noopener');
  return url;
}

/** 高德路线规划：从当前位置到这个地点 */
export function openAmapRoute(keyword, city, mode = 'car') {
  const k = encodeURIComponent(keyword || '');
  const url = `https://uri.amap.com/navigation?to=${k},${encodeCity(city)}&mode=${mode}&src=${AMAP_SRC}&callnative=1`;
  window.open(url, '_blank', 'noopener');
  return url;
}

/** 复制一段文字到剪贴板（用于分享行程给同伴） */
export async function copyText(text) {
  try {
    if (navigator.share) {
      await navigator.share({ text });
      return 'shared';
    }
  } catch {
    /* 用户取消分享，继续走复制 */
  }
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

/** 把一段文本变成可分享的行程摘要 */
export function buildShareText(trip, dayNodes, fmtTime, fmtMoney) {
  const lines = [`【${trip.name}】${dayNodes[0]?.date || ''}`];
  for (const n of dayNodes) {
    lines.push(`${n.start_time ? n.start_time + ' ' : ''}${n.title}${n.location ? ' @ ' + n.location : ''}`);
  }
  return lines.join('\n');
}
