/**
 * agent（微信AI 独立分包）的传输层：wx.request 包成 Promise，自动带上登录令牌。
 *
 * 独立分包不能 require 主包的 platform/wx/net.js，这里是它的精简复刻：
 * 令牌 key（travel.token）、调试基址（travel.base）、线上域名都保持一致，
 * 用户在小程序里的登录态与调试指向在这边原样生效。
 *
 * 只实现原子接口用到的部分，不做离线队列 —— 写失败就如实回调失败，
 * 由接口层的文案让 AI 告诉用户重试。
 */
const PROD_BASE = 'https://travel.hclstudio.cn';
const TOKEN_KEY = 'travel.token';
const BASE_KEY = 'travel.base';

/** 带 HTTP 状态码的错误；status = 0 表示网络层失败（连不上/超时） */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function baseUrl() {
  try {
    return wx.getStorageSync(BASE_KEY) || PROD_BASE;
  } catch {
    return PROD_BASE;
  }
}

/* wx.request 在 Content-Type 是 json 时已经解析过一层；字符串兜底再解析一次 */
function parseMaybe(data) {
  if (typeof data !== 'string') return data === undefined ? null : data;
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * 发请求。2xx 解析后 resolve；其余 reject(ApiError)。
 * 服务端的 message 本来就是写给人看的中文，直接透传给模型当失败原因。
 */
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const header = {};
    const token = getToken();
    if (token) header.Authorization = `Bearer ${token}`;
    if (body !== undefined) header['Content-Type'] = 'application/json';

    wx.request({
      url: `${baseUrl()}${path}`,
      method,
      header,
      data: body,
      success(res) {
        const parsed = parseMaybe(res.data);
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const message = (parsed && parsed.message) || `请求失败（${res.statusCode}）`;
        reject(new ApiError(res.statusCode, message));
      },
      fail(err) {
        reject(new ApiError(0, (err && err.errMsg) || '网络不可用'));
      },
    });
  });
}

module.exports = { ApiError, request, getToken, baseUrl, PROD_BASE };
