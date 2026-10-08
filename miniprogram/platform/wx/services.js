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
 * 打开地图：
 * - 配了腾讯位置服务 key：先用 WebServiceAPI 把地名解析成坐标，再 wx.openLocation
 *   直接打开地图；解析不到、网络错误或域名没加白名单（真机会被拦），都回退到复制。
 * - 没配 key：保持旧行为 —— 复制地名、引导去地图 App 里搜。
 * key 的申请与域名配置见根目录 config.js 的注释。
 */
export function openMap(keyword) {
  const text = String(keyword || '').trim();
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
      const loc = data && data.status === 0 && data.result && data.result.location;
      const lat = Number(loc && loc.lat);
      const lng = Number(loc && loc.lng);
      const ok =
        Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
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
