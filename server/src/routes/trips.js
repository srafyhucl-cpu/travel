import express from 'express';
import { db, nowISO, uid, genShortCode } from '../db.js';
import { hashPassphrase, requireAuth, requireTripAccess, extractBearerToken, verifyToken } from '../auth.js';
import { getTripSummary, getUserTrips, cloneTripLogic, createDefaultTripForUser } from '../trip-service.js';
import { broadcast } from '../events.js';

const router = express.Router();
const PALETTE = ['#E2574C', '#2F80ED', '#27AE60', '#9B51E0', '#F2994A', '#00897B'];

/** 加入行程预览：根据 8 位邀请码/只读码或口令查询行程信息与未认领成员 */
router.get('/join-preview', (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const passphrase = String(req.query.passphrase || '').trim();

  if (!code && !passphrase) {
    return res.status(400).json({ error: 'bad_request', message: '请输入邀请码或口令' });
  }

  let trip = null;
  let mode = 'editor';

  if (code) {
    // 1. 尝试匹配 8 位协作码 (editor)
    trip = db.prepare('SELECT * FROM trips WHERE invite_code = ?').get(code);
    if (trip) {
      mode = 'editor';
    } else {
      // 2. 尝试匹配 8 位只读码 (viewer)
      trip = db.prepare('SELECT * FROM trips WHERE view_code = ?').get(code);
      if (trip) {
        mode = 'viewer';
      }
    }
  }

  // 3. 尝试匹配历史口令
  if (!trip && passphrase) {
    const hash = hashPassphrase(passphrase);
    const key = db.prepare('SELECT trip_id FROM trip_keys WHERE key_hash = ?').get(hash);
    if (key) {
      trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(key.trip_id);
      mode = 'editor';
    }
  }

  if (!trip) {
    return res.status(404).json({ error: 'TRIP_NOT_FOUND', message: '未找到匹配的行程或邀请码无效' });
  }

  // 检查是否已有登录用户
  let alreadyJoined = false;
  const token = extractBearerToken(req);
  const payload = verifyToken(token);
  if (payload?.uid) {
    const existing = db.prepare('SELECT 1 FROM members WHERE trip_id = ? AND user_id = ?').get(trip.id, payload.uid);
    alreadyJoined = !!existing;
  }

  const claimableMembers = db
    .prepare('SELECT id, name, color FROM members WHERE trip_id = ? AND user_id IS NULL ORDER BY created_at')
    .all(trip.id);

  res.json({
    trip: {
      id: trip.id,
      name: trip.name,
      destination: trip.destination || '',
      startDate: trip.start_date,
      endDate: trip.end_date,
    },
    mode,
    alreadyJoined,
    claimableMembers,
  });
});

// 其余接口全部需要用户登录鉴权
router.use(requireAuth);

/** 获取当前用户的所有旅行时间线列表 */
router.get('/', (req, res) => {
  if (req.user) {
    let trips = getUserTrips(req.user.id);
    if (trips.length === 0) {
      createDefaultTripForUser(req.user.id, req.user.nickname, req.user.avatar_url);
      trips = getUserTrips(req.user.id);
    }
    const activeTripId =
      req.user.last_trip_id && trips.some((t) => t.id === req.user.last_trip_id)
        ? req.user.last_trip_id
        : trips[0]?.id || '';
    return res.json({ trips, activeTripId });
  }

  if (req.legacyAuth) {
    const t = getTripSummary(req.legacyAuth.tid, null);
    return res.json({ trips: t ? [t] : [], activeTripId: req.legacyAuth.tid });
  }

  res.json({ trips: [], activeTripId: '' });
});

/** 新建行程时间线 */
router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const destination = String(req.body?.destination || '').trim().slice(0, 60);
  const startDate = String(req.body?.startDate || '').trim();
  const endDate = String(req.body?.endDate || '').trim() || startDate;
  const theme = String(req.body?.theme || 'plain').trim().slice(0, 20);

  if (!name) {
    return res.status(400).json({ error: 'bad_request', message: '行程名称不能为空' });
  }
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: 'bad_request', message: '请提供合法的出发日期 (YYYY-MM-DD)' });
  }

  const tripId = uid();
  const now = nowISO();
  const inviteCode = genShortCode(8);
  const viewCode = genShortCode(8);
  const memberId = uid();
  const userId = req.user ? req.user.id : null;
  const userName = req.user?.nickname || '旅行者';
  const userAvatar = req.user?.avatar_url || '';

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO trips (id, name, destination, start_date, end_date, theme, is_template, owner_id, status, invite_code, view_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'ongoing', ?, ?, ?, ?)`
    ).run(tripId, name, destination, startDate, endDate, theme, userId, inviteCode, viewCode, now, now);

    db.prepare(
      `INSERT INTO members (id, trip_id, name, color, created_at, user_id, role, avatar_url)
       VALUES (?, ?, ?, '#2F80ED', ?, ?, 'owner', ?)`
    ).run(memberId, tripId, userName, now, userId, userAvatar);

    if (userId) {
      db.prepare('UPDATE users SET last_trip_id = ?, updated_at = ? WHERE id = ?').run(tripId, now, userId);
    }
  });

  tx();

  res.status(201).json({
    tripId,
    trip: getTripSummary(tripId, userId),
  });
});

/** 克隆行程（衍生备选分支 Plan B） */
router.post('/:id/clone', requireTripAccess('viewer'), (req, res) => {
  const srcTripId = req.params.id;
  const name = String(req.body?.name || '').trim();
  const startDate = String(req.body?.startDate || '').trim() || null;

  try {
    const result = cloneTripLogic({
      srcTripId,
      destName: name,
      newStartDate: startDate,
      userId: req.user ? req.user.id : null,
      userName: req.user?.nickname || req.auth?.name || '旅行者',
      userAvatar: req.user?.avatar_url || '',
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(404).json({ error: 'TRIP_NOT_FOUND', message: '源行程不存在' });
  }
});

/** 修改行程元信息（状态 / 重置分享码） */
router.patch('/:id', requireTripAccess('editor'), (req, res) => {
  const tripId = req.params.id;
  const { status, resetCodes } = req.body || {};

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return res.status(404).json({ error: 'TRIP_NOT_FOUND' });

  const now = nowISO();

  if (status !== undefined) {
    const validStatuses = ['planning', 'ongoing', 'archived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'bad_request', message: '无效的行程状态' });
    }
    db.prepare('UPDATE trips SET status = ?, updated_at = ? WHERE id = ?').run(status, now, tripId);
  }

  if (resetCodes) {
    if (req.auth.role !== 'owner') {
      return res.status(403).json({ error: 'FORBIDDEN', message: '只有创建者才能重置分享码' });
    }
    const newInviteCode = genShortCode(8);
    const newViewCode = genShortCode(8);
    db.prepare('UPDATE trips SET invite_code = ?, view_code = ?, updated_at = ? WHERE id = ?').run(
      newInviteCode,
      newViewCode,
      now,
      tripId
    );
  }

  broadcast(tripId, { type: 'trip' });
  res.json({ trip: getTripSummary(tripId, req.user?.id) });
});

/** 删除行程或退出行程 */
router.delete('/:id', (req, res) => {
  const tripId = req.params.id;
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!trip) return res.status(404).json({ error: 'TRIP_NOT_FOUND', message: '行程不存在' });

  if (!req.user) {
    // 传统口令模式直接删除
    db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
    return res.json({ deleted: true, left: false, nextTripId: '' });
  }

  const member = db.prepare('SELECT * FROM members WHERE trip_id = ? AND user_id = ?').get(tripId, req.user.id);
  if (!member) {
    return res.status(403).json({ error: 'NOT_TRIP_MEMBER', message: '您不是该行程成员' });
  }

  let deleted = false;
  let left = false;

  if (member.role === 'owner') {
    db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
    deleted = true;
  } else {
    db.prepare('DELETE FROM members WHERE id = ?').run(member.id);
    broadcast(tripId, { type: 'members' });
    left = true;
  }

  let nextTripId = '';
  const remaining = getUserTrips(req.user.id);
  if (remaining.length === 0) {
    const def = createDefaultTripForUser(req.user.id, req.user.nickname, req.user.avatar_url);
    nextTripId = def.tripId;
  } else {
    nextTripId = remaining[0].id;
  }

  db.prepare('UPDATE users SET last_trip_id = ?, updated_at = ? WHERE id = ?').run(nextTripId, nowISO(), req.user.id);

  res.json({ deleted, left, nextTripId });
});

/** 加入或认领行程 */
router.post('/join', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: '请先登录微信账号' });
  }

  const code = String(req.body?.code || '').trim().toUpperCase();
  const passphrase = String(req.body?.passphrase || '').trim();
  const claimMemberId = String(req.body?.claimMemberId || '').trim();
  const nickname = String(req.body?.nickname || '').trim().slice(0, 24);

  let trip = null;
  let targetRole = 'editor';

  if (code) {
    trip = db.prepare('SELECT * FROM trips WHERE invite_code = ?').get(code);
    if (trip) {
      targetRole = 'editor';
    } else {
      trip = db.prepare('SELECT * FROM trips WHERE view_code = ?').get(code);
      if (trip) {
        targetRole = 'viewer';
      }
    }
  }

  if (!trip && passphrase) {
    const hash = hashPassphrase(passphrase);
    const key = db.prepare('SELECT trip_id FROM trip_keys WHERE key_hash = ?').get(hash);
    if (key) {
      trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(key.trip_id);
      targetRole = 'editor';
    }
  }

  if (!trip) {
    return res.status(404).json({ error: 'TRIP_NOT_FOUND', message: '无效的邀请码或口令' });
  }

  const now = nowISO();

  // 1. 检查当前用户是否已在该行程中（幂等处理）
  const existing = db.prepare('SELECT * FROM members WHERE trip_id = ? AND user_id = ?').get(trip.id, req.user.id);
  if (existing) {
    if (existing.role === 'viewer' && targetRole === 'editor') {
      db.prepare('UPDATE members SET role = ? WHERE id = ?').run('editor', existing.id);
      broadcast(trip.id, { type: 'members' });
      existing.role = 'editor';
    }
    db.prepare('UPDATE users SET last_trip_id = ?, updated_at = ? WHERE id = ?').run(trip.id, now, req.user.id);
    return res.json({ tripId: trip.id, role: existing.role, memberId: existing.id });
  }

  let finalMemberId = '';
  let finalRole = targetRole;

  const tx = db.transaction(() => {
    // 2. 若指定认领虚拟成员且目标为 editor 权限
    if (claimMemberId && targetRole === 'editor') {
      const claimable = db
        .prepare('SELECT * FROM members WHERE id = ? AND trip_id = ? AND user_id IS NULL')
        .get(claimMemberId, trip.id);
      if (claimable) {
        db.prepare(
          `UPDATE members
           SET user_id = ?, avatar_url = ?, name = COALESCE(NULLIF(?, ''), name)
           WHERE id = ?`
        ).run(req.user.id, req.user.avatar_url || '', nickname || req.user.nickname, claimable.id);
        finalMemberId = claimable.id;
        finalRole = claimable.role || 'editor';
        return;
      }
    }

    // 3. 作为新成员加入
    finalMemberId = uid();
    const count = db.prepare('SELECT COUNT(*) as c FROM members WHERE trip_id = ?').get(trip.id)?.c || 0;
    const memberName = nickname || req.user.nickname || '旅行者';
    db.prepare(
      `INSERT INTO members (id, trip_id, name, color, created_at, user_id, role, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      finalMemberId,
      trip.id,
      memberName,
      PALETTE[count % PALETTE.length],
      now,
      req.user.id,
      targetRole,
      req.user.avatar_url || ''
    );
  });

  tx();

  broadcast(trip.id, { type: 'members' });
  db.prepare('UPDATE users SET last_trip_id = ?, updated_at = ? WHERE id = ?').run(trip.id, now, req.user.id);

  res.json({
    tripId: trip.id,
    role: finalRole,
    memberId: finalMemberId,
    claimedMemberId: claimMemberId ? finalMemberId : null,
  });
});

export default router;
