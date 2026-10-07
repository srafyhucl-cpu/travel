/**
 * 平台服务（微信实现）：复制已实现；导航要坐标或地图插件，本轮占位。
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

export function openMap() {
  wx.showToast({ title: '小程序端导航待接地图插件', icon: 'none' });
}
