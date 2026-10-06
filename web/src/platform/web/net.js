/**
 * 平台传输（Web 实现）：fetch / FormData / EventSource。
 *
 * 契约：
 *   send(options) -> Promise<ResponseLike>
 *   ResponseLike = { status, ok, text(), json() } —— 小程序实现返回同样形状的替身即可，
 *   上层的鉴权、离线排队、错误语义都在 store/api.js 里，与平台无关。
 */
import { session } from './session.js';

export function createNet() {
  async function send({ method = 'GET', path, headers = {}, body, isForm = false }) {
    const h = { ...headers };
    const token = session.getToken();
    if (token) h.Authorization = `Bearer ${token}`;
    let payload = body;
    if (!isForm && body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    return fetch(path, { method, headers: h, body: payload });
  }

  /** 上传文件：files = [{ name, file, field? }]，field 默认 photos */
  async function upload({ path, files = [], fields = {} }) {
    const fd = new FormData();
    for (const f of files) fd.append(f.field || 'photos', f.file, f.name);
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) fd.append(k, v);
    }
    return send({ method: 'POST', path, body: fd, isForm: true });
  }

  /**
   * 实时流。Web 用 EventSource；小程序没有它，实现成轮询即可
   * （收 onMessage 的地方只认「服务端有变化」这一件事，不关心怎么送来的）。
   */
  function openStream({ path, onOpen, onMessage, onError }) {
    const url = `${path}?token=${encodeURIComponent(session.getToken() || '')}`;
    const es = new EventSource(url);
    es.onopen = () => onOpen?.();
    es.onmessage = (evt) => onMessage?.(evt.data);
    es.onerror = () => onError?.();
    return { close: () => es.close() };
  }

  /** 相对路径 -> 带令牌的可打开/下载地址（.ics、模板导出用） */
  function url(path) {
    const token = session.getToken();
    if (!token) return path;
    return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }

  return { send, upload, openStream, url };
}
