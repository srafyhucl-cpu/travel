import { actions, getState, subscribe } from '../../store/store.js';
import { iconDataUri } from '../../platform/wx/icons.js';

/* 未选中的类别图标统一走灰，选中的才染上类别色 —— 跟 Web 的胶囊一致 */
const GRAY = '#9ca3af';

/** 类别默认 food；vocab 里没有 food 就退到第一项，兜底还是 food（服务端也认它） */
function pickCategory(vocab, current) {
  const list = vocab?.categories || [];
  if (list.some((c) => c.key === current)) return current;
  return list.some((c) => c.key === 'food') ? 'food' : list[0]?.key || 'food';
}

function toCategoryPills(vocab, current) {
  return (vocab?.categories || []).map((c) => {
    const color = c.color || '#6B7280';
    const on = c.key === current;
    return {
      key: c.key,
      label: c.label,
      color,
      icon: iconDataUri(c.icon || 'ring', on ? color : GRAY, 28),
      on,
    };
  });
}

/** 「我」怎么认：meId 优先，老会话没有 meId 才退回按名字对；名字本来就叫「我」就不重复加标签 */
function toPayerPills(data, current) {
  return (data.members || []).map((m) => ({
    id: m.id,
    name: m.name,
    me: (data.meId ? m.id === data.meId : m.name === data.me) && m.name !== '我',
    on: m.name === current,
  }));
}

Page({
  data: {
    ready: false,
    editing: false, // 改这笔（query.id 有值时）
    amount: '',
    note: '',
    category: 'food',
    payer: '',
    categories: [],
    payers: [],
    nodeTitle: '',
    canSave: false,
  },

  // query.nodeId 可空：从某个行程卡进来时会带上，提交时原样放进 payload。
  // query.id 有值 = 改这笔：从快照预填，保存走 patchExpense，页面底部另有「删掉」。
  onLoad(query) {
    this.nodeId = (query && query.nodeId) || '';
    this.expenseId = (query && query.id) || '';
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    this.unsub?.();
  },

  onAmount(e) {
    const amount = e.detail.value;
    this.setData({ amount, canSave: Number(amount) > 0 && !this.busy });
  },

  onNote(e) {
    this.setData({ note: e.detail.value });
  },

  onCategory(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.category) return;
    this.setData({
      category: key,
      categories: toCategoryPills(getState().data?.vocab, key),
    });
  },

  onPayer(e) {
    const name = e.currentTarget.dataset.name;
    if (!name || name === this.data.payer) return;
    this.setData({
      payer: name,
      payers: this.data.payers.map((p) => ({ ...p, on: p.name === name })),
    });
  },

  /** 新增 / 保存共用一个按钮：编辑模式只发改动的四个字段，时间与挂靠保持原值 */
  async onSave() {
    if (this.busy) return;
    const amount = Number(this.data.amount);
    if (!(amount > 0)) return;

    this.busy = true;
    this.setData({ canSave: false });
    try {
      if (this.expenseId) {
        await actions.patchExpense(this.expenseId, {
          amount,
          category: this.data.category,
          payer: this.data.payer,
          note: this.data.note.trim() || null,
        });
      } else {
        await actions.addExpense({
          amount,
          category: this.data.category,
          payer: this.data.payer,
          note: this.data.note.trim() || null,
          occurredAt: new Date().toISOString(),
          ...(this.nodeId ? { nodeId: this.nodeId } : {}),
        });
      }
      // 成功（离线时会进待同步队列，同样算成功）：退回时间线
      if (getCurrentPages().length > 1) wx.navigateBack();
      else wx.reLaunch({ url: '/pages/timeline/index' });
    } catch {
      // 失败原因 store 已经全局 toast；这里只把按钮恢复可用，让用户改完再试
      this.busy = false;
      this.setData({ canSave: Number(this.data.amount) > 0 });
    }
  },

  /** 删掉这笔：二次确认后走 store；离线入队时不弹「已删除」（照片删除同款处理） */
  onDelete() {
    if (this.busy) return;
    wx.showModal({
      title: '删掉这笔？',
      content: '删了就找不回来了',
      confirmText: '删除',
      success: async (r) => {
        if (!r.confirm) return;
        this.busy = true;
        try {
          await actions.deleteExpense(this.expenseId);
          const stillThere = (getState().data?.expenses || []).some((e) => e.id === this.expenseId);
          if (!stillThere) wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => {
            if (getCurrentPages().length > 1) wx.navigateBack();
            else wx.reLaunch({ url: '/pages/timeline/index' });
          }, stillThere ? 0 : 600);
        } catch {
          /* store 已经弹过错误提示 */
          this.busy = false;
        }
      },
    });
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

    const data = s.data;
    const members = data.members || [];

    /*
     * 编辑模式只预填一次：sync 每 20 秒跟着 store 刷新跑一轮，
     * 每轮都重填会把用户正在输入的内容冲掉。
     */
    if (this.expenseId && !this.prefilled) {
      const exp = (data.expenses || []).find((e) => e.id === this.expenseId);
      if (exp) {
        this.prefilled = true;
        const category = pickCategory(data.vocab, exp.category);
        const payer = exp.payer || '';
        this.setData({
          ready: true,
          editing: true,
          amount: String(exp.amount ?? ''),
          note: exp.note || '',
          category,
          payer,
          categories: toCategoryPills(data.vocab, category),
          payers: toPayerPills(data, payer),
          nodeTitle: (data.nodes || []).find((n) => n.id === exp.node_id)?.title || '',
          canSave: Number(exp.amount) > 0,
        });
        return;
      }
      // 页面刚打开时 data 可能已经旧了：找不到就提示一声退回，别让用户对着空表单保存
      if (!this.missing) {
        this.missing = true;
        wx.showToast({ title: '这笔账已经不在了', icon: 'none' });
        setTimeout(() => {
          if (getCurrentPages().length > 1) wx.navigateBack();
          else wx.reLaunch({ url: '/pages/timeline/index' });
        }, 900);
      }
      return;
    }

    const category = pickCategory(data.vocab, this.data.category);
    // 默认当前成员；认不出来再退第一个成员，实在没有成员就交给服务端兜底。
    // 编辑模式不覆盖已有付款人（可能是历史名字，胶囊里没有对应项）
    const meName =
      (data.meId ? members.find((m) => m.id === data.meId)?.name : null) ||
      (members.some((m) => m.name === data.me) ? data.me : '');
    const payer = this.expenseId
      ? this.data.payer
      : members.some((m) => m.name === this.data.payer)
        ? this.data.payer
        : meName || members[0]?.name || '我';
    const node = this.nodeId ? (data.nodes || []).find((n) => n.id === this.nodeId) : null;

    this.setData({
      ready: true,
      category,
      payer,
      categories: toCategoryPills(data.vocab, category),
      payers: toPayerPills(data, payer),
      nodeTitle: node?.title || '',
    });
  },
});
