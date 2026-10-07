/* 同步生成，勿手改：来源 web/src/core|store，跑 miniprogram/scripts/sync-shared.mjs 更新 */
/**
 * 待办在前端的形状：{id, text, done, done_at}。
 *
 * 服务端已经规范化过一次，这里再兜一层：离线快照是升级前存进 IndexedDB 的，
 * 首屏先渲染它的时候里面还是纯字符串，不补齐的话勾一下就整页报错。
 */
let seq = 0;

/** 服务端也卡在 20（见 server/src/checklist.js），这里只负责别让输入超过它 */
export const CHECKLIST_MAX = 20;

export function newItem(text = '') {
  seq += 1;
  return {
    id: `c${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    text,
    done: false,
    done_at: null,
  };
}

export function normalizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (typeof it === 'string') {
      const text = it.trim();
      if (text) out.push(newItem(text));
    } else if (it && typeof it === 'object' && typeof it.text === 'string' && it.text.trim()) {
      out.push({
        id: it.id ? String(it.id) : newItem().id,
        text: it.text,
        done: !!it.done,
        done_at: it.done_at || null,
      });
    }
  }
  return out;
}

/** 快照进容器前统一把 checklist 摊成对象数组 */
export function normalizeSnapshot(data) {
  if (!data || !Array.isArray(data.nodes)) return data;
  const members = Array.isArray(data.members) ? data.members : [];
  /*
   * meId 是登录时记下的成员 id。改名之后 token 里的旧名字就认不出「我」了，
   * 用 id 反查成员表的当前名字；老 token 没有 meId 时退回按名字认。
   */
  const currentName = data.meId ? members.find((m) => m.id === data.meId)?.name : null;
  return {
    ...data,
    me: currentName || data.me,
    nodes: data.nodes.map((n) => ({ ...n, checklist: normalizeItems(n.checklist) })),
  };
}

/** x/y 和「是不是全做完了」——模块卡收起、进度字样都靠它 */
export function progress(items = []) {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  return { total, done, allDone: total > 0 && done === total };
}
