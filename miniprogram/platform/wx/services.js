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

/**
 * 打开地图：小程序没有「按关键词搜索地图」的接口，拿坐标又要额外接地图插件 ——
 * 复制地名、引导去地图 App 里搜，比一个点不动的占位按钮有用。
 */
export function openMap(keyword) {
  const text = String(keyword || '').trim();
  if (!text) return;
  wx.setClipboardData({
    data: text,
    success: () => wx.showToast({ title: '地名已复制，去地图 App 里搜', icon: 'none', duration: 2500 }),
  });
}
