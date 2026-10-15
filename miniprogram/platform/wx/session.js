/**
 * 登录态存储（微信实现）：同名 key，接口与 platform/web/session.js 一致。
 * 退出登录只清 token 和 tripId；名字留着，登录页预填。
 */
const TOKEN_KEY = 'travel.token';
const TRIP_KEY = 'travel.tripId';
const NAME_KEY = 'travel.memberName';
const USER_KEY = 'travel.user';

const read = (key) => wx.getStorageSync(key) || null;

export const session = {
  getToken() {
    return read(TOKEN_KEY);
  },
  setToken(t) {
    wx.setStorageSync(TOKEN_KEY, t);
  },
  getTripId() {
    return read(TRIP_KEY);
  },
  setTripId(id) {
    if (id) wx.setStorageSync(TRIP_KEY, id);
  },
  getMemberName() {
    return read(NAME_KEY);
  },
  setMemberName(name) {
    if (!name || name === read(NAME_KEY)) return;
    wx.setStorageSync(NAME_KEY, name);
  },
  getUser() {
    const raw = read(USER_KEY);
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  setUser(user) {
    if (user) wx.setStorageSync(USER_KEY, user);
    else wx.removeStorageSync(USER_KEY);
  },
  getWxLoginCode() {
    return new Promise((resolve, reject) => {
      if (typeof wx.login !== 'function') {
        return resolve('mock_code_' + Date.now());
      }
      wx.login({
        success: (res) => {
          if (res.code) resolve(res.code);
          else reject(new Error(res.errMsg || 'wx.login failed without code'));
        },
        fail: reject,
      });
    });
  },
  clear() {
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(TRIP_KEY);
    wx.removeStorageSync(USER_KEY);
  },
};
