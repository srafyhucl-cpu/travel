/**
 * deleteExpense：删除一笔消费（写，不可恢复）。
 *
 * 删除是资金记录里最危险的动作，所以设了两道硬闸门：
 * 1) expenseId 必须能在快照里找到（ID 只能来自 listExpenses 的原文）；
 * 2) amount 必须和这笔记录一致（防「删错一笔」）—— 对不上就拒绝，绝不硬删。
 * 批删、按描述模糊删在本接口不存在：一次只处理用户明确指名的那一笔。
 */
const { load, findExpense, drop } = require('../../../lib/snapshot.js');
const { request } = require('../../../lib/net.js');
const { fail } = require('../../../lib/respond.js');
const { moneyText, localWhenText } = require('../../../lib/present.js');

/** 金额核对误差：容忍浮点写法（64.0000001 这类）在肉眼上等于原值 */
const AMOUNT_EPSILON = 0.001;

async function deleteExpense({ expenseId, amount } = {}) {
  const id = typeof expenseId === 'string' ? expenseId.trim() : '';
  if (!id) {
    return fail('缺少 expenseId。expenseId 必须取自 listExpenses 返回的原文，不能从用户的话里猜。请先查这笔消费再去删。');
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return fail(
      '删除前必须核对金额：amount 要传这笔消费的金额（数字，单位：元）。' +
        '请先用 listExpenses 查到它的 expenseId 与 amount 原值，再带上正确金额来删。'
    );
  }

  const snap = await load();
  const row = findExpense(snap, id);
  if (!row) {
    return fail('没有找到这笔消费（expenseId 可能过期或不对）。请先用 listExpenses 查一次核对；不要编造 expenseId，也不要删除找不到的账。');
  }

  const recorded = Number(row.amount);
  if (Math.abs(amount - recorded) > AMOUNT_EPSILON) {
    return fail(
      `金额核对不上：传入 ${moneyText(amount)}，这笔实际记录的是 ${moneyText(recorded)}，已阻止删除。` +
        '请先用 listExpenses 重新核对要删的是哪一笔，带上正确金额再调用；不要用同一对参数反复重试。'
    );
  }

  await request('DELETE', `/api/money/expenses/${id}`);
  drop();

  const whenText = localWhenText(row.occurred_at);
  const label = row.note || moneyText(row.amount);

  return {
    isError: false,
    content: [{
      type: 'text',
      text: `已删除这笔消费（${whenText} ${label}）。请如实告知用户；删除后找不回来，不要暗示可以恢复。`,
    }],
    structuredContent: {
      deleted: true,
      expenseId: id,
      amount: row.amount,
      note: row.note || '',
    },
    handoff: { query: '' },
  };
}

module.exports = deleteExpense;
