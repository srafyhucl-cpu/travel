/**
 * getExpenseSummary：花费与预算汇总（只读）。
 *
 * 数字全部来自 core/budget.js 的 computeBudget（与小程序预算页同一套口径），
 * 这里不另算一遍 —— AI 说的数字必须和用户在小程序里看到的完全一致。
 */
const { load } = require('../../../lib/snapshot.js');
const { computeBudget } = require('../../../lib/core/budget.js');
const { moneyText, categoryLabelOf } = require('../../../lib/present.js');

/** 正文里只点前几个大类，全量明细交给小程序卡片 */
const TOP_CATEGORIES = 3;

async function getExpenseSummary() {
  const snap = await load();
  const expenses = snap.expenses || [];
  const budget = computeBudget({ budgets: snap.budgets, expenses });

  const byCategory = budget.spent.map((s) => ({
    key: s.category,
    label: categoryLabelOf(snap.vocab, s.category),
    amount: s.actual,
    count: s.count,
  }));
  const byPayer = budget.paid.map((p) => ({ name: p.name, amount: p.paid, count: p.count }));

  const hasBudget = budget.plannedTotal > 0;
  const structuredContent = {
    total: budget.actualTotal,
    count: expenses.length,
    byCategory,
    byPayer,
    budget: hasBudget
      ? { planned: budget.plannedTotal, remaining: budget.remaining, over: budget.over }
      : null,
  };

  if (!expenses.length) {
    const facts = hasBudget
      ? `目前还没有记过消费；总预算 ${moneyText(budget.plannedTotal)}，还剩 ${moneyText(budget.remaining)}`
      : '目前还没有记过消费';
    return {
      isError: false,
      content: [{
        type: 'text',
        text: `${facts}。请如实告知用户还没记过账；不要编造消费记录；可以引导用户点击小程序卡片查看预算页。`,
      }],
      structuredContent,
      handoff: { query: '' },
    };
  }

  const top = byCategory
    .slice(0, TOP_CATEGORIES)
    .map((c) => `${c.label} ${moneyText(c.amount)}`)
    .join('、');

  let text = `目前共花费 ${moneyText(budget.actualTotal)}（${expenses.length} 笔）`;
  if (top) text += `，几笔大头：${top}`;
  if (hasBudget) {
    text += `；总预算 ${moneyText(budget.plannedTotal)}，${
      budget.over ? `已超支 ${moneyText(-budget.remaining)}` : `还剩 ${moneyText(budget.remaining)}`
    }`;
  }
  text += '。请把关键数字转述给用户，并引导点击小程序卡片查看预算页；不要编造未列出的数字。';

  return {
    isError: false,
    content: [{ type: 'text', text }],
    structuredContent,
    handoff: { query: '' },
  };
}

module.exports = getExpenseSummary;
