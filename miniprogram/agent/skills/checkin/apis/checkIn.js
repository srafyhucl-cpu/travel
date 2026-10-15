/**
 * checkIn：对行程项打卡（写）。
 * action：arrived（到达）/ departed（出发、离开）/ done（完成）。
 * nodeId 必须来自上游查询接口的原文，先查后打，不猜。
 */
const { load, findNode, drop } = require('../../../lib/snapshot.js');
const { request } = require('../../../lib/net.js');
const { localWhenText } = require('../../../lib/present.js');
const { fail } = require('../../../lib/respond.js');

const ACTIONS = { arrived: '到达', departed: '出发/离开', done: '完成' };

async function checkIn({ nodeId, action } = {}) {
  const id = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!id) {
    return fail(
      '缺少 nodeId。nodeId 必须取自 getDaySchedule / findItems / getTodos 返回的原文，不能从用户的话里猜。请先查当天或搜索行程，拿到 nodeId 后再打卡。'
    );
  }
  if (!ACTIONS[action]) {
    return fail('action 必须是 arrived（到达）/ departed（出发/离开）/ done（完成）之一，请按用户的意思选一个再调用。');
  }

  const snap = await load();
  const node = findNode(snap, id);
  if (!node) {
    return fail(
      '没有找到这个行程项（nodeId 可能过期或不对）。请重新用 getDaySchedule / findItems 查一次，拿最新的 nodeId 再打卡；不要编造 nodeId。'
    );
  }

  if (action === 'done' && node.status === 'done') {
    return {
      isError: false,
      content: [{
        type: 'text',
        text: `「${node.title}」已经是完成状态，不需要重复打卡。请如实告诉用户这一项早就完成了，不要再重复调用本接口。`,
      }],
      structuredContent: { nodeId: node.id, title: node.title, action, alreadyDone: true },
    };
  }

  const row = await request('POST', '/api/checkins', { nodeId: node.id, action });
  drop();

  return {
    isError: false,
    content: [{
      type: 'text',
      text:
        `已为「${node.title}」打卡「${ACTIONS[action]}」（${localWhenText(row && row.at_time)}）。` +
        `请用一句话向用户确认打卡成功${action === 'done' ? '，并祝贺完成这一项' : ''}；不要重复调用本接口。`,
    }],
    structuredContent: {
      nodeId: node.id,
      title: node.title,
      date: node.date,
      action,
      actionText: ACTIONS[action],
      at: row && row.at_time,
    },
    handoff: { query: `date=${node.date}` },
  };
}

module.exports = checkIn;
