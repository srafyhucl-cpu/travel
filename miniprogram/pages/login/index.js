import { actions, getState } from '../../store/store.js';
import { platform } from '../../platform/index.js';

Page({
  data: {
    passphrase: '',
    name: '',
    busy: false,
    wxBusy: false,
    canWxLogin: typeof platform.session?.getWxLoginCode === 'function',
  },

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

  async onWxLogin() {
    if (this.data.wxBusy || this.data.busy) return;
    this.setData({ wxBusy: true });
    try {
      const code = await platform.session.getWxLoginCode();
      if (!code) {
        wx.showToast({ title: '获取微信登录凭证失败', icon: 'none' });
        return;
      }
      await actions.wxLogin(code);
      wx.reLaunch({ url: '/pages/timeline/index' });
    } catch (err) {
      wx.showToast({ title: err?.message || '微信登录失败，请尝试口令登录', icon: 'none' });
    } finally {
      this.setData({ wxBusy: false });
    }
  },

  async submit() {
    if (this.data.busy || this.data.wxBusy) return;
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
