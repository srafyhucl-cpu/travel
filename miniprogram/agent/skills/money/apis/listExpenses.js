/**
 * listExpenses：最近的消费记录（只读）。
 *
 * 服务端快照已按发生时间倒序，这里只做过滤与截取、不重排 —— 排序口径与小程序时间线一致。
 * 返回的 expenseId / amount 也是改一笔、删一笔的上游取值，禁止模型自己改写。
 */
const { load, findNode } = require('../../../lib/snapshot.js');
const { fail } = require('../../../lib/respond.js');
const { moneyText, categoryLabelOf, localWhenText } = require('../../../lib/present.js');

const { hasCategory, categoryChoices } = require('../utils.js');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

/** limit 只认数字：非数字退回默认值，再夹到 1..30，防止一次把整本账拉进对话 */
function normalizeLimit(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(v)));
}

/** 挂靠的行程项还在就带上标题；没挂靠或挂靠项已被删就留空 */
function nodeTitleOf(snap, nodeId) {
  const node = nodeId ? findNode(snap, nodeId) : null;
  return node ? node.title : '';
}

async function listExpenses({ limit, category } = {}) {
  if (category !== undefined && category !== null && typeof category !== 'string') {
    return fail('category 必须是类别 key（字符串）；想看全部就省略本字段。');
  }
  const lim = normalizeLimit(limit);
  const categoryKey = typeof category === 'string' ? category.trim() : '';

  const snap = await load();
  if (categoryKey && !hasCategory(snap, categoryKey)) {
    return fail(
      `类别「${categoryKey}」不在本趟旅行的消费类别表里。可用类别：${categoryChoices(snap.vocab)}。` +
        '请改用表里的 key，或省略 category 查看全部；不要自造类别。'
    );
  }

  const all = (snap.expenses || []).filter((e) => !categoryKey || e.category === categoryKey);
  const picked = all.slice(0, lim);
  const sum = Math.round(picked.reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100) / 100;

  const items = picked.map((e) => ({
    expenseId: e.id,
    amount: e.amount,
    note: e.note || '',
    categoryLabel: categoryLabelOf(snap.vocab, e.category),
    payer: e.payer,
    whenText: localWhenText(e.occurred_at),
    nodeTitle: nodeTitleOf(snap, e.node_id),
  }));

  const structuredContent = { count: items.length, totalCount: all.length, items };

  if (!items.length) {
    return {
      isError: false,
      content: [{
        type: 'text',
        text: categoryKey
          ? `没有取到「${categoryLabelOf(snap.vocab, categoryKey)}」类别的消费记录。请如实告知用户；不要编造记录；可以引导用户点击小程序卡片查看完整时间线。`
          : '还没有记过任何消费。请如实告知用户；不要编造记录；可以引导用户点击小程序卡片查看完整时间线。',
      }],
      structuredContent,
      handoff: { query: '' },
    };
  }

  return {
    isError: false,
    content: [{
      type: 'text',
      text:
        `已取到最近 ${items.length} 笔消费（合计 ${moneyText(sum)}）。` +
        '请按时间倒序简要转述（时间、金额、说明），并引导用户点击小程序卡片查看完整时间线；不要编造列表外的记录。',
    }],
    structuredContent,
    handoff: { query: '' },
  };
}

module.exports = listExpenses;
