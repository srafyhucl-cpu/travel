import { getState, subscribe } from '../../store/store.js';
import { formatDate, formatMoney } from '../../core/format.js';
import { computeBudget } from '../../core/budget.js';
import { files } from '../../platform/wx/files.js';
import { renderPoster, renderTripLongImage, loadImage, TEMPLATES, ACCENTS } from '../../platform/wx/canvas.js';

Page({
  data: {
    ready: false,
    mode: 'long', // long = 行程长图；photo = 照片海报
    template: 'classic',
    templates: TEMPLATES,
    accents: ACCENTS,
    accent: ACCENTS[0],
    includePhotos: false,
    count: 4,
    counts: [2, 4, 6, 9],
    title: '',
    subtitle: '',
    photoCount: 0,
    busy: false,
    progress: '',
    previewPath: '',
    dispW: 0,
    dispH: 260,
  },

  onLoad() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.dispW = Math.max(240, Math.floor(info.windowWidth - 32));
    this.gen = 0; // 出图批次号：++undefined 会是 NaN，NaN !== NaN 恒真会把结果全丢掉
    this.setData({ dispW: this.dispW });
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onUnload() {
    // 卸载后还在飞的出图/导出回调一律作废：gen 一变，后面所有检查都短路
    this.unloaded = true;
    this.gen = (this.gen || 0) + 1;
    this.unsub?.();
  },

  /** 画布节点要等页面 ready 才能取到 */
  onReady() {
    wx.createSelectorQuery()
      .in(this)
      .select('#cv')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (this.unloaded) return; // 查询回来得比卸载晚：别再动画布
        this.canvas = res?.[0]?.node || null;
        if (!this.canvas) {
          wx.showToast({ title: '画布初始化失败', icon: 'none' });
          return;
        }
        this.boot();
      });
  },

  /** 画布与数据都齐了才开第一张图（两者到达顺序不固定） */
  boot() {
    if (this.booted || this.unloaded || !this.canvas || !getState().data) return;
    this.booted = true;
    this.generate();
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
    const patch = { ready: true, photoCount: (s.data.photos || []).length };
    const photoCount = patch.photoCount;
    // 照片被删光时别停在「照片海报」：那只会出一张灰块占位图
    if (!photoCount && this.data.mode === 'photo') patch.mode = 'long';
    // 选中的张数超过现有张数时收敛到可用的最大档，别让禁用胶囊还亮着
    if (photoCount >= 2 && this.data.count > photoCount) {
      patch.count = [...this.data.counts].reverse().find((n) => n <= photoCount) || this.data.count;
    }
    // 标题/副标题只预填一次，别把用户改过的字冲掉
    if (!this.prefilled) {
      this.prefilled = true;
      patch.title = s.data.trip?.name || '旅行记录';
      patch.subtitle = s.data.trip?.destination || '';
    }
    this.setData(patch);
    if (patch.mode) this.generate(); // 退回长图要重出，不然预览还停在旧照片海报
    this.boot();
  },

  stats(data) {
    const days = Math.max(1, Math.round((new Date(data.trip.end_date) - new Date(data.trip.start_date)) / 86400000) + 1);
    const b = computeBudget({ budgets: data.budgets, expenses: data.expenses });
    return [
      { label: '天数', value: `${days} 天` },
      { label: '消费', value: `¥${formatMoney(b.actualTotal)}` },
      { label: '照片', value: `${(data.photos || []).length} 张` },
    ];
  },

  /* ------------------------------ 选项 ------------------------------ */

  onMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.mode) return;
    if (mode === 'photo' && !this.data.photoCount) {
      wx.showToast({ title: '还没有照片', icon: 'none' });
      return;
    }
    this.setData({ mode });
    this.generate();
  },

  onTemplate(e) {
    const template = e.currentTarget.dataset.id;
    if (!template || template === this.data.template) return;
    this.setData({ template });
    this.generate();
  },

  onAccent(e) {
    const accent = e.currentTarget.dataset.color;
    if (!accent || accent === this.data.accent) return;
    this.setData({ accent });
    this.generate();
  },

  onIncludePhotos(e) {
    this.setData({ includePhotos: e.detail.value });
    this.generate();
  },

  onCount(e) {
    const count = Number(e.currentTarget.dataset.n);
    if (!count || count === this.data.count) return;
    if (count > this.data.photoCount) {
      wx.showToast({ title: `这趟只有 ${this.data.photoCount} 张照片`, icon: 'none' });
      return;
    }
    this.setData({ count });
    this.generate();
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  onSubtitle(e) {
    this.setData({ subtitle: e.detail.value });
  },

  onRegenerate() {
    this.generate();
  },

  /* ------------------------------ 出图 ------------------------------ */

  async generate() {
    if (!this.canvas || !getState().data) return;
    const gen = ++this.gen;
    this.setData({ busy: true, progress: '', previewPath: '' });
    try {
      const data = getState().data;
      let size;
      if (this.data.mode === 'long') {
        size = await renderTripLongImage({
          canvas: this.canvas,
          trip: data.trip,
          nodes: data.nodes,
          expenses: data.expenses,
          photos: data.photos,
          checkins: data.checkins,
          members: data.members,
          budgets: data.budgets,
          vocab: data.vocab,
          accent: this.data.accent,
          includePhotos: this.data.includePhotos && (data.photos || []).length > 0,
          title: this.data.title,
          subtitle: this.data.subtitle,
          onProgress: (done, total) => {
            if (gen === this.gen) this.setData({ progress: `${done}/${total}` });
          },
          loadPhoto: async (id) => {
            const path = await files.url(id);
            return path ? await loadImage(this.canvas, path) : null;
          },
        });
      } else {
        // 一张都没有时别出灰块占位海报
        if (!(data.photos || []).length) {
          this.setData({ busy: false, progress: '' });
          return;
        }
        const srcs = [];
        for (const p of (data.photos || []).slice(0, this.data.count)) {
          const u = await files.url(p.id);
          if (u) srcs.push(u);
        }
        size = await renderPoster({
          canvas: this.canvas,
          template: this.data.template,
          accent: this.data.accent,
          title: this.data.title.trim() || '旅行记录',
          subtitle: this.data.subtitle.trim(),
          dateLabel: `${formatDate(data.trip?.start_date, { short: true })} – ${formatDate(data.trip?.end_date, { short: true })}`,
          location: data.trip?.destination || '',
          stats: this.stats(data),
          footer: 'Made with 旅行助手',
          photoSrcs: srcs,
        });
      }
      if (gen !== this.gen) return; // 期间又改过配置：这次的结果作废
      const path = await this.toFile(size);
      if (gen !== this.gen) return;
      this.setData({
        previewPath: path,
        dispH: Math.max(120, Math.round((this.dispW * size.height) / size.width)),
        busy: false,
        progress: '',
      });
    } catch (e) {
      if (gen === this.gen) {
        this.setData({ busy: false, progress: '' });
        wx.showToast({ title: '出图失败：' + (e?.message || '未知错误'), icon: 'none' });
      }
    }
  },

  /** 画布导出成临时文件（微信分享/保存都吃这个路径） */
  toFile(size) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: this.canvas,
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
        destWidth: size.width,
        destHeight: size.height,
        fileType: 'png',
        success: (r) => (r.tempFilePath ? resolve(r.tempFilePath) : reject(new Error('导出为空'))),
        fail: (e) => reject(new Error(e?.errMsg || '导出失败')),
      });
    });
  },

  /* ------------------------------ 保存 / 分享 ------------------------------ */

  onSave() {
    if (!this.data.previewPath) return;
    wx.saveImageToPhotosAlbum({
      filePath: this.data.previewPath,
      success: () => wx.showToast({ title: '已存到相册', icon: 'success' }),
      fail: (err) => {
        const msg = err?.errMsg || '';
        if (/cancel/i.test(msg)) return;
        if (/auth|deny/i.test(msg)) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存图片需要「添加到相册」权限，去设置里打开一下？',
            confirmText: '去设置',
            success: (r) => {
              if (r.confirm) wx.openSetting();
            },
          });
          return;
        }
        wx.showToast({ title: '没存上，稍后再试', icon: 'none' });
      },
    });
  },

  onShare() {
    if (!this.data.previewPath) return;
    wx.showShareImageMenu({
      path: this.data.previewPath,
      fail: () => wx.showToast({ title: '没能打开分享', icon: 'none' }),
    });
  },
});
