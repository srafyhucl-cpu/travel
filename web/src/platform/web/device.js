/**
 * 平台设备能力（Web 实现）：网络状态、切回前台、振动。
 * 小程序对应 wx.onNetworkStatusChange / onShow / vibrateShort。
 */
export const device = {
  isOnline() {
    return typeof navigator === 'undefined' ? true : navigator.onLine;
  },

  /** cb({ online })；返回取消订阅的函数 */
  onNetwork(cb) {
    const on = () => cb({ online: true });
    const off = () => cb({ online: false });
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  },

  /** 从后台切回前台 */
  onResume(cb) {
    const fn = () => {
      if (document.visibilityState === 'visible') cb();
    };
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  },

  vibrate(ms = 8) {
    navigator.vibrate?.(ms);
  },
};
