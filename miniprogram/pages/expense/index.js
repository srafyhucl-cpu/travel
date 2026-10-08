import { actions, getState, subscribe } from '../../store/store.js';
import { iconDataUri } from '../../platform/wx/icons.js';

/* 未选中的类别图标统一走灰，选中的才染上类别色 —— 跟 Web 的胶囊一致 */
const GRAY = '#9ca3af';

const PAD = (n) => String(n).padStart(2, '0');

/*
 * 时间收发的都是本地墙钟，库里存 UTC（跟 Web 的 ExpenseEditor 同一套转换）。
 * 打开时把 UTC 转成本地年月日/时分来预填，保存时再把本地墙钟转回 UTC。
 * 少走任何一边，同一笔每打开保存一轮就会偏 8 小时。
 */
function toLocalParts(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return toLocalParts(null);
  return {
    date: `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`,
    time: `${PAD(d.getHours())}:${PAD(d.getMinutes())}`,
  };
}

/** 本地墙钟 -> UTC ISO；坏值退回「现在」，别把 Invalid Date 传上去 */
function toIso(date, time) {
  const d = new Date(`${date}T${time || '00:00'}:00`);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

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
    date: '', // 本地墙钟 YYYY-MM-DD（库里是 UTC，见 toLocalParts / toIso）
    time: '', // 本地墙钟 HH:MM
    categories: [],
    payers: [],
    nodeTitle: '',
    canSave: false,
  },

  // query.nodeId 可空：从某个行程卡进来时会带上，新增时预填挂靠、保存放进 payload。
  // query.id 有值 = 改这笔：从快照预填（含时间与挂靠），保存走 patchExpense。
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

  onDate(e) {
    this.setData({ date: e.detail.value });
  },

  onTime(e) {
    this.setData({ time: e.detail.value });
  },

  /** 进「挂在哪一项」选节点，结果从事件通道回来（null = 不指定） */
  onPickNode() {
    wx.navigateTo({
      url: `/pages/nodepick/index${this.nodeId ? `?current=${encodeURIComponent(this.nodeId)}` : ''}`,
      events: {
        picked: (node) => {
          this.nodeId = node?.id || '';
          this.setData({ nodeTitle: node?.title || '' });
        },
      },
    });
  },

  /**
   * 新增 / 保存共用一个按钮，两个模式都发全量字段：
   * 服务端 patch 是「整行覆盖」式清洗（cleanExpense 只认 camelCase），
   * 少发 occurredAt 会被重置成「现在」、少发 nodeId 会被清成 null。
   */
  async onSave() {
    if (this.busy) return;
    const amount = Number(this.data.amount);
    if (!(amount > 0)) return;

    this.busy = true;
    this.setData({ canSave: false });
    const payload = {
      amount,
      category: this.data.category,
      payer: this.data.payer,
      note: this.data.note.trim() || null,
      occurredAt: toIso(this.data.date, this.data.time), // 本地墙钟 -> UTC
      nodeId: this.nodeId || null, // 不指定 = null
    };
    try {
      if (this.expenseId) await actions.patchExpense(this.expenseId, payload);
      else await actions.addExpense(payload);
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
     * 每轮都重填会把用户正在输入的金额、时间、挂靠冲掉。
     */
    if (this.expenseId && !this.prefilled) {
      const exp = (data.expenses || []).find((e) => e.id === this.expenseId);
      if (exp) {
        this.prefilled = true;
        const category = pickCategory(data.vocab, exp.category);
        const payer = exp.payer || '';
        const when = toLocalParts(exp.occurred_at); // UTC -> 本地墙钟
        this.nodeId = exp.node_id || '';
        this.setData({
          ready: true,
          editing: true,
          amount: String(exp.amount ?? ''),
          note: exp.note || '',
          category,
          payer,
          date: when.date,
          time: when.time,
          categories: toCategoryPills(data.vocab, category),
          payers: toPayerPills(data, payer),
          nodeTitle: (data.nodes || []).find((n) => n.id === this.nodeId)?.title || '',
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

    // 新增：时间默认「现在」，只定一次 —— 之后用户改过的日期/时间不跟着同步走
    const patch = {};
    if (!this.expenseId && !this.timeInit) {
      this.timeInit = true;
      const now = toLocalParts(null);
      patch.date = now.date;
      patch.time = now.time;
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
      ...patch,
    });
  },
});
