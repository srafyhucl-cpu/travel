/**
 * createItem：新建一个行程项（写）。
 *
 * 校验口径与服务端保持一致（标题 80 / 地点 120 / 备注 2000 / 待办 20 条·单条 100 字），
 * 在请求前就拦下不合法参数，让模型拿到明确的修正指引，而不是被服务端静默截断。
 * payload 只带「用户确实提供」的字段：没提到的内容不替用户编，服务端会补默认值。
 */
const { load, drop } = require('../../../lib/snapshot.js');
const { request } = require('../../../lib/net.js');
const { dayTextOf, timeRangeText } = require('../../../lib/present.js');
const { fail } = require('../../../lib/respond.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const MAX_TITLE = 80;
const MAX_LOCATION = 120;
const MAX_NOTES = 2000;
const MAX_CHECKLIST_ITEMS = 20;
const MAX_CHECKLIST_ITEM = 100;

/** 可选文本归一：undefined / null / 空串都视为「没提供」；字符串去首尾空白 */
function optionalText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  return value.trim() || null;
}

async function createItem({ date, title, type, startTime, endTime, location, notes, checklist } = {}) {
  const day = typeof date === 'string' ? date.trim() : '';
  if (!DATE_RE.test(day)) {
    return fail(
      `日期「${date}」的格式不对。请把用户说的「今天/明天/第 N 天」先换算成 YYYY-MM-DD 再添加，不要用其它写法。`
    );
  }

  const name = typeof title === 'string' ? title.trim() : '';
  if (!name) {
    return fail('缺少标题。请把用户要添加的安排名称原文放进 title；用户没说名称时先问清楚，不要自己取一个。');
  }
  if (name.length > MAX_TITLE) {
    return fail(`标题太长（最多 ${MAX_TITLE} 字）。请精简后再添加，不要截断后当作添加成功。`);
  }

  const start = optionalText(startTime);
  if (start !== null && !(typeof start === 'string' && TIME_RE.test(start))) {
    return fail(`开始时间「${startTime}」的格式不对，应为 24 小时制 HH:mm（如 09:00）。请换算后重试。`);
  }
  const end = optionalText(endTime);
  if (end !== null && !(typeof end === 'string' && TIME_RE.test(end))) {
    return fail(`结束时间「${endTime}」的格式不对，应为 24 小时制 HH:mm（如 11:00）。请换算后重试。`);
  }

  const kind = optionalText(type);
  if (kind !== null && typeof kind !== 'string') {
    return fail('type 必须是类型 key 字符串（如 train / spot / food）；没有把握时不要传。');
  }

  const loc = optionalText(location);
  if (loc !== null && (typeof loc !== 'string' || loc.length > MAX_LOCATION)) {
    return fail(`地点不合法（应为不超过 ${MAX_LOCATION} 字的文字）。请精简后重试。`);
  }

  const note = optionalText(notes);
  if (note !== null && (typeof note !== 'string' || note.length > MAX_NOTES)) {
    return fail(`备注不合法（应为不超过 ${MAX_NOTES} 字的文字）。请精简后重试。`);
  }

  let todos = null;
  if (checklist !== undefined && checklist !== null) {
    if (!Array.isArray(checklist)) {
      return fail('checklist 必须是字符串数组，每项是一条待办的文字（如 ["充电宝", "身份证"]）。');
    }
    const texts = [];
    for (const it of checklist) {
      if (typeof it !== 'string') {
        return fail('checklist 的每一项都必须是文字（字符串），请检查后重试。');
      }
      const text = it.trim();
      if (!text) continue; // 空串直接过滤掉
      if (text.length > MAX_CHECKLIST_ITEM) {
        return fail(`待办「${text}」太长（单条最多 ${MAX_CHECKLIST_ITEM} 字）。请精简后重试。`);
      }
      texts.push(text);
    }
    if (texts.length > MAX_CHECKLIST_ITEMS) {
      return fail(`待办太多（最多 ${MAX_CHECKLIST_ITEMS} 条）。请精简后再添加，或先添加本项、待办后续在小程序里补。`);
    }
    if (texts.length) todos = texts;
  }

  // 先拿快照里的旅行信息：成功文案用「第 N 天」这种用户口径（出发前/行程结束后也能如实说）
  const snap = await load();
  const trip = snap.trip || {};

  const body = { date: day, title: name };
  if (typeof kind === 'string' && kind) body.type = kind;
  if (start !== null) body.startTime = start;
  if (end !== null) body.endTime = end;
  if (typeof loc === 'string') body.location = loc;
  if (typeof note === 'string') body.notes = note;
  if (todos) body.checklist = todos;

  const row = await request('POST', '/api/nodes', body);
  drop();

  const dayLabel = dayTextOf(trip, day);
  const timeText = timeRangeText(start, end);
  const addedTitle = (row && row.title) || name;

  return {
    isError: false,
    content: [{
      type: 'text',
      text: `已添加「${addedTitle}」（${dayLabel} ${timeText}）。请告知用户已加好，并引导点击小程序卡片查看当天时间线；不要编造没添加的内容。`,
    }],
    structuredContent: {
      nodeId: (row && row.id) || '',
      date: day,
      dayText: dayLabel,
      title: addedTitle,
      timeText,
      location: typeof loc === 'string' ? loc : '',
    },
    handoff: { query: `date=${day}` },
  };
}

module.exports = createItem;
