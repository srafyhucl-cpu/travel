/**
 * 应用状态容器。不依赖 React，也只依赖 platform 的接口 ——
 * 换成小程序时，这个文件和 core/ 原样复用。
 *
 * 策略：先从本地快照立刻渲染（秒开、断网可用），再从服务器拉最新覆盖。
 */
import { api, flushQueue, onAuthFailure } from './api.js';
import { platform } from '../platform/index.js';
import { normalizeSnapshot } from '../core/checklist.js';
import { computeAchievements } from '../core/achievements.js';

const listeners = new Set();

const initial = {
  phase: 'boot', // boot | login | ready
  data: null, // 行程快照
  now: new Date(),
  online: platform.device.isOnline(),
  live: false, // 实时流是否连着
  syncing: false,
  pending: 0,
  error: null,
  toast: null,
  confirm: null, // 确认弹窗（各端自己画；小程序没有阻塞式 confirm）
  user: null, // { id, nickname, avatarUrl, isProfileSet } | null
  trips: [], // TripSummary[] 用户参与的所有时间线列表
  activeTripId: '', // 当前激活的 trip_id
  switchingTrip: false, // 是否正在拉取新切换行程的远端快照
  pendingInviteCode: '', // 从小程序分享卡片带入的待处理邀请码/只读码
};

let state = { ...initial };
let tickTimer = null;
let stream = null;
let reconnectTimer = null;
let lastSnapshotFingerprint = null;

function emit() {
  for (const l of listeners) l();
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(patch) {
  state = { ...state, ...patch };
  emit();
}

export function toast(message, kind = 'info') {
  set({ toast: { message, kind, at: Date.now() } });
  setTimeout(() => {
    if (state.toast?.message === message) set({ toast: null });
  }, 2600);
}

/*
 * 确认弹窗。替掉 window.confirm —— 系统弹窗跟 App 两套长相，小程序里也没有
 * 阻塞式 confirm。状态放这里（纯逻辑），长什么样由各端 ui 自己画。
 * 返回 Promise<boolean>，调用处 `if (await askConfirm(...))` 即可。
 */
export function askConfirm(message, { danger = false, confirmText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    // 上一个还没关就被新的顶掉：旧的按「取消」收场，别把 Promise 悬着
    state.confirm?.resolve?.(false);
    set({ confirm: { message, danger, confirmText, cancelText, resolve } });
  });
}

export function resolveConfirm(ok) {
  const c = state.confirm;
  if (!c) return;
  set({ confirm: null });
  c.resolve(ok);
}

let _switchSeq = 0;

function guardEditable() {
  const myRole =
    state.data?.myRole ||
    state.data?.trip?.role ||
    state.data?.me?.role ||
    state.trips?.find((t) => t.id === state.activeTripId)?.role;
  if (myRole === 'viewer') {
    toast('当前为只读预览模式，无法修改', 'warn');
    return false;
  }
  return true;
}

function stopStream() {
  if (stream && typeof stream.close === 'function') {
    stream.close();
  }
  stream = null;
  clearTimeout(reconnectTimer);
}

function startStreamForTrip(tripId) {
  stopStream();
  if (!tripId || !platform.session.getToken()) return;
  try {
    stream = platform.net.openStream({
      path: '/api/trip/stream',
      onOpen: () => set({ live: true }),
      onMessage: (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'hello') return;
        } catch {}
        if (state.activeTripId === tripId) {
          debouncedRefresh();
        }
      },
      onError: () => {
        set({ live: false });
        stopStream();
        reconnectTimer = setTimeout(() => {
          if (state.activeTripId === tripId) startStreamForTrip(tripId);
        }, 4000);
      },
    });
  } catch {
    set({ live: false });
  }
}

export async function switchTrip(targetTripId) {
  if (!targetTripId) return;
  const seq = ++_switchSeq;
  stopStream();
  platform.session.setTripId(targetTripId);

  // 先尝试用本地分桶快照立即替换视图（支持离线秒切）
  const cached = (await platform.storage.loadSnapshot(targetTripId).catch(() => null)) || null;
  set({
    activeTripId: targetTripId,
    switchingTrip: true,
    ...(cached ? { data: normalizeSnapshot(cached), phase: 'ready' } : {}),
  });

  try {
    const snap = normalizeSnapshot(await api.snapshot());
    if (seq !== _switchSeq) return; // 竞态丢弃：用户已在期间切往其他行程
    lastSnapshotFingerprint = snapshotFingerprint(snap);
    await platform.storage.saveSnapshot(targetTripId, snap).catch(() => {});
    set({
      data: snap,
      phase: 'ready',
      switchingTrip: false,
      error: null,
    });
    startStreamForTrip(targetTripId);
    flushQueue().catch(() => {});
  } catch (err) {
    if (seq !== _switchSeq) return;
    set({ switchingTrip: false });
    // 若该行程已被删除或无权限 (403/404)，自动自愈切换到剩余可用行程
    if (err?.status === 403 || err?.status === 404) {
      await platform.storage.dropSnapshot(targetTripId).catch(() => {});
      const listRes = await api.listTrips().catch(() => null);
      if (listRes?.trips?.length > 0) {
        const fallbackId = listRes.trips[0].id;
        set({
          trips: listRes.trips,
        });
        toast('原行程已不可用，已自动切换', 'info');
        if (fallbackId !== targetTripId) await switchTrip(fallbackId);
      }
    } else if (!cached && state.phase !== 'ready') {
      set({ phase: 'login' });
    }
  }
}

/* ------------------------------ 启动 ------------------------------ */

export async function boot() {
  onAuthFailure(() => {
    platform.session.clear();
    set({ phase: 'login', data: null, live: false });
  });

  const token = platform.session.getToken();
  const savedTripId = platform.session.getTripId();
  const savedUser = typeof platform.session.getUser === 'function' ? platform.session.getUser() : null;

  if (token && savedTripId) {
    const cached = await platform.storage.loadSnapshot(savedTripId).catch(() => null);
    set({
      user: savedUser,
      activeTripId: savedTripId,
      ...(cached ? { data: normalizeSnapshot(cached), phase: 'ready' } : {}),
    });
    actions.refreshTrips().catch(() => {});
    await switchTrip(savedTripId);
    startClock();
    platform.device.onNetwork(({ online }) => (online ? handleOnline() : handleOffline()));
    platform.device.onResume(handleVisibility);
    return;
  }

  // 本地无 Token 时，尝试微信小程序静默登录
  if (typeof platform.session.getWxLoginCode === 'function') {
    try {
      const code = await platform.session.getWxLoginCode();
      if (code) {
        const res = await api.wxLogin(code);
        platform.session.setToken(res.token);
        platform.session.setUser?.(res.user);
        platform.session.setTripId(res.activeTripId);
        set({
          user: res.user,
          trips: res.trips || [],
          activeTripId: res.activeTripId,
        });
        await switchTrip(res.activeTripId);
        startClock();
        platform.device.onNetwork(({ online }) => (online ? handleOnline() : handleOffline()));
        platform.device.onResume(handleVisibility);
        return;
      }
    } catch (e) {
      // 静默登录失败（如无网或服务端未就绪），平滑降级至 login 页
    }
  }

  set({ phase: 'login' });
  startClock();
  platform.device.onNetwork(({ online }) => (online ? handleOnline() : handleOffline()));
  platform.device.onResume(handleVisibility);
}

function handleOnline() {
  set({ online: true });
  flushQueue()
    .then(({ done, dropped }) => {
      const bits = [];
      if (done) bits.push(`已补传 ${done} 条离线记录`);
      if (dropped) bits.push(`${dropped} 条已失效被跳过`);
      if (bits.length) toast(bits.join('，'), dropped ? 'warn' : 'success');
      refresh();
    })
    .catch(() => {});
  connectLive();
}

function handleOffline() {
  set({ online: false, live: false });
}

function handleVisibility() {
  if (platform.device.isOnline()) {
    refresh({ quiet: true });
    connectLive();
  }
}

function startClock() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    state = { ...state, now: new Date() };
    emit();
  }, 30000); // 每 30 秒刷新一次"现在"，够用且不费电
}

/* ------------------------------ 成就 ------------------------------ */

/*
 * 解锁庆祝：和本机已读记录对比，新解锁的合并成一条 toast。
 * 第一次跑（还没有记录）只登记不弹 —— 升级时一口气解锁十几个不是惊喜是噪音。
 * 成就是锦上添花，任何失败都咽掉，别影响同步主流程。
 */
async function celebrateAchievements(data) {
  try {
    const achv = computeAchievements(data);
    const meId = data.meId || data.members?.find((m) => m.name === data.me)?.id || null;
    const mine = [...achv.team, ...(achv.byMember[meId] || [])];
    const doneIds = mine.filter((b) => b.done).map((b) => b.id);

    const meta = await platform.storage.loadMeta('achvSeen');
    if (!meta || !Array.isArray(meta.ids)) {
      await platform.storage.saveMeta('achvSeen', { ids: doneIds });
      return;
    }
    const seen = new Set(meta.ids);
    const fresh = mine.filter((b) => b.done && !seen.has(b.id));
    const merged = [...new Set([...meta.ids, ...doneIds])];
    if (merged.length !== meta.ids.length) await platform.storage.saveMeta('achvSeen', { ids: merged });
    if (fresh.length) {
      const names = fresh.slice(0, 3).map((b) => b.title).join('、');
      // 延后一点：先让刚触发的操作提示（如"已上传 2 张照片"）说完，再庆祝
      setTimeout(() => toast(`解锁成就：${names}${fresh.length > 3 ? ' 等' : ''}`, 'success'), 1800);
    }
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------ 拉数据 ------------------------------ */

/**
 * 快照指纹：轮询拿回来的 serverTime 每次都会变，旧数据的待办 id 也可能每次现生成。
 * 比较前把这两类易变字段收掉，内容没变就别替换 data / 重写本地快照。
 */
function snapshotFingerprint(data) {
  if (!data) return '';
  const stable = {
    ...data,
    serverTime: undefined,
    nodes: Array.isArray(data.nodes)
      ? data.nodes.map((n) => ({
          ...n,
          checklist: Array.isArray(n.checklist)
            ? n.checklist.map((c) => ({ text: c?.text, done: !!c?.done, done_at: c?.done_at || null }))
            : n.checklist,
        }))
      : data.nodes,
  };
  try {
    return JSON.stringify(stable);
  } catch {
    return null;
  }
}

export async function refresh({ quiet = false } = {}) {
  if (!platform.session.getToken()) return;
  if (!quiet) set({ syncing: true });
  try {
    const data = normalizeSnapshot(await api.snapshot());
    const fingerprint = snapshotFingerprint(data);
    if (fingerprint !== null && fingerprint === lastSnapshotFingerprint) {
      set({ phase: 'ready', syncing: false, error: null });
      return;
    }
    lastSnapshotFingerprint = fingerprint;
    set({ data, phase: 'ready', syncing: false, error: null });
    // 改过名之后，登录页预填也要跟着换成新名字，否则下次会被认成另一个人
    if (data?.me) platform.session.setMemberName(data.me);
    await celebrateAchievements(data);
    if (data?.trip?.id) await platform.storage.saveSnapshot(data.trip.id, data);
  } catch (e) {
    if (e.status === 0) {
      set({ syncing: false, online: false });
    } else {
      set({ syncing: false, error: e.message });
    }
  }
}

/* ------------------------------ 实时同步 ------------------------------ */

/* ------------------------------ 实时同步 ------------------------------ */

export function connectLive() {
  const currentTripId = state.activeTripId || platform.session.getTripId();
  if (!currentTripId || !platform.session.getToken()) return;
  startStreamForTrip(currentTripId);
}

let debounceTimer = null;
function debouncedRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => refresh({ quiet: true }), 400);
}

export function disconnectLive() {
  stopStream();
  clearInterval(tickTimer);
  tickTimer = null;
}

/* ------------------------------ 动作 ------------------------------ */

async function run(fn, { quiet = false, needEdit = false } = {}) {
  if (needEdit && !guardEditable()) return;
  try {
    const r = await fn();
    await refresh({ quiet: true });
    return r;
  } catch (e) {
    if (e.status === 0) {
      // 队列类操作会说「已加入待同步队列」；照片这种不排队的会说「要联网」
      toast(e.message || '已离线，记录会等联网后自动同步', 'warn');
      await refresh({ quiet: true });
    } else {
      toast(e.message || '操作失败', 'error');
      throw e;
    }
  }
}

/** 登录成功：把令牌、旅行、名字写进平台会话存储 */
function applySession({ token, trip, member }) {
  lastSnapshotFingerprint = null;
  platform.session.setToken(token);
  if (trip?.id) platform.session.setTripId(trip.id);
  if (member?.name) platform.session.setMemberName(member.name);
}

export const actions = {
  switchTrip,

  async refreshTrips() {
    const res = await api.listTrips();
    const trips = res?.trips || [];
    set({ trips });
    return trips;
  },

  async updateUserProfile({ nickname, avatarUrl }) {
    const res = await api.updateProfile({ nickname, avatarUrl });
    platform.session.setUser?.(res.user);
    set({ user: res.user });
    toast('个人资料已更新', 'success');
    await refresh({ quiet: true });
    return res.user;
  },

  async cloneCurrentTrip({ name, startDate }) {
    const curId = state.activeTripId || platform.session.getTripId();
    if (!curId) return;
    const res = await api.cloneTrip(curId, { name, startDate });
    await actions.refreshTrips();
    await switchTrip(res.tripId);
    toast('已生成备选行程分支', 'success');
    return res.tripId;
  },

  async patchTripStatus(tripId, status) {
    if (!guardEditable()) return;
    await api.patchTripMeta(tripId, { status });
    await actions.refreshTrips();
    if (tripId === state.activeTripId) await refresh({ quiet: true });
  },

  async deleteOrLeaveTrip(tripId) {
    const res = await api.deleteOrLeaveTrip(tripId);
    await platform.storage.dropSnapshot(tripId).catch(() => {});
    await actions.refreshTrips();
    if (res.nextTripId) {
      await switchTrip(res.nextTripId);
    }
    toast(res.deleted ? '行程已删除' : '已退出该行程', 'success');
    return res;
  },

  async previewJoin({ code = '', passphrase = '' }) {
    return await api.joinPreview({ code, passphrase });
  },

  async confirmJoin({ code = '', passphrase = '', claimMemberId = '', nickname = '' }) {
    const res = await api.joinTrip({ code, passphrase, claimMemberId, nickname });
    await actions.refreshTrips();
    await switchTrip(res.tripId);
    toast('已加入行程', 'success');
    return res;
  },

  async addVirtualMember({ name, color }) {
    if (!guardEditable()) return;
    const res = await api.addVirtualMember({ name, color });
    await refresh({ quiet: true });
    toast(`已添加同伴「${name}」`, 'success');
    return res;
  },

  async removeTripMember(memberId) {
    if (!guardEditable()) return;
    const res = await api.removeMember(memberId);
    await refresh({ quiet: true });
    toast('成员已移除', 'success');
    return res;
  },

  async wxLogin(code) {
    const res = await api.wxLogin(code);
    platform.session.setToken(res.token);
    if (res.user) platform.session.setUser?.(res.user);
    if (res.activeTripId) platform.session.setTripId(res.activeTripId);
    set({
      user: res.user,
      trips: res.trips || [],
      activeTripId: res.activeTripId,
      phase: 'ready',
    });
    await switchTrip(res.activeTripId);
    connectLive();
    return res;
  },

  login: (passphrase, name) =>
    run(async () => {
      const res = await api.login(passphrase, name);
      applySession(res);
      set({ phase: 'ready', activeTripId: res.trip?.id || '' });
      connectLive();
      return res;
    }),

  createTrip: (payload) =>
    run(async () => {
      // 区分是多时间线新建还是传统口令建旅行
      if (payload?.passphrase) {
        const res = await api.createTrip(payload);
        applySession(res);
        set({ phase: 'ready', activeTripId: res.trip?.id || '' });
        connectLive();
        return res;
      }
      const res = await api.createNewTrip(payload);
      await actions.refreshTrips();
      await switchTrip(res.tripId);
      toast('新行程已创建', 'success');
      return res.tripId;
    }),

  logout: async () => {
    disconnectLive();
    lastSnapshotFingerprint = null;
    const tripId = platform.session.getTripId();
    if (tripId) await platform.storage.dropSnapshot(tripId).catch(() => {});
    await platform.queue.clear().catch(() => {});
    platform.session.clear();
    set({ phase: 'login', data: null, live: false, user: null, trips: [], activeTripId: '' });
  },

  createNode: (payload) => run(() => api.createNode(payload), { needEdit: true }),
  patchNode: (id, payload) => run(() => api.patchNode(id, payload), { needEdit: true }),
  deleteNode: (id) => run(() => api.deleteNode(id), { needEdit: true }),
  move: (payload) => run(() => api.move(payload), { needEdit: true }),
  previewMove: (payload) => api.movePreview(payload),

  checkin: (nodeId, action) => run(() => api.checkin(nodeId, action), { needEdit: true }),

  setChecklistItem: (nodeId, itemId, done, text) =>
    run(() => api.setChecklistItem(nodeId, itemId, done, text), { needEdit: true }),
  addExpense: (payload) => run(() => api.addExpense(payload), { needEdit: true }),
  patchExpense: (id, payload) => run(() => api.patchExpense(id, payload), { needEdit: true }),
  deleteExpense: (id) => run(() => api.deleteExpense(id), { needEdit: true }),

  addBudget: (payload) => run(() => api.addBudget(payload), { needEdit: true }),
  patchBudget: (id, payload) => run(() => api.patchBudget(id, payload), { needEdit: true }),
  deleteBudget: (id) => run(() => api.deleteBudget(id), { needEdit: true }),

  // 预算只剩一个总数：把历史分类行合并成一行，之后只维护这一行
  setTotalBudget: (amount, existing = []) =>
    run(
      async () => {
        const [keep, ...rest] = existing;
        for (const b of rest) await api.deleteBudget(b.id);
        if (keep) return api.patchBudget(keep.id, { category: '总预算', amount, vocabKey: null });
        return api.addBudget({ category: '总预算', amount, vocabKey: null });
      },
      { needEdit: true }
    ),

  changePassphrase: (current, next) => run(() => api.changePassphrase({ current, next })),

  patchTrip: (payload) => run(() => api.patchTrip(payload), { needEdit: true }),

  /** 导入行程模板：只新增节点，不动已有内容 */
  importTemplate: (payload) =>
    run(
      async () => {
        const r = await api.importTemplate(payload);
        toast(`已导入 ${r.created} 项`, 'success');
        return r;
      },
      { needEdit: true }
    ),

  addVocab: (payload) => run(() => api.addVocab(payload), { needEdit: true }),
  patchVocab: (id, payload) => run(() => api.patchVocab(id, payload), { needEdit: true }),
  deleteVocab: (id) => run(() => api.deleteVocab(id), { needEdit: true }),
  patchMember: (id, payload) => run(() => api.patchMember(id, payload), { needEdit: true }),

  /** payload = { files: [{ name, file }], fields } */
  uploadPhotos: (payload) =>
    run(
      async () => {
        const rows = await api.uploadPhotos(payload);
        toast(`已上传 ${rows.length} 张照片`, 'success');
        return rows;
      },
      { needEdit: true }
    ),

  deletePhoto: (id) =>
    run(
      async () => {
        const r = await api.deletePhoto(id);
        platform.files.drop(id);
        return r;
      },
      { needEdit: true }
    ),
  patchPhoto: (id, payload) => run(() => api.patchPhoto(id, payload), { needEdit: true }),

  flushQueue,
};
