/* 同步生成，勿手改：来源 web/src/core|store，跑 miniprogram/scripts/sync-shared.mjs 更新 */
/**
 * 应用状态容器。不依赖 React，也只依赖 platform 的接口 ——
 * 换成小程序时，这个文件和 core/ 原样复用。
 *
 * 策略：先从本地快照立刻渲染（秒开、断网可用），再从服务器拉最新覆盖。
 */
import { api, flushQueue, onAuthFailure } from './api.js';
import { platform } from '../platform/index.js';
import { normalizeSnapshot } from '../core/checklist.js';

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
};

let state = { ...initial };
let tickTimer = null;
let stream = null;
let reconnectTimer = null;

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

/* ------------------------------ 启动 ------------------------------ */

export async function boot() {
  onAuthFailure(() => {
    platform.session.clear();
    set({ phase: 'login', data: null, live: false });
  });

  if (!platform.session.getToken()) {
    set({ phase: 'login' });
    return;
  }

  const tripId = platform.session.getTripId();
  const cached = tripId ? await platform.storage.loadSnapshot(tripId) : null;
  if (cached) set({ phase: 'ready', data: normalizeSnapshot(cached) });

  await refresh({ quiet: true });
  connectLive();
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

/* ------------------------------ 拉数据 ------------------------------ */

export async function refresh({ quiet = false } = {}) {
  if (!platform.session.getToken()) return;
  if (!quiet) set({ syncing: true });
  try {
    const data = normalizeSnapshot(await api.snapshot());
    set({ data, phase: 'ready', syncing: false, error: null });
    // 改过名之后，登录页预填也要跟着换成新名字，否则下次会被认成另一个人
    if (data?.me) platform.session.setMemberName(data.me);
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

export function connectLive() {
  if (stream || !platform.session.getToken()) return;
  try {
    // Web 端 Stream 走 EventSource（令牌由平台实现放进 query）；小程序端可以换成轮询
    stream = platform.net.openStream({
      path: '/api/trip/stream',
      onOpen: () => set({ live: true }),
      onMessage: (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'hello') return;
        } catch {
          /* 忽略心跳 */
        }
        debouncedRefresh();
      },
      onError: () => {
        set({ live: false });
        stream?.close();
        stream = null;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectLive, 4000);
      },
    });
  } catch {
    set({ live: false });
  }
}

let debounceTimer = null;
function debouncedRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => refresh({ quiet: true }), 400);
}

export function disconnectLive() {
  stream?.close();
  stream = null;
  clearTimeout(reconnectTimer);
  clearInterval(tickTimer);
  tickTimer = null;
}

/* ------------------------------ 动作 ------------------------------ */

async function run(fn, { quiet = false } = {}) {
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
  platform.session.setToken(token);
  if (trip?.id) platform.session.setTripId(trip.id);
  if (member?.name) platform.session.setMemberName(member.name);
}

export const actions = {
  login: (passphrase, name) =>
    run(async () => {
      const res = await api.login(passphrase, name);
      applySession(res);
      set({ phase: 'ready' });
      connectLive();
      return res;
    }),

  createTrip: (payload) =>
    run(async () => {
      const res = await api.createTrip(payload);
      applySession(res);
      set({ phase: 'ready' });
      connectLive();
      return res;
    }),

  logout: async () => {
    disconnectLive();
    const tripId = platform.session.getTripId();
    if (tripId) await platform.storage.dropSnapshot(tripId).catch(() => {});
    /*
     * 队列里的写操作属于上一趟旅行：路径里的节点 id 在新旅行里对不上，
     * 新建类操作还会凭空写进新旅行。退出就是退出，清掉，别让它在下次登录时乱补。
     */
    await platform.queue.clear().catch(() => {});
    platform.session.clear();
    set({ phase: 'login', data: null, live: false });
  },

  createNode: (payload) => run(() => api.createNode(payload)),
  patchNode: (id, payload) => run(() => api.patchNode(id, payload)),
  deleteNode: (id) => run(() => api.deleteNode(id)),
  move: (payload) => run(() => api.move(payload)),

  checkin: (nodeId, action) => run(() => api.checkin(nodeId, action)),

  setChecklistItem: (nodeId, itemId, done, text) => run(() => api.setChecklistItem(nodeId, itemId, done, text)),
  addExpense: (payload) => run(() => api.addExpense(payload)),
  patchExpense: (id, payload) => run(() => api.patchExpense(id, payload)),
  deleteExpense: (id) => run(() => api.deleteExpense(id)),

  addBudget: (payload) => run(() => api.addBudget(payload)),
  patchBudget: (id, payload) => run(() => api.patchBudget(id, payload)),
  deleteBudget: (id) => run(() => api.deleteBudget(id)),

  // 预算只剩一个总数：把历史分类行合并成一行，之后只维护这一行
  setTotalBudget: (amount, existing = []) =>
    run(async () => {
      const [keep, ...rest] = existing;
      for (const b of rest) await api.deleteBudget(b.id);
      if (keep) return api.patchBudget(keep.id, { category: '总预算', amount, vocabKey: null });
      return api.addBudget({ category: '总预算', amount, vocabKey: null });
    }),

  changePassphrase: (current, next) => run(() => api.changePassphrase({ current, next })),

  patchTrip: (payload) => run(() => api.patchTrip(payload)),

  /** 导入行程模板：只新增节点，不动已有内容 */
  importTemplate: (payload) =>
    run(async () => {
      const r = await api.importTemplate(payload);
      toast(`已导入 ${r.created} 项`, 'success');
      return r;
    }),

  addVocab: (payload) => run(() => api.addVocab(payload)),
  patchVocab: (id, payload) => run(() => api.patchVocab(id, payload)),
  deleteVocab: (id) => run(() => api.deleteVocab(id)),
  patchMember: (id, payload) => run(() => api.patchMember(id, payload)),

  /** payload = { files: [{ name, file }], fields } */
  uploadPhotos: (payload) =>
    run(async () => {
      const rows = await api.uploadPhotos(payload);
      toast(`已上传 ${rows.length} 张照片`, 'success');
      return rows;
    }),

  deletePhoto: (id) =>
    run(async () => {
      const r = await api.deletePhoto(id);
      platform.files.drop(id); // 本地缓存的缩略图/原图一并清掉
      return r;
    }),
  patchPhoto: (id, payload) => run(() => api.patchPhoto(id, payload)),

  flushQueue,
};
