/**
 * 平台设备能力（微信实现）：网络状态、切回前台、振动。
 * 小程序没有取消订阅的稳定接口（老基础库），这里返回空函数占位。
 */
export const device = {
  isOnline() {
    // 初始乐观；真实状态由 onNetwork 推过来
    return true;
  },

  onNetwork(cb) {
    const handler = (res) => cb({ online: !!res.isConnected });
    wx.onNetworkStatusChange(handler);
    return () => wx.offNetworkStatusChange?.(handler);
  },

  onResume(cb) {
    const handler = () => cb();
    wx.onAppShow(handler);
    return () => wx.offAppShow?.(handler);
  },

  vibrate(ms = 8) {
    wx.vibrateShort({ type: ms > 10 ? 'medium' : 'light' });
  },
};
