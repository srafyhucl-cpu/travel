/**
 * deleteItem：删除一个行程项（写，不可恢复）。
 *
 * 防误删是本接口的第一目标：调用的前提是用户本轮明确说了「删」，
 * 且传入的 title 与实际项名称一字不差 —— 对不上直接拒绝，
 * 绝不「挑一个差不多的」删掉。删除后数据找不回来，文案只陈述事实。
 */
const { load, findNode, drop } = require('../../../lib/snapshot.js');
const { request } = require('../../../lib/net.js');
const { dayTextOf } = require('../../../lib/present.js');
const { fail } = require('../../../lib/respond.js');

async function deleteItem({ nodeId, title } = {}) {
  const id = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!id) {
    return fail('缺少 nodeId。nodeId 必须取自 getDaySchedule / findItems 返回的原文，不能从用户的话里猜。请先查询拿到 nodeId 再删除。');
  }
  const name = typeof title === 'string' ? title.trim() : '';
  if (!name) {
    return fail('缺少 title（要删除项的名称）。请先用 findItems 查到准确名称，向用户复述确认后再调用；不要直接删。');
  }

  const snap = await load();
  const trip = snap.trip || {};
  const node = findNode(snap, id);
  if (!node) {
    return fail('没有找到这个行程项（nodeId 可能过期或不对）。请先用 findItems / getDaySchedule 查一次，拿到最新的 nodeId 再删；不要编造 nodeId。');
  }

  // 防误删硬闸门：名称必须完全一致，杜绝「名字差不多就删了」
  const actual = typeof node.title === 'string' ? node.title.trim() : '';
  if (actual !== name) {
    return fail(
      `名称对不上：你传的是「${name}」，这一项实际叫「${actual}」。为防止误删，title 必须与实际名称完全一致。请先把要删的这一项向用户复述确认，再用准确名称调用；不要用相近的名字硬删。`
    );
  }

  await request('DELETE', `/api/nodes/${node.id}`);
  drop();

  return {
    isError: false,
    content: [{
      type: 'text',
      text: `已删除「${node.title}」（${dayTextOf(trip, node.date)}）。请如实告知用户；删除后找不回来，不要暗示可以恢复。`,
    }],
    structuredContent: {
      deleted: true,
      nodeId: node.id,
      title: node.title,
      date: node.date,
    },
    handoff: { query: '' },
  };
}

module.exports = deleteItem;
