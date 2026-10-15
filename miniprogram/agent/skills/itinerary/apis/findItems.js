/**
 * findItems：在整趟行程里按关键词搜行程项（只读）。
 * 关键词匹配标题、地点、备注；也用于「用户提到某个活动」时拿到 nodeId。
 */
const { load, timelineNodes } = require('../../../lib/snapshot.js');
const { dayTextOf, timeRangeText, statusTextOf } = require('../../../lib/present.js');
const { fail } = require('../../../lib/respond.js');

const MAX_RESULTS = 20;
const MAX_KEYWORD = 50;

async function findItems({ keyword, onlyRemaining } = {}) {
  const kw = typeof keyword === 'string' ? keyword.trim().slice(0, MAX_KEYWORD) : '';
  if (!kw) {
    return fail(
      '缺少搜索关键词。请把用户想找的名称/地点原文作为 keyword 传入；用户没有说具体对象时，改用 getDaySchedule（看某天）或 getTripOverview（看全貌）。'
    );
  }

  const snap = await load();
  const trip = snap.trip || {};
  const needle = kw.toLowerCase();
  const matched = timelineNodes(snap).filter((n) => {
    if (onlyRemaining === true && n.status === 'done') return false;
    const hay = `${n.title || ''} ${n.location || ''} ${n.notes || ''}`.toLowerCase();
    return hay.includes(needle);
  });

  if (!matched.length) {
    return fail(
      `没有找到与「${kw}」相关的行程项（已在标题、地点、备注里查找）。请如实告知用户没有找到；建议换个关键词，或点击小程序卡片在时间线里查看、手动添加；不要用相同关键词重复调用本接口。`
    );
  }

  const items = matched.slice(0, MAX_RESULTS).map((n) => ({
    nodeId: n.id,
    title: n.title,
    dateText: dayTextOf(trip, n.date),
    timeText: timeRangeText(n.start_time, n.end_time),
    location: n.location || '',
    statusText: statusTextOf(n),
  }));

  const single = matched.length === 1;
  return {
    isError: false,
    content: [{
      type: 'text',
      text:
        `找到 ${matched.length} 项与「${kw}」相关的安排` +
        `${matched.length > items.length ? `（只先列出最早的 ${items.length} 项）` : ''}。` +
        '请按日期顺序简要转述每项（日期、时间、标题），并引导用户点击小程序卡片查看完整时间线；不要编造结果里没有的项。',
    }],
    structuredContent: {
      keyword: kw,
      total: matched.length,
      items,
      detailPath: '/pages/timeline/index',
      detailTitle: '查看完整时间线',
    },
    handoff: { query: single ? `date=${matched[0].date}` : '' },
  };
}

module.exports = findItems;
