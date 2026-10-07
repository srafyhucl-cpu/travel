/**
 * 平台传输（微信实现）：wx.request 包成 {status, ok, text(), json()}。
 * store/api.js 的鉴权、离线排队、错误语义与 Web 完全共用。
 *
 * 小程序没有 EventSource：openStream 用轮询实现 —— 收 onMessage 的地方
 * 只认「服务端可能有变化」这一件事，不关心怎么送来的。
 */
import { session } from './session.js';

/* 小程序不能发相对地址；这里就是线上域名。开发阶段 DevTools 勾了
 * 「不校验合法域名」，真机预览要先把域名加进 request 合法域名。 */
const BASE = 'https://travel.hclstudio.cn';

const POLL_MS = 20000;

function toResponse(res) {
  const data = res.data;
  return {
    status: res.statusCode,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data ?? '')),
    json: () =>
      Promise.resolve(
        typeof data === 'string'
          ? (() => {
              try {
                return JSON.parse(data);
              } catch {
                return null;
              }
            })()
          : data ?? null
      ),
  };
}

export function send({ method = 'GET', path, headers = {}, body, isForm = false }) {
  return new Promise((resolve, reject) => {
    const header = { ...headers };
    const token = session.getToken();
    if (token) header.Authorization = `Bearer ${token}`;
    if (!isForm && body !== undefined) header['Content-Type'] = 'application/json';
    wx.request({
      url: `${BASE}${path}`,
      method,
      header,
      data: body,
      success: (res) => resolve(toResponse(res)),
      fail: (err) => reject(new Error(err?.errMsg || 'request failed')),
    });
  });
}

/**
 * 上传：wx.uploadFile 一次只能传一个文件，和 Web 的批量语义不同。
 * 本轮不加照片，先占位；开做照片时再定「多张顺序传、合并返回」的实现。
 */
export function upload() {
  return Promise.reject(new Error('小程序端上传尚未实现（照片功能开做时补）'));
}

export function openStream({ onOpen, onMessage, onError }) {
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
  if (!token) return `${BASE}${path}`;
  return `${BASE}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
