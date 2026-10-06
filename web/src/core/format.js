/**
 * 纯逻辑，不依赖 DOM / React。微信小程序版可以直接复制这个文件。
 */

const PAD = (n) => String(n).padStart(2, '0');

/** "19:50" -> 1190（分钟）。无效返回 null */
export function toMinutes(t) {
  if (typeof t !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 1190 -> "19:50" */
export function toTime(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const w = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${PAD(Math.floor(w / 60))}:${PAD(w % 60)}`;
}

/** "09:50" -> "9小时50分"；用于"还有多久" */
export function humanizeDuration(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} 小时` : `${h} 小时 ${r} 分`;
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "2026-10-01" -> "10月1日 周三" */
export function formatDate(dateStr, opts = {}) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (opts.short) return md;
  return `${md} ${WEEKDAY[d.getDay()]}`;
}

export function weekdayOf(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAY[d.getDay()];
}

export function todayStr(now = new Date()) {
  return `${now.getFullYear()}-${PAD(now.getMonth() + 1)}-${PAD(now.getDate())}`;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
}

/** 相对日期描述：今天 / 明天 / 3 天后 / 昨天 */
export function relativeDay(dateStr, now = new Date()) {
  const diff = daysBetween(todayStr(now), dateStr);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  return diff > 0 ? `${diff} 天后` : `${-diff} 天前`;
}

export function formatMoney(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const cents = Math.abs(v % 1) > 0.0001;
  return v.toLocaleString(
    'zh-CN',
    cents
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumFractionDigits: 0 }
  );
}

/** 成员头像的淡色底：把一个 HEX 调成 12% 透明度 */
export function tintOf(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return 'rgba(47,128,237,0.12)';
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.12)`;
}

export function formatClockTime(d = new Date()) {
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

/*
* 类型和消费类别的真正来源是服务端下发的 vocab（可以在 App 里自由增删改），
* 这里的 FALLBACK 只用于「历史数据里出现了已删除的项」时兜底显示。
*/
const FALLBACK = { key: 'other', label: '其他', icon: 'ring', color: '#6B7280', soft: '#F1F3F5', leadMinutes: 30, custom: false };

export function typeMeta(vocab, key) {
return vocab?.byKey?.[key] || { ...FALLBACK, key, label: key || FALLBACK.label };
}

export function categoryMeta(vocab, key) {
return vocab?.categories?.find((c) => c.key === key) || { ...FALLBACK, key, label: key || FALLBACK.label };
}
