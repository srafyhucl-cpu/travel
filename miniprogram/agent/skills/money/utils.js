/**
 * money SKILL 内共用的小工具：金额、类别参数的校验与口径。
 *
 * addExpense / updateExpense / listExpenses 都依赖同一套「金额怎么算合法、
 * 类别怎么算存在、报错时怎么列可选类别」——放一处，避免三份拷贝各写各的漂移。
 * 业务性判断（谁付款、怎么合并原值）仍留在各自的接口实现里。
 */
const MAX_AMOUNT = 1000000;
const MAX_CATEGORY_CHOICES = 12;
const MAX_NOTE = 200;
/** 服务端没收到类别时的兜底 key；中文名从类别表里取，不在这里写死 */
const DEFAULT_CATEGORY = 'misc';

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
/** 传了不是字符串、也不是没传（null/undefined）→ 模型类型传错，要报出来而不是静默忽略 */
const badText = (v) => v !== undefined && v !== null && typeof v !== 'string';

/** 金额只认真正的 number："88" 这种字符串也拒绝 —— 模型抄错一位就是一笔错账 */
function validAmount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_AMOUNT;
}

/** 类别 key 是否在本趟旅行的类别表里（自定义类别也在这张表里） */
function hasCategory(snap, key) {
  return ((snap.vocab && snap.vocab.categories) || []).some((c) => c.key === key);
}

/** 列可用类别：key=label，最多 12 个，超出用「等 N 类」收尾 */
function categoryChoices(vocab) {
  const list = (vocab && vocab.categories) || [];
  const shown = list
    .slice(0, MAX_CATEGORY_CHOICES)
    .map((c) => `${c.key}=${c.label}`)
    .join('、');
  return list.length > MAX_CATEGORY_CHOICES ? `${shown} 等 ${list.length} 类` : shown;
}

module.exports = {
  MAX_AMOUNT,
  MAX_NOTE,
  DEFAULT_CATEGORY,
  clean,
  badText,
  validAmount,
  hasCategory,
  categoryChoices,
};
