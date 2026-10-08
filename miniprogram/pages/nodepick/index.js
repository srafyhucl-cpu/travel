import { getState, subscribe } from '../../store/store.js';
import { formatDate, relativeDay } from '../../core/format.js';

/** 标题 / 日期（原始与好读两种）/ 地点命中关键词；大小写不敏感 */
function hit(n, kw) {
  if (!kw) return true;
  const hay = `${n.title || ''} ${n.date || ''} ${formatDate(n.date)} ${n.location || ''}`;
  return hay.toLowerCase().includes(kw);
}

/** 节点按日期分组：日期升序，组内按 sort_order；行上带 on 供打勾 */
function toGroups(nodes, current, q) {
  const kw = q.trim().toLowerCase();
  const byDate = new Map();
  for (const n of nodes || []) {
    if (!hit(n, kw)) continue;
    const date = n.date || '';
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(n);
  }
  return [...byDate.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([date, items]) => ({
      date,
      label: date ? `${formatDate(date)} · ${relativeDay(date)}` : '未安排日期',
      items: items
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((n) => ({
          id: n.id,
          time: n.start_time || '',
          title: n.title || '',
          on: n.id === current,
        })),
    }));
}

Page({
  data: {
    ready: false,
    current: '', // 当前挂靠的节点 id；空 = 不指定
    q: '',
    groups: [],
    emptyText: '',
  },

  // query.current = 调用方当前挂靠的节点 id（可空）
  onLoad(query) {
    this.setData({ current: (query && query.current) || '' });
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    this.unsub?.();
  },

  onSearch(e) {
    const q = e.detail.value;
    this.setData({ q });
    this.render(q);
  },

  /** 「不指定」：回传 null */
  onClear() {
    this.picked(null);
  },

  onPick(e) {
    const id = e.currentTarget.dataset.id;
    const n = (getState().data?.nodes || []).find((x) => x.id === id);
    if (!n) return;
    this.picked({ id: n.id, title: n.title || '' });
  },

  /** 选中即回传 + 退回调用方；node 为 null 表示「不指定」 */
  picked(node) {
    this.getOpenerEventChannel?.()?.emit?.('picked', node);
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: '/pages/timeline/index' });
  },

  /** 列表 + 空态文案：没节点和搜索没命中的说法不一样 */
  render(q = this.data.q) {
    const nodes = getState().data?.nodes || [];
    const groups = toGroups(nodes, this.data.current, q);
    this.setData({
      groups,
      emptyText: groups.length ? '' : nodes.length ? '没有匹配的行程项' : '这趟旅行还没有行程项',
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
    this.setData({ ready: true });
    this.render();
  },
});
