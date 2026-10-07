import { actions, getState } from '../../store/store.js';
import { platform } from '../../platform/index.js';

Page({
  data: { passphrase: '', name: '', busy: false },

  onLoad() {
    const s = getState();
    // 已经有会话（含正在恢复的）就直接走行程页；没有则 boot() 已经把 phase 置为 login
    if (s.phase !== 'login') {
      wx.reLaunch({ url: '/pages/timeline/index' });
      return;
    }
    this.setData({ name: platform.session.getMemberName() || '' });
  },

  onPass(e) {
    this.setData({ passphrase: e.detail.value });
  },

  onName(e) {
    this.setData({ name: e.detail.value });
  },

  async submit() {
    if (this.data.busy) return;
    const passphrase = this.data.passphrase.trim();
    const name = this.data.name.trim() || '我';
    if (passphrase.length < 4) {
      wx.showToast({ title: '口令至少 4 位', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    try {
      await actions.login(passphrase, name);
      wx.reLaunch({ url: '/pages/timeline/index' });
    } catch {
      /* store 已经把错误 toast 到全局了 */
    } finally {
      this.setData({ busy: false });
    }
  },
});
