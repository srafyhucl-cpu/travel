import { actions, getState, refresh, subscribe } from '../../store/store.js';
import { computeNow, decorate, groupByDate } from '../../core/timeline.js';
import { formatDate, relativeDay, typeMeta, categoryMeta, formatMoney, tintOf } from '../../core/format.js';
import { computeBudget } from '../../core/budget.js';
import { progress } from '../../core/checklist.js';
import { iconDataUri } from '../../platform/wx/icons.js';
import { files } from '../../platform/wx/files.js';
import { openMap } from '../../platform/wx/services.js';

/** 缩略图同时最多拉 3 张：够快，又不至于把 20 秒一轮的同步挤成图片风暴 */
const THUMB_CONCURRENCY = 3;

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

/** ISO -> 本地 HH:MM（打卡时间胶囊用）；坏值给空串 */
function hhmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 一笔账 -> 一行视图：类别图标 + 备注（没填用类别名）+ 金额 */
function toExpRow(e, vocab) {
  const cm = categoryMeta(vocab, e.category);
  const color = cm.color || '#6B7280';
  return {
    id: e.id,
    icon: iconDataUri(cm.icon || 'ring', color, 30),
    color,
    text: e.note || cm.label,
    amount: formatMoney(e.amount),
  };
}

function toCard(n, vocab, currentId, expRows) {
  const meta = typeMeta(vocab, n.type);
  const spent = expRows.reduce((s, e) => s + (Number(e.rawAmount) || 0), 0);
  return {
    id: n.id,
    title: n.title,
    time: n.start_time || '—',
    range: n.end_time && n.start_time ? `${n.start_time}–${n.end_time}` : '',
    typeLabel: meta.label,
    typeColor: meta.color,
    typeSoft: meta.soft,
    icon: iconDataUri(meta.icon, meta.color),
    location: n.location || '',
    navKeyword: n.nav_keyword || '',
    done: n.isDone ? 1 : 0,
    started: n.isStarted && !n.isDone ? 1 : 0,
    doneAt: n.isDone ? hhmm(n.actual_end) : '',
    current: n.id === currentId ? 1 : 0,
    checklist: (n.checklist || []).map((c) => ({ id: c.id, text: c.text, done: c.done ? 1 : 0 })),
    money: expRows,
    spend: spent > 0 ? formatMoney(spent) : '',
  };
}

/**
 * 快照 -> 页面视图。照片同时做两件聚合：
 *   - 按 node_id 归到对应卡片，每张只带 { id, caption }；
 *   - node_id 为空的进「随手记」。
 * 账目同样按 node_id 归卡（卡片头显示合计、卡里逐行可点开编辑），无主的进「随手记」。
 * 预览时得按组顺序取图，所以另外给一份 `groups`（photoId 数组）；它由页面
 * 存在实例上而不进 data —— 几百张照片的 id 不必每轮 setData 都序列化一遍。
 */
function buildView(s) {
  const data = s.data;
  const clock = computeNow({ trip: data.trip, nodes: data.nodes, checkins: data.checkins }, s.now);
  const decorated = decorate(data.nodes, data.checkins);
  const byDate = groupByDate(decorated);

  const byNode = new Map();
  const loose = [];
  for (const p of data.photos || []) {
    const shot = { id: p.id, caption: p.caption || '' };
    if (p.node_id) {
      if (!byNode.has(p.node_id)) byNode.set(p.node_id, []);
      byNode.get(p.node_id).push(shot);
    } else {
      loose.push(shot);
    }
  }
  const groups = { loose: loose.map((p) => p.id) };
  for (const [nodeId, list] of byNode) groups[`n:${nodeId}`] = list.map((p) => p.id);

  const expByNode = new Map();
  const looseExp = [];
  for (const e of data.expenses || []) {
    if (e.node_id) {
      if (!expByNode.has(e.node_id)) expByNode.set(e.node_id, []);
      expByNode.get(e.node_id).push(e);
    } else {
      looseExp.push(toExpRow(e, data.vocab));
    }
  }

  const days = clock.allDates.map((d) => {
    const list = byDate.get(d) || [];
    return {
      date: d,
      label: formatDate(d),
      rel: relativeDay(d, s.now),
      isToday: d === clock.today,
      done: list.filter((n) => n.isDone).length,
      total: list.length,
      nodes: list.map((n) => {
        const rows = (expByNode.get(n.id) || []).map((e) => ({ ...toExpRow(e, data.vocab), rawAmount: e.amount }));
        return { ...toCard(n, data.vocab, clock.currentNode?.id, rows), photos: byNode.get(n.id) || [] };
      }),
    };
  });

  /* 前置模块：role === 'module' 的那一项，在「现在」卡下面单独露一份进度 */
  const module = (data.nodes || []).find((n) => n.role === 'module') || null;
  let moduleView = null;
  if (module) {
    const meta = typeMeta(data.vocab, module.type);
    const p = progress(module.checklist);
    moduleView = {
      id: module.id,
      title: module.title,
      icon: iconDataUri(meta.icon, meta.color),
      color: meta.color,
      done: p.done,
      total: p.total,
      allDone: p.allDone ? 1 : 0,
      checks: (module.checklist || []).map((c) => ({ id: c.id, text: c.text, done: c.done ? 1 : 0 })),
    };
  }

  /* 钱：总预算对照（core/budget 与 Web 同一份逻辑） */
  const b = computeBudget({ budgets: data.budgets, expenses: data.expenses });
  const budget = {
    planned: formatMoney(b.plannedTotal),
    actual: formatMoney(b.actualTotal),
    hasPlanned: b.plannedTotal > 0,
    over: b.over,
    remaining: formatMoney(Math.abs(b.remaining)),
    rate: b.plannedTotal > 0 ? Math.min(1, b.actualTotal / b.plannedTotal) : 0,
    spent: b.spent.map((r) => {
      const cm = categoryMeta(data.vocab, r.category);
      const color = cm.color || '#6B7280';
      return {
        key: r.category,
        label: cm.label,
        icon: iconDataUri(cm.icon || 'ring', color, 28),
        amount: formatMoney(r.actual),
        count: r.count,
      };
    }),
    paid: b.paid.map((r) => {
      const m = (data.members || []).find((x) => x.name === r.name);
      const color = m?.color || '#2F80ED';
      return {
        name: r.name,
        initial: (r.name || '?').slice(0, 1),
        color,
        tint: tintOf(color),
        amount: formatMoney(r.paid),
      };
    }),
  };

  return {
    view: {
      tripName: data.trip?.name || '旅行助手',
      now: nowCard(clock),
      days,
      loose,
      looseExp,
      module: moduleView,
      budget,
      online: s.online,
      syncing: s.syncing,
    },
    groups,
  };
}

Page({
  data: {
    ready: false,
    now: {},
    days: [],
    loose: [],
    looseExp: [],
    module: null,
    budget: {},
    seg: '', // Deck 展开的那一格：'' | 'prep' | 'money'
    online: true,
    syncing: true,
    photoPaths: {}, // photoId -> 本地路径；出现一张补一张，不阻塞列表渲染
    cameraIcon: '',
    walletIcon: '',
  },

  onLoad() {
    // 图标只算一次：data URI 生成要遍历字形，别放进每轮 buildView
    this.setData({
      cameraIcon: iconDataUri('camera', '#6b7280'),
      walletIcon: iconDataUri('wallet', '#6b7280'),
    });
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
    const { view, groups } = buildView(s);
    this.groups = groups;
    // 视图落地后再补缩略图：新照片每轮同步都会重新排进来
    this.setData({ ready: true, ...view }, () => this.fillThumbs());
  },

  /** Deck 那两格：点一下展开/收起（一次只开一格） */
  onSeg(e) {
    const seg = e.currentTarget.dataset.seg;
    if (!seg) return;
    this.setData({ seg: this.data.seg === seg ? '' : seg });
  },

  /** 逐张补缩略图（并发 3）：每张成功只动 photoPaths 里一个 key，列表不整体重排 */
  fillThumbs() {
    const paths = this.data.photoPaths || {};
    const busy = (this.thumbBusy = this.thumbBusy || new Set());
    const queue = [];
    for (const list of Object.values(this.groups || {})) {
      for (const id of list) {
        if (!paths[id] && !busy.has(id)) queue.push(id);
      }
    }
    if (!queue.length) return;

    let i = 0;
    const next = () => {
      if (i >= queue.length) return;
      const id = queue[i++];
      busy.add(id);
      const done = () => {
        busy.delete(id);
        next();
      };
      files
        .url(id, { thumb: true })
        .then((path) => {
          // 期间可能已被别的轮次补上，别拿旧结果盖新的
          if (path && !this.data.photoPaths?.[id]) this.setData({ [`photoPaths.${id}`]: path });
        })
        .catch(() => {}) // 拉不到就保持占位底色，下一轮 sync 再试
        .then(done, done);
    };
    for (let k = 0; k < THUMB_CONCURRENCY; k++) next();
  },

  /** 点开一张：把同组照片按顺序取 display 图，进系统预览里左右翻 */
  async onPhoto(e) {
    const { group, pid } = e.currentTarget.dataset;
    if (!pid) return;
    const ids = (this.groups || {})[group] || [pid];
    wx.showLoading({ title: '打开照片…', mask: true });
    const urls = [];
    let current = '';
    let failed = false;
    try {
      for (const id of ids) {
        const path = await files.url(id);
        if (!path) continue; // 单张失败不拖垮整组
        urls.push(path);
        if (id === pid && !current) current = path;
      }
      if (!urls.length) failed = true;
    } catch {
      failed = true;
    } finally {
      wx.hideLoading();
    }
    if (failed) {
      wx.showToast({ title: '照片打不开', icon: 'none' });
      return;
    }
    wx.previewImage({
      urls,
      current: current || urls[0],
      complete: () => {
        // 预览关闭后释放 display 的内存缓存；临时文件交给微信自己回收
        for (const id of ids) files.forget(id);
      },
    });
  },

  /** 长按缩略图：保存原图 / 删除 */
  onPhotoLong(e) {
    const pid = e.currentTarget.dataset.pid;
    if (!pid) return;
    wx.showActionSheet({
      itemList: ['保存原图', '删除照片'],
      success: (res) => {
        if (res.tapIndex === 0) this.saveOriginal(pid);
        else if (res.tapIndex === 1) this.confirmDelete(pid);
      },
      fail: () => {}, // 点空白收起：什么都不做
    });
  },

  /** 保存原图：下下来再存相册；权限被拒引导去设置，别让用户对着失败提示猜 */
  async saveOriginal(id) {
    wx.showLoading({ title: '正在取原图…', mask: true });
    let path = null;
    try {
      path = await files.original(id);
    } catch {
      /* files.original 自己兜底返回 null，这里再防一手 */
    } finally {
      wx.hideLoading();
    }
    if (!path) {
      wx.showToast({ title: '原图没下来，检查网络再试', icon: 'none' });
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => wx.showToast({ title: '已存到相册', icon: 'success' }),
      fail: (err) => {
        const msg = err?.errMsg || '';
        if (/cancel/i.test(msg)) return; // 用户自己取消的，不打扰
        if (/auth|deny/i.test(msg)) {
          // 曾经拒绝过相册权限，微信不会再弹窗，只能引导去设置页打开
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

  /** 删除：二次确认后走 store（它会刷新快照；真失败时会全局 toast） */
  confirmDelete(id) {
    wx.showModal({
      title: '删掉这张照片？',
      content: '删了就找不回来了',
      confirmText: '删除',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await actions.deletePhoto(id);
          // 离线时 store 只是把它排进队列并提示「待同步」，快照里照片还在：
          // 这种「假成功」不弹「已删除」，免得用户以为已经删干净
          const stillThere = (getState().data?.photos || []).some((p) => p.id === id);
          if (stillThere) return;
          wx.showToast({ title: '已删除', icon: 'success' });
          this.thumbBusy?.delete(id);
          const paths = { ...(this.data.photoPaths || {}) };
          delete paths[id]; // 顺手清掉页面里这张的路径，别留悬空缓存
          this.setData({ photoPaths: paths });
        } catch {
          /* store 已经弹过错误提示 */
        }
      },
    });
  },

  /** 加照片：选完直接传，nodeId 带上就把照片挂在这张卡下 */
  onAddPhoto(e) {
    if (this.uploading) return; // 上传中拒绝重入：连点会开两次选图、重复上传
    const nodeId = e.currentTarget.dataset.id || '';
    this.pickAndUpload(nodeId);
  },

  /** 右下角「＋」：传照片（不指定就进随手记）/ 加一项 —— 对应 Web 的快捷面板 */
  onQuickAdd() {
    if (this.uploading) return;
    wx.showActionSheet({
      itemList: ['传照片', '加一项'],
      success: (res) => {
        if (res.tapIndex === 0) this.pickAndUpload('');
        else if (res.tapIndex === 1) wx.navigateTo({ url: '/pages/node/index' });
      },
      fail: () => {},
    });
  },

  pickAndUpload(nodeId) {
    this.uploading = true;
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sizeType: ['original', 'compressed'],
      success: async (res) => {
        const picked = res.tempFiles || [];
        if (!picked.length) {
          this.uploading = false;
          return;
        }
        const filesToUpload = picked.map((f) => ({ filePath: f.tempFilePath, name: 'photo' }));
        wx.showLoading({ title: `上传 ${picked.length} 张…`, mask: true });
        try {
          await actions.uploadPhotos({ files: filesToUpload, fields: nodeId ? { nodeId } : {} });
        } catch {
          /* store 已经弹过错误提示；这里只负责别让 loading 卡死 */
        } finally {
          this.uploading = false;
          wx.hideLoading();
        }
      },
      fail: () => {
        // 用户取消选图 / 拒绝相机权限：静默返回，选图取消不该被当成错误
        this.uploading = false;
      },
    });
  },

  /** 记一笔：带上这张卡的 nodeId 进记账页，记完回来 */
  onAddExpense(e) {
    const nodeId = e.currentTarget.dataset.id || '';
    wx.navigateTo({ url: `/pages/expense/index${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}` });
  },

  /** 点账目行：进编辑页（改金额/类别/谁付的/备注，也能删） */
  onEditExpense(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/expense/index?id=${encodeURIComponent(id)}` });
  },

  /** 点卡片（标题行）或编辑按钮：进行程编辑页 */
  onEditNode(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/node/index?id=${encodeURIComponent(id)}` });
  },

  /** 每天末尾「加一项」：带日期进新建页 */
  onAddNode(e) {
    const date = e.currentTarget.dataset.date || '';
    wx.navigateTo({ url: `/pages/node/index${date ? `?date=${encodeURIComponent(date)}` : ''}` });
  },

  /** 打卡：出发 / 完成（走真实接口，和 Web 的 chip 同一套动作） */
  onCheckin(e) {
    const { id, action } = e.currentTarget.dataset;
    if (!id || !action) return;
    actions.checkin(id, action).catch(() => {});
  },

  /** 我的：设置页（行程信息 / 成员 / 词汇 / 导出导入 / 口令） */
  onSettings() {
    wx.navigateTo({ url: '/pages/settings/index' });
  },

  /** 导航：复制地名（见 platform/wx/services.js 的说明） */
  onNav(e) {
    openMap(e.currentTarget.dataset.kw || '');
  },

  /** 勾选待办：走真实写接口 —— 这条路径验证了鉴权、请求、刷新整条链路 */
  onToggle(e) {
    const { node, item, done, text } = e.currentTarget.dataset;
    actions.setChecklistItem(node, item, !Number(done), text).catch(() => {});
  },
});
