/**
 * 登录态存储（Web 实现）：token / tripId / 上次用的名字。
 *
 * 小程序版换成 wx.setStorageSync 即可，接口保持一致。
 * 退出登录只清 token 和 tripId；名字留着，登录页预填，免得又建出一个「我」。
 */
const TOKEN_KEY = 'travel.token';
const TRIP_KEY = 'travel.tripId';
const NAME_KEY = 'travel.memberName';
const USER_KEY = 'travel.user';

export const session = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY) || null;
  },
  setToken(t) {
    localStorage.setItem(TOKEN_KEY, t);
  },
  getTripId() {
    return localStorage.getItem(TRIP_KEY) || null;
  },
  setTripId(id) {
    if (id) localStorage.setItem(TRIP_KEY, id);
  },
  /** 上次登录用的名字：登录页预填；快照认回「我」之后也会对齐 */
  getMemberName() {
    return localStorage.getItem(NAME_KEY) || null;
  },
  setMemberName(name) {
    if (!name || name === this.getMemberName()) return;
    localStorage.setItem(NAME_KEY, name);
  },
  getUser() {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  setUser(user) {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  },
  async getWxLoginCode() {
    return null;
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TRIP_KEY);
    localStorage.removeItem(USER_KEY);
  },
};
