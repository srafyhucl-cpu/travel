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

/* ------------------------- 长按拖动排序的手感参数 ------------------------- */

/** 按住多久算「捏起来」。微信原生 longpress 也是 350ms，两条路对齐 */
const DRAG_HOLD_MS = 350;
/** 长按判定前移动超过这个距离：用户想滚列表，不起拖 */
const HOLD_SLOP = 8;
/** 整段手势最远没过这个距离：长按后没想拖，松手取消（不发请求） */
const DRAG_SLOP = 10;
/** 手指离滚动区上下边缘这么近时开始自动滚动（px） */
const EDGE = 120;
/** 自动滚动每拍最多挪多少 px（一拍 40ms，约 350px/s） */
const EDGE_STEP = 14;
const EDGE_TICK_MS = 40;

/** 从触摸列表里挑出指定手指（多指时别被第二根手指把拖动拽跑；没给 identifier 就取第一根） */
function pickTouch(list, identifier) {
  if (!list || !list.length) return null;
  if (identifier == null) return list[0];
  return list.find((x) => x.identifier === identifier) || list[0];
}

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

function toCard(n, vocab, currentId, expRows, moduleId) {
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
    // 拖动排序要求完整的起止时间（服务端同口径：缺时间的不给拖，客户端先拦一道）
    hasTime: n.start_time && n.end_time ? 1 : 0,
    checklist: (n.checklist || []).map((c) => ({ id: c.id, text: c.text, done: c.done ? 1 : 0 })),
    // 被顶栏「前置」收编的那个模块：待办只在 Deck 里出现，卡片上不再重复一份
    hideChecks: moduleId && n.id === moduleId ? 1 : 0,
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
        return { ...toCard(n, data.vocab, clock.currentNode?.id, rows, module?.id), photos: byNode.get(n.id) || [] };
      }),
    };
  });

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
    // 长按拖动排序：dragging 期间锁滚动，卡片跟手位移 + 插入指示线
    dragging: false,
    dragId: '',
    dragY: 0,
    dropDate: '',
    dropBefore: '',
    dropY: -1,
    scrollTop: 0,
    refreshing: false,
  },

  onLoad() {
    // 图标只算一次：data URI 生成要遍历字形，别放进每轮 buildView
    this.setData({
      cameraIcon: iconDataUri('camera', '#6b7280'),
      walletIcon: iconDataUri('wallet', '#6b7280'),
    });
    // scroll-view 的实时位置：拖动落点判定要按它平移（不跟 data，避免每滚一下都 setData）
    this.scrollTop = 0;
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.windowHeight = win.windowHeight || 0;
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  onHide() {
    // 页面被盖住（去编辑页等）：手势已经不在，复位别把拖动状态带回来
    this.cancelHold();
    if (this.dragStarting) this.dragCanceled = true;
    this.abortDrag();
  },

  onUnload() {
    this.unloaded = true;
    this.unsub?.();
    this.cancelHold();
    if (this.dragStarting) this.dragCanceled = true;
    if (this.drag) this.stopAutoScroll(this.drag);
    this.drag = null;
  },

  /** 下拉刷新（scroll-view 的 refresher 走这里）；自动化脚本也会 callMethod 调它 */
  async onPullDownRefresh() {
    // 拖动中即使页面级下拉被误触，也别刷新（列表一重排拖动就散了），只收起刷新状态
    if (this.drag) {
      if (!this.unloaded) this.setData({ refreshing: false });
      wx.stopPullDownRefresh();
      return;
    }
    this.setData({ refreshing: true });
    try {
      await refresh({ quiet: true });
    } finally {
      // 刷新跨过了页面卸载（automator 的 nudgeRefresh 后面常接 reLaunch）：别再 setData
      if (!this.unloaded) this.setData({ refreshing: false });
      wx.stopPullDownRefresh();
    }
  },

  sync() {
    const s = getState();
    // 拖动中来同步：只有快照真的换了（20 秒轮询 / 实时流 / 别处改动）才作废 —— days 会重排；
    // 时钟 tick、toast 这类 emit 不动数据，列表不会动，拖动继续
    if (this.drag && s.data !== this.lastSyncData) this.abortDrag();
    this.lastSyncData = s.data;
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

  /* ---------------------------- 长按拖动排序 ---------------------------- */

  /** 视图里找一张卡（拖动资格要看它有没有完整的起止时间） */
  findNode(id) {
    for (const day of this.data.days || []) {
      for (const n of day.nodes || []) {
        if (n.id === id) return { date: day.date, node: n };
      }
    }
    return null;
  },

  cancelHold() {
    if (this.hold) {
      clearTimeout(this.hold.timer);
      this.hold = null;
    }
  },

  /**
   * 长按起点：记下手指位置与当时的滚动位置，350ms 后进拖动。
   * 微信原生 longpress 同样在 350ms 触发（见 onNodeLongPress），两条路谁先到谁算，
   * beginDrag 自己有重入保护 —— 真机上原生那条更稳，automator 合成的触摸走这条计时器。
   */
  onNodeTouchStart(e) {
    if (this.drag || this.dragStarting) return;
    // 照片自己长按出菜单（catchlongpress），不抢
    if (e.target?.dataset?.pid) return;
    const { id, date } = e.currentTarget.dataset;
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!id || !t) return;
    this.cancelHold();
    this.hold = {
      id,
      date,
      touchId: t.identifier,
      x: t.clientX,
      y: t.clientY,
      scrollTop: this.scrollTop,
      timer: setTimeout(() => {
        const h = this.hold;
        if (!h) return;
        this.hold = null;
        this.beginDrag(h.id, h.date, h.y, h.x, h.scrollTop, h.touchId);
      }, DRAG_HOLD_MS),
    };
  },

  /** 微信原生 longpress：和上面的计时器互为兜底 */
  onNodeLongPress(e) {
    if (this.drag || this.dragStarting) return;
    if (e.target?.dataset?.pid) return;
    const h = this.hold;
    this.cancelHold();
    const { id, date } = e.currentTarget.dataset;
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!id || !t) return;
    this.beginDrag(id, date, t.clientY, t.clientX, h ? h.scrollTop : this.scrollTop, h ? h.touchId : t.identifier);
  },

  /**
   * 进拖动。先量一次所有卡与所有天的位置（viewport 坐标）：拖动期间列表不再动，
   * 之后的位置只是这份快照随 scrollTop 整体平移 —— 落点判定不查 DOM、不卡手。
   */
  beginDrag(id, date, fingerY, fingerX, scrollTop0, touchId) {
    if (this.drag || this.dragStarting) return;
    const found = this.findNode(id);
    if (!found) return;
    if (!found.node.hasTime) {
      wx.showToast({ title: '先给这项填上开始和结束时间再拖动', icon: 'none' });
      return;
    }
    // 手指按住的这 350ms 里页面自己在滚（惯性 / 滑动）：这不是长按，是滚列表
    if (Math.abs(this.scrollTop - (scrollTop0 || 0)) > 24) return;

    this.dragCanceled = false;
    this.dragStarting = true;
    this.createSelectorQuery()
      .selectAll('.node')
      .fields({ rect: true, size: true, dataset: true })
      .selectAll('.day')
      .fields({ rect: true, size: true, dataset: true })
      .select('.scroll')
      .boundingClientRect()
      .select('.scroll-inner')
      .boundingClientRect()
      .exec((res) => {
        this.dragStarting = false;
        // 量位置期间手指已经抬了 / 已经又起了一次拖动：作废
        if (this.dragCanceled || this.drag) {
          this.dragCanceled = false;
          return;
        }
        const [cards, dayRects, scrollRect, innerRect] = res || [];
        const me = (cards || []).find((r) => r && r.dataset && r.dataset.id === id);
        if (!me || !this.findNode(id)) return; // 期间被同步重排换掉了

        // 每天末尾的空位：有卡就取当天最后一张卡的下沿，空天取这天区块的下沿
        const lastBottom = new Map();
        for (const r of cards || []) {
          if (r && r.dataset) lastBottom.set(r.dataset.date, r.bottom);
        }
        const slots = [];
        for (const r of cards || []) {
          if (r && r.dataset) slots.push({ date: r.dataset.date, beforeId: r.dataset.id, y: r.top });
        }
        for (const d of dayRects || []) {
          if (!d || !d.dataset) continue;
          const y = lastBottom.has(d.dataset.date) ? lastBottom.get(d.dataset.date) : d.bottom;
          slots.push({ date: d.dataset.date, beforeId: '', y });
        }

        const scroll = scrollRect || { top: 0, bottom: this.windowHeight, height: this.windowHeight };
        this.drag = {
          id,
          date,
          touchId,
          rect: me,
          slots,
          x0: fingerX || 0,
          y0: fingerY,
          x: fingerX || 0,
          y: fingerY,
          far: 0,
          dy: 0,
          dropY: -1,
          target: null,
          timer: null,
          scrollTop0: this.scrollTop,
          realScrollTop: this.scrollTop, // onScroll 证实过的真实位置（防编程滚动没生效时算漂）
          pending: null, // 上一拍编程滚动等待确认（{ from, miss }）
          maxScroll: Math.max(0, ((innerRect && innerRect.height) || 0) - (scroll.height || this.windowHeight)),
          edgeTop: (scroll.top || 0) + EDGE,
          edgeBottom: (scroll.bottom || this.windowHeight) - EDGE,
        };
        this.setData({ dragging: true, dragId: id, dragY: 0, dropDate: '', dropBefore: '', dropY: -1 });
        wx.vibrateShort({ fail: () => {} });
      });
  },

  /** 拖动中跟手：刷新位移和落点，顺手管边缘自动滚动 */
  onDragMove(e) {
    const h = this.hold;
    if (h) {
      const ht = pickTouch(e.touches, h.touchId) || pickTouch(e.changedTouches, h.touchId);
      if (ht && (Math.abs(ht.clientX - h.x) > HOLD_SLOP || Math.abs(ht.clientY - h.y) > HOLD_SLOP)) {
        this.cancelHold(); // 判定前就动了：这是想滚列表
      }
    }
    const d = this.drag;
    if (!d) return;
    const t = pickTouch(e.touches, d.touchId) || pickTouch(e.changedTouches, d.touchId);
    if (!t) return;
    d.x = t.clientX;
    d.y = t.clientY;
    d.far = Math.max(d.far, Math.abs(d.x - d.x0), Math.abs(d.y - d.y0));
    this.applyDrag();
    this.ensureAutoScroll();
  },

  /** 松手 / 被系统收走：真挪过且有落点就发 move，其余都当没拖 */
  onDragEnd(e) {
    const d = this.drag;
    if (!d) {
      if (this.dragStarting) this.dragCanceled = true; // 量位置时手指抬了
      this.cancelHold();
      return;
    }
    const t = pickTouch(e.changedTouches, d.touchId) || pickTouch(e.touches, d.touchId);
    if (t) {
      d.x = t.clientX;
      d.y = t.clientY;
      d.far = Math.max(d.far, Math.abs(d.x - d.x0), Math.abs(d.y - d.y0));
      this.applyDrag(); // 松手前最后定一次落点，别停在过期的高亮上
    }
    this.finishDrag();
  },

  onDragCancel(e) {
    // touchcancel：系统把手势收走了。落点还在就照样放（和 Web 同一套判断）
    this.onDragEnd(e);
  },

  /** 按当前手指位置刷新两件事：卡片跟手到哪、指示线落在哪条缝 */
  applyDrag() {
    const d = this.drag;
    if (!d) return;
    const scrolled = this.scrollTop - d.scrollTop0;
    const dy = d.y - d.y0 - scrolled; // 页面滚走的量扣掉，卡片才一直粘在手指底下
    const patch = {};
    if (Math.abs(dy - d.dy) >= 0.5) {
      d.dy = dy;
      patch.dragY = dy;
    }

    // 落点：拿被拖卡片的中心找最近的插入空位（不让手指去钻卡缝）
    const centerY = d.rect.top + d.rect.height / 2 + dy;
    let best = null;
    let bestD = Infinity;
    for (const s of d.slots) {
      const yNow = s.y - scrolled;
      const dist = Math.abs(yNow - centerY);
      if (dist < bestD) {
        bestD = dist;
        best = { date: s.date, beforeId: s.beforeId, y: yNow };
      }
    }
    if (best) {
      const cur = d.target;
      if (!cur || cur.date !== best.date || cur.beforeId !== best.beforeId) {
        d.target = best;
        patch.dropDate = best.date;
        patch.dropBefore = best.beforeId || '';
        patch.dropY = best.y;
      } else if (Math.abs(best.y - d.dropY) >= 0.5) {
        patch.dropY = best.y;
      }
      d.dropY = best.y;
    }
    if (patch.dragY !== undefined || patch.dropDate !== undefined || patch.dropY !== undefined) {
      this.setData(patch);
    }
  },

  ensureAutoScroll() {
    const d = this.drag;
    if (!d || d.timer) return;
    d.timer = setInterval(() => this.autoScrollTick(), EDGE_TICK_MS);
  },

  stopAutoScroll(d) {
    const x = d || this.drag;
    if (x && x.timer) {
      clearInterval(x.timer);
      x.timer = null;
    }
  },

  /** 手指悬在上下边缘：定时挪 scrollTop；列表滚了，卡片和落点跟着重算 */
  autoScrollTick() {
    const d = this.drag;
    if (!d) {
      this.stopAutoScroll();
      return;
    }
    // 校验上一拍的编程滚动有没有真的发生：onScroll 报回的位置一直不动，说明这个环境里
    // scroll-y=false 挡住了 scroll-top。回滚乐观值并停掉自动滚动，别让落点跟着算漂
    if (d.pending) {
      if (d.realScrollTop !== d.pending.from) {
        d.pending = null; // 动了，正常
      } else if (++d.pending.miss > 3) {
        this.scrollTop = d.realScrollTop;
        d.pending = null;
        this.stopAutoScroll();
        return;
      }
    }
    let v = 0;
    if (d.y < d.edgeTop) v = -Math.ceil(((d.edgeTop - d.y) / EDGE) * EDGE_STEP);
    else if (d.y > d.edgeBottom) v = Math.ceil(((d.y - d.edgeBottom) / EDGE) * EDGE_STEP);
    const next = Math.min(d.maxScroll, Math.max(0, this.scrollTop + v));
    if (!v || next === this.scrollTop) {
      this.stopAutoScroll(); // 滚到底 / 没在边缘：先停，手指再动时会重新起
      return;
    }
    d.pending = { from: d.realScrollTop, miss: 0 };
    this.scrollTop = next; // 乐观更新：不等 onScroll 回来，免得连发两拍同样的值
    this.setData({ scrollTop: next });
    this.applyDrag();
  },

  finishDrag() {
    const d = this.drag;
    if (!d) return;
    this.stopAutoScroll(d);
    this.drag = null;
    this.setData({ dragging: false, dragId: '', dragY: 0, dropDate: '', dropBefore: '', dropY: -1 });
    if (d.far < DRAG_SLOP) return; // 长按后没真挪过：取消，不发请求
    const t = d.target;
    if (!t) return;
    actions
      .move({ nodeId: d.id, toDate: t.date, beforeNodeId: t.beforeId || null })
      .then((r) => {
        // 放回原位也是一种结果，说清楚比让用户猜「到底放没放进去」强（服务端给了 moved）
        if (r && r.moved === false) wx.showToast({ title: '放回原来的位置了', icon: 'none' });
        else if (r && r.overflow) wx.showToast({ title: `已插进去，这天装不下 ${r.overflow} 项`, icon: 'none' });
      })
      .catch(() => {}); // 真失败时 store 已经全局提示过
  },

  /** 拖动中数据被同步重排（20 秒轮询等）：复位，不提交，顺序等下一轮同步就位 */
  abortDrag() {
    const d = this.drag;
    if (!d) return;
    this.stopAutoScroll(d);
    this.drag = null;
    this.setData({ dragging: false, dragId: '', dragY: 0, dropDate: '', dropBefore: '', dropY: -1 });
  },

  onScroll(e) {
    this.scrollTop = e.detail.scrollTop;
    if (this.drag) this.drag.realScrollTop = e.detail.scrollTop; // 真实位置：自动滚动的校验基准
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

  /** 长按缩略图：保存原图 / 挂到某一项 / 删除 */
  onPhotoLong(e) {
    const pid = e.currentTarget.dataset.pid;
    if (!pid) return;
    const group = e.currentTarget.dataset.group || '';
    wx.showActionSheet({
      itemList: ['保存原图', '挂到某一项', '删除照片'],
      success: (res) => {
        if (res.tapIndex === 0) this.saveOriginal(pid);
        else if (res.tapIndex === 1) this.pickNodeForPhoto(pid, group);
        else if (res.tapIndex === 2) this.confirmDelete(pid);
      },
      fail: () => {}, // 点空白收起：什么都不做
    });
  },

  /** 挂到某一项（或移回随手记）：节点选择页把结果通过事件通道回传 */
  pickNodeForPhoto(pid, group) {
    const current = group.startsWith('n:') ? group.slice(2) : '';
    wx.navigateTo({
      url: `/pages/nodepick/index${current ? `?current=${encodeURIComponent(current)}` : ''}`,
      events: {
        picked: (node) => {
          actions
            .patchPhoto(pid, { nodeId: node?.id || null })
            .then(() => wx.showToast({ title: node ? '已挂到这项' : '已移回随手记', icon: 'success' }))
            .catch(() => {});
        },
      },
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
