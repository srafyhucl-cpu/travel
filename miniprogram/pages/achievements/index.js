import { getState, subscribe } from '../../store/store.js';
import { computeAchievements } from '../../core/achievements.js';
import { formatDate, tintOf } from '../../core/format.js';
import { iconDataUri } from '../../platform/wx/icons.js';

const GRAY = '#9ca3af';

/** 徽章日期按本地自然日显示（快照里是 UTC ISO） */
function dayOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toBadge(b) {
  const color = b.color || '#2F80ED';
  return {
    id: b.id,
    title: b.title,
    desc: b.desc,
    icon: iconDataUri(b.icon || 'ring', b.done ? color : GRAY, 36),
    tint: b.done ? tintOf(color) : 'transparent',
    done: b.done ? 1 : 0,
    atLabel: b.done && b.at ? `${formatDate(dayOf(b.at), { short: true })} 达成` : '',
    progress: b.progress && b.progress.total > 0 ? { done: b.progress.done, total: b.progress.total, rate: Math.min(1, b.progress.done / b.progress.total) } : null,
  };
}

Page({
  data: {
    ready: false,
    pick: 'team',
    picks: [],
    list: [],
    unlocked: 0,
    total: 0,
  },

  onLoad() {
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    this.unsub?.();
  },

  onPick(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || id === this.data.pick) return;
    this.setData({ pick: id });
    this.sync();
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
    const model = computeAchievements(data);
    const meId = data.meId || model.memberList.find((m) => m.name === data.me)?.id || null;

    // 选中的成员没了（改名/清库）：退回全队
    const pick = this.data.pick !== 'team' && !model.byMember[this.data.pick] ? 'team' : this.data.pick;
    const raw = pick === 'team' ? model.team : model.byMember[pick] || [];
    const list = raw.map(toBadge);
    const unlocked = list.filter((b) => b.done).length;

    this.setData({
      ready: true,
      pick,
      picks: [
        { id: 'team', label: `全队 ${model.team.filter((b) => b.done).length}/${model.team.length}`, on: pick === 'team', me: false },
        ...model.memberList.map((m) => ({
          id: m.id,
          label: m.name,
          on: pick === m.id,
          me: m.id === meId && m.name !== '我',
        })),
      ],
      list,
      unlocked,
      total: list.length,
    });
  },
});
