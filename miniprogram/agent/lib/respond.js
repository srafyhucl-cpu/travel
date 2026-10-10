/**
 * 原子接口的统一应答与登录闸门。
 *
 * 为什么不只用中间件：中间件没法把「未登录引导」这类精确应答（含接力页）
 * 带回给模型 —— 它只能抛错。所以登录检查做成处理函数的外壳；
 * 中间件保留给日志（见 lib/skill.js）。
 */
const { getToken } = require('./net.js');

const LOGIN_PAGE = '/pages/login/index';

const NOT_LOGGED_IN_TEXT =
  '你还没有登录过旅行助手。请点击下方小程序卡片，用旅行口令登录（第一次登录会让你起个名字），' +
  '然后回到这里对我说「已登录」，我会接着完成刚才的事。';

/** 未登录：文案引导 + 接力到登录页（动态 path 覆盖 mcp.json 里的常规接力页） */
function notLoggedIn() {
  return {
    isError: true,
    content: [{ type: 'text', text: NOT_LOGGED_IN_TEXT }],
    handoff: { path: LOGIN_PAGE, query: '' },
  };
}

/** 通用失败：只给模型事实与出口，不给内部实现细节 */
function fail(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

function explain(err) {
  if (err && err.status === 0) return '网络不可用';
  return (err && err.message) || '未知错误';
}

/**
 * 给每个原子接口套上：登录检查（无令牌直接引导登录）+
 * 401（令牌过期/失效）同样引导登录 + 其它错误转成可读文案。
 */
function requireLogin(handler) {
  return async (args) => {
    if (!getToken()) return notLoggedIn();
    try {
      return await handler(args || {});
    } catch (err) {
      if (err && err.status === 401) return notLoggedIn();
      console.error('[agent] 原子接口失败:', err);
      return fail(`操作失败：${explain(err)}。请如实告知用户失败原因，稍后可以再试；不要立即重复调用本接口。`);
    }
  };
}

module.exports = { notLoggedIn, fail, requireLogin, NOT_LOGGED_IN_TEXT, LOGIN_PAGE };
