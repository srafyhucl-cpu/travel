import { db, nowISO, uid, genShortCode } from './db.js';
import { TRIP, NODES, BUDGETS } from './seed/yunnan.js';

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function getTripSummary(tripId, userId = null) {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return null;

  const members = db
    .prepare('SELECT id, name, color, avatar_url, user_id, role FROM members WHERE trip_id = ? ORDER BY created_at')
    .all(tripId);

  let myRole = 'viewer';
  if (userId) {
    const me = members.find((m) => m.user_id === userId);
    if (me) {
      myRole = me.role || 'editor';
    } else if (trip.owner_id === userId) {
      myRole = 'owner';
    }
  }

  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE trip_id = ?').get(tripId)?.c || 0;

  return {
    id: trip.id,
    name: trip.name,
    destination: trip.destination || '',
    startDate: trip.start_date,
    endDate: trip.end_date,
    theme: trip.theme || 'plain',
    status: trip.status || 'ongoing',
    role: myRole,
    inviteCode: myRole === 'viewer' ? null : trip.invite_code,
    invite_code: myRole === 'viewer' ? null : trip.invite_code,
    viewCode: trip.view_code,
    view_code: trip.view_code,
    memberCount: members.length,
    nodeCount,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      avatarUrl: m.avatar_url || '',
      isVirtual: !m.user_id,
      role: m.role || 'editor',
    })),
  };
}

export function getUserTrips(userId) {
  if (!userId) return [];
  const rows = db
    .prepare(
      `SELECT DISTINCT t.id FROM trips t
       JOIN members m ON m.trip_id = t.id
       WHERE m.user_id = ?
       ORDER BY t.created_at DESC`
    )
    .all(userId);
  return rows.map((r) => getTripSummary(r.id, userId)).filter(Boolean);
}

function resetChecklist(clJson) {
  if (!clJson) return null;
  try {
    const list = JSON.parse(clJson);
    if (Array.isArray(list)) {
      const resetList = list.map((item) => {
        if (typeof item === 'string') return { text: item, done: false };
        return { ...item, done: false };
      });
      return JSON.stringify(resetList);
    }
  } catch {}
  return clJson;
}

export function cloneTripLogic({ srcTripId, destName, newStartDate, userId, userName = '旅行者', userAvatar = '' }) {
  const src = db.prepare('SELECT * FROM trips WHERE id = ?').get(srcTripId);
  if (!src) throw new Error('Source trip not found');

  const now = nowISO();
  const destTripId = uid();
  const memberId = uid();
  const inviteCode = genShortCode(8);
  const viewCode = genShortCode(8);

  const startDate = newStartDate || src.start_date;
  const dayShift = newStartDate ? daysBetween(src.start_date, newStartDate) : 0;
  const endDate = dayShift ? addDays(src.end_date, dayShift) : src.end_date;

  const srcNodes = db.prepare('SELECT * FROM nodes WHERE trip_id = ? ORDER BY sort_order').all(srcTripId);
  const srcBudgets = db.prepare('SELECT * FROM budgets WHERE trip_id = ? ORDER BY sort_order').all(srcTripId);

  const tx = db.transaction(() => {
    // 1. 创建新行程
    db.prepare(
      `INSERT INTO trips (id, name, destination, start_date, end_date, theme, is_template, owner_id, status, invite_code, view_code, forked_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'ongoing', ?, ?, ?, ?, ?)`
    ).run(
      destTripId,
      destName || `${src.name} (Plan B)`,
      src.destination,
      startDate,
      endDate,
      src.theme || 'plain',
      userId,
      inviteCode,
      viewCode,
      srcTripId,
      now,
      now
    );

    // 2. 添加当前用户为 owner 成员
    db.prepare(
      `INSERT INTO members (id, trip_id, name, color, created_at, user_id, role, avatar_url)
       VALUES (?, ?, ?, '#2F80ED', ?, ?, 'owner', ?)`
    ).run(memberId, destTripId, userName, now, userId, userAvatar || '');

    // 3. 克隆 nodes
    const insNode = db.prepare(
      `INSERT INTO nodes (id, trip_id, day_index, date, type, title, start_time, end_time, location,
                          nav_keyword, lat, lng, notes, checklist, transport_minutes, sort_order, status,
                          actual_start, actual_end, role, created_at, updated_at)
       VALUES (@id, @trip_id, @day_index, @date, @type, @title, @start_time, @end_time, @location,
               @nav_keyword, @lat, @lng, @notes, @checklist, @transport_minutes, @sort_order, 'planned',
               NULL, NULL, @role, @created_at, @updated_at)`
    );

    for (const n of srcNodes) {
      const shiftedDate = dayShift ? addDays(n.date, dayShift) : n.date;
      insNode.run({
        ...n,
        id: uid(),
        trip_id: destTripId,
        date: shiftedDate,
        checklist: resetChecklist(n.checklist),
        created_at: now,
        updated_at: now,
      });
    }

    // 4. 克隆 budgets
    const insBudget = db.prepare(
      `INSERT INTO budgets (id, trip_id, category, vocab_key, planned_amount, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const b of srcBudgets) {
      insBudget.run(uid(), destTripId, b.category, b.vocab_key, b.planned_amount, b.sort_order);
    }
  });

  tx();

  return {
    tripId: destTripId,
    trip: getTripSummary(destTripId, userId),
  };
}

export function getTodayDateStr() {
  const d = new Date();
  const offset = 8 * 60; // Asia/Shanghai UTC+8
  const localDate = new Date(d.getTime() + (d.getTimezoneOffset() + offset) * 60000);
  return localDate.toISOString().slice(0, 10);
}

export function createDefaultTripForUser(userId, userName = '旅行者', userAvatar = '') {
  const today = getTodayDateStr();
  const startDate = addDays(today, 7);
  const endDate = addDays(today, 10);
  const seedStart = TRIP.startDate || '2026-10-01';

  const now = nowISO();
  const tripId = uid();
  const memberId = uid();
  const inviteCode = genShortCode(8);
  const viewCode = genShortCode(8);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO trips (id, name, destination, start_date, end_date, theme, is_template, owner_id, status, invite_code, view_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'planning', ?, ?, ?, ?)`
    ).run(
      tripId,
      '大理丽江 4 日游 (示例)',
      TRIP.destination,
      startDate,
      endDate,
      TRIP.theme || 'plain',
      userId,
      inviteCode,
      viewCode,
      now,
      now
    );

    db.prepare(
      `INSERT INTO members (id, trip_id, name, color, created_at, user_id, role, avatar_url)
       VALUES (?, ?, ?, '#E2574C', ?, ?, 'owner', ?)`
    ).run(memberId, tripId, userName, now, userId, userAvatar || '');

    const ins = db.prepare(
      `INSERT INTO nodes (id, trip_id, day_index, date, type, title, start_time, end_time, location, nav_keyword,
                          notes, checklist, transport_minutes, sort_order, status, actual_start, actual_end,
                          created_at, updated_at)
       VALUES (@id, @trip_id, @day_index, @date, @type, @title, @start_time, @end_time, @location, @nav_keyword,
               @notes, @checklist, @transport_minutes, @sort_order, 'planned', NULL, NULL, @created_at, @updated_at)`
    );

    NODES.forEach((n, idx) => {
      const dayDiff = daysBetween(seedStart, n.date);
      const shiftedDate = addDays(startDate, dayDiff);
      ins.run({
        id: uid(),
        trip_id: tripId,
        day_index: 0,
        date: shiftedDate,
        type: n.type,
        title: n.title,
        start_time: n.startTime || null,
        end_time: n.endTime || null,
        location: n.location || null,
        nav_keyword: n.navKeyword || null,
        notes: n.notes || null,
        checklist: n.checklist ? JSON.stringify(n.checklist.map((t) => ({ text: t, done: false }))) : null,
        transport_minutes: n.transportMinutes || 0,
        sort_order: idx * 10,
        created_at: now,
        updated_at: now,
      });
    });

    const insB = db.prepare(
      `INSERT INTO budgets (id, trip_id, category, planned_amount, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    );
    BUDGETS.forEach((b, idx) => {
      insB.run(uid(), tripId, b.category, b.amount, idx * 10);
    });
  });

  tx();

  if (userId) {
    db.prepare('UPDATE users SET last_trip_id = ?, updated_at = ? WHERE id = ?').run(tripId, nowISO(), userId);
  }

  return {
    tripId,
    trip: getTripSummary(tripId, userId),
  };
}
