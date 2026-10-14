/**
 * 平台传输（微信实现）：wx.request 包成 {status, ok, text(), json()}。
 * store/api.js 的鉴权、离线排队、错误语义与 Web 完全共用。
 *
 * 小程序没有 EventSource：openStream 用轮询实现 —— 收 onMessage 的地方
 * 只认「服务端可能有变化」这一件事，不关心怎么送来的。
 */
import { session } from './session.js';

/* 小程序不能发相对地址；这里是线上域名。
 * 开发/自动化测试时可以在控制台或脚本里 wx.setStorageSync('travel.base', 'http://127.0.0.1:7042')
 * 指向本机后端 —— 每次请求现读，改完不用重启。 */
const PROD_BASE = 'https://travel.hclstudio.cn';
const DEV_LOCAL_BASE = 'http://127.0.0.1:7052';

export function baseUrl() {
  try {
    const custom = wx.getStorageSync('travel.base');
    if (custom) return custom;
    const accountInfo = wx.getAccountInfoSync?.();
    const envVersion = accountInfo?.miniProgram?.envVersion;
    if (envVersion === 'develop') {
      return DEV_LOCAL_BASE;
    }
    return PROD_BASE;
  } catch {
    return PROD_BASE;
  }
}

const POLL_MS = 20000;

function parseMaybe(data) {
  if (typeof data !== 'string') return data ?? null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function toResponse(status, data) {
  const parsed = parseMaybe(data);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(parsed ?? '')),
    json: () => Promise.resolve(parsed),
  };
}

function authHeader(tripId = '') {
  const token = session.getToken();
  const targetTripId = tripId || session.getTripId();
  const h = {};
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (targetTripId) h['Trip-Id'] = targetTripId;
  return h;
}

export function send({ method = 'GET', path, headers = {}, body, isForm = false, tripId = '' }) {
  return new Promise((resolve, reject) => {
    const header = { ...headers, ...authHeader(tripId) };
    if (!isForm && body !== undefined) header['Content-Type'] = 'application/json';
    wx.request({
      url: `${baseUrl()}${path}`,
      method,
      header,
      data: body,
      success: (res) => resolve(toResponse(res.statusCode, res.data)),
      fail: (err) => reject(new Error(err?.errMsg || 'request failed')),
    });
  });
}

/**
 * 上传：wx.uploadFile 一次只能传一个文件，这里顺序逐张传，
 * 把每次返回的数组拼起来，给 store/api 的响应形状保持不变。
 * 网络失败直接 reject；HTTP 错误仍返回响应，由 store/api 统一给可读提示。
 * 前面已传成功的照片服务端已收下，失败那次不假装成功。
 */
export async function upload({ path, files = [], fields = {}, tripId = '' }) {
  const rows = [];
  for (const f of files) {
    const formData = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) formData[k] = String(v);
    }
    const res = await new Promise((resolve, reject) =>
      wx.uploadFile({
        url: `${baseUrl()}${path}`,
        filePath: f.filePath,
        name: f.field || 'photos',
        header: authHeader(tripId),
        formData,
        success: (r) => resolve({ status: r.statusCode, data: r.data }),
        fail: (err) => reject(new Error(err?.errMsg || 'upload failed')),
      })
    );
    if (res.status < 200 || res.status >= 300) return toResponse(res.status, res.data);
    const parsed = parseMaybe(res.data);
    if (Array.isArray(parsed)) rows.push(...parsed);
    else if (parsed) rows.push(parsed);
  }
  return toResponse(200, JSON.stringify(rows));
}

export function openStream(optionsOrPath, maybeOnMessage) {
  let onOpen, onMessage, onError;
  if (typeof optionsOrPath === 'string') {
    onMessage = maybeOnMessage;
  } else if (optionsOrPath && typeof optionsOrPath === 'object') {
    onOpen = optionsOrPath.onOpen;
    onMessage = optionsOrPath.onMessage;
    onError = optionsOrPath.onError;
  }

  let closed = false;
  const emit = () => {
    if (closed) return;
    try {
      onMessage?.('{"type":"poll"}');
    } catch {
      onError?.();
    }
  };
  const first = setTimeout(() => {
    if (closed) return;
    onOpen?.();
    emit();
  }, 0);
  const timer = setInterval(emit, POLL_MS);
  return {
    close() {
      closed = true;
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

/** 带令牌的下载地址（日历订阅/模板导出用；小程序里打开文件另走 wx.downloadFile） */
export function url(path) {
  const token = session.getToken();
  const base = baseUrl();
  if (!token) return `${base}${path}`;
  return `${base}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
