/**
 * 成就：从快照纯计算，不落库、零调度。条件是单调的 —— 只会从「未达成」走向
 * 「达成」，不会因为后来数据变动回退（预算类只在旅行结束后判定一次）。
 *
 * 归属：打卡/照片靠 member_id（服务端写入时落；老数据追认给创建者，见 db.js）；
 * 个人徽章按成员算，全队徽章看整趟。解锁时间尽量从数据时间戳反推，
 * 推不出来的（量入为出）为 null，UI 不显示日期。
 *
 * 本文件不许碰 DOM / 平台 —— 小程序端原样复用。
 */

/** 本地自然日："YYYY-MM-DD" */
function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function computeAchievements(data, now = new Date()) {
  const trip = data?.trip || {};
  const nodes = data?.nodes || [];
  const members = [...(data?.members || [])].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at))
  );
  const checkins = data?.checkins || [];
  const photos = data?.photos || [];
  const expenses = data?.expenses || [];
  const budgets = data?.budgets || [];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const doneCheckins = checkins
    .filter((c) => c.action === 'done' && nodeIds.has(c.node_id))
    .sort((a, b) => String(a.at_time).localeCompare(String(b.at_time)));
  const doneTimes = doneCheckins.map((c) => c.at_time);
  const total = nodes.length;
  const done = nodes.filter((n) => n.status === 'done').length;
  const nth = (arr, n) => (arr.length >= n ? arr[n - 1] : null);

  /* ------------------------------ 全队 ------------------------------ */
  const team = [];
  const T = (id, title, desc, icon, color, ok, at, progress) =>
    team.push({ id, scope: 'team', title, desc, icon, color, done: !!ok, at: at || null, progress: progress || null });

  const halfN = Math.ceil(total / 2);
  T('team-half', '行程过半', `完成 ${halfN} 项行程`, 'route', '#2F80ED',
    total > 0 && done * 2 >= total, nth(doneTimes, halfN),
    { done: Math.min(done, halfN), total: halfN });

  T('team-all', '全部完成', `全部 ${total} 项行程都完成`, 'sparkle', '#27AE60',
    total > 0 && done >= total, doneTimes.length ? doneTimes[doneTimes.length - 1] : null,
    { done, total });

  // 完美一天：某天 ≥2 项且全部完成（按日期找第一个达成的）
  const byDate = new Map();
  for (const n of nodes) {
    if (!byDate.has(n.date)) byDate.set(n.date, []);
    byDate.get(n.date).push(n);
  }
  const doneAtByNode = new Map(doneCheckins.map((c) => [c.node_id, c.at_time]));
  let perfectAt = null;
  for (const [, list] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length >= 2 && list.every((n) => n.status === 'done')) {
      perfectAt = list.map((n) => doneAtByNode.get(n.id)).filter(Boolean).sort().pop() || null;
      break;
    }
  }
  T('team-perfect-day', '完美一天', '某一天的行程全部完成', 'calendar', '#27AE60', !!perfectAt, perfectAt);

  const moduleNode = nodes.find((n) => n.role === 'module');
  const prepList = moduleNode?.checklist || [];
  const prepDone = prepList.filter((i) => i.done).length;
  const prepAt = prepList.filter((i) => i.done && i.done_at).map((i) => i.done_at).sort().pop() || null;
  T('team-prep', '准备就绪', '前置准备全部勾完', 'pack', '#7B61FF',
    prepList.length > 0 && prepDone >= prepList.length,
    prepDone >= prepList.length && prepList.length ? prepAt : null,
    { done: prepDone, total: prepList.length });

  const allChecks = nodes.flatMap((n) => n.checklist || []);
  const checksDone = allChecks.filter((i) => i.done).length;
  const checksAt = allChecks.filter((i) => i.done && i.done_at).map((i) => i.done_at).sort().pop() || null;
  T('team-checklist', '一个不落', '所有待办都勾完了', 'check', '#00897B',
    allChecks.length > 0 && checksDone >= allChecks.length,
    allChecks.length > 0 && checksDone >= allChecks.length ? checksAt : null,
    { done: checksDone, total: allChecks.length });

  const photoTimes = photos.map((p) => p.created_at).filter(Boolean).sort();
  T('team-photos-50', '影像库', '上传满 50 张照片', 'image', '#2F80ED',
    photos.length >= 50, nth(photoTimes, 50), { done: Math.min(photos.length, 50), total: 50 });

  const planned = budgets.reduce((s, b) => s + (+b.planned_amount || 0), 0);
  const spent = expenses.reduce((s, e) => s + (+e.amount || 0), 0);
  const finished = !!trip.end_date && localDay(now.toISOString()) > trip.end_date;
  T('team-budget', '量入为出', '旅行结束后没超预算', 'receipt', '#27AE60',
    finished && planned > 0 && spent <= planned, null);

  T('team-companion', '结伴同行', '至少两名成员一起走', 'user', '#E2574C',
    members.length >= 2, members[1]?.created_at || null,
    { done: Math.min(members.length, 2), total: 2 });

  /* ------------------------------ 个人 ------------------------------ */
  const byMember = {};
  for (const m of members) {
    const mine = checkins
      .filter((c) => c.member_id === m.id)
      .sort((a, b) => String(a.at_time).localeCompare(String(b.at_time)));
    const myDone = mine.filter((c) => c.action === 'done');
    const myArrivals = mine.filter((c) => c.action !== 'done');
    const myPhotos = photos
      .filter((p) => p.member_id === m.id && p.created_at)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    const list = [];
    const M = (id, title, desc, icon, color, ok, at, progress) =>
      list.push({ id, scope: 'member', title, desc, icon, color, done: !!ok, at: at || null, progress: progress || null });

    M('me-first-checkin', '出发咯', '第一次打卡', 'pin', '#F2994A', mine.length > 0, mine[0]?.at_time || null);
    M('me-first-done', '旗开得胜', '完成第一项行程', 'check', '#27AE60', myDone.length > 0, myDone[0]?.at_time || null);
    M('me-done-5', '五子登科', '完成 5 项行程', 'sparkle', '#9B51E0',
      myDone.length >= 5, nth(myDone.map((c) => c.at_time), 5),
      { done: Math.min(myDone.length, 5), total: 5 });

    // 走过三站：不同行程点
    const seen = new Set();
    let thirdAt = null;
    for (const c of myArrivals) {
      if (seen.has(c.node_id)) continue;
      seen.add(c.node_id);
      if (seen.size === 3) {
        thirdAt = c.at_time;
        break;
      }
    }
    M('me-stations-3', '走过三站', '在 3 个不同的行程点打过卡', 'route', '#2F80ED',
      seen.size >= 3, thirdAt, { done: Math.min(seen.size, 3), total: 3 });

    M('me-photo-1', '第一张照片', '上传第一张照片（算在自己名下）', 'camera', '#2F80ED',
      myPhotos.length > 0, myPhotos[0]?.created_at || null);
    M('me-photo-10', '十张照片', '上传 10 张照片', 'image', '#9B51E0',
      myPhotos.length >= 10, nth(myPhotos.map((p) => p.created_at), 10),
      { done: Math.min(myPhotos.length, 10), total: 10 });

    // 三日影像：不同日期都拍过（按本地自然日算）
    const days = new Set();
    let thirdDayAt = null;
    for (const p of myPhotos) {
      const d = localDay(p.created_at);
      if (days.has(d)) continue;
      days.add(d);
      if (days.size === 3) {
        thirdDayAt = p.created_at;
        break;
      }
    }
    M('me-photo-days-3', '三日影像', '有 3 天都拍了照片', 'calendar', '#00897B',
      days.size >= 3, thirdDayAt, { done: Math.min(days.size, 3), total: 3 });

    const early = mine.find((c) => {
      const d = new Date(c.at_time);
      return !Number.isNaN(d.getTime()) && d.getHours() < 7;
    });
    M('me-early', '早起鸟', '早上 7 点前打过卡', 'clock', '#F2994A', !!early, early?.at_time || null);

    byMember[m.id] = list;
  }

  return { team, byMember, memberList: members };
}
