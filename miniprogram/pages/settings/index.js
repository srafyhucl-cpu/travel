import { actions, getState, subscribe } from '../../store/store.js';
import { icsUrl, templateUrl, backupUrl } from '../../store/api.js';
import { baseUrl } from '../../platform/wx/net.js';
import { copyText } from '../../platform/wx/services.js';
import { formatDate, daysBetween, todayStr, tintOf } from '../../core/format.js';
import { computeAchievements } from '../../core/achievements.js';
import { iconDataUri } from '../../platform/wx/icons.js';
import { PICKABLE } from '../../core/glyphs.js';

const MEMBER_COLORS = ['#2F80ED', '#E2574C', '#27AE60', '#F2994A', '#9B51E0', '#00897B', '#111827'];
const GRAY = '#9ca3af';

/** 下载带令牌的文件（URL 里已经带 token）再交给微信「转发到聊天」 */
function downloadAndShare(url, fileName) {
  wx.showLoading({ title: '准备文件…', mask: true });
  wx.downloadFile({
    url,
    success: (res) => {
      wx.hideLoading();
      if (res.statusCode !== 200 || !res.tempFilePath) {
        wx.showToast({ title: '下载失败，稍后再试', icon: 'none' });
        return;
      }
      wx.shareFileMessage({
        filePath: res.tempFilePath,
        fileName,
        fail: () => wx.showToast({ title: '没有转发出去', icon: 'none' }),
      });
    },
    fail: () => {
      wx.hideLoading();
      wx.showToast({ title: '下载失败，检查网络', icon: 'none' });
    },
  });
}

function toVocabChips(vocab) {
  const chip = (item) => {
    const color = item.color || '#6B7280';
    return {
      key: item.key,
      label: item.label,
      color,
      soft: item.soft || tintOf(color),
      icon: iconDataUri(item.icon || 'ring', color, 26),
      custom: !!item.custom,
    };
  };
  return {
    types: (vocab?.nodeTypes || []).map(chip),
    cats: (vocab?.categories || []).map(chip),
  };
}

Page({
  data: {
    ready: false,
    // 旅行信息
    trip: {},
    dayCount: 1,
    statsLine: '',
    tripEdit: false,
    tripForm: { name: '', destination: '', startDate: '', endDate: '' },
    tripBusy: false,
    // 成员
    members: [],
    memberEdit: false,
    memberForm: [],
    colors: MEMBER_COLORS,
    // 词汇
    types: [],
    cats: [],
    custom: [],
    vocabAdd: '', // 'node_type' | 'expense_category' | ''
    vocabForm: { label: '', icon: 'pin', color: '#00897B', leadMinutes: '30' },
    iconChoices: [],
    vocabManage: false,
    // 口令
    passEdit: false,
    passForm: { current: '', next: '', confirm: '' },
    passMsg: '',
    passCan: false,
    passBusy: false,
    // 导入模板
    importInfo: null,
    importDate: '',
    importBusy: false,
    // 成就
    achvText: '',
  },

  onLoad() {
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    this.unsub?.();
  },

  /* ------------------------------ 旅行信息 ------------------------------ */

  onTripToggle() {
    if (this.data.tripEdit) this.setData({ tripEdit: false });
    else this.onTripEdit();
  },

  onTripEdit() {
    const t = getState().data?.trip || {};
    this.setData({
      tripEdit: true,
      tripForm: {
        name: t.name || '',
        destination: t.destination || '',
        startDate: t.start_date || '',
        endDate: t.end_date || '',
      },
    });
  },

  onTripCancel() {
    this.setData({ tripEdit: false });
  },

  onTripField(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`tripForm.${k}`]: e.detail.value });
  },

  onTripDate(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`tripForm.${k}`]: e.detail.value });
  },

  async onTripSave() {
    const f = this.data.tripForm;
    if (!f.name.trim() || !f.startDate || !f.endDate) {
      wx.showToast({ title: '名称和起止日期都要填', icon: 'none' });
      return;
    }
    if (f.endDate < f.startDate) {
      wx.showToast({ title: '回来日不能早于出发日', icon: 'none' });
      return;
    }
    if (this.data.tripBusy) return;
    this.setData({ tripBusy: true });
    try {
      await actions.patchTrip({
        name: f.name.trim(),
        destination: f.destination.trim(),
        startDate: f.startDate,
        endDate: f.endDate,
      });
      this.setData({ tripEdit: false });
    } catch {
      /* store 已经弹过提示 */
    } finally {
      this.setData({ tripBusy: false });
    }
  },

  /* ------------------------------ 成员 ------------------------------ */

  onMemberToggle() {
    if (this.data.memberEdit) this.setData({ memberEdit: false });
    else this.onMemberEdit();
  },

  onMemberEdit() {
    const members = getState().data?.members || [];
    this.setData({
      memberEdit: true,
      memberForm: members.map((m) => ({ id: m.id, name: m.name, color: m.color || MEMBER_COLORS[0] })),
    });
  },

  onMemberCancel() {
    this.setData({ memberEdit: false });
  },

  onMemberName(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.detail.value;
    this.setData({ memberForm: this.data.memberForm.map((m) => (m.id === id ? { ...m, name } : m)) });
  },

  onMemberColor(e) {
    const { id, color } = e.currentTarget.dataset;
    this.setData({ memberForm: this.data.memberForm.map((m) => (m.id === id ? { ...m, color } : m)) });
  },

  async onMemberSave() {
    try {
      for (const m of this.data.memberForm) {
        await actions.patchMember(m.id, { name: m.name.trim() || m.name, color: m.color });
      }
      this.setData({ memberEdit: false });
    } catch {
      /* store 已经弹过提示 */
    }
  },

  /* ------------------------------ 词汇 ------------------------------ */

  onVocabAdd(e) {
    const kind = e.currentTarget.dataset.kind;
    this.setData({
      vocabAdd: kind,
      vocabForm: {
        label: '',
        icon: kind === 'node_type' ? 'pin' : 'wallet',
        color: '#00897B',
        leadMinutes: '30',
      },
      iconChoices: PICKABLE.map((k) => ({ key: k, icon: iconDataUri(k, '#00897B', 40) })),
    });
  },

  onVocabCancel() {
    this.setData({ vocabAdd: '' });
  },

  onVocabField(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`vocabForm.${k}`]: e.detail.value });
  },

  onVocabIcon(e) {
    const key = e.currentTarget.dataset.key;
    const color = this.data.vocabForm.color;
    this.setData({
      'vocabForm.icon': key,
      iconChoices: PICKABLE.map((k) => ({ key: k, icon: iconDataUri(k, k === key ? color : GRAY, 40) })),
    });
  },

  onVocabColor(e) {
    const color = e.currentTarget.dataset.color;
    const icon = this.data.vocabForm.icon;
    this.setData({
      'vocabForm.color': color,
      iconChoices: PICKABLE.map((k) => ({ key: k, icon: iconDataUri(k, k === icon ? color : GRAY, 40) })),
    });
  },

  async onVocabSave() {
    const f = this.data.vocabForm;
    const kind = this.data.vocabAdd;
    if (!kind || !f.label.trim()) {
      wx.showToast({ title: '给它起个名字', icon: 'none' });
      return;
    }
    try {
      await actions.addVocab({
        kind,
        label: f.label.trim(),
        icon: f.icon,
        color: f.color,
        leadMinutes: Number(f.leadMinutes) || 0,
      });
      this.setData({ vocabAdd: '' });
    } catch {
      /* store 已经弹过提示 */
    }
  },

  onVocabManage() {
    this.setData({ vocabManage: !this.data.vocabManage });
  },

  /** 改名：借微信的原生输入弹窗（editable），省一张表单 */
  onVocabRename(e) {
    const { id, label } = e.currentTarget.dataset;
    wx.showModal({
      title: '改成什么名字？',
      editable: true,
      placeholderText: '新名字',
      content: label,
      success: async (r) => {
        if (!r.confirm) return;
        const next = String(r.content || '').trim();
        if (!next || next === label) return;
        try {
          await actions.patchVocab(id, { label: next });
        } catch {
          /* store 已经弹过提示 */
        }
      },
    });
  },

  onVocabDelete(e) {
    const { id, label } = e.currentTarget.dataset;
    wx.showModal({
      title: `删掉「${label}」？`,
      content: '已经用这个类型的行程/消费会保留，只是失去图标和配色',
      confirmText: '删除',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await actions.deleteVocab(id);
        } catch {
          /* store 已经弹过提示 */
        }
      },
    });
  },

  /* ------------------------------ 导出与提醒 ------------------------------ */

  onShareTemplate() {
    downloadAndShare(templateUrl(), '行程模板.json');
  },

  onShareBackup() {
    downloadAndShare(backupUrl(), '旅行备份.json');
  },

  async onCopyIcs() {
    const r = await copyText(icsUrl());
    wx.showToast({ title: r === 'copied' ? '订阅链接已复制' : '复制失败', icon: r === 'copied' ? 'success' : 'none' });
  },

  async onCopyUrl() {
    const r = await copyText(baseUrl());
    wx.showToast({ title: r === 'copied' ? '网址已复制' : '复制失败', icon: r === 'copied' ? 'success' : 'none' });
  },

  /* ------------------------------ 导入模板 ------------------------------ */

  onImport() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json'],
      success: (res) => {
        const f = (res.tempFiles || [])[0];
        if (!f) return;
        try {
          const text = wx.getFileSystemManager().readFileSync(f.path, 'utf8');
          const tpl = JSON.parse(text);
          if (!tpl || tpl.kind !== 'travel-template' || !Array.isArray(tpl.days)) {
            wx.showToast({ title: '这不是本 App 导出的行程模板', icon: 'none' });
            return;
          }
          const total = tpl.days.reduce((s, d) => s + (d.nodes?.length || 0), 0);
          this.importTemplate = tpl; // 大对象放实例上，不进 data
          this.setData({
            importInfo: { fileName: f.name || '模板.json', days: tpl.days.length, total },
            importDate: getState().data?.trip?.start_date || todayStr(),
          });
        } catch {
          wx.showToast({ title: '文件读不出来，或不是有效的 JSON', icon: 'none' });
        }
      },
      fail: () => {},
    });
  },

  onImportDate(e) {
    this.setData({ importDate: e.detail.value });
  },

  async onImportGo() {
    if (!this.importTemplate || this.data.importBusy) return;
    this.setData({ importBusy: true });
    try {
      await actions.importTemplate({ template: this.importTemplate, startDate: this.data.importDate });
      this.importTemplate = null;
      this.setData({ importInfo: null });
    } catch {
      /* store 已经弹过提示 */
    } finally {
      this.setData({ importBusy: false });
    }
  },

  onImportCancel() {
    this.importTemplate = null;
    this.setData({ importInfo: null });
  },

  /* ------------------------------ 口令 / 退出 ------------------------------ */

  onPassToggle() {
    if (this.data.passEdit) this.setData({ passEdit: false });
    else this.onPassEdit();
  },

  onPassEdit() {
    this.setData({ passEdit: true, passForm: { current: '', next: '', confirm: '' }, passMsg: '', passCan: false });
  },

  onPassCancel() {
    this.setData({ passEdit: false });
  },

  onPassField(e) {
    const k = e.currentTarget.dataset.k;
    const form = { ...this.data.passForm, [k]: e.detail.value };
    const tooShort = form.next.length > 0 && form.next.length < 6;
    const mismatch = form.confirm.length > 0 && form.next !== form.confirm;
    const same = form.next.length > 0 && form.next === form.current;
    let msg = '';
    if (tooShort) msg = '新口令至少 6 位';
    else if (mismatch) msg = '两遍新口令不一样';
    else if (same) msg = '新口令和当前口令一样';
    this.setData({
      passForm: form,
      passMsg: msg,
      passCan: !!form.current && form.next.length >= 6 && !mismatch && !same,
    });
  },

  async onPassSave() {
    if (!this.data.passCan || this.data.passBusy) return;
    this.setData({ passBusy: true });
    try {
      await actions.changePassphrase(this.data.passForm.current, this.data.passForm.next);
      wx.showToast({ title: '口令已更新', icon: 'success' });
      this.setData({ passEdit: false });
    } catch {
      /* store 已经弹过提示；表单留着让用户改完重试 */
    } finally {
      this.setData({ passBusy: false });
    }
  },

  onLogout() {
    wx.showModal({
      title: '退出登录？',
      content: '退出后要重新输入旅行口令才能进来',
      confirmText: '退出',
      success: async (r) => {
        if (!r.confirm) return;
        await actions.logout();
        wx.reLaunch({ url: '/pages/login/index' });
      },
    });
  },

  onAchv() {
    wx.navigateTo({ url: '/pages/achievements/index' });
  },

  /* ------------------------------ 数据落地 ------------------------------ */

  sync() {
    const s = getState();
    if (s.phase === 'login') {
      wx.reLaunch({ url: '/pages/login/index' });
      return;
    }
    if (!s.data) {
      if (this.data.ready) this.setData({ ready: false });
      return;
    }
    const data = s.data;
    const { trip, members } = data;
    const dayCount = Math.max(1, daysBetween(trip.start_date, trip.end_date) + 1);
    const chips = toVocabChips(data.vocab);
    const custom = [
      ...(data.vocab?.nodeTypes || []).filter((t) => t.custom).map((t) => ({ ...t, kind: 'node_type', kindLabel: '行程类型' })),
      ...(data.vocab?.categories || []).filter((c) => c.custom).map((c) => ({ ...c, kind: 'expense_category', kindLabel: '消费类别' })),
    ].map((c) => ({ id: c.id, label: c.label, kindLabel: c.kindLabel }));

    const achv = computeAchievements(data);
    const meId = data.meId || achv.memberList.find((m) => m.name === data.me)?.id || null;
    const mine = achv.byMember[meId] || [];

    this.setData({
      ready: true,
      trip,
      dayCount,
      statsLine: `${(data.nodes || []).length} 行程 · ${(data.expenses || []).length} 消费 · ${(data.photos || []).length} 照片`,
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color || MEMBER_COLORS[0],
        tint: tintOf(m.color || MEMBER_COLORS[0]),
        initial: (m.name || '?').trim().slice(0, 1),
        me: (data.meId ? m.id === data.meId : m.name === data.me) && m.name !== '我',
      })),
      types: chips.types,
      cats: chips.cats,
      custom,
      achvText: `我的 ${mine.filter((b) => b.done).length}/${mine.length} · 全队 ${achv.team.filter((b) => b.done).length}/${achv.team.length}`,
    });
  },
});
