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
    // 导航坐标（GCJ-02）：地图选点存下来的；pickLat/pickLng 是地图当前中心
    lat: null,
    lng: null,
    hasCoord: false,
    showMap: false,
    pickLat: 26.8721, // 默认落在丽江（本行程）；用户拖一下就换
    pickLng: 100.2299,
    transportMinutes: '',
    checklist: [],
    types: [],
    missing: '',
    canSave: false,
    focusId: '',
    isReadOnly: false,
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

  /* ------------------------------ 地图选点 ------------------------------ */
  // 拖地图把中心对准地点 → 「用中心点」记住坐标。比按地名解析准，也不吃地理编码配额。
  // 取中心点优先用 regionchange（end 阶段带 centerLocation，基础库 2.3.0 起），
  // 没拖过地图时退到 MapContext.getCenterLocation（老基础库没有就提示再拖一下）。

  onToggleMap() {
    const showMap = !this.data.showMap;
    const hasLat = typeof this.data.lat === 'number' && Number.isFinite(this.data.lat);
    const hasLng = typeof this.data.lng === 'number' && Number.isFinite(this.data.lng);
    this.setData({
      showMap,
      pickLat: hasLat ? this.data.lat : this.data.pickLat,
      pickLng: hasLng ? this.data.lng : this.data.pickLng,
    });
  },

  onMapRegion(e) {
    const c = e?.detail?.centerLocation;
    // 0 视为「地图还没就绪」的退化值，不记；否则会在空白底图上存出一个 (0,0)
    if (c && Number.isFinite(c.latitude) && Number.isFinite(c.longitude) && c.latitude !== 0 && c.longitude !== 0) {
      this.mapCenter = { latitude: c.latitude, longitude: c.longitude };
    }
  },

  onMapUse() {
    const take = (latitude, longitude) => {
      const lat = Number(Number(latitude).toFixed(6));
      const lng = Number(Number(longitude).toFixed(6));
      // 拿不到有效中心点（NaN / 0 / 退化到 0）就明确提示，不落库
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) {
        wx.showToast({ title: '没取到有效中心点，拖一下地图再试', icon: 'none' });
        return;
      }
      this.setData({ lat, lng, hasCoord: true });
      wx.showToast({ title: '坐标已记住', icon: 'success' });
    };
    if (this.mapCenter) {
      take(this.mapCenter.latitude, this.mapCenter.longitude);
      return;
    }
    const ctx = wx.createMapContext('pickMap', this);
    if (typeof ctx?.getCenterLocation === 'function') {
      ctx.getCenterLocation({
        success: (r) => take(r.latitude, r.longitude),
        fail: () => wx.showToast({ title: '没取到中心点，再拖一下地图', icon: 'none' }),
      });
      return;
    }
    wx.showToast({ title: '这个基础库取不到中心点，拖一下地图再试', icon: 'none' });
  },

  onMapClear() {
    this.setData({ lat: null, lng: null, hasCoord: false });
    wx.showToast({ title: '坐标已清除', icon: 'none' });
  },

  onTransport(e) {
    this.setData({ transportMinutes: e.detail.value });
  },

  onType(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.type) return;
    this.setData({ type: key, types: toTypePills(getState().data?.vocab, key) });
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
    if (this.data.isReadOnly) {
      wx.showToast({ title: '只读模式无法删除', icon: 'none' });
      return;
    }
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
    if (this.data.isReadOnly) {
      wx.showToast({ title: '只读模式无法修改', icon: 'none' });
      return;
    }
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
      lat: this.data.hasCoord ? this.data.lat : null,
      lng: this.data.hasCoord ? this.data.lng : null,
      transportMinutes: this.data.transportMinutes === '' ? null : Number(this.data.transportMinutes),
      checklist,
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
    const myRole = data.me?.role || data.trip?.role || (s.trips?.find((t) => t.id === s.activeTripId)?.role) || 'editor';
    const isReadOnly = myRole === 'viewer';

    // 编辑模式只预填一次，别让 20 秒一轮的同步把正在输入的内容冲掉
    if (this.nodeId && !this.prefilled) {
      const n = (data.nodes || []).find((x) => x.id === this.nodeId);
      if (n) {
        this.prefilled = true;
        const date = n.date || '';
        const title = n.title || '';
        wx.setNavigationBarTitle({ title: isReadOnly ? '查看行程' : '编辑行程' });
        this.setData({
          ready: true,
          editing: true,
          isReadOnly,
          title,
          type: n.type || 'spot',
          date,
          startTime: n.start_time || '',
          endTime: n.end_time || '',
          location: n.location || '',
          navKeyword: n.nav_keyword || '',
          lat: Number.isFinite(n.lat) ? n.lat : null,
          lng: Number.isFinite(n.lng) ? n.lng : null,
          hasCoord: Number.isFinite(n.lat) && Number.isFinite(n.lng),
          pickLat: Number.isFinite(n.lat) ? n.lat : 26.8721,
          pickLng: Number.isFinite(n.lng) ? n.lng : 100.2299,
          transportMinutes: n.transport_minutes ?? '',
          checklist: normalizeItems(n.checklist),
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
        isReadOnly,
        date,
        types: toTypePills(data.vocab, this.data.type),
        ...this.gate(this.data.title, date),
      });
      return;
    }

    // 已预填：只保持类型胶囊和校验状态跟着最新数据走
    this.setData({
      isReadOnly,
      types: toTypePills(data.vocab, this.data.type),
      ...this.gate(this.data.title, this.data.date),
    });
  },
});
