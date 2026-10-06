/**
 * 与后端通信。断网时把写操作排队，恢复后自动补传。
 */
import { cache, queue } from './idb.js';

const TOKEN_KEY = 'travel.token';
const TRIP_KEY = 'travel.tripId';
const NAME_KEY = 'travel.memberName';

let token = localStorage.getItem(TOKEN_KEY) || null;
let tripId = localStorage.getItem(TRIP_KEY) || null;
let memberName = localStorage.getItem(NAME_KEY) || null;
let authFailed = null;

export function getToken() {
  return token;
}
export function getTripId() {
  return tripId;
}
/** 上次登录用的名字：登录页预填，免得又建出一个「我」 */
export function getMemberName() {
  return memberName;
}
/** 快照认回「我」之后把名字对齐（改名、或上次登录用的是旧名） */
export function rememberMemberName(name) {
  if (!name || name === memberName) return;
  memberName = name;
  localStorage.setItem(NAME_KEY, name);
}
export function onAuthFailure(cb) {
  authFailed = cb;
}

export function setSession({ token: t, trip, member }) {
  token = t;
  tripId = trip?.id ?? tripId;
  localStorage.setItem(TOKEN_KEY, t);
  if (trip?.id) localStorage.setItem(TRIP_KEY, trip.id);
  if (member?.name) {
    memberName = member.name;
    localStorage.setItem(NAME_KEY, memberName);
  }
  cache.saveMeta('session', { token: t, tripId, at: Date.now() });
}

export function clearSession() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TRIP_KEY);
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `请求失败（${status}）`);
    this.status = status;
    this.code = body?.error;
    this.body = body;
  }
}

export { ApiError };

async function request(method, path, body, opts = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch (e) {
    // 网络层面失败：能排队就排队
    if (method !== 'GET' && opts.queueable !== false) {
      await queue.push({ method, path, body: body instanceof FormData ? null : body, isForm: body instanceof FormData, formBody: body instanceof FormData ? body : null });
    }
    throw new ApiError(0, { message: '网络不可用，已加入待同步队列', offline: true });
  }

  if (res.status === 401) {
    authFailed?.();
    throw new ApiError(401, await safeJson(res));
  }

  if (!res.ok) {
    throw new ApiError(res.status, await safeJson(res));
  }

  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return { message: res.statusText };
  }
}

const get = (p) => request('GET', p);
const post = (p, b, o) => request('POST', p, b, o);
const patch = (p, b) => request('PATCH', p, b);
const del = (p) => request('DELETE', p);

export const api = {
  /* ---- 登录 ---- */
  login: (passphrase, name) => post('/api/auth/login', { passphrase, name }),
  createTrip: (payload) => post('/api/auth/trips', payload),
  changePassphrase: (payload) => post('/api/auth/passphrase', payload),

  /* ---- 数据 ---- */
  snapshot: () => get('/api/trip/snapshot'),

  /* ---- 行程节点 ---- */
  createNode: (payload) => post('/api/nodes', payload),
  patchNode: (id, payload) => patch(`/api/nodes/${id}`, payload),
/* 文案一起带上：库里没升级过的待办是纯字符串，服务端那边 id 每次读都重新生成，
对不上时靠文案找（见 routes/nodes.js）。 */
setChecklistItem: (nodeId, itemId, done, text) => post(`/api/nodes/${nodeId}/checklist/${itemId}`, { done, text }),
  deleteNode: (id) => del(`/api/nodes/${id}`),
  reorder: (orderedIds) => post('/api/nodes/reorder', { orderedIds }),
  shift: (payload) => post('/api/nodes/shift', payload),
  move: (payload) => post('/api/nodes/move', payload),
  shiftDays: (payload) => post('/api/nodes/shift-days', payload),

  /* ---- 打卡 ---- */
  checkin: (nodeId, action, at) => post('/api/checkins', { nodeId, action, at }),
  deleteCheckin: (id) => del(`/api/checkins/${id}`),

  /* ---- 钱 ---- */
  addExpense: (payload) => post('/api/money/expenses', payload),
  patchExpense: (id, payload) => patch(`/api/money/expenses/${id}`, payload),
  deleteExpense: (id) => del(`/api/money/expenses/${id}`),
  addBudget: (payload) => post('/api/money/budgets', payload),
  patchBudget: (id, payload) => patch(`/api/money/budgets/${id}`, payload),
  deleteBudget: (id) => del(`/api/money/budgets/${id}`),

  /* ---- 行程基本信息 ---- */
  patchTrip: (payload) => patch('/api/trip/trip', payload),
  patchMember: (id, payload) => patch(`/api/trip/members/${id}`, payload),

  /* ---- 照片 ---- */

/* ---- 词汇表（行程类型 / 消费类别）---- */
getVocab: () => get('/api/vocab'),
addVocab: (payload) => post('/api/vocab', payload),
patchVocab: (id, payload) => patch(`/api/vocab/${id}`, payload),
deleteVocab: (id) => del(`/api/vocab/${id}`),
  uploadPhotos: (formData) => post('/api/photos', formData, { queueable: false }),
  patchPhoto: (id, payload) => patch(`/api/photos/${id}`, payload),
  deletePhoto: (id) => del(`/api/photos/${id}`),
};

/* ---- 照片：带鉴权取回 → Blob → objectURL，并缓存到 IndexedDB ---- */

const urlCache = new Map(); // photoId -> objectURL

export async function photoUrl(photoId) {
  if (!photoId) return null;
  if (urlCache.has(photoId)) return urlCache.get(photoId);

  try {
    const cached = await cache.loadBlob(photoId);
    if (cached) {
      const url = URL.createObjectURL(cached);
      urlCache.set(photoId, url);
      return url;
    }
  } catch {
    /* 缓存读取失败，走网络 */
  }

  const res = await fetch(`/api/photos/${photoId}/file`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  cache.saveBlob(photoId, blob).catch(() => {});
  const url = URL.createObjectURL(blob);
  urlCache.set(photoId, url);
  return url;
}

export function forgetPhotoUrl(photoId) {
  const url = urlCache.get(photoId);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(photoId);
  }
  cache.dropBlob(photoId).catch(() => {});
}

/* ---- 导出地址（带 token，日历 App 也要能直接拉） ---- */

export function icsUrl() {
  return `/api/export/calendar.ics?token=${encodeURIComponent(token || '')}`;
}

export function templateUrl() {
  return `/api/export/template?token=${encodeURIComponent(token || '')}`;
}

/* ---- 离线队列补传 ---- */

export async function flushQueue() {
  const items = await queue.list();
  let done = 0;
  let dropped = 0;
  for (const item of items) {
    try {
      if (item.isForm && item.formBody) {
        await api.uploadPhotos(item.formBody);
      } else {
        await request(item.method, item.path, item.body);
      }
      await queue.remove(item.seq);
      done++;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) break; // 登录失效：重新登录后再补
      /*
       * 服务端明确拒绝的条目（节点已删、落点失效、checklist 对不上…）重放一万次
       * 也是同样的结果，留着只会把后面所有离线操作永远堵死。丢掉并计数，
       * 让用户知道有东西没能补上。
       */
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        await queue.remove(item.seq);
        dropped++;
        continue;
      }
      break; // 网络或 5xx：保留，下次联网再试
    }
  }
  return { done, dropped };
}
