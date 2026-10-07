import { boot, getState, subscribe } from './store/store.js';

let lastToastAt = 0;

App({
  onLaunch() {
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
});
