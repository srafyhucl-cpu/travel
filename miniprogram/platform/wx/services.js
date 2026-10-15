import { TENCENT_MAP_KEY } from '../../config.js';

/**
 * 平台服务（微信实现）：复制、分享、导航。
 */
export function copyText(text) {
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: text,
      success: () => resolve('copied'),
      fail: () => resolve('failed'),
    });
  });
}

export async function shareText(text) {
  return copyText(text);
}

/** 复制地名并弹提示（无 key / 解析失败 / 打开地图失败时的兜底路径） */
function copyAndHint(text, title) {
  wx.setClipboardData({
    data: text,
    success: () => wx.showToast({ title, icon: 'none', duration: 2500 }),
  });
}

/**
 * 打开地图（按优先级三条路）：
 * 1. 有坐标（编辑页「在地图上选点」存的 lat/lng）：直接 wx.openLocation —— 不解析、不吃配额、最准；
 * 2. 没坐标但配了腾讯位置服务 key：用 WebServiceAPI 把地名解析成坐标再打开；
 * 3. 解析不到 / 没 key / 网络或白名单被拦：复制地名，引导去地图 App 里搜。
 * key 的申请与域名配置见根目录 config.js 的注释。
 */
export function openMap(keyword, coords) {
  const text = String(keyword || '').trim();
  const lat = Number(coords?.lat);
  const lng = Number(coords?.lng);
  // 经纬度任一为 0 一律当无效：(0,0) 是解析失败/地图未就绪最常见的退化值，不是任何真实地点。
  // 这是有意取舍 —— 赤道 lat 0 / 格林尼治 lng 0 这类合法点会被一起拒掉，本行程用不到；别当成 bug 改回去。
  const hasCoord =
    coords?.lat !== null &&
    coords?.lat !== undefined &&
    coords?.lat !== '' &&
    coords?.lng !== null &&
    coords?.lng !== undefined &&
    coords?.lng !== '' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat !== 0 &&
    lng !== 0 &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180;
  if (hasCoord) {
    wx.openLocation({
      latitude: lat,
      longitude: lng,
      name: text || '选好的地点',
      scale: 16,
      fail: () => copyAndHint(text || '选好的地点', '打不开地图，地名已复制'),
    });
    return;
  }
  if (!text) return;
  const key = String(TENCENT_MAP_KEY || '').trim();
  if (!key) {
    copyAndHint(text, '地名已复制，去地图 App 里搜');
    return;
  }
  const url = `https://apis.map.qq.com/ws/geocoder/v1/?address=${encodeURIComponent(text)}&key=${encodeURIComponent(key)}`;
  wx.request({
    url,
    success: (res) => {
      const data = res && res.data;
      // 先拆开判：status 非 0（例如 121 配额用尽、112 IP 未授权）或 result/location 缺失时，
      // loc 不能再短路成布尔的 false —— 否则 Number(false) === 0 会被当成合法坐标，直接打开 (0,0) 的海面。
      const loc = data && data.status === 0 && data.result ? data.result.location : null;
      const lat = typeof loc?.lat === 'number' ? loc.lat : Number(loc?.lat);
      const lng = typeof loc?.lng === 'number' ? loc.lng : Number(loc?.lng);
      const ok =
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat !== 0 &&
        lng !== 0 &&
        Math.abs(lat) <= 90 &&
        Math.abs(lng) <= 180;
      if (!ok) {
        copyAndHint(text, '没找到这个地点，地名已复制');
        return;
      }
      wx.openLocation({
        latitude: lat,
        longitude: lng,
        name: text,
        scale: 16,
        fail: () => copyAndHint(text, '打不开地图，地名已复制'),
      });
    },
    // 真机上 https://apis.map.qq.com 没进 request 合法域名会走到这里，网络错误也一样
    fail: () => copyAndHint(text, '地名已复制，去地图 App 里搜'),
  });
}
