/**
 * updateExpense：修改一笔已记录的消费（写）。
 *
 * 服务端 PATCH 是「整行覆盖」式清洗：请求体里没带 occurredAt 会被重置成「现在」、
 * 没带 nodeId 会被清成 null（快照里的 snake_case 原值 cleanExpense 认不出来）。
 * 所以这里必须先用快照里这笔的原值合并出「全量 payload」再提交，
 * 调用方只负责传用户本轮明确要改的字段。
 *
 * 清空语义只在用户本轮明确表达时发生：note=null 清空备注、nodeId=null 取消挂靠；
 * 其它字段传 null 一律按「没提供」处理，避免模型顺手填 null 把原值洗掉。
 */
const { load, findNode, findExpense, drop } = require('../../../lib/snapshot.js');
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

async function updateExpense({ expenseId, amount, note, category, payer, occurredAt, nodeId } = {}) {
  const id = clean(expenseId);
  if (!id) {
    return fail('缺少 expenseId。expenseId 必须取自 listExpenses 返回的原文，不能从用户的话里猜。请先查这笔消费再去改。');
  }

  if (badText(category) || badText(payer) || badText(occurredAt) || badText(nodeId) || badText(note)) {
    return fail('category / payer / occurredAt / nodeId / note 必须是字符串（nodeId、note 清空时传 null；不修改的字段请整体省略）。');
  }

  const categoryKey = clean(category);
  const payerKey = clean(payer);
  const whenRaw = clean(occurredAt);
  const hasAmount = amount !== undefined && amount !== null;
  if (hasAmount && !validAmount(amount)) {
    return fail('金额不对：amount 必须是大于 0 且不超过 1000000 的数字（单位：元）。请向用户确认要改成的金额；不要猜测。');
  }

  // 至少要带一个「要改的东西」：空更新的请求直接拒绝，避免模型以为自己办成了事
  if (!hasAmount && note === undefined && nodeId === undefined && !categoryKey && !payerKey && !whenRaw) {
    return fail('没有提供要修改的内容。请先问清用户要改哪个字段（金额 / 类别 / 付款人 / 时间 / 备注 / 挂靠），只传要改的字段再试。');
  }

  const snap = await load();
  const row = findExpense(snap, id);
  if (!row) {
    return fail('没有找到这笔消费（expenseId 可能过期或不对）。请先用 listExpenses 查一次，拿返回里的 expenseId 原文再改；不要编造 expenseId。');
  }

  /* -------------------- 逐字段合并：传了就校验并使用，没传就沿用原值 -------------------- */

  const nextAmount = hasAmount ? amount : row.amount;

  let nextCategory = row.category || DEFAULT_CATEGORY;
  if (categoryKey) {
    if (!hasCategory(snap, categoryKey)) {
      return fail(
        `类别「${categoryKey}」不在本趟旅行的消费类别表里。可用类别：${categoryChoices(snap.vocab)}。` +
          `请改用表里的 key，或省略 category 保持原类别「${categoryLabelOf(snap.vocab, nextCategory)}」；不要自造类别。`
      );
    }
    nextCategory = categoryKey;
  }

  let nextPayer = row.payer;
  if (payerKey) {
    const memberNames = (snap.members || []).map((m) => m.name);
    if (!memberNames.includes(payerKey)) {
      return fail(
        `付款人「${payerKey}」不在同行成员名单里。当前成员：${memberNames.join('、') || '（名单为空）'}。` +
          '请改用名单里的名字；不要编造成员。'
      );
    }
    nextPayer = payerKey;
  }

  let nextOccurredAt = row.occurred_at;
  if (whenRaw) {
    const iso = parseWhen(whenRaw);
    if (!iso) {
      return fail(
        `时间「${whenRaw}」看不懂（支持 2026-10-12 或 2026-10-12 14:30 两种写法）。` +
          '请把用户说的相对时间（昨天、中午等）换算成具体日期时间再传；不要传自然语言。'
      );
    }
    nextOccurredAt = iso;
  }

  // 备注：undefined/空串 = 保留；null = 清空（用户明确要删）；字符串 = 新值
  let nextNote = row.note || null;
  if (note === null) nextNote = null;
  else if (typeof note === 'string' && note.trim()) nextNote = note.trim().slice(0, MAX_NOTE);

  // 挂靠：undefined/空串 = 保留；null = 取消；字符串 = 换挂靠（必须能找到才生效）
  let nextNode = row.node_id ? findNode(snap, row.node_id) || null : null;
  if (nodeId === null) {
    nextNode = null;
  } else if (nodeId && nodeId.trim()) {
    nextNode = findNode(snap, nodeId.trim());
    if (!nextNode) {
      return fail(
        '找不到要改挂靠的行程项（nodeId 可能过期或不对）。请先用 getDaySchedule / findItems 查一次，拿返回里的 nodeId 原文再改；不要编造 nodeId。'
      );
    }
  }

  /* -------------------- 实际改动清单：content 只复述真的变化，不编造没改的字段 -------------------- */

  const changes = [];
  if (Math.round(nextAmount * 100) !== Math.round((Number(row.amount) || 0) * 100)) {
    changes.push(`金额改为 ${moneyText(nextAmount)}`);
  }
  if (nextCategory !== (row.category || DEFAULT_CATEGORY)) {
    changes.push(`类别改为「${categoryLabelOf(snap.vocab, nextCategory)}」`);
  }
  if (nextPayer !== row.payer) {
    changes.push(`付款人改为 ${nextPayer}`);
  }
  if (Date.parse(nextOccurredAt) !== Date.parse(row.occurred_at)) {
    changes.push(`时间改为 ${localWhenText(nextOccurredAt)}`);
  }
  if ((nextNote || '') !== (row.note || '')) {
    changes.push(nextNote ? `备注改为「${nextNote}」` : '备注已清空');
  }
  if ((nextNode ? nextNode.id : null) !== (row.node_id || null)) {
    changes.push(nextNode ? `改为挂靠「${nextNode.title}」` : '已取消挂靠行程项');
  }

  const current = {
    expenseId: id,
    amount: nextAmount,
    note: nextNote || '',
    categoryLabel: categoryLabelOf(snap.vocab, nextCategory),
    payer: nextPayer,
    whenText: localWhenText(nextOccurredAt),
  };

  if (!changes.length) {
    return {
      isError: false,
      content: [{
        type: 'text',
        text: '按你传的内容对比后，这笔消费与原来一致，没有需要更新的改动。请如实告知用户没有变化；如果用户坚持要改，请确认要改成什么、只传要改的字段再来。',
      }],
      structuredContent: current,
      handoff: { query: `id=${id}` },
    };
  }

  // 全量 payload：原值也必须带上，否则被服务端的「整行覆盖」清洗掉
  const saved = (await request('PATCH', `/api/money/expenses/${id}`, {
    amount: nextAmount,
    category: nextCategory,
    payer: nextPayer,
    note: nextNote,
    occurredAt: nextOccurredAt,
    nodeId: nextNode ? nextNode.id : null,
  })) || {};
  drop();

  return {
    isError: false,
    content: [{
      type: 'text',
      text: `已更新这笔消费：${changes.join('，')}。请向用户复述实际改动，并引导点击小程序卡片查看；不要提及没有改动的字段。`,
    }],
    structuredContent: {
      expenseId: id,
      amount: saved.amount !== undefined ? saved.amount : nextAmount,
      note: (saved.note !== undefined ? saved.note : nextNote) || '',
      categoryLabel: categoryLabelOf(snap.vocab, saved.category || nextCategory),
      payer: saved.payer || nextPayer,
      whenText: localWhenText(saved.occurred_at || nextOccurredAt),
    },
    handoff: { query: `id=${id}` },
  };
}

module.exports = updateExpense;
