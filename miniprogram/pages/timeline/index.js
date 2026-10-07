import { actions, getState, refresh, subscribe } from '../../store/store.js';
import { computeNow, decorate, groupByDate } from '../../core/timeline.js';
import { formatDate, relativeDay, typeMeta } from '../../core/format.js';

/** 「现在」卡：口径与 Web 的 Deck 一致，数据来自 core/timeline 的 computeNow */
function nowCard(clock) {
  const day = `第 ${clock.dayNumber}/${clock.totalDays} 天`;
  if (clock.phase === 'upcoming') {
    return { label: '还没出发', title: clock.headline, sub: clock.subline, tone: 'upcoming' };
  }
  if (clock.phase === 'finished') {
    return { label: '已结束', title: clock.headline, sub: clock.subline || day, tone: 'done' };
  }
  if (clock.currentNode) {
    return { label: '现在', title: clock.currentNode.title, sub: clock.currentNode.location || day, tone: 'active' };
  }
  if (clock.nextNode) {
    return {
      label: '下一个',
      title: clock.nextNode.title,
      sub: `${day} · ${clock.nextNode.start_time || ''} 开始`.trim(),
      tone: 'normal',
    };
  }
  return { label: clock.tone === 'done' ? '已完成' : '空闲', title: clock.headline, sub: clock.subline || day, tone: 'normal' };
}

function toCard(n, vocab, currentId) {
  const meta = typeMeta(vocab, n.type);
  return {
    id: n.id,
    title: n.title,
    time: n.start_time || '—',
    range: n.end_time && n.start_time ? `${n.start_time}–${n.end_time}` : '',
    typeLabel: meta.label,
    typeColor: meta.color,
    typeSoft: meta.soft,
    location: n.location || '',
    done: n.isDone ? 1 : 0,
    current: n.id === currentId ? 1 : 0,
    checklist: (n.checklist || []).map((c) => ({ id: c.id, text: c.text, done: c.done ? 1 : 0 })),
  };
}

function buildView(s) {
  const data = s.data;
  const clock = computeNow({ trip: data.trip, nodes: data.nodes, checkins: data.checkins }, s.now);
  const decorated = decorate(data.nodes, data.checkins);
  const byDate = groupByDate(decorated);
  const days = clock.allDates.map((d) => {
    const list = byDate.get(d) || [];
    return {
      date: d,
      label: formatDate(d),
      rel: relativeDay(d, s.now),
      isToday: d === clock.today,
      done: list.filter((n) => n.isDone).length,
      total: list.length,
      nodes: list.map((n) => toCard(n, data.vocab, clock.currentNode?.id)),
    };
  });
  return {
    tripName: data.trip?.name || '旅行助手',
    now: nowCard(clock),
    days,
    online: s.online,
    syncing: s.syncing,
  };
}

Page({
  data: { ready: false, now: {}, days: [], online: true, syncing: true },

  onLoad() {
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    this.unsub?.();
  },

  async onPullDownRefresh() {
    try {
      await refresh({ quiet: true });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  sync() {
    const s = getState();
    if (s.phase === 'login') {
      wx.redirectTo({ url: '/pages/login/index' });
      return;
    }
    if (!s.data) {
      this.setData({ ready: false, syncing: true });
      return;
    }
    wx.setNavigationBarTitle({ title: s.data.trip?.name || '旅行助手' });
    this.setData({ ready: true, ...buildView(s) });
  },

  /** 勾选待办：走真实写接口 —— 这条路径验证了鉴权、请求、刷新整条链路 */
  onToggle(e) {
    const { node, item, done, text } = e.currentTarget.dataset;
    actions.setChecklistItem(node, item, !Number(done), text).catch(() => {});
  },
});
