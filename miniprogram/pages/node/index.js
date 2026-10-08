import { actions, getState, subscribe } from '../../store/store.js';
import { iconDataUri } from '../../platform/wx/icons.js';
import { normalizeItems, newItem, CHECKLIST_MAX } from '../../core/checklist.js';

const GRAY = '#9ca3af';

function toTypePills(vocab, current) {
  return (vocab?.nodeTypes || []).map((t) => {
    const color = t.color || '#6B7280';
    const on = t.key === current;
    return {
      key: t.key,
      label: t.label,
      color,
      icon: iconDataUri(t.icon || 'ring', on ? color : GRAY, 28),
      on,
    };
  });
}

Page({
  data: {
    ready: false,
    editing: false, // 编辑已有项（query.id 有值时）
    title: '',
    type: 'spot',
    date: '',
    startTime: '',
    endTime: '',
    location: '',
    navKeyword: '',
    showNav: false,
    transportMinutes: '',
    checklist: [],
    isModule: false,
    types: [],
    missing: '',
    canSave: false,
    focusId: '',
  },

  // query.id = 编辑；query.date = 给某天新建（都为空就是「加一项」，日期默认行程第一天）
  onLoad(query) {
    this.nodeId = (query && query.id) || '';
    this.draftDate = (query && query.date) || '';
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    this.unsub?.();
  },

  onTitle(e) {
    this.setData({ title: e.detail.value, ...this.gate(e.detail.value, this.data.date) });
  },

  onDate(e) {
    this.setData({ date: e.detail.value, ...this.gate(this.data.title, e.detail.value) });
  },

  onStart(e) {
    this.setData({ startTime: e.detail.value });
  },

  onEnd(e) {
    this.setData({ endTime: e.detail.value });
  },

  onClearTime(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'startTime' || k === 'endTime') this.setData({ [k]: '' });
  },

  onLocation(e) {
    this.setData({ location: e.detail.value });
  },

  onNav(e) {
    this.setData({ navKeyword: e.detail.value });
  },

  onToggleNav() {
    this.setData({ showNav: !this.data.showNav });
  },

  onTransport(e) {
    this.setData({ transportMinutes: e.detail.value });
  },

  onType(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.type) return;
    this.setData({ type: key, types: toTypePills(getState().data?.vocab, key) });
  },

  onModule(e) {
    this.setData({ isModule: e.detail.value });
  },

  /* ------------------------------ 待办 ------------------------------ */

  onCheckText(e) {
    const id = e.currentTarget.dataset.id;
    const text = e.detail.value;
    this.setData({
      checklist: this.data.checklist.map((it) => (it.id === id ? { ...it, text } : it)),
    });
  },

  onCheckDel(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ checklist: this.data.checklist.filter((it) => it.id !== id) });
  },

  onCheckAdd() {
    if (this.data.checklist.length >= CHECKLIST_MAX) {
      wx.showToast({ title: `最多 ${CHECKLIST_MAX} 条`, icon: 'none' });
      return;
    }
    const item = newItem('');
    this.setData({ checklist: [...this.data.checklist, item], focusId: item.id });
  },

  /* ------------------------------ 删除 ------------------------------ */

  onDelete() {
    wx.showModal({
      title: `删掉「${this.data.title || '这一项'}」？`,
      content: '删了就找不回来了',
      confirmText: '删除',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await actions.deleteNode(this.nodeId);
          this.back();
        } catch {
          /* store 已经弹过提示 */
        }
      },
    });
  },

  /* ------------------------------ 保存 ------------------------------ */

  async onSave() {
    if (this.busy) return;
    const title = this.data.title.trim();
    if (!title || !this.data.date) return;
    const checklist = this.data.checklist
      .map((it) => ({ ...it, text: it.text.trim() }))
      .filter((it) => it.text)
      .map((it) => ({ id: it.id, text: it.text, done: it.done, done_at: it.done ? it.done_at : null }));
    const payload = {
      title,
      type: this.data.type,
      date: this.data.date,
      startTime: this.data.startTime || null,
      endTime: this.data.endTime || null,
      location: this.data.location.trim() || null,
      navKeyword: this.data.navKeyword.trim() || this.data.location.trim() || null,
      transportMinutes: this.data.transportMinutes === '' ? null : Number(this.data.transportMinutes),
      checklist,
      role: this.data.isModule ? 'module' : null,
    };
    this.busy = true;
    try {
      if (this.nodeId) {
        await actions.patchNode(this.nodeId, payload);
      } else {
        const created = await actions.createNode(payload);
        // 新建后让时间线滚到这张卡（时间线 onShow 读这个 key）
        if (created?.id) wx.setStorageSync('travel.scrollTo', created.id);
      }
      this.back();
    } catch {
      /* store 已经弹过提示；留着表单让用户改完重试 */
    } finally {
      this.busy = false;
    }
  },

  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/timeline/index' });
  },

  /** 必填校验的提示文案：置灰按钮却不说原因，用户会以为卡了 */
  gate(title, date) {
    const missing = [];
    if (!title.trim()) missing.push('标题');
    if (!date) missing.push('日期');
    return { missing: missing.join('、'), canSave: missing.length === 0 };
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

    // 编辑模式只预填一次，别让 20 秒一轮的同步把正在输入的内容冲掉
    if (this.nodeId && !this.prefilled) {
      const n = (data.nodes || []).find((x) => x.id === this.nodeId);
      if (n) {
        this.prefilled = true;
        const date = n.date || '';
        const title = n.title || '';
        wx.setNavigationBarTitle({ title: '编辑行程' });
        this.setData({
          ready: true,
          editing: true,
          title,
          type: n.type || 'spot',
          date,
          startTime: n.start_time || '',
          endTime: n.end_time || '',
          location: n.location || '',
          navKeyword: n.nav_keyword || '',
          transportMinutes: n.transport_minutes ?? '',
          checklist: normalizeItems(n.checklist),
          isModule: n.role === 'module',
          types: toTypePills(data.vocab, n.type || 'spot'),
          ...this.gate(title, date),
        });
        return;
      }
      if (!this.missing) {
        this.missing = true;
        wx.showToast({ title: '这一项已经不在了', icon: 'none' });
        setTimeout(() => this.back(), 900);
      }
      return;
    }

    // 新建：默认日期 = 带进来的那天，其次行程第一天
    if (!this.nodeId && !this.prefilled) {
      this.prefilled = true;
      const date = this.draftDate || data.trip?.start_date || '';
      wx.setNavigationBarTitle({ title: '新增行程' });
      this.setData({
        ready: true,
        date,
        types: toTypePills(data.vocab, this.data.type),
        ...this.gate(this.data.title, date),
      });
      return;
    }

    // 已预填：只保持类型胶囊和校验状态跟着最新数据走
    this.setData({
      types: toTypePills(data.vocab, this.data.type),
      ...this.gate(this.data.title, this.data.date),
    });
  },
});
