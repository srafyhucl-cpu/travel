/**
 * 「我现在该在哪」的推算逻辑。纯函数、无依赖，小程序版可直接复用。
 * 「我现在该在哪」的推算逻辑。纯函数、无依赖，小程序版可直接复用。
 *
 * 判定优先级：
 *   1. 打卡记录优先于计划时间 —— 你实际到了哪，就是哪
 *   2. 没有打卡时，退回按计划时间推算
 *   3. 打卡显示落后于计划时，算出「晚了多久」并建议顺延
 */
import { toMinutes, todayStr, daysBetween, typeMeta } from './format.js';

/** ISO 时间 -> 本地当天分钟数 */
export function isoToLocalMinutes(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

function bySort(a, b) {
  // 顺序听人的，不听时间的。用户拖成什么样就是什么样，时间只是这一项的标签。
  // 服务端已经把 sort_order 重排成一条贯穿全程的全局序列，这里只按它排。
  return (a.sort_order ?? 0) - (b.sort_order ?? 0);
}

export function groupByDate(nodes) {
  const map = new Map();
  for (const n of nodes || []) {
    if (!map.has(n.date)) map.set(n.date, []);
    map.get(n.date).push(n);
  }
  for (const arr of map.values()) arr.sort(bySort);
  return map;
}

/** 给每个节点算出"实际时间"和"落后分钟数" */
export function decorate(nodes, checkins) {
  const checkinByNode = new Map();
  for (const c of checkins || []) {
    if (!checkinByNode.has(c.node_id)) checkinByNode.set(c.node_id, []);
    checkinByNode.get(c.node_id).push(c);
  }

  return nodes.map((n) => {
    const list = (checkinByNode.get(n.id) || []).slice().sort((a, b) => a.at_time.localeCompare(b.at_time));
    const arrived = list.find((c) => c.action === 'arrived' || c.action === 'departed');
    const done = list.find((c) => c.action === 'done');

    const plannedStart = toMinutes(n.start_time);
    const plannedEnd = toMinutes(n.end_time);

    const actualStartMin = arrived ? isoToLocalMinutes(arrived.at_time) : n.actual_start ? isoToLocalMinutes(n.actual_start) : null;
    const actualEndMin = done ? isoToLocalMinutes(done.at_time) : n.actual_end ? isoToLocalMinutes(n.actual_end) : null;

    // 迟到：实际开始 - 计划开始。正数表示晚了
    const delayMinutes =
      plannedStart !== null && actualStartMin !== null ? actualStartMin - plannedStart : null;

    return {
      ...n,
      checkins: list,
      actualStartMin,
      actualEndMin,
      plannedStart,
      plannedEnd,
      delayMinutes,
      isDone: n.status === 'done' || !!done,
      isStarted: !!arrived || actualStartMin !== null,
      isSkipped: n.status === 'skipped',
    };
  });
}

/**
 * 主推算函数。
 * 返回值包含给首页大卡片用的所有信息。
 */
export function computeNow({ trip, nodes = [], checkins = [] }, now = new Date()) {
/*
 * 时间线上的日期序列 = 行程的起止区间 ∪ 实际有安排的日期。
 * 整天顺延把后面挪走以后，中间空出来的那天不会凭空消失，「第 N 天」也不会错位。
 */
function fullDateRange(startDate, endDate, extra) {
  const set = new Set(extra);
  if (startDate && endDate) {
    const span = daysBetween(startDate, endDate);
    for (let i = 0; i <= span; i++) set.add(shiftDate(startDate, i));
  }
  return [...set].sort();
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

  const today = todayStr(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const startDate = trip?.start_date;
  const endDate = trip?.end_date;

  // 行程还没开始 → 聚焦第一天，做倒计时
  // 行程已结束 → 聚焦最后一天，回顾模式
  let focusDate;
  let phase;
  if (startDate && today < startDate) {
    focusDate = startDate;
    phase = 'upcoming';
  } else if (endDate && today > endDate) {
    focusDate = endDate;
    phase = 'finished';
  } else {
    focusDate = today;
    phase = 'active';
  }

  const byDate = groupByDate(nodes);
  // 空白日也留着：整天顺延之后会空出一天，而且空白天正是拖拽要落进去的地方
  const allDates = fullDateRange(startDate, endDate, byDate.keys());
  const dayNodes = (byDate.get(focusDate) || []).map((n) => decorate([n], checkins)[0]);

  const dayNumber = startDate ? daysBetween(startDate, focusDate) + 1 : 1;
  const totalDays = startDate && endDate ? daysBetween(startDate, endDate) + 1 : allDates.length;

  // 今天的（已装饰的）全部节点
  const allDecorated = decorate(nodes, checkins);
  const decoratedByDate = groupByDate(allDecorated);

  // 找出"你实际在哪"：最后一个已开始但未完成的节点
  const startedToday = dayNodes.filter((n) => n.isStarted && !n.isDone && !n.isSkipped);
  const currentNode = startedToday.length ? startedToday[startedToday.length - 1] : null;

  // 还没打卡时，按计划时间找当前节点
  let plannedCurrent = null;
  if (!currentNode) {
    plannedCurrent =
      dayNodes.find((n) => {
        if (n.isDone || n.isSkipped || n.plannedStart === null) return false;
        const end = n.plannedEnd ?? n.plannedStart + 90;
        return nowMin >= n.plannedStart && nowMin < end;
      }) || null;
  }

  const activeNode = currentNode || plannedCurrent;

  const pending = dayNodes.filter((n) => !n.isDone && !n.isSkipped && !n.isStarted);
  const nextNode = pending.length ? pending[0] : null;
  const nextIndex = activeNode ? dayNodes.indexOf(activeNode) : -1;
  const followingNodes = nextIndex >= 0 ? dayNodes.slice(nextIndex + 1).filter((n) => !n.isDone && !n.isSkipped) : pending;

  const doneCount = dayNodes.filter((n) => n.isDone).length;
  const totalCount = dayNodes.length;

  // 落后多久
  let delayMinutes = null;
  if (activeNode?.delayMinutes != null && activeNode.delayMinutes > 0) {
    delayMinutes = activeNode.delayMinutes;
  } else if (activeNode?.isStarted && activeNode.plannedEnd !== null && nowMin - activeNode.plannedEnd > 15) {
    delayMinutes = nowMin - activeNode.plannedEnd;
  }

  // 建议顺延：落后 20 分钟以上，且后面还有带时间的安排
  const shiftable = followingNodes.filter((n) => n.plannedStart !== null && !n.isSkipped);
  const suggestShift = delayMinutes !== null && delayMinutes >= 20 && shiftable.length > 0
    ? { minutes: Math.round(delayMinutes / 5) * 5, count: shiftable.length, fromNodeId: shiftable[0].id }
    : null;

  /* ------------------------- 组织成一句话 ------------------------- */
  let headline;
  let subline;
  let tone = 'normal'; // normal | active | warn | done | upcoming

  if (phase === 'upcoming') {
    const days = daysBetween(today, startDate);
    const firstNode = (decoratedByDate.get(startDate) || [])[0];
    tone = 'upcoming';
    headline = days === 0 ? '今天出发' : days === 1 ? '明天出发' : `${days} 天后出发`;
    subline = firstNode
      ? `${firstNode.start_time || ''} ${firstNode.title}`.trim()
      : '行程已就绪';
  } else if (phase === 'finished') {
    tone = 'done';
    headline = '这趟旅行结束了';
    const last = dayNodes[dayNodes.length - 1];
    subline = last ? `最后一项：${last.title}` : '';
  } else if (!totalCount) {
    tone = 'normal';
    headline = '今天没有安排';
    subline = '可以自己加一项';
  } else if (activeNode) {
    tone = 'active';
    headline = `你现在应该在：${activeNode.title}`;
    subline = activeNode.location || '';
  } else if (nextNode && nextNode.plannedStart !== null && nextNode.plannedStart > nowMin) {
    tone = 'normal';
    const gap = nextNode.plannedStart - nowMin;
    headline = gap <= 60 ? `还有 ${gap} 分钟：${nextNode.title}` : `下一个：${nextNode.title}`;
    subline = `${nextNode.start_time} 开始`;
  } else if (doneCount === totalCount) {
    tone = 'done';
    headline = '今天的安排都完成了';
    subline = '好好休息';
  } else {
    tone = 'normal';
    headline = '当前没有进行中的安排';
    subline = nextNode ? `下一项：${nextNode.title}` : '';
  }

  return {
    phase,
    today,
    focusDate,
    dayNumber,
    totalDays,
    nowMin,
    dayNodes,
    allDates,
    decoratedByDate,
    currentNode: activeNode,
    nextNode,
    followingNodes,
    doneCount,
    totalCount,
    delayMinutes,
    suggestShift,
    headline,
    subline,
    tone,
  };
}

/**
 * 下一项提醒：按类型的提前量，在「该出发了」的时刻给出提醒。
 * （这一段原来只开了个头 `/**`、没有正文也没有收尾，把整个函数吞进了注释里，
 *   文件能跑、函数却是死的 —— 补成正常的文档注释。）
 */
export function nextReminder({ trip, nodes = [], checkins = [], vocab = null }, now = new Date()) {
  const state = computeNow({ trip, nodes, checkins }, now);
  if (state.phase !== 'active') return null;

  const candidates = [];
  for (const list of state.decoratedByDate.values()) {
    for (const n of list) {
      if (n.isDone || n.isSkipped || n.plannedStart === null) continue;
const lead = typeMeta(vocab, n.type).leadMinutes ?? 30;
      const fireAt = n.plannedStart - lead;
      if (nowMinOf(now) >= fireAt && nowMinOf(now) < n.plannedStart) {
        candidates.push({ node: n, lead, fireAt, urgency: 1 - (nowMinOf(now) - fireAt) / lead });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.fireAt - b.fireAt);
  return candidates[0];
}

function nowMinOf(now) {
  return now.getHours() * 60 + now.getMinutes();
}

/** 时间线里每个节点该显示成什么状态 */
export function nodeState(node, state) {
  if (node.isSkipped) return 'skipped';
  if (node.isDone) return 'done';
  if (state.currentNode?.id === node.id) return 'current';
  if (node.isStarted) return 'started';
  return 'upcoming';
}
