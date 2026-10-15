/**
 * setTodo：勾选 / 取消勾选行程项下的一条待办（写）。
 *
 * 定位优先用 itemId（getTodos 返回的原文），对不上时用 itemText 精确兜底：
 * 同文案多条时挑「状态正好相反」的那条（要勾的挑未勾的，要取消的挑已勾的），
 * 既符合用户「把这条勾上」的意图，也和服务端 checklist 接口的兜底口径一致。
 * 已经是目标状态不算失败：如实告诉用户状态即可，不重复写。
 */
const { load, findNode, drop } = require('../../../lib/snapshot.js');
const { request } = require('../../../lib/net.js');
const { fail } = require('../../../lib/respond.js');

async function setTodo({ nodeId, itemText, itemId, done } = {}) {
  const id = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!id) {
    return fail('缺少 nodeId。nodeId 必须取自 getDaySchedule / findItems / getTodos 返回的原文，不能从用户的话里猜。请先查询拿到 nodeId 再勾选。');
  }
  if (typeof done !== 'boolean') {
    return fail('done 必须传 true（勾选）或 false（取消勾选）。');
  }

  const wantId = typeof itemId === 'string' ? itemId.trim() : '';
  const wantText = typeof itemText === 'string' ? itemText.trim() : '';
  if (!wantId && !wantText) {
    return fail('缺少 itemId / itemText，无法定位要操作的待办。请先用 getTodos 查到最新 itemId 或 itemText 再调用。');
  }

  const snap = await load();
  const node = findNode(snap, id);
  if (!node) {
    return fail('没有找到这个行程项（nodeId 可能过期或不对）。请先用 getDaySchedule / findItems 查一次，拿到最新的 nodeId 再勾选；不要编造 nodeId。');
  }

  const items = Array.isArray(node.checklist) ? node.checklist : [];
  let item = null;
  if (wantId) item = items.find((i) => i.id === wantId) || null;
  if (!item && wantText) {
    const same = items.filter((i) => typeof i.text === 'string' && i.text.trim() === wantText);
    // 同文案多条：优先挑状态与目标相反的那条，不动已经对的那条
    item = same.find((i) => i.done !== done) || same[0] || null;
  }
  if (!item) {
    return fail(
      `在「${node.title}」的待办里没有找到${wantText ? `「${wantText}」` : '这条待办'}。请先用 getTodos 查最新 itemId / itemText 再操作；不要用同样的值重复调用。`
    );
  }

  if (item.done === done) {
    return {
      isError: false,
      content: [{
        type: 'text',
        text: `「${item.text}」已经是${done ? '已完成' : '未勾选'}状态，无需重复操作。请如实告知用户，不要重复调用本接口。`,
      }],
      structuredContent: {
        nodeId: node.id,
        nodeTitle: node.title,
        itemId: item.id,
        itemText: item.text,
        done,
        noop: true,
      },
    };
  }

  // itemId 用快照里找到的那条（可能是通过文案兜底找到的），text 一并带上供服务端兜底
  const row = await request('POST', `/api/nodes/${node.id}/checklist/${item.id}`, { done, text: item.text });
  drop();

  const updated = row && Array.isArray(row.checklist)
    ? row.checklist
    : items.map((i) => (i === item ? { ...i, done } : i));
  const remaining = updated.filter((i) => !i.done).length;

  return {
    isError: false,
    content: [{
      type: 'text',
      text: done
        ? `已把「${node.title}」的待办「${item.text}」勾选完成（还剩 ${remaining} 条）。请告知用户。`
        : `已把「${node.title}」的待办「${item.text}」取消勾选（还剩 ${remaining} 条）。请告知用户。`,
    }],
    structuredContent: {
      nodeId: node.id,
      nodeTitle: node.title,
      itemText: item.text,
      done,
      remaining,
    },
    // 出行准备（role=module）不在按天时间线上，卡片就不带日期定位
    handoff: { query: node.role === 'module' ? '' : `date=${node.date}` },
  };
}

module.exports = setTodo;
