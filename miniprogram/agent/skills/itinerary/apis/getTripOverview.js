/**
 * getTripOverview：旅行概览（只读）。
 * 用户问「这次旅行是什么安排 / 玩到哪天了 / 还剩多少」时的第一入口。
 */
const { load, timelineNodes } = require('../../../lib/snapshot.js');
const { dayTextOf, timeRangeText } = require('../../../lib/present.js');
const { todayStr } = require('../../../lib/core/format.js');

/** 还没结束的项里，从今天起最早的一项；全排在今天之前时退回最早的一项 */
function nextUnfinished(nodes, today) {
  const open = nodes.filter((n) => n.status !== 'done' && n.status !== 'skipped');
  return open.find((n) => n.date >= today) || open[0] || null;
}

async function getTripOverview() {
  const snap = await load();
  const trip = snap.trip || {};
  const today = todayStr();
  const nodes = timelineNodes(snap);
  const done = nodes.filter((n) => n.status === 'done').length;
  const next = nextUnfinished(nodes, today);

  const nextText = next
    ? `${dayTextOf(trip, next.date)} ${timeRangeText(next.start_time, next.end_time)}「${next.title}」`
    : '';
  const facts = [
    `旅行「${trip.name}」${trip.destination ? `，目的地 ${trip.destination}` : ''}`,
    `日期 ${trip.start_date} 至 ${trip.end_date}`,
    `共 ${nodes.length} 项安排，已完成 ${done} 项`,
    nextText ? `下一项：${nextText}` : '没有待进行的安排',
  ];

  return {
    isError: false,
    content: [{
      type: 'text',
      text: `${facts.join('；')}。请用一两句话向用户概括这些关键信息（旅行、日期范围、进度、下一项），并引导用户点击小程序卡片查看完整时间线；不要编造行程里没有的内容。`,
    }],
    structuredContent: {
      tripName: trip.name,
      destination: trip.destination || '',
      startDate: trip.start_date,
      endDate: trip.end_date,
      today: dayTextOf(trip, today),
      progress: { done, total: nodes.length, remaining: nodes.length - done },
      members: (snap.members || []).map((m) => m.name),
      nextItem: next
        ? {
            nodeId: next.id,
            title: next.title,
            dateText: dayTextOf(trip, next.date),
            timeText: timeRangeText(next.start_time, next.end_time),
            location: next.location || '',
          }
        : null,
      detailPath: '/pages/timeline/index',
      detailTitle: '查看完整时间线',
    },
    handoff: { query: '' },
  };
}

module.exports = getTripOverview;
