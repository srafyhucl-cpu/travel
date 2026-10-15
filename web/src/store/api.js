/**
 * 与后端通信。业务层：端点、鉴权、离线排队、错误语义。
 * 传输细节全部在 platform.net 后面 —— 换成小程序只换平台实现，这个文件不动。
 */
import { platform } from '../platform/index.js';

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `请求失败（${status}）`);
    this.status = status;
    this.code = body?.error;
    this.body = body;
  }
}

export { ApiError };

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return { message: res.statusText };
  }
}

/** 工厂：接收一份平台实现，返回这套 api（方便后续无浏览器环境测试） */
export function createApi(platform) {
  const { net, queue } = platform;
  let authFailed = null;

  function onAuthFailure(cb) {
    authFailed = cb;
  }

  async function request(method, path, body, opts = {}) {
    let res;
    const currentTripId =
      opts.tripId || (typeof platform.session?.getTripId === 'function' ? platform.session.getTripId() : '');
    try {
      res = await net.send({ method, path, body, isForm: opts.isForm, tripId: opts.tripId });
    } catch {
      // 网络层面失败：能排队就排队（上传文件不排队，见 uploadPhotos）
      if (method !== 'GET' && opts.queueable !== false) {
        await queue.push({
          method,
          path,
          body: body === undefined ? null : body,
          tripId: currentTripId,
        });
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

  const get = (p, o) => request('GET', p, undefined, o);
  const post = (p, b, o) => request('POST', p, b, o);
  const put = (p, b, o) => request('PUT', p, b, o);
  const patch = (p, b, o) => request('PATCH', p, b, o);
  const del = (p, o) => request('DELETE', p, undefined, o);

  const api = {
    /* ---- 微信登录 & 资料 ---- */
    wxLogin(code) {
      return post('/api/auth/wx-login', { code });
    },
    updateProfile(payload) {
      return put('/api/auth/profile', payload);
    },

    /* ---- 多时间线行程管理 ---- */
    listTrips() {
      return get('/api/trips');
    },
    createNewTrip(payload) {
      return post('/api/trips', payload);
    },
    createDemoTrip() {
      return post('/api/trips/demo', {});
    },
    cloneTrip(tripId, payload) {
      return post(`/api/trips/${tripId}/clone`, payload);
    },
    patchTripMeta(tripId, payload) {
      return patch(`/api/trips/${tripId}`, payload);
    },
    deleteOrLeaveTrip(tripId) {
      return del(`/api/trips/${tripId}`);
    },
    joinPreview({ code = '', passphrase = '' }) {
      const q = code
        ? `code=${encodeURIComponent(code)}`
        : `passphrase=${encodeURIComponent(passphrase)}`;
      return get(`/api/trips/join-preview?${q}`);
    },
    joinTrip(payload) {
      return post('/api/trips/join', payload);
    },
    addVirtualMember(payload) {
      return post('/api/trip/members', payload);
    },
    removeMember(memberId) {
      return del(`/api/trip/members/${memberId}`);
    },

    /* ---- 传统口令登录 ---- */
    login: (passphrase, name) => post('/api/auth/login', { passphrase, name }),
    createTrip: (payload) => post('/api/auth/trips', payload),
    changePassphrase: (payload) => post('/api/auth/passphrase', payload),

    /* ---- 数据 ---- */
    snapshot: () => get('/api/trip/snapshot'),
    // 轻量版本号：后台轮询先对比它，没变就不拉全量快照（见 store.js 的 refresh）
    rev: () => get('/api/trip/rev'),

    /* ---- 行程节点 ---- */
    createNode: (payload) => post('/api/nodes', payload),
    patchNode: (id, payload) => patch(`/api/nodes/${id}`, payload),
    /* 文案一起带上：库里没升级过的待办是纯字符串，服务端那边 id 每次读都重新生成，
       对不上时靠文案找（见 routes/nodes.js）。 */
    setChecklistItem: (nodeId, itemId, done, text) => post(`/api/nodes/${nodeId}/checklist/${itemId}`, { done, text }),
    deleteNode: (id) => del(`/api/nodes/${id}`),
    move: (payload) => post('/api/nodes/move', payload),
    // 试算：只读，不改数据；不排队（离线时直接失败，确认页自己兜底）
    movePreview: (payload) => request('POST', '/api/nodes/move-preview', payload, { queueable: false }),

    /* ---- 打卡 ---- */
    checkin: (nodeId, action, at) => post('/api/checkins', { nodeId, action, at }),

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

    /* ---- 导入 ---- */
    importTemplate: (payload) => post('/api/export/import-template', payload),

    /* ---- 词汇表（行程类型 / 消费类别）---- */
    getVocab: () => get('/api/vocab'),
    addVocab: (payload) => post('/api/vocab', payload),
    patchVocab: (id, payload) => patch(`/api/vocab/${id}`, payload),
    deleteVocab: (id) => del(`/api/vocab/${id}`),

    /* ---- 照片 ---- */
    /*
     * 上传不走 request()：照片不排离线队列（文件上不了队），失败就当场说清楚。
     * net.upload 返回的是原始响应，这里必须像别处一样判状态、解析 JSON ——
     * 少这一步会把 400 当成功、把 undefined 当张数（真发生过）。
     */
    uploadPhotos: async ({ files, fields, tripId }) => {
      let res;
      try {
        res = await net.upload({ path: '/api/photos', files, fields, tripId });
      } catch {
        throw new ApiError(0, { message: '网络不可用，照片要联网才能传' });
      }
      if (res.status === 401) {
        authFailed?.();
        throw new ApiError(401, await safeJson(res));
      }
      if (!res.ok) {
        throw new ApiError(res.status, await safeJson(res));
      }
      return res.json();
    },
    patchPhoto: (id, payload) => patch(`/api/photos/${id}`, payload),
    deletePhoto: (id) => del(`/api/photos/${id}`),
  };

  /** 离线队列补传：4xx 永久失败就丢弃并计数，网络/5xx 保留重试，401 重登后再补 */
  async function flushQueue() {
    const items = await queue.list();
    let done = 0;
    let dropped = 0;
    for (const item of items) {
      try {
        await request(item.method, item.path, item.body, { queueable: false, tripId: item.tripId });
        await queue.remove(item.seq);
        done++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          authFailed?.();
          break;
        }
        if (e instanceof ApiError && (e.status === 400 || e.status === 403 || e.status === 404 || e.status === 409 || (e.status >= 400 && e.status < 500))) {
          await queue.remove(item.seq);
          dropped++;
          continue;
        }
        break;
      }
    }
    return { done, dropped };
  }

  return { api, onAuthFailure, flushQueue };
}

const instance = createApi(platform);

export const api = instance.api;
export const onAuthFailure = instance.onAuthFailure;
export const flushQueue = instance.flushQueue;

/* ---- 导出地址（带令牌，日历 App / 浏览器直接打开） ---- */

export function icsUrl() {
  return platform.net.url('/api/export/calendar.ics');
}

export function templateUrl() {
  return platform.net.url('/api/export/template');
}

export function backupUrl() {
  return platform.net.url('/api/export/backup');
}
