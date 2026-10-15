import { actions, getState, subscribe } from '../../store/store.js';
import { computeBudget } from '../../core/budget.js';
import { formatMoney } from '../../core/format.js';

Page({
  data: {
    ready: false,
    amount: '',
    actual: '0',
    remaining: '0',
    over: false,
    hasPlanned: false,
    canSave: true,
    isReadOnly: false,
  },

  onLoad() {
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    this.unsub?.();
  },

  onAmount(e) {
    const amount = e.detail.value;
    const n = Number(amount);
    this.setData({ amount, canSave: amount.trim() === '' || (!Number.isNaN(n) && n >= 0) });
  },

  async onSave() {
    if (this.data.isReadOnly) {
      wx.showToast({ title: '只读模式无法修改预算', icon: 'none' });
      return;
    }
    if (this.busy || !this.data.canSave) return;
    const value = Number(this.data.amount || 0);
    if (!Number.isFinite(value) || value < 0) {
      wx.showToast({ title: '填一个有效的金额', icon: 'none' });
      return;
    }
    this.busy = true;
    try {
      await actions.setTotalBudget(value, getState().data?.budgets || []);
      if (getCurrentPages().length > 1) wx.navigateBack();
      else wx.reLaunch({ url: '/pages/timeline/index' });
    } catch {
      /* store 已经弹过提示 */
    } finally {
      this.busy = false;
    }
  },

  sync() {
    const s = getState();
    if (s.phase === 'login') {
      wx.redirectTo({ url: '/pages/login/index' });
      return;
    }
    if (!s.data) {
      if (this.data.ready) this.setData({ ready: false });
      return;
    }
    const b = computeBudget({ budgets: s.data.budgets, expenses: s.data.expenses });
    const myRole = s.data.me?.role || s.data.trip?.role || (s.trips?.find((t) => t.id === s.activeTripId)?.role) || 'editor';
    const isReadOnly = myRole === 'viewer';
    const patch = {
      ready: true,
      isReadOnly,
      actual: formatMoney(b.actualTotal),
      remaining: formatMoney(Math.abs(b.remaining)),
      over: b.over,
      hasPlanned: b.plannedTotal > 0,
    };
    // 只预填一次：别让 20 秒一轮的同步把正在输入的数字冲掉
    if (!this.prefilled) {
      this.prefilled = true;
      patch.amount = b.plannedTotal > 0 ? String(b.plannedTotal) : '';
    }
    this.setData(patch);
  },
});
