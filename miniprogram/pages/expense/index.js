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
    amount: '',
    note: '',
    category: 'food',
    payer: '',
    categories: [],
    payers: [],
    nodeTitle: '',
    canSave: false,
  },

  // query.nodeId 可空：从某个行程卡进来时会带上，提交时原样放进 payload
  onLoad(query) {
    this.nodeId = (query && query.nodeId) || '';
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    this.unsub?.();
  },

  onAmount(e) {
    const amount = e.detail.value;
    this.setData({ amount, canSave: Number(amount) > 0 && !this.saving });
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

  async onSave() {
    if (this.saving) return;
    const amount = Number(this.data.amount);
    if (!(amount > 0)) return;

    this.saving = true;
    this.setData({ canSave: false });
    try {
      await actions.addExpense({
        amount,
        category: this.data.category,
        payer: this.data.payer,
        note: this.data.note.trim() || null,
        occurredAt: new Date().toISOString(),
        ...(this.nodeId ? { nodeId: this.nodeId } : {}),
      });
      // 成功（离线时会进待同步队列，同样算成功）：退回时间线
      if (getCurrentPages().length > 1) wx.navigateBack();
      else wx.reLaunch({ url: '/pages/timeline/index' });
    } catch {
      // 失败原因 store 已经全局 toast；这里只把按钮恢复可用，让用户改完再试
      this.saving = false;
      this.setData({ canSave: Number(this.data.amount) > 0 });
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

    const data = s.data;
    const members = data.members || [];
    const category = pickCategory(data.vocab, this.data.category);
    // 默认当前成员；认不出来再退第一个成员，实在没有成员就交给服务端兜底
    const meName =
      (data.meId ? members.find((m) => m.id === data.meId)?.name : null) ||
      (members.some((m) => m.name === data.me) ? data.me : '');
    const payer = members.some((m) => m.name === this.data.payer)
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
