/**
 * 平台持久化（微信实现）：快照 / 元数据 / 离线写队列都放 wx storage。
 *
 * 注意单 key 1MB、总量 10MB：大行程的快照可能存不下，那就放弃缓存
 * （功能不受影响，只是下次打开不能秒开）。照片二进制本轮不做，
 * 开做照片时用 FileSystemManager 存临时/永久路径。
 */
const SNAP_PREFIX = 'snap.';
const META_PREFIX = 'meta.';
const QUEUE_KEY = 'queue.items';

export const storage = {
  async loadSnapshot(tripId) {
    try {
      const row = wx.getStorageSync(SNAP_PREFIX + tripId);
      return row?.data ?? null;
    } catch {
      return null;
    }
  },
  async saveSnapshot(tripId, data) {
    try {
      wx.setStorageSync(SNAP_PREFIX + tripId, { data, savedAt: Date.now() });
    } catch {
      /* 超 1MB 存不下就算了，别影响主流程 */
    }
  },
  async dropSnapshot(tripId) {
    try {
      wx.removeStorageSync(SNAP_PREFIX + tripId);
    } catch {
      /* 忽略 */
    }
  },

  async loadMeta(key) {
    try {
      return wx.getStorageSync(META_PREFIX + key) ?? null;
    } catch {
      return null;
    }
  },
  async saveMeta(key, value) {
    try {
      wx.setStorageSync(META_PREFIX + key, value);
    } catch {
      /* 忽略 */
    }
  },
  async dropMeta(key) {
    try {
      wx.removeStorageSync(META_PREFIX + key);
    } catch {
      /* 忽略 */
    }
  },

  /* 照片二进制：本轮不带照片，接口先占位（files.js 同样返回 null） */
  async loadBlob() {
    return null;
  },
  async saveBlob() {},
  async dropBlob() {},
};

export const queue = {
  _all() {
    try {
      return wx.getStorageSync(QUEUE_KEY) || [];
    } catch {
      return [];
    }
  },
  _save(list) {
    try {
      wx.setStorageSync(QUEUE_KEY, list);
    } catch {
      /* 忽略 */
    }
  },
  async list() {
    return this._all();
  },
  async push(item) {
    const list = this._all();
    const seq = (list[list.length - 1]?.seq || 0) + 1;
    list.push({ ...item, seq, queuedAt: Date.now() });
    this._save(list);
    return seq;
  },
  async remove(seq) {
    this._save(this._all().filter((i) => i.seq !== seq));
  },
  async size() {
    return this._all().length;
  },
  async clear() {
    wx.removeStorageSync(QUEUE_KEY);
  },
};
