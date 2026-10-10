/**
 * 快照读取与索引。原子接口几乎都从 GET /api/trip/snapshot 取数，
 * 这里统一做「按登录令牌缓存 + 写成功后失效」，并收拢常用的查找口径。
 *
 * 缓存的意义：一次对话里可能连环调用多个接口（先查后改再查），
 * 没有缓存就会把同一份快照来回拉好几遍。TTL 很短，只服务于连环调用。
 */
const { request, getToken } = require('./net.js');

const CACHE_TTL_MS = 10 * 1000;

let cache = { token: '', at: 0, data: null };

/** 拉快照；令牌变了自动重拉（同机换账号登录不会被上一个账号的缓存串台） */
async function load({ fresh = false } = {}) {
  const token = getToken();
  const usable = cache.data && cache.token === token && Date.now() - cache.at < CACHE_TTL_MS;
  if (!fresh && usable) return cache.data;

  const data = await request('GET', '/api/trip/snapshot');
  cache = { token, at: Date.now(), data };
  return data;
}

/** 写操作成功后调用：下一次 load 一定重新拉 */
function drop() {
  cache = { token: '', at: 0, data: null };
}

function findNode(snap, nodeId) {
  return (snap.nodes || []).find((n) => n.id === nodeId) || null;
}

function findExpense(snap, expenseId) {
  return (snap.expenses || []).find((e) => e.id === expenseId) || null;
}

/** 时间线节点：role=module 的「前置准备」不进按天时间线（和界面逻辑一致） */
function timelineNodes(snap) {
  return (snap.nodes || []).filter((n) => n.role !== 'module');
}

function nodesOn(snap, date) {
  return timelineNodes(snap).filter((n) => n.date === date);
}

/**
 * 未完成的待办。
 * scope=all   → 整趟旅行全部节点；
 * 默认 today  → 今天的节点 + 前置准备（它没有"哪天"的概念，但永远值得看）。
 */
function undoneTodos(snap, scope, today) {
  const out = [];
  for (const node of snap.nodes || []) {
    const wanted = node.role === 'module' || node.date === today;
    if (scope !== 'all' && !wanted) continue;
    for (const item of node.checklist || []) {
      if (!item.done) out.push({ node, item });
    }
  }
  return out;
}

module.exports = { load, drop, findNode, findExpense, timelineNodes, nodesOn, undoneTodos };
