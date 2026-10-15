/**
 * addExpense：记一笔消费（写）。
 *
 * 账本的可信度取决于数字与对象是否真实，所以这里宁可拒绝也不猜：
 * 金额不是数字或超出合理范围、类别/付款人/挂靠项对不上快照里的名单，全部直接失败，
 * 让模型回到用户那里确认清楚再来一次，绝不把含糊的值写进账本。
 *
 * 服务端 POST 只认「传了的字段」：不传 occurredAt 记「现在」、不传 nodeId 记 null。
 * 唯一必须显式传的是 payer —— 不传会落到第一个成员，而不是用户看到的「我」。
 */
const { load, findNode, drop } = require('../../../lib/snapshot.js');
const { request } = require('../../../lib/net.js');
const { fail } = require('../../../lib/respond.js');
const { parseWhen } = require('../../../lib/times.js');
const { moneyText, categoryLabelOf, localWhenText } = require('../../../lib/present.js');

const {
  clean,
  badText,
  validAmount,
  hasCategory,
  categoryChoices,
  DEFAULT_CATEGORY,
  MAX_NOTE,
} = require('../utils.js');

/**
 * 「我」是谁：meId 优先（改过名后名字对不上），再退回按名字对。
 * 都认不出来返回空串，由调用方拒绝 —— 不能把付款人默默记到别的成员头上。
 */
function myName(snap) {
  const members = snap.members || [];
  const mine = snap.meId ? members.find((m) => m.id === snap.meId) : null;
  if (mine) return mine.name;
  return snap.me && members.some((m) => m.name === snap.me) ? snap.me : '';
}

async function addExpense({ amount, note, category, payer, occurredAt, nodeId } = {}) {
  if (!validAmount(amount)) {
    return fail(
      '金额不对：amount 必须是大于 0 且不超过 1000000 的数字（单位：元）。' +
        '请向用户确认实际金额后再记；不要猜测，也不要用 0 或字符串占位。'
    );
  }

  const snap = await load();

  if (badText(category) || badText(payer) || badText(occurredAt) || badText(nodeId)) {
    return fail('category / payer / occurredAt / nodeId 都必须是字符串（不清楚的值请整体省略本字段）。');
  }

  const categoryKey = clean(category);
  if (categoryKey && !hasCategory(snap, categoryKey)) {
    return fail(
      `类别「${categoryKey}」不在本趟旅行的消费类别表里。可用类别：${categoryChoices(snap.vocab)}。` +
        `请改用表里的 key，或省略 category（会记入默认类别「${categoryLabelOf(snap.vocab, DEFAULT_CATEGORY)}」）；不要自造类别。`
    );
  }

  const payerKey = clean(payer);
  const memberNames = (snap.members || []).map((m) => m.name);
  if (payerKey && !memberNames.includes(payerKey)) {
    return fail(
      `付款人「${payerKey}」不在同行成员名单里。当前成员：${memberNames.join('、') || '（名单为空）'}。` +
        '请改用名单里的名字，或省略 payer（默认记当前登录者）；不要编造成员。'
    );
  }
  const payerName = payerKey || myName(snap);
  if (!payerName) {
    return fail('认不出当前登录者是哪位成员，无法把付款人默认成「我」。请先问清谁付的钱，或让用户在小程序里确认成员身份后再记。');
  }

  const whenRaw = clean(occurredAt);
  let whenIso = '';
  if (whenRaw) {
    whenIso = parseWhen(whenRaw);
    if (!whenIso) {
      return fail(
        `时间「${whenRaw}」看不懂（支持 2026-10-12 或 2026-10-12 14:30 两种写法）。` +
          '请把用户说的相对时间（昨天、中午等）换算成具体日期时间再传；不要传自然语言。'
      );
    }
  }

  const nodeKey = clean(nodeId);
  let node = null;
  if (nodeKey) {
    node = findNode(snap, nodeKey);
    if (!node) {
      return fail(
        '找不到要挂靠的行程项（nodeId 可能过期或不对）。请先用 getDaySchedule / findItems 查一次，拿返回里的 nodeId 原文再记；不要编造 nodeId。'
      );
    }
  }

  const noteText = clean(note).slice(0, MAX_NOTE);

  // 只带「用户实际给了的字段」：服务端对缺省字段有自己的默认（现在 / null）
  const body = { amount, payer: payerName };
  if (categoryKey) body.category = categoryKey;
  if (whenIso) body.occurredAt = whenIso;
  if (node) body.nodeId = node.id;
  if (noteText) body.note = noteText;

  const row = (await request('POST', '/api/money/expenses', body)) || {};
  drop();

  const savedCategory = row.category || DEFAULT_CATEGORY;
  const categoryLabel = categoryLabelOf(snap.vocab, savedCategory);
  const whenText = localWhenText(row.occurred_at);
  const noteSaved = row.note || '';

  return {
    isError: false,
    content: [{
      type: 'text',
      text:
        `已记一笔：${categoryLabel} ${moneyText(row.amount)}${noteSaved ? `，${noteSaved}` : ''}` +
        `，付款人 ${row.payer}（${whenText}）。` +
        '请向用户复述金额与说明做确认，并引导点击小程序卡片查看或调整这笔记录。',
    }],
    structuredContent: {
      expenseId: row.id,
      amount: row.amount,
      note: noteSaved,
      category: savedCategory,
      categoryLabel,
      payer: row.payer,
      whenText,
    },
    handoff: { query: `id=${row.id}` },
  };
}

module.exports = addExpense;
