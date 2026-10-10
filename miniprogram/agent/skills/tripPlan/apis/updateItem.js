/**
 * updateItem：修改已有行程项（写）。
 *
 * 两条硬规则写在实现里：
 *   1) 只改用户明确提到的字段 —— payload 只由本次传入的字段拼成，没传的一律不动
 *      （比如只改开始时间时，结束时间保持原样，不顺手补齐）；
 *   2) nodeId 必须来自上游查询的原文 —— 先查后改，防止改错对象。
 * 成功文案只复述实际提交的字段，模型照说即可，不会编没改过的内容。
 */
const { load, findNode, drop } = require('../../../lib/snapshot.js');
const { request } = require('../../../lib/net.js');
const { dayTextOf, timeRangeText } = require('../../../lib/present.js');
const { fail } = require('../../../lib/respond.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const MAX_TITLE = 80;
const MAX_LOCATION = 120;
const MAX_NOTES = 2000;

async function updateItem({ nodeId, title, date, startTime, endTime, location, notes } = {}) {
  const id = typeof nodeId === 'string' ? nodeId.trim() : '';
  if (!id) {
    return fail('缺少 nodeId。nodeId 必须取自 getDaySchedule / findItems 返回的原文，不能从用户的话里猜。请先查询拿到 nodeId 再修改。');
  }

  const snap = await load();
  const trip = snap.trip || {};
  const node = findNode(snap, id);
  if (!node) {
    return fail('没有找到这个行程项（nodeId 可能过期或不对）。请先用 findItems（知道名称）或 getDaySchedule（知道哪天）查一次，拿到最新的 nodeId 再修改；不要编造 nodeId。');
  }

  const payload = {};

  if (date !== undefined) {
    const v = typeof date === 'string' ? date.trim() : '';
    if (!DATE_RE.test(v)) {
      return fail(`日期「${date}」的格式不对。请把用户说的日期先换算成 YYYY-MM-DD 再改，不要用其它写法。`);
    }
    payload.date = v;
  }

  if (title !== undefined) {
    const v = typeof title === 'string' ? title.trim() : '';
    if (!v) {
      return fail('标题不能为空。请把用户要改成的名称原文传进 title；用户没说名称时先问清楚。');
    }
    if (v.length > MAX_TITLE) {
      return fail(`标题太长（最多 ${MAX_TITLE} 字）。请精简后再改。`);
    }
    payload.title = v;
  }

  if (startTime !== undefined) {
    const v = typeof startTime === 'string' ? startTime.trim() : '';
    if (!TIME_RE.test(v)) {
      return fail(`开始时间「${startTime}」的格式不对，应为 24 小时制 HH:mm（如 09:00）。请换算后再改，只改开始时间时不要传结束时间。`);
    }
    payload.startTime = v;
  }

  if (endTime !== undefined) {
    const v = typeof endTime === 'string' ? endTime.trim() : '';
    if (!TIME_RE.test(v)) {
      return fail(`结束时间「${endTime}」的格式不对，应为 24 小时制 HH:mm（如 11:00）。请换算后再改，只改结束时间时不要传开始时间。`);
    }
    payload.endTime = v;
  }

  if (location !== undefined) {
    const v = typeof location === 'string' ? location.trim() : '';
    if (!v || v.length > MAX_LOCATION) {
      return fail(`地点不合法（应为 1~${MAX_LOCATION} 字的文字）。请检查后重试。`);
    }
    payload.location = v;
  }

  if (notes !== undefined) {
    const v = typeof notes === 'string' ? notes.trim() : '';
    if (!v || v.length > MAX_NOTES) {
      return fail(`备注不合法（应为 1~${MAX_NOTES} 字的文字）。请检查后重试。`);
    }
    payload.notes = v;
  }

  if (Object.keys(payload).length === 0) {
    return fail('没有收到任何要修改的字段。请把用户本轮明确提到的字段（date / title / startTime / endTime / location / notes）传进来再调用本接口。');
  }

  const row = await request('PATCH', `/api/nodes/${node.id}`, payload);
  drop();

  // 服务端正常会返回更新后的完整节点；万一响应异常，用本地快照 + 本次改动拼出等价结果
  const updated = row || {
    date: payload.date !== undefined ? payload.date : node.date,
    title: payload.title !== undefined ? payload.title : node.title,
    start_time: payload.startTime !== undefined ? payload.startTime : node.start_time,
    end_time: payload.endTime !== undefined ? payload.endTime : node.end_time,
    location: payload.location !== undefined ? payload.location : node.location,
  };

  // 文案只复述本次提交过的字段；没提交的不提
  const clauses = [];
  if (payload.date !== undefined) clauses.push(`日期改为 ${dayTextOf(trip, updated.date)}`);
  if (payload.title !== undefined) clauses.push(`标题改为「${updated.title}」`);
  if (payload.startTime !== undefined || payload.endTime !== undefined) {
    clauses.push(`时间改为 ${timeRangeText(updated.start_time, updated.end_time)}`);
  }
  if (payload.location !== undefined) clauses.push(`地点改为「${updated.location || ''}」`);
  if (payload.notes !== undefined) clauses.push('备注已更新');

  return {
    isError: false,
    content: [{
      type: 'text',
      text: `已更新「${node.title}」：${clauses.join('，')}。请如实告知用户这次改动；只复述上面列出的字段，不要编造没改过的内容。`,
    }],
    structuredContent: {
      nodeId: node.id,
      title: updated.title,
      date: updated.date,
      dayText: dayTextOf(trip, updated.date),
      timeText: timeRangeText(updated.start_time, updated.end_time),
    },
    handoff: { query: `date=${updated.date}` },
  };
}

module.exports = updateItem;
