/**
 * 时间处理：把模型可能给出的几种时间写法归一成 UTC ISO。
 *
 * 模型的时间来源是用户的话（「昨天中午」「10 月 12 号」），格式不受控，
 * 这里收三种写法（其余一律返回 null，由接口提示重新确认，不猜）：
 *   2026-10-12T04:00:00.000Z   完整时刻，校验后原样转 ISO
 *   2026-10-12                 只给日期 → 当地当天 12:00（「昨天花了 xx」的常见口径）
 *   2026-10-12 14:30           当地墙钟 → ISO（与小程序记账页 toIso 同一套转换）
 */
const { todayStr } = require('./core/format.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/;
const DEFAULT_TIME = '12:00';

function parseWhen(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;

  let d;
  if (DATE_RE.test(v)) {
    d = new Date(`${v}T${DEFAULT_TIME}:00`);
  } else {
    const m = DATE_TIME_RE.exec(v);
    if (m) d = new Date(`${m[1]}T${String(m[2]).padStart(2, '0')}:${m[3]}:00`);
    else d = new Date(v);
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 今天的本地日期（YYYY-MM-DD），与用户在小程序里看到的一致 */
function todayLocal() {
  return todayStr();
}

module.exports = { parseWhen, todayLocal };
