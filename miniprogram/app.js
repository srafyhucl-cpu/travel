import { boot, getState, subscribe } from './store/store.js';

let lastToastAt = 0;

App({
  globalData: {
    // 微信AI handoff 缓存：以接力页实例 pageId 为 key，存 { path, query, payload }。
    // App 先收（onAgentHandoff 在接力页 onLoad 前触发）、页面再按 pageId 取走。
    agentHandoffs: {},
  },

  onLaunch() {
    this.registerAgentHandoff();

    /*
     * 全局 toast：store 只负责把 toast 状态写进容器（跟 Web 一样是纯逻辑），
     * 小程序端在这里统一用 wx.showToast 呈现。
     */
    subscribe(() => {
      const t = getState().toast;
      if (t && t.at !== lastToastAt) {
        lastToastAt = t.at;
        wx.showToast({ title: t.message, icon: 'none', duration: 2200 });
      }
    });

    boot();
  },

  /** 微信AI 接力：用户点小程序卡片进入接力页时触发一次；须尽早注册（早于接力页 onLoad） */
  registerAgentHandoff() {
    if (!wx.onAgentHandoff) return; // 老基础库没有这个 API：正常跑，只是用不了 AI 接力
    wx.onAgentHandoff(({ pageId, path, query, payload }) => {
      this.globalData.agentHandoffs[pageId] = { path, query, payload };
    });
  },

  /** 接力页取走自己那份 handoff（取后删除，避免重复消费）；没有则返回 null */
  takeAgentHandoff(pageId) {
    const map = this.globalData.agentHandoffs;
    const handoff = map[pageId];
    if (handoff) delete map[pageId];
    return handoff || null;
  },
});
