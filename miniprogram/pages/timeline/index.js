import { actions, getState, refresh, subscribe } from '../../store/store.js';
import { computeNow, decorate, groupByDate } from '../../core/timeline.js';
import { formatDate, relativeDay, typeMeta, categoryMeta, formatMoney, tintOf } from '../../core/format.js';
import { computeBudget } from '../../core/budget.js';
import { iconDataUri } from '../../platform/wx/icons.js';
import { files } from '../../platform/wx/files.js';
import { openMap } from '../../platform/wx/services.js';
import { url as netUrl, baseUrl } from '../../platform/wx/net.js';
import { session } from '../../platform/wx/session.js';

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
/** 迷你拖拽卡相对手指上抬的高度（px）：卡片小一条，别压在手指底下 */
const DRAG_LIFT = 56;

/** 从触摸列表里挑出指定手指（多指时别被第二根手指把拖动拽跑；没给 identifier 就取第一根） */
function pickTouch(list, identifier) {
  if (!list || !list.length) return null;
  if (identifier == null) return list[0];
  return list.find((x) => x.identifier === identifier) || list[0];
}

/** 严格按 identifier 找（双指逻辑用，找不到就是找不到，不退回第一根） */
function findTouch(list, identifier) {
  if (!list || !list.length) return null;
  if (identifier == null) return list[0];
  return list.find((x) => x.identifier === identifier) || null;
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
      // 下一项没定时间时别写成「·  开始」：明说是待定
      sub: `${day} · ${clock.nextNode.start_time ? `${clock.nextNode.start_time} 开始` : '时间待定'}`,
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

function toCard(n, vocab, currentId, expRows, hasPrev) {
  const meta = typeMeta(vocab, n.type);
  const spent = expRows.reduce((s, e) => s + (Number(e.rawAmount) || 0), 0);
  return {
    id: n.id,
    title: n.title,
    time: n.start_time || '待定',
    tbd: n.start_time ? 0 : 1, // 没定时间：时间格给「待定」，不给一个像缺字的「—」
    range: n.end_time && n.start_time ? `${n.start_time}–${n.end_time}` : '',
    typeLabel: meta.label,
    typeColor: meta.color,
    typeSoft: meta.soft,
    icon: iconDataUri(meta.icon, meta.color),
    location: n.location || '',
    navKeyword: n.nav_keyword || '',
    lat: Number.isFinite(n.lat) ? n.lat : null,
    lng: Number.isFinite(n.lng) ? n.lng : null,
    done: n.isDone ? 1 : 0,
    started: n.isStarted && !n.isDone ? 1 : 0,
    doneAt: n.isDone ? hhmm(n.actual_end) : '',
    current: n.id === currentId ? 1 : 0,
    driveMinutes: hasPrev && !n.isDone && Number(n.transport_minutes) > 0 ? Number(n.transport_minutes) : 0,
    // 拖动排序要求完整的起止时间（服务端同口径：缺时间的不给拖，客户端先拦一道）
    hasTime: n.start_time && n.end_time ? 1 : 0,
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
  /*
   * 「前置准备」（role=module）不是行程里的一项：它没有起止时间，塞进按天的
   * 时间线只能给它一格「—」。这里把它整个从行程里摘出来，单独交给下面那张
   * 「出行准备」清单卡；只装了它的那天也不在时间线上留一个空壳日期。
   */
  const allNodes = data.nodes || [];
  const moduleNode = allNodes.find((n) => n.role === 'module') || null;
  const itinerary = moduleNode ? allNodes.filter((n) => n.role !== 'module') : allNodes;
  const clock = computeNow({ trip: data.trip, nodes: itinerary, checkins: data.checkins }, s.now);
  const decorated = decorate(itinerary, data.checkins);
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

  const allByDate = moduleNode ? groupByDate(allNodes) : byDate;
  const days = [];
  for (const d of clock.allDates) {
    const list = byDate.get(d) || [];
    // 这天只是准备卡的落脚处：整格端走，别在时间线上挂一个空壳日期
    if (!list.length && (allByDate.get(d) || []).length) continue;
    days.push({
      date: d,
      label: formatDate(d),
      rel: relativeDay(d, s.now),
      isToday: d === clock.today,
      done: list.filter((n) => n.isDone).length,
      total: list.length,
      nodes: list.map((n, i) => {
        const rows = (expByNode.get(n.id) || []).map((e) => ({ ...toExpRow(e, data.vocab), rawAmount: e.amount }));
        return { ...toCard(n, data.vocab, clock.currentNode?.id, rows, i > 0), photos: byNode.get(n.id) || [] };
      }),
    });
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

  /* 总结卡：状态 + 日期范围 + 总进度 + 三格统计（数据全部来自上面这份 days / budget / photos） */
  const doneAll = days.reduce((sum, d) => sum + d.done, 0);
  const totalAll = days.reduce((sum, d) => sum + d.total, 0);
  const trip = data.trip || {};
  const summary = {
    status: clock.phase === 'upcoming' ? '还没出发' : clock.phase === 'finished' ? '已结束' : `第 ${clock.dayNumber}/${clock.totalDays} 天`,
    tone: clock.phase === 'finished' ? 'done' : clock.phase === 'upcoming' ? 'upcoming' : 'active',
    range: trip.start_date && trip.end_date ? `${formatDate(trip.start_date, { short: true })} – ${formatDate(trip.end_date, { short: true })}` : '',
    done: doneAll,
    total: totalAll,
    pct: totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : 0,
    photos: (data.photos || []).length,
  };

  /*
   * 出行准备：一趟只带一条（服务端只留一个 role=module），没清单就不占位。
   * 它不是某一项行程，进度也算它自己的，不混进上面那条行程进度条。
   */
  const prepItems = moduleNode?.checklist || [];
  const prepDone = prepItems.filter((c) => c.done).length;
  const prep = prepItems.length
    ? {
        id: moduleNode.id,
        title: (moduleNode.title || '').trim() || '出行准备',
        icon: iconDataUri('pack', '#2F80ED'),
        items: prepItems.map((c) => ({ id: c.id, text: c.text, done: c.done ? 1 : 0 })),
        done: prepDone,
        total: prepItems.length,
        left: prepItems.length - prepDone,
        pct: Math.round((prepDone / prepItems.length) * 100),
        allDone: prepDone === prepItems.length ? 1 : 0,
      }
    : null;

  return {
    view: {
      tripName: trip.name || '旅行助手',
      now: nowCard(clock),
      summary,
      prep,
      days,
      loose,
      looseExp,
      budget,
      online: s.online,
      syncing: s.syncing,
    },
    groups,
  };
}

/**
 * 自定义导航栏尺寸（px）：
 *   状态栏高度 = windowInfo.statusBarHeight；
 *   导航栏高度 = 胶囊高度 + 上下留白 × 2（留白 = 胶囊顶 - 状态栏底，跟原生居中对齐）；
 *   标题最大宽度 = 中线到「我的」按钮 / 微信胶囊中更近的那一侧 × 2，保证不被盖。
 */
function readNav() {
  let win = {};
  try {
    win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  } catch {
    win = {};
  }
  const windowWidth = win.windowWidth || 375;
  const statusBarHeight = win.statusBarHeight || 20;
  let menu = null;
  try {
    menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
  } catch {
    menu = null;
  }
  if (!menu || !menu.height || !menu.width) {
    // 老基础库兜底：按常见胶囊尺寸假一个
    menu = { top: statusBarHeight + 4, height: 32, width: 87, left: windowWidth - 94, right: windowWidth - 7 };
  }
  const gap = Math.max(menu.top - statusBarHeight, 4);
  const navBarHeight = Math.round(menu.height + gap * 2);
  // 标题居中；两侧分别给「我的」按钮和微信胶囊让位，谁离中线更近听谁的（窄屏也不被盖）
  const half = Math.max(40, Math.min(windowWidth / 2 - 56, menu.left - windowWidth / 2 - 10));
  return {
    statusBarHeight,
    navBarHeight,
    navTotal: statusBarHeight + navBarHeight,
    navTitleMax: Math.round(half * 2),
  };
}

/** 标题按长度自适应字号（px）：>14 字 14px、>10 字 15px，其余 17px；再长由省略号收尾 */
function titleFontPx(name) {
  const len = Array.from(String(name || '')).length;
  if (len > 14) return 14;
  if (len > 10) return 15;
  return 17;
}

/**
 * 照片直连地址：net.url 会自带 token（previewImage 没法带请求头，只能把令牌挂 query）。
 * 兜底：个别版本 net.url 引用了未定义变量会直接抛 —— 这时用 baseUrl + 会话令牌自己拼。
 */
function photoUrl(id) {
  const path = `/api/photos/${encodeURIComponent(id)}/file?variant=display`;
  try {
    return netUrl(path);
  } catch {
    const token = session.getToken();
    const full = `${baseUrl()}${path}`;
    return token ? `${full}&token=${encodeURIComponent(token)}` : full;
  }
}

Page({
  data: {
    ready: false,
    // 自定义导航栏尺寸（onLoad 按状态栏 + 胶囊实测）
    nav: { statusBarHeight: 20, navBarHeight: 44, navTotal: 64, navTitleMax: 200 },
    navTitleSize: 17,
    tripName: '旅行助手',
    now: {},
    summary: { status: '', tone: 'active', range: '', done: 0, total: 0, pct: 0, photos: 0 },
    prep: null, // 出行准备（role=module）的清单卡视图；没清单就是 null
    prepOpen: false, // 默认收起，只露一条进度；勾完最后一条会自动收回去
    days: [],
    loose: [],
    looseExp: [],
    budget: {},
    seg: '', // 总结卡展开的那一格：'' | 'money'
    online: true,
    syncing: true,
    photoPaths: {}, // photoId -> 本地路径；出现一张补一张，不阻塞列表渲染
    cameraIcon: '',
    walletIcon: '',
    carIcon: '',
    // 长按拖动排序 v2：迷你卡跟手 + 虚线占位 + 双指滚动 + 松手确认面板
    dragging: false,
    dragId: '',
    dragCardTop: -999,
    dragView: {},
    dropDate: '',
    dropBefore: '',
    dropY: -1,
    dropSheet: null, // { dayLabel, rows: [{id,icon,time,title,on,timeMoved}], note, busy }
    scrollTop: 0,
    refreshing: false,
  },

  onLoad(query) {
    // 图标只算一次：data URI 生成要遍历字形，别放进每轮 buildView
    this.setData({
      cameraIcon: iconDataUri('camera', '#6b7280'),
      walletIcon: iconDataUri('wallet', '#6b7280'),
      carIcon: iconDataUri('car', '#9ca3af', 26),
      nav: readNav(),
    });
    // 微信AI 接力：?date=YYYY-MM-DD 时，数据就绪后滚到当天第一张卡（见 flushScrollTo）
    if (query && typeof query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
      this.pendingDate = query.date;
    }
    // scroll-view 的实时位置：拖动落点判定要按它平移（不跟 data，避免每滚一下都 setData）
    this.scrollTop = 0;
    this.syncPending = false; // 拖动期间收到 store 刷新，结束后补一次
    this.lastViewData = undefined;
    this.lastViewClock = null;
    this.hidden = false;
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.windowHeight = win.windowHeight || 0;
    this.unsub = subscribe(() => this.sync());
    this.sync();
  },

  /** ⑦ 编辑页新建成功后写下的 travel.scrollTo：读走即清，数据就绪后滚到那张新卡 */
  onShow() {
    this.hidden = false;
    let jump = '';
    try {
      jump = wx.getStorageSync('travel.scrollTo') || '';
    } catch {
      jump = '';
    }
    if (jump) {
      try {
        wx.removeStorageSync('travel.scrollTo');
      } catch {
        /* 清不掉也不拦着这次滚动 */
      }
      this.pendingScrollTo = jump;
    }
    this.flushPendingSync();
    if (this.data.ready) this.flushScrollTo();
  },

  onHide() {
    this.hidden = true;
    // 页面被盖住（去编辑页等）：手势已经不在，复位别把拖动 / 确认面板带回来
    this.cancelHold();
    if (this.dragStarting) this.dragCanceled = true;
    this.abortDrag();
  },

  onUnload() {
    this.unloaded = true;
    this.syncPending = false;
    this.unsub?.();
    this.cancelHold();
    if (this.dragStarting) this.dragCanceled = true;
    if (this.drag) this.stopAutoScroll(this.drag);
    this.drag = null;
    this.pendingDrop = null;
  },

  /** 下拉刷新（scroll-view 的 refresher 走这里）；自动化脚本也会 callMethod 调它 */
  async onPullDownRefresh() {
    // 拖动时列表不能重画，但数据还是可以后台拉：sync 会记住待补的一版，松手后再落地
    const locked = !!(this.drag || this.dragStarting || this.data.dropSheet);
    if (!locked && !this.unloaded) this.setData({ refreshing: true });
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
    // 量卡/拖动期间不重画列表：数据先记一笔，手势收尾后再补 sync。
    if (this.drag || this.dragStarting) {
      this.syncPending = true;
      return;
    }
    this.syncPending = false;
    if (s.phase === 'login') {
      wx.redirectTo({ url: '/pages/login/index' });
      return;
    }
    if (!s.data) {
      this.lastViewData = undefined;
      this.lastViewClock = null;
      this.setData({ ready: false, syncing: true });
      return;
    }
    const clock = Math.floor(s.now.getTime() / 30000);
    if (this.lastViewData === s.data && this.lastViewClock === clock && this.data.ready) {
      this.patchStatus(s);
      return;
    }
    const { view, groups } = buildView(s);
    this.groups = groups;
    this.lastViewData = s.data;
    this.lastViewClock = clock;
    const patch = { ready: true, ...view };
    if (view.tripName !== this.lastTripName) {
      this.lastTripName = view.tripName;
      patch.navTitleSize = titleFontPx(view.tripName);
    }
    // 准备清单刚勾完最后一条：顺手把面板收回去（跟 Web Deck 同一个手感）
    const prepLeft = view.prep ? view.prep.left : null;
    if (prepLeft === 0 && this.prepLeft > 0) patch.prepOpen = false;
    this.prepLeft = prepLeft;
    // 视图落地后再补缩略图：新照片每轮同步都会重新排进来
    this.setData(patch, () => {
      this.fillThumbs();
      this.flushScrollTo();
    });
  },

  /** 数据没变时只更新顶栏两个小状态，别为一次 toast/时钟 emit 重建整页。 */
  patchStatus(s) {
    const patch = {};
    if (this.data.online !== s.online) patch.online = s.online;
    if (this.data.syncing !== s.syncing) patch.syncing = s.syncing;
    if (Object.keys(patch).length) this.setData(patch);
  },

  /** 拖动期间被推迟的那次视图同步，等手势收尾后再落。 */
  flushPendingSync() {
    if (this.unloaded || this.hidden || !this.syncPending) return;
    this.syncPending = false;
    this.sync();
  },

  /* ------------------------- ⑦ 新建后滚到新卡 ------------------------- */

  flushScrollTo() {
    // AI 接力按日期来：先换算成当天第一张卡，走下面同一套滚动
    if (!this.pendingScrollTo && this.pendingDate) {
      const date = this.pendingDate;
      this.pendingDate = '';
      const day = (this.data.days || []).find((d) => d.date === date);
      this.pendingScrollTo = (day && day.nodes && day.nodes[0] && day.nodes[0].id) || '';
    }
    const id = this.pendingScrollTo;
    if (!id || !this.data.ready || this.drag || this.data.dropSheet) return;
    this.pendingScrollTo = '';
    const q = this.createSelectorQuery();
    q.selectAll('.node').fields({ rect: true, dataset: true });
    q.select('.scroll').boundingClientRect();
    q.select('.scroll').scrollOffset();
    q.exec((res) => {
      if (this.unloaded) return;
      const [cards, scrollRect, scrollInfo] = res || [];
      if (!scrollRect || !scrollInfo) return; // 拿不到位置就当没这回事
      const me = (cards || []).find((r) => r && r.dataset && r.dataset.id === id);
      if (!me) return; // 找不到就忽略
      const target = Math.max(0, scrollInfo.scrollTop + (me.top - scrollRect.top) - 90);
      this.scrollTop = target;
      // scroll-top 绑定的旧值恰好等于目标时，属性没变化不会触发滚动：先挪 1px 再落回来
      if (target === this.data.scrollTop) {
        this.setData({ scrollTop: target > 0 ? target - 1 : 1 }, () => this.setData({ scrollTop: target }));
        return;
      }
      this.setData({ scrollTop: target });
    });
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
    if (this.drag || this.dragStarting || this.data.dropSheet) return; // 确认面板期间再长按其它卡片无效
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
    if (this.drag || this.dragStarting || this.data.dropSheet) return;
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
   * v2：原卡不再放大跟手，改为一条迷你卡 fixed 跟手指；原位留虚线占位。
   */
  beginDrag(id, date, fingerY, fingerX, scrollTop0, touchId) {
    if (this.drag || this.dragStarting || this.data.dropSheet) return;
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
          this.flushPendingSync();
          return;
        }
        const [cards, dayRects, scrollRect, innerRect] = res || [];
        const me = (cards || []).find((r) => r && r.dataset && r.dataset.id === id);
        const foundNow = this.findNode(id);
        if (!me || !foundNow) {
          this.flushPendingSync(); // 期间被同步重排换掉了
          return;
        }

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

        // 原位标记：拖到自己现处的位置（自己的槽位 / 下一张之前）都算没动
        const dayNodes = (this.data.days.find((x) => x.date === foundNow.date) || {}).nodes || [];
        const selfIndex = dayNodes.findIndex((x) => x.id === id);
        const origNext = selfIndex >= 0 ? dayNodes[selfIndex + 1]?.id || '' : '';

        const scroll = scrollRect || { top: 0, bottom: this.windowHeight, height: this.windowHeight };
        const cardView = { icon: foundNow.node.icon, time: foundNow.node.time, title: foundNow.node.title, color: foundNow.node.typeColor };
        this.drag = {
          id,
          date: foundNow.date,
          touchId,
          rect: me,
          slots,
          view: cardView,
          origNext,
          x0: fingerX || 0,
          y0: fingerY,
          x: fingerX || 0,
          y: fingerY,
          far: 0,
          cardTop: Math.max(56, fingerY - DRAG_LIFT),
          dropY: -1,
          target: null,
          timer: null,
          panId: null, // 第二根手指（双指滚动）的 identifier
          panY0: 0,
          panScroll0: 0,
          scrollTop0: this.scrollTop,
          realScrollTop: this.scrollTop, // onScroll 证实过的真实位置（防编程滚动没生效时算漂）
          pending: null, // 上一拍编程滚动等待确认（{ from, miss }）
          maxScroll: Math.max(0, ((innerRect && innerRect.height) || 0) - (scroll.height || this.windowHeight)),
          edgeTop: (scroll.top || 0) + EDGE,
          edgeBottom: (scroll.bottom || this.windowHeight) - EDGE,
        };
        this.setData({
          dragging: true,
          dragId: id,
          dragCardTop: Math.max(56, fingerY - DRAG_LIFT),
          dragView: cardView,
          dropDate: '',
          dropBefore: '',
          dropY: -1,
        });
        wx.vibrateShort({ fail: () => {} });
      });
  },

  /** 拖动中跟手 + 双指滚动。第二根手指只按 identifier 跟踪，纵向位移 1:1 驱动 scrollTop */
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
    const touches = e.touches || [];

    // ⑤ 双指：拖动手指还在、又有第二根手指 → 停掉边缘自动滚动，改由它的位移驱动列表（无惯性）
    const dragT = findTouch(touches, d.touchId);
    const other = dragT ? touches.find((t) => t.identifier !== d.touchId) : null;
    if (other && d.panId == null) {
      d.panId = other.identifier;
      d.panY0 = other.clientY;
      d.panScroll0 = this.scrollTop;
      this.stopAutoScroll(d);
    } else if (d.panId != null && !findTouch(touches, d.panId)) {
      d.panId = null; // 第二根手指抬起：回到单指边缘自动滚动
    }
    if (d.panId != null) {
      const pt = findTouch(touches, d.panId);
      if (pt) {
        const next = Math.min(d.maxScroll, Math.max(0, d.panScroll0 + (pt.clientY - d.panY0)));
        if (next !== this.scrollTop) {
          this.scrollTop = next;
          d.realScrollTop = next; // 这是我们自己驱动的滚动，直接认作真实位置
          this.setData({ scrollTop: next });
        }
      }
    }

    const t = findTouch(touches, d.touchId) || findTouch(e.changedTouches, d.touchId);
    if (t) {
      d.x = t.clientX;
      d.y = t.clientY;
      d.far = Math.max(d.far, Math.abs(d.x - d.x0), Math.abs(d.y - d.y0));
    }
    this.applyDrag(); // 滚动变了也重算：迷你卡落点/指示线随内容实时走
    if (d.panId == null) this.ensureAutoScroll();
  },

  /** 松手 / 被系统收走：算出目标位置；没动或落回原位就复位，其余弹确认面板 */
  onDragEnd(e) {
    const d = this.drag;
    if (!d) {
      if (this.dragStarting) this.dragCanceled = true; // 量位置时手指抬了
      this.cancelHold();
      return;
    }
    const t = findTouch(e.changedTouches, d.touchId) || findTouch(e.touches, d.touchId);
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

  /**
   * 按当前手指位置刷新三件事：迷你卡跟手到哪、落点落在哪条缝、指示线画在哪。
   * v2 的坐标口径：迷你卡是 fixed 的，中心 = 起始矩形中心 + 手指位移（不随列表内容漂）；
   * 各插入空位还按内容坐标记着，减去 scrollTop 得到「此刻的视口位置」再比距离 ——
   * 所以双指滚动时，落点会随着列表在手指底下滑过而实时变化。
   */
  applyDrag() {
    const d = this.drag;
    if (!d) return;
    const scrolled = this.scrollTop - d.scrollTop0;
    const patch = {};

    const cardTop = Math.max(56, d.y - DRAG_LIFT);
    if (Math.abs(cardTop - d.cardTop) >= 0.5) {
      d.cardTop = cardTop;
      patch.dragCardTop = cardTop;
    }

    const centerY = d.rect.top + d.rect.height / 2 + (d.y - d.y0);
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
    if (patch.dragCardTop !== undefined || patch.dropDate !== undefined || patch.dropY !== undefined) {
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

  /** 单指悬在上下边缘：定时挪 scrollTop；列表滚了，迷你卡落点跟着重算 */
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
    const t = d.target;
    // 落回原位（自己那格 / 原来下一张之前）与没真挪过一样：直接复位，不弹面板、不发请求
    const samePlace = !t || (t.date === d.date && (t.beforeId === d.id || t.beforeId === d.origNext));
    if (d.far < DRAG_SLOP || samePlace) {
      this.resetDragUI();
      return;
    }
    this.openDropSheet(d, t);
  },

  /** ⑥ 落点确认面板：先用本地数据排一版目标天的新顺序，再拿 previewMove 的试算结果刷新 */
  openDropSheet(d, target) {
    const day = (this.data.days || []).find((x) => x.date === target.date);
    const rows = this.buildLocalRows(d, target, day);
    this.pendingDrop = { nodeId: d.id, toDate: target.date, beforeNodeId: target.beforeId || null };
    // 面板开着期间保持拖动锁定（scroll-y=false）：dragging 先别复位，只收起迷你卡和指示线
    this.setData({
      dragId: '',
      dragCardTop: -999,
      dragView: {},
      dropDate: '',
      dropBefore: '',
      dropY: -1,
      dropSheet: { dayLabel: day?.label || target.date, rows, note: '', busy: false },
    });
    actions
      .previewMove({ ...this.pendingDrop })
      .then((r) => this.applyPreview(r))
      .catch((err) => {
        // 离线等：保留本地顺序，提示确认后会按新规则顺延时间
        if (!this.pendingDrop || !this.data.dropSheet) return;
        const offline = !err || err.status === 0;
        this.setData({ 'dropSheet.note': offline ? '离线：确认后按新规则顺延时间' : '预览没算出来：确认后按新规则顺延时间' });
      });
  },

  /** 本地版目标天顺序：拖走的那张从原列表摘掉，再插到落点前（落点为空则排最后） */
  buildLocalRows(d, target, day) {
    const rows = ((day && day.nodes) || [])
      .filter((n) => n.id !== d.id)
      .map((n) => ({ id: n.id, icon: n.icon, time: n.time, title: n.title, on: 0, timeMoved: 0 }));
    let at = rows.length;
    if (target.beforeId) {
      const i = rows.findIndex((r) => r.id === target.beforeId);
      if (i >= 0) at = i;
    }
    rows.splice(at, 0, { id: d.id, icon: d.view.icon, time: d.view.time, title: d.view.title, on: 1, timeMoved: 0 });
    return rows;
  },

  /** 试算回来：用服务端排出的顺序与时间刷新面板；time_changed 的项标「时间调整」 */
  applyPreview(r) {
    const drop = this.pendingDrop;
    if (!drop || !this.data.dropSheet) return;
    if (r && r.moved === false) {
      // 服务端也认为没动：直接复位，不提交
      this.pendingDrop = null;
      this.resetDragUI();
      return;
    }
    const rows = (r?.day?.nodes || []).map((n) => {
      const local = this.findNode(n.id)?.node || null;
      return {
        id: n.id,
        icon: local?.icon || '',
        time: n.start_time || '待定',
        title: n.title || local?.title || '',
        on: n.id === drop.nodeId ? 1 : 0,
        timeMoved: n.time_changed ? 1 : 0,
      };
    });
    if (!rows.length) return; // 响应里没列表就不动本地那份
    this.setData({
      'dropSheet.rows': rows,
      'dropSheet.note': r?.overflow > 0 ? `这天会装不下 ${r.overflow} 项，时间会顺延得比较晚` : '',
    });
  },

  onDropConfirm() {
    const drop = this.pendingDrop;
    const sheet = this.data.dropSheet;
    if (!drop || !sheet || sheet.busy) return;
    this.setData({ 'dropSheet.busy': true });
    actions
      .move(drop)
      .then((r) => {
        this.pendingDrop = null;
        this.resetDragUI();
        if (r && r.overflow) wx.showToast({ title: `已插进去，这天装不下 ${r.overflow} 项`, icon: 'none' });
        else if (r && r.moved === false) wx.showToast({ title: '放回原来的位置了', icon: 'none' });
      })
      .catch(() => {
        // store 已经全局提示过；面板留着让用户重试或取消
        if (!this.unloaded && this.data.dropSheet) this.setData({ 'dropSheet.busy': false });
      });
  },

  onDropCancel() {
    // 取消：不发请求，直接复位
    this.pendingDrop = null;
    this.resetDragUI();
  },

  resetDragUI() {
    if (this.unloaded) return; // 卸载后的回调不许再碰视图
    this.setData({
      dragging: false,
      dragId: '',
      dragCardTop: -999,
      dragView: {},
      dropDate: '',
      dropBefore: '',
      dropY: -1,
      dropSheet: null,
    }, () => {
      this.flushPendingSync();
    });
  },

  /** 页面被盖住 / 卸载前：停手势并复位，不提交；下一页回到前台再补同步。 */
  abortDrag() {
    const d = this.drag;
    if (d) this.stopAutoScroll(d);
    this.drag = null;
    this.pendingDrop = null;
    this.resetDragUI();
  },

  noop() {},

  onScroll(e) {
    this.scrollTop = e.detail.scrollTop;
    if (this.drag) this.drag.realScrollTop = e.detail.scrollTop; // 真实位置：自动滚动的校验基准
  },

  /** 总结卡那两格：点一下展开/收起（一次只开一格） */
  onSeg(e) {
    const seg = e.currentTarget.dataset.seg;
    if (!seg) return;
    this.setData({ seg: this.data.seg === seg ? '' : seg });
  },

  /** 出行准备卡：整头像一行展开/收起，清单里每条仍走同一个勾选动作 */
  onPrepToggle() {
    if (!this.data.prep) return;
    this.setData({ prepOpen: !this.data.prepOpen });
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
          if (path && !this.unloaded && !this.data.photoPaths?.[id]) this.setData({ [`photoPaths.${id}`]: path });
        })
        .catch(() => {}) // 拉不到就保持占位底色，下一轮 sync 再试
        .then(done, done);
    };
    for (let k = 0; k < THUMB_CONCURRENCY; k++) next();
  },

  /**
   * ⑧ 点开一张：直连 display 地址交给微信原生预览（自带加载与缓存），不再预下载整组。
   * 组顺序仍按 this.groups；token 见 net.url。
   */
  onPhoto(e) {
    const { group, pid } = e.currentTarget.dataset;
    if (!pid) return;
    const ids = (this.groups || {})[group] || [pid];
    const list = ids.includes(pid) ? ids : [...ids, pid];
    wx.previewImage({
      urls: list.map(photoUrl),
      current: photoUrl(pid),
      fail: () => wx.showToast({ title: '照片打不开', icon: 'none' }),
    });
  },

  /** 长按缩略图：保存原图 / 编辑备注 / 挂到某一项 / 删除 */
  onPhotoLong(e) {
    const { pid, group = '' } = e.currentTarget.dataset;
    if (!pid) return;
    // 备注从快照里取，不往 WXML 塞 data-caption：长列表上少一份绑定
    const photo = (getState().data?.photos || []).find((p) => p.id === pid);
    const caption = photo?.caption || '';
    wx.showActionSheet({
      itemList: ['保存原图', '编辑备注', '挂到某一项', '删除照片'],
      success: (res) => {
        if (res.tapIndex === 0) this.saveOriginal(pid);
        else if (res.tapIndex === 1) this.editCaption(pid, caption);
        else if (res.tapIndex === 2) this.pickNodeForPhoto(pid, group);
        else if (res.tapIndex === 3) this.confirmDelete(pid);
      },
      fail: () => {}, // 点空白收起：什么都不做
    });
  },

  /** 编辑照片备注：与 Web 查看器共用 patchPhoto；清空即删除备注。 */
  editCaption(pid, current = '') {
    wx.showModal({
      title: '照片备注',
      content: current || '',
      editable: true,
      placeholderText: '给这张照片写句话',
      confirmText: '保存',
      success: (r) => {
        if (!r.confirm) return;
        const next = String(r.content || '').trim().slice(0, 200);
        if (next === String(current || '').trim()) return;
        actions
          .patchPhoto(pid, { caption: next })
          .then(() => wx.showToast({ title: next ? '备注已保存' : '备注已清除', icon: 'success' }))
          .catch(() => {});
      },
      fail: () => {},
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
    if (this.unloaded) return; // 下载跨过了页面卸载：别再出后续提示
    if (!path) {
      wx.showToast({ title: '原图没下来，检查网络再试', icon: 'none' });
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => {
        if (!this.unloaded) wx.showToast({ title: '已存到相册', icon: 'success' });
      },
      fail: (err) => {
        if (this.unloaded) return;
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
          if (this.unloaded) return; // 确认弹框开着时页面可能已经卸载
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

  /** 改预算：预算页（设置总预算） */
  onEditBudget() {
    wx.navigateTo({ url: '/pages/budget/index' });
  },

  /** 导航：有坐标直接开地图；没坐标按地名解析，失败回退复制（见 platform/wx/services.js） */
  onNav(e) {
    const d = e.currentTarget.dataset;
    openMap(d.kw || '', { lat: d.lat, lng: d.lng });
  },

  /** 勾选待办：走真实写接口 —— 这条路径验证了鉴权、请求、刷新整条链路 */
  onToggle(e) {
    const { node, item, done, text } = e.currentTarget.dataset;
    actions.setChecklistItem(node, item, !Number(done), text).catch(() => {});
  },
});
