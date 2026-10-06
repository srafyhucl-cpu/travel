/**
 * 应用状态容器。不依赖 React，小程序版可直接照搬这个结构。
 *
 * 策略：先从 IndexedDB 立刻渲染（秒开、断网可用），再从服务器拉最新覆盖。
 */
import { api, setSession, clearSession, getToken, getTripId, flushQueue, onAuthFailure, rememberMemberName } from './api.js';
import { cache, queue } from './idb.js';
import { normalizeSnapshot } from '../core/checklist.js';

const listeners = new Set();

const initial = {
  phase: 'boot', // boot | login | ready
  data: null, // 行程快照
  now: new Date(),
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  live: false, // SSE 是否连着
  syncing: false,
  pending: 0,
  error: null,
  toast: null,
};

let state = { ...initial };
let refreshTimer = null;
let tickTimer = null;
let es = null;
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

/* ------------------------------ 启动 ------------------------------ */

export async function boot() {
  onAuthFailure(() => {
    clearSession();
    set({ phase: 'login', data: null, live: false });
  });

  if (!getToken()) {
    set({ phase: 'login' });
    return;
  }

  const tripId = getTripId();
  const cached = tripId ? await cache.loadSnapshot(tripId) : null;
  if (cached) set({ phase: 'ready', data: normalizeSnapshot(cached) });

  await refresh({ quiet: true });
  connectLive();
  startClock();

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  document.addEventListener('visibilitychange', handleVisibility);
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
  if (document.visibilityState === 'visible' && navigator.onLine) {
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
  if (!getToken()) return;
  if (!quiet) set({ syncing: true });
  try {
    const data = normalizeSnapshot(await api.snapshot());
    set({ data, phase: 'ready', syncing: false, error: null });
    // 改过名之后，登录页预填也要跟着换成新名字，否则下次会被认成另一个人
    if (data?.me) rememberMemberName(data.me);
    if (data?.trip?.id) await cache.saveSnapshot(data.trip.id, data);
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
  if (es || !getToken()) return;
  try {
    // EventSource 不能带 Authorization 头，令牌只能走 query
    es = new EventSource(`/api/trip/stream?token=${encodeURIComponent(getToken() || '')}`);
    es.onopen = () => set({ live: true });
    es.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'hello') return;
      } catch {
        /* 忽略心跳 */
      }
      debouncedRefresh();
    };
    es.onerror = () => {
      set({ live: false });
      es?.close();
      es = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectLive, 4000);
    };
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
  es?.close();
  es = null;
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
      toast('已离线，记录会等联网后自动同步', 'warn');
      await refresh({ quiet: true });
    } else {
      toast(e.message || '操作失败', 'error');
      throw e;
    }
  }
}

export const actions = {
  login: (passphrase, name) =>
    run(async () => {
      const res = await api.login(passphrase, name);
      setSession(res);
      set({ phase: 'ready' });
      connectLive();
      return res;
    }),

  createTrip: (payload) =>
    run(async () => {
      const res = await api.createTrip(payload);
      setSession(res);
      set({ phase: 'ready' });
      connectLive();
      return res;
    }),

  logout: async () => {
    disconnectLive();
    const tripId = getTripId();
    if (tripId) await cache.dropSnapshot(tripId).catch(() => {});
    /*
     * 队列里的写操作属于上一趟旅行：路径里的节点 id 在新旅行里对不上，
     * 新建类操作还会凭空写进新旅行。退出就是退出，清掉，别让它在下次登录时乱补。
     */
    await queue.clear().catch(() => {});
    clearSession();
    set({ phase: 'login', data: null, live: false });
  },

  createNode: (payload) => run(() => api.createNode(payload)),
  patchNode: (id, payload) => run(() => api.patchNode(id, payload)),
  deleteNode: (id) => run(() => api.deleteNode(id)),
  reorder: (ids) => run(() => api.reorder(ids), { quiet: true }),
  shift: (payload) => run(() => api.shift(payload)),
  move: (payload) => run(() => api.move(payload)),
  shiftDays: (payload) => run(() => api.shiftDays(payload)),

  checkin: (nodeId, action) => run(() => api.checkin(nodeId, action)),
  undoCheckin: (id) => run(() => api.deleteCheckin(id)),

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
addVocab: (payload) => run(() => api.addVocab(payload)),
patchVocab: (id, payload) => run(() => api.patchVocab(id, payload)),
deleteVocab: (id) => run(() => api.deleteVocab(id)),
  patchMember: (id, payload) => run(() => api.patchMember(id, payload)),

  uploadPhotos: (formData) =>
    run(async () => {
      const rows = await api.uploadPhotos(formData);
      toast(`已上传 ${rows.length} 张照片`, 'success');
      return rows;
    }),

  deletePhoto: (id) => run(() => api.deletePhoto(id)),
  patchPhoto: (id, payload) => run(() => api.patchPhoto(id, payload)),

  flushQueue,
};
