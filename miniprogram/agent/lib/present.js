/**
 * 展示用文本：把快照里的原始字段变成给模型/用户读的短句。
 * 只做格式化与口径统一，不做业务判断；业务规则留在各原子接口里。
 *
 * 日期、金额、类别/类型标签都走 core/format.js（与小程序同一套实现，
 * 由 sync-shared.mjs 转成 CommonJS 同步过来），保证 AI 说的话和界面一致。
 */
const {
  formatDate,
  formatMoney,
  daysBetween,
  typeMeta,
  categoryMeta,
} = require('./core/format.js');

/** "10月12日 周日" */
function dateText(date) {
  return formatDate(date);
}

/** "10月12日 周日（第 3 天）"；出发前/行程外也如实说 */
function dayTextOf(trip, date) {
  const n = daysBetween(trip.start_date, date) + 1;
  const total = daysBetween(trip.start_date, trip.end_date) + 1;
  const label = n < 1 ? '出发前' : n > total ? '行程结束后' : `第 ${n} 天`;
  return `${formatDate(date)}（${label}）`;
}

/** "09:00-11:00" / "09:00 起" / "待定" */
function timeRangeText(start, end) {
  if (start && end) return `${start}-${end}`;
  if (start) return `${start} 起`;
  return '待定';
}

/** 节点状态：以实际打卡为准，用用户口径说话 */
function statusTextOf(node) {
  if (node.status === 'done') return '已完成';
  if (node.status === 'skipped') return '已跳过';
  if (node.actual_start) return '进行中';
  return '未开始';
}

/** "待办 1/3"；没有待办返回空串 */
function checklistTextOf(node) {
  const items = Array.isArray(node.checklist) ? node.checklist : [];
  if (!items.length) return '';
  const done = items.filter((i) => i.done).length;
  return `待办 ${done}/${items.length}`;
}

function typeLabelOf(vocab, key) {
  return typeMeta(vocab, key).label;
}

function categoryLabelOf(vocab, key) {
  return categoryMeta(vocab, key).label;
}

/** "¥1,234.5" */
function moneyText(n) {
  return `¥${formatMoney(n)}`;
}

/** UTC ISO → 本地读法："10月12日 12:30"（打卡、记账的确认文案共用） */
function localWhenText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = {
  dateText,
  dayTextOf,
  timeRangeText,
  statusTextOf,
  checklistTextOf,
  typeLabelOf,
  categoryLabelOf,
  moneyText,
  localWhenText,
};
