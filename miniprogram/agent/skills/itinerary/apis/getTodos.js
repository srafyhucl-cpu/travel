/**
 * getTodos：未完成待办清单（只读）。
 * scope=all 整趟旅行；默认 today = 今天 + 前置准备（role=module，它没有"哪天"）。
 */
const { load, undoneTodos } = require('../../../lib/snapshot.js');
const { dayTextOf } = require('../../../lib/present.js');
const { todayStr } = require('../../../lib/core/format.js');

const MAX_TODOS = 30;
const SCOPES = new Set(['today', 'all']);

async function getTodos({ scope } = {}) {
  const s = SCOPES.has(scope) ? scope : 'today';
  const snap = await load();
  const trip = snap.trip || {};
  const today = todayStr();
  const todos = undoneTodos(snap, s, today);
  const scopeText = s === 'all' ? '整趟旅行' : '今天与出行准备';

  const base = {
    scope: s,
    total: todos.length,
    detailPath: '/pages/timeline/index',
    detailTitle: '查看完整时间线',
  };

  if (!todos.length) {
    return {
      isError: false,
      content: [{
        type: 'text',
        text: `${scopeText}里没有任何未完成的待办，都清完了。请如实告诉用户；如果用户想看整趟旅行的待办，可以再用 scope=all 查一次。`,
      }],
      structuredContent: { ...base, items: [] },
      handoff: { query: '' },
    };
  }

  const items = todos.slice(0, MAX_TODOS).map(({ node, item }) => ({
    nodeId: node.id,
    nodeTitle: node.title,
    dateText: node.role === 'module' ? '' : dayTextOf(trip, node.date),
    itemId: item.id,
    itemText: item.text,
  }));

  return {
    isError: false,
    content: [{
      type: 'text',
      text:
        `${scopeText}共有 ${todos.length} 条待办未完成。` +
        '请按所属行程项分条列出（项名 + 待办文字），并告诉用户：想勾掉的话直接说「把 XX 勾掉」即可；不要编造列表外的待办。',
    }],
    structuredContent: { ...base, items },
    handoff: { query: '' },
  };
}

module.exports = getTodos;
