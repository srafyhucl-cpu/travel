/**
 * getDaySchedule：查看某一天的行程安排（只读）。
 * date 缺省 = 今天；「明天」「第 3 天」由模型换算成 YYYY-MM-DD 再传。
 */
const { load, nodesOn } = require('../../../lib/snapshot.js');
const {
  dayTextOf,
  timeRangeText,
  statusTextOf,
  checklistTextOf,
  typeLabelOf,
} = require('../../../lib/present.js');
const { todayStr } = require('../../../lib/core/format.js');
const { fail } = require('../../../lib/respond.js');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function getDaySchedule({ date } = {}) {
  const day = date === undefined || date === null || date === '' ? todayStr() : String(date).trim();
  if (!DATE_RE.test(day)) {
    return fail(
      `日期「${date}」的格式不对。请把用户说的「今天/明天/第 N 天」换算成 YYYY-MM-DD 后重试，不要用其它写法调本接口。`
    );
  }

  const snap = await load();
  const trip = snap.trip || {};
  const dayLabel = dayTextOf(trip, day);
  const nodes = nodesOn(snap, day);
  const doneCount = nodes.filter((n) => n.status === 'done').length;

  const items = nodes.map((n) => ({
    nodeId: n.id,
    title: n.title,
    timeText: timeRangeText(n.start_time, n.end_time),
    location: n.location || '',
    typeLabel: typeLabelOf(snap.vocab, n.type),
    statusText: statusTextOf(n),
    checklistText: checklistTextOf(n),
  }));

  const structuredContent = {
    date: day,
    dayText: dayLabel,
    summary: { total: items.length, done: doneCount },
    items,
    detailPath: `/pages/timeline/index?date=${day}`,
    detailTitle: '查看当天时间线',
  };

  if (!items.length) {
    return {
      isError: false,
      content: [{
        type: 'text',
        text: `${dayLabel}没有任何安排。请如实告诉用户；如果用户想看别的日期，按他说的日期再查一次；也可以引导用户点击小程序卡片在时间线里添加安排。`,
      }],
      structuredContent,
      handoff: { query: `date=${day}` },
    };
  }

  const first = items[0];
  return {
    isError: false,
    content: [{
      type: 'text',
      text:
        `${dayLabel}共 ${items.length} 项安排，已完成 ${doneCount} 项，` +
        `最早一项 ${first.timeText}「${first.title}」。` +
        '请按时间顺序简要转述每项的时间与标题（有地点可带上），提醒哪些还没打卡；' +
        '并引导用户点击小程序卡片查看完整时间线；不要编造这一天没有的内容。',
    }],
    structuredContent,
    handoff: { query: `date=${day}` },
  };
}

module.exports = getDaySchedule;
