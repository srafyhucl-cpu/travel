/**
 * 待办（checklist）的解析与规范化。
 *
 * 库里存的是一段 JSON 文本，历史上两种格式都有：
 *   老数据 ["买机票", "订民宿"]                  —— 纯字符串
 *   新数据 [{id, text, done, done_at}, …]      —— 带勾选状态
 *
 * 两种都得能读。老格式读出来时补成「未勾选」的对象，下次保存自然写成新格式，
 * 所以上线不用跑数据迁移，老节点也不受影响。
 */
import { uid, nowISO } from './db.js';

const MAX_ITEMS = 20;
const MAX_TEXT = 100;

function cleanText(v) {
  return String(v ?? '').trim().slice(0, MAX_TEXT);
}

function cleanId(v) {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : null;
}

function normalizeItems(arr) {
  const out = [];
  for (const it of arr.slice(0, MAX_ITEMS)) {
    if (typeof it === 'string') {
      const text = cleanText(it);
      if (text) out.push({ id: uid(), text, done: false, done_at: null });
    } else if (it && typeof it === 'object') {
      const text = cleanText(it.text);
      if (!text) continue;
      const done = !!it.done;
      out.push({
        id: cleanId(it.id) || uid(),
        text,
        done,
        done_at: done ? (typeof it.done_at === 'string' && it.done_at ? it.done_at : nowISO()) : null,
      });
    }
  }
  return out;
}

/** 读库：JSON 文本（或已经是数组）→ 对象数组 */
export function parseChecklist(raw) {
  if (Array.isArray(raw)) return normalizeItems(raw);
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? normalizeItems(v) : [];
  } catch {
    return [];
  }
}

/** 写库：客户端送来的数组 → 规范化后的 JSON 文本 */
export function sanitizeChecklist(input) {
  return JSON.stringify(normalizeItems(Array.isArray(input) ? input : []));
}
