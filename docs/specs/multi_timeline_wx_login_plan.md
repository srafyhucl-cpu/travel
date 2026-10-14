# 旅行助手小程序：多时间线与微信登录工程实施规范（V3 零歧义健壮版）

> **文档目标**：本文档为可直接指导编码落地的**零歧义工程级技术规格书（Engineering Specification）**。所有文件路径、导出函数签名、本地缓存 Key、请求头、Store 状态机字段及小程序 WXML/JS 交互逻辑均 100% 对齐仓库 [srafyhucl-cpu/travel](https://www.google.com/search?q=https%3A%2F%2Fgithub.com%2Fsrafyhucl-cpu%2Ftravel) 的真实源码，重点强化**前端架构、状态竞态防护、离线队列隔离与小程序页面级代码实现**。

## 一、 现有源码基准契约（严禁偏离的命名与红线）

在执行改造时，必须严格遵守现有代码库的以下真实命名与构建契约，**严禁新建冲突的缓存 Key 或绕过单源同步脚本**：

| 模块位置 | 现有源码真实定义（[srafyhucl-cpu/travel](https://www.google.com/search?q=https%3A%2F%2Fgithub.com%2Fsrafyhucl-cpu%2Ftravel)） | 改造强制约束（零歧义规范） |
| :--- | :--- | :--- |
| **跨端单源同步**<br>`miniprogram/scripts/sync-shared.mjs` | 自动将 `web/src/core/*.js`、`web/src/store/store.js`、`web/src/store/api.js` 同步至 `miniprogram/core/` 与 `miniprogram/store/`，并用 `esbuild.transformSync` 校验语法 | **严禁直接手改 `miniprogram/core/` 和 `miniprogram/store/`**；所有对 `api.js` 与 `store.js` 的修改必须在 `web/src/store/` 中完成后运行 `node miniprogram/scripts/sync-shared.mjs` |
| **平台契约校验**<br>`miniprogram/scripts/check-platform.mjs` | 静态校验 `platform/wx/` 导出的函数名：<br>• `session`: `getToken`, `setToken`, `getTripId`, `setTripId`, `getMemberName`, `setMemberName`, `clear`<br>• `net`: `baseUrl`, `send`, `upload`, `openStream` | **直接复用现有 `getTripId()` / `setTripId(id)` 存储当前激活的行程 ID**（严禁另建 `activeTripId` 缓存 Key）；新增的 `getUser`, `setUser`, `getWxLoginCode` 必须同步写入 `web/src/platform/`、`miniprogram/platform/wx/` 及 `check-platform.mjs` |
| **会话存储 Key**<br>`miniprogram/platform/wx/session.js` | • `TOKEN_KEY = 'travel.token'`<br>• `TRIP_KEY = 'travel.trip_id'`<br>• `NAME_KEY = 'travel.member_name'` | 保持上述 3 个 Key 常量名与字符串值不变；仅新增 `USER_KEY = 'travel.user'` 存储 `{ id, nickname, avatarUrl, isProfileSet }` |
| **网络请求头**<br>`miniprogram/platform/wx/net.js` | `send()` 已自动注入请求头：<br>• `Authorization: Bearer <token>`<br>• `Trip-Id: <tripId>` | **前后端统一沿用 `Trip-Id` 请求头**（后端兼容读取 `Trip-Id` 与 `X-Trip-Id`）；扩展 `send()` 与 `upload()` 支持显式传入 `tripId` 参数覆盖默认 `session.getTripId()` |
| **本地持久化**<br>`miniprogram/platform/wx/persist.js` | • 快照：`loadSnapshot(tripId)` / `saveSnapshot(tripId, data)` 存储在 `'snap.' + tripId`<br>• 离线队列：`QUEUE_KEY = 'queue.items'` | 快照已天然按 `tripId` 分桶存储；**离线队列项入队时必须附加 `tripId` 字段**，重放时按各队列项自带的 `item.tripId` 发送请求头 |

## 二、 数据库 Schema 与幂等迁移规范（`server/src/db.js`）

### 1. 新增表与索引 DDL

在 `server/src/db.js` 初始化函数中保留全部现有表，新增 `users` 表及相关索引：

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                        -- 格式: 'usr_' + 12位随机hex
  openid TEXT UNIQUE NOT NULL,                -- 微信小程序 OpenID
  unionid TEXT DEFAULT '',                    -- 微信开放平台 UnionID (预留)
  nickname TEXT NOT NULL DEFAULT '旅行者',     -- 用户昵称
  avatar_url TEXT NOT NULL DEFAULT '',        -- 用户头像 URL
  is_profile_set INTEGER NOT NULL DEFAULT 0,  -- 0: 未主动设置头像昵称, 1: 已设置
  last_trip_id TEXT DEFAULT '',               -- 最后激活的 trip_id
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_user_id ON members(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_trip_user ON members(trip_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_invite_code ON trips(invite_code) WHERE invite_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_view_code ON trips(view_code) WHERE view_code IS NOT NULL;
```

### 2. 幂等列迁移与存量数据初始化函数

```javascript
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function migrateMultiTimelineSchema(db) {
  // 1. 扩展 trips 表
  ensureColumn(db, 'trips', 'owner_id', 'TEXT DEFAULT NULL');
  ensureColumn(db, 'trips', 'status', "TEXT NOT NULL DEFAULT 'ongoing'"); // 'planning' | 'ongoing' | 'archived'
  ensureColumn(db, 'trips', 'invite_code', 'TEXT DEFAULT NULL');          // 8位大写字母数字: 协作编辑码 (editor)
  ensureColumn(db, 'trips', 'view_code', 'TEXT DEFAULT NULL');            // 8位大写字母数字: 只读围观码 (viewer)
  ensureColumn(db, 'trips', 'forked_from', 'TEXT DEFAULT NULL');          // 克隆来源 trip_id

  // 2. 扩展 members 表
  ensureColumn(db, 'members', 'user_id', 'TEXT DEFAULT NULL');            // 关联 users.id；NULL 代表虚拟记账同伴或未认领历史成员
  ensureColumn(db, 'members', 'role', "TEXT NOT NULL DEFAULT 'editor'");  // 'owner' | 'editor' | 'viewer'
  ensureColumn(db, 'members', 'avatar_url', "TEXT NOT NULL DEFAULT ''");

  // 3. 为存量缺少分享码的行程补齐唯一邀请码与只读码
  const existingTrips = db.prepare(`SELECT id, invite_code, view_code FROM trips`).all();
  const updateCodes = db.prepare(`UPDATE trips SET invite_code = ?, view_code = ? WHERE id = ?`);
  for (const t of existingTrips) {
    if (!t.invite_code || !t.view_code) {
      updateCodes.run(t.invite_code || genShortCode(8), t.view_code || genShortCode(8), t.id);
    }
  }
}
```

## 三、 后端鉴权中间件与 API 精确契约（`server/src/`）

### 1. 双层鉴权中间件实现（`server/src/auth.js`）

通过将 `requireAuth`（认人）与 `requireTripAccess`（认行程并回填 `req.auth`）解耦，使现有的 `routes/trip.js`、`nodes.js`、`money.js`、`checkins.js`、`photos.js`、`vocab.js`、`export.js` 无需修改任何 SQL 即可按 `Trip-Id` 切换工作：

```javascript
const ROLE_WEIGHT = { viewer: 1, editor: 2, owner: 3 };

export function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: '登录已过期，请重新登录' });
  }
  if (payload.uid) {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(payload.uid);
    if (!user) return res.status(401).json({ error: 'USER_NOT_FOUND', message: '用户不存在' });
    req.user = user;
  } else if (payload.tid && payload.mid) {
    // 兼容旧版口令登录签发的 Token
    req.legacyAuth = payload;
  } else {
    return res.status(401).json({ error: 'INVALID_TOKEN', message: '无效的凭证格式' });
  }
  next();
}

export function requireTripAccess(minRole = 'viewer') {
  return (req, res, next) => {
    const tid =
      req.get('Trip-Id') ||
      req.get('X-Trip-Id') ||
      req.query.tripId ||
      req.legacyAuth?.tid ||
      req.user?.last_trip_id;

    if (!tid) {
      return res.status(400).json({ error: 'MISSING_TRIP_ID', message: '请求未指定目标行程 Trip-Id' });
    }

    const trip = db.prepare(`SELECT id, status FROM trips WHERE id = ?`).get(tid);
    if (!trip) {
      return res.status(404).json({ error: 'TRIP_NOT_FOUND', message: '目标行程不存在或已被删除' });
    }

    let member = null;
    if (req.user) {
      member = db.prepare(`SELECT * FROM members WHERE trip_id = ? AND user_id = ?`).get(tid, req.user.id);
    } else if (req.legacyAuth && req.legacyAuth.tid === tid) {
      member = db.prepare(`SELECT * FROM members WHERE id = ? AND trip_id = ?`).get(req.legacyAuth.mid, tid);
    }

    if (!member) {
      return res.status(403).json({ error: 'NOT_TRIP_MEMBER', message: '您不在该行程的成员列表中' });
    }

    const userWeight = ROLE_WEIGHT[member.role || 'editor'] || 0;
    const reqWeight = ROLE_WEIGHT[minRole] || 1;
    if (userWeight < reqWeight) {
      return res.status(403).json({ error: 'READ_ONLY_ROLE', message: '当前为只读预览权限，无法执行修改操作' });
    }

    // 关键桥接：回填 req.auth，使所有现有业务路由零改动读取 req.auth.tid 和 req.auth.mid
    req.auth = {
      tid: tid,
      mid: member.id,
      name: member.name,
      role: member.role || 'editor',
      uid: req.user ? req.user.id : null,
    };
    next();
  };
}
```

### 2. 后端 API 精确请求与响应契约

| 接口路径 | 方法 | 请求参数 | 响应结构 (200 OK) | 精确业务规则 |
| :--- | :--- | :--- | :--- | :--- |
| `/api/auth/wx-login` | `POST` | `{ code: string }` | `{ token, user: { id, nickname, avatarUrl, isProfileSet }, trips: TripSummary[], activeTripId: string }` | 1. 调微信 `jscode2session` 换取 `openid`（若未配 `WX_SECRET` 且 `code` 以 `mock_` 开头则使用 `code` 作为测试 `openid`）；<br>2. 若该用户名下尚无任何行程，自动调用内部克隆函数为其创建一条默认示例行程，确保返回的 `trips` 非空且 `activeTripId` 有效 |
| `/api/auth/profile` | `PUT` | `{ nickname: string, avatarUrl?: string }` | `{ user: { id, nickname, avatarUrl, isProfileSet: 1 } }` | 事务内更新 `users` 表，并同步执行 `UPDATE members SET name = ?, avatar_url = ? WHERE user_id = ?`，递增对应行程 `rev` |
| `/api/trips` | `GET` | 无 | `{ trips: TripSummary[], activeTripId: string }` | `TripSummary` 结构：`{ id, name, destination, startDate, endDate, theme, status, role, inviteCode, viewCode, memberCount, nodeCount, members: [{ id, name, color, avatarUrl, isVirtual }] }`（当 `role === 'viewer'` 时隐藏 `inviteCode`） |
| `/api/trips`<br>*(并兼容 `/api/auth/trips`)* | `POST` | `{ name, destination?, startDate, endDate, theme?, passphrase? }` | `{ tripId: string, trip: TripSummary }` | 新建 `trips`（生成 8 位 `invite_code` 和 `view_code`，`owner_id = req.user.id`），根据起止日期生成 `days`，将当前用户插入 `members`（`role = 'owner'`） |
| `/api/trips/:id/clone` | `POST` | `{ name: string, startDate?: string }` | `{ tripId: string, trip: TripSummary }` | 校验 `requireTripAccess('viewer')`；深拷贝源行程的 `days`（若传了新 `startDate` 则按天数偏移重算日期）、`nodes`（重置 `done = 0`）、`budgets`；清空 `expenses`、`checkins`、`photos` |
| `/api/trips/:id` | `PATCH` | `{ status?: 'planning'\|'ongoing'\|'archived', resetCodes?: boolean }` | `{ trip: TripSummary }` | 校验 `requireTripAccess('editor')`；重置分享码 `resetCodes: true` 仅允许 `owner` 执行 |
| `/api/trips/:id` | `DELETE` | 无 | `{ deleted: boolean, left: boolean, nextTripId: string }` | `owner` 调用时彻底删除该 `trips` 记录（级联清理）；`editor`/`viewer` 调用时仅删除其本人的 `members` 记录（退出行程）。若操作后用户剩余行程为空，自动生成一条空白默认行程返回其 `nextTripId` |
| `/api/trips/join-preview` | `GET` | `?code=xxx` 或 `?passphrase=xxx` | `{ trip: { id, name, destination, startDate, endDate }, mode: 'editor'\|'viewer', alreadyJoined: boolean, claimableMembers: [{ id, name, color }] }` | 匹配 `invite_code`（`mode='editor'`）、`view_code`（`mode='viewer'`）或 `trip_keys`（`mode='editor'`）；返回该行程下 `user_id IS NULL` 的虚拟/历史成员列表供认领 |
| `/api/trips/join` | `POST` | `{ code?: string, passphrase?: string, claimMemberId?: string, nickname?: string }` | `{ tripId: string, role: string, memberId: string }` | 1. 若当前 `user_id` 已在该行程 `members` 中，幂等返回（若原为 `viewer` 且本次用 `invite_code` 加入则更新 `role = 'editor'`）；<br>2. 若指定了 `claimMemberId` 且目标为 `editor`，执行 `UPDATE members SET user_id = ?, avatar_url = ? WHERE id = ? AND trip_id = ? AND user_id IS NULL`；<br>3. 否则新增一条 `members` 记录 |
| `/api/trip/members` | `POST` | `{ name: string, color?: string }` | `{ member: { id, name, color, role: 'editor', userId: null, isVirtual: true } }` | 校验 `requireTripAccess('editor')`；添加 `user_id = NULL` 的虚拟同伴供记账分摊 |
| `/api/trip/members/:id` | `DELETE` | 无 | `{ ok: true }` | 校验 `requireTripAccess('editor')`；若该成员存在关联 `expenses` 则返回 `409 { error: 'MEMBER_HAS_EXPENSES', message: '该成员名下已有记账记录，无法直接移除' }` |

## 四、 前端工程级实施规范（重中之重：精确到函数签名与代码实现）

### 1. 第一层：平台契约与网络层改造（`miniprogram/platform/wx/` & `web/src/platform/`）

#### (1) 更新 `miniprogram/scripts/check-platform.mjs`
在 `check-platform.mjs` 的 `session` 模块契约数组中加入 `'getUser'`, `'setUser'`, `'getWxLoginCode'`：
```javascript
session: [
  'getToken', 'setToken',
  'getTripId', 'setTripId',
  'getMemberName', 'setMemberName',
  'getUser', 'setUser', 'getWxLoginCode',
  'clear'
],
```

#### (2) 修改 `miniprogram/platform/wx/net.js`
在 `send` 和 `upload` 中增加可选参数 `tripId`，允许离线队列重放时指定目标行程 ID，同时保证 `openStream` 轮询携带当前 `session.getTripId()`：

```javascript
export function send({ method = 'GET', path, headers = {}, body, isForm = false, tripId = '' }) {
  const token = session.getToken();
  const targetTripId = tripId || session.getTripId();
  const reqHeaders = { ...headers };
  if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
  if (targetTripId) reqHeaders['Trip-Id'] = targetTripId;
  // ...其余 wx.request 封装逻辑保持原样
}

export function upload({ path, files = [], fields = {}, tripId = '' }) {
  const token = session.getToken();
  const targetTripId = tripId || session.getTripId();
  const reqHeaders = {};
  if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
  if (targetTripId) reqHeaders['Trip-Id'] = targetTripId;
  // ...其余 wx.uploadFile 封装逻辑保持原样
}
```

### 2. 第二层：单源 API 与离线队列隔离改造（`web/src/store/api.js`）

在 `web/src/store/api.js` 中扩展 `createApi(platform)`：

1. **离线队列项强制绑定 `tripId`**：
   * 在任何离线入队操作 `enqueue(item)` 中，强制记录生成该操作时的行程 ID：
     ```javascript
     const queueItem = {
       ...item,
       tripId: item.tripId || platform.session.getTripId(),
     };
     ```
2. **`flushQueue()` 按项绑定 `tripId` 与死信清理**：
   * 在 `flushQueue()` 发送请求时，读取 `item.tripId` 传给 `platform.net.send({ ..., tripId: item.tripId })`。
   * **死信防卡死规则**：捕获 `send` 异常或非 `2xx` 响应时：
     * 若 `res.status === 401`：触发 `onAuthFailure()`，暂停队列等待重登；
     * 若 `res.status === 400 || res.status === 403 || res.status === 404 || res.status === 409`（业务拒绝、只读权限或目标行程/节点已删除）：**立即调用 `queue.remove(item.seq)` 丢弃该条操作并继续处理后续队列**，严禁因单条失效操作阻塞整个队列！
     * 若为网络断开（`status === 0`）或服务端错误（`status >= 500`）：保留在队列中等待下次网络恢复重试。
3. **新增 API 方法列表（直接加入 `createApi` 返回的 `api` 对象）**：
   ```javascript
   wxLogin(code) {
     return request('POST', '/api/auth/wx-login', { code });
   },
   updateProfile(payload) {
     return request('PUT', '/api/auth/profile', payload);
   },
   listTrips() {
     return request('GET', '/api/trips');
   },
   createNewTrip(payload) {
     return request('POST', '/api/trips', payload);
   },
   cloneTrip(tripId, payload) {
     return request('POST', `/api/trips/${tripId}/clone`, payload);
   },
   patchTripMeta(tripId, payload) {
     return request('PATCH', `/api/trips/${tripId}`, payload);
   },
   deleteOrLeaveTrip(tripId) {
     return request('DELETE', `/api/trips/${tripId}`);
   },
   joinPreview({ code = '', passphrase = '' }) {
     const q = code
       ? `code=${encodeURIComponent(code)}`
       : `passphrase=${encodeURIComponent(passphrase)}`;
     return request('GET', `/api/trips/join-preview?${q}`);
   },
   joinTrip(payload) {
     return request('POST', '/api/trips/join', payload);
   },
   addVirtualMember(payload) {
     return request('POST', '/api/trip/members', payload);
   },
   removeMember(memberId) {
     return request('DELETE', `/api/trip/members/${memberId}`);
   },
   ```

### 3. 第三层：全局 Store 状态机精确实现（`web/src/store/store.js`）

#### (1) 状态树扩展字段
在 `web/src/store/store.js` 的 `initial` 状态对象中增加以下字段（**严禁删除或重命名原有的 `phase`, `data`, `now`, `online`, `live`, `syncing`, `pending`, `error`, `toast`, `confirm` 字段**）：

```javascript
user: null,             // { id, nickname, avatarUrl, isProfileSet } | null
trips: [],              // TripSummary[] 用户参与的所有时间线列表
activeTripId: '',       // 当前激活的 trip_id
switchingTrip: false,   // 是否正在拉取新切换行程的远端快照
pendingInviteCode: '',  // 从小程序分享卡片带入的待处理邀请码/只读码
```

#### (2) 核心生命周期与切换逻辑（防竞态、防白屏、防内存泄漏）

```javascript
let _switchSeq = 0;
let _streamHandle = null;

function stopStream() {
  if (_streamHandle && typeof _streamHandle.close === 'function') {
    _streamHandle.close();
  }
  _streamHandle = null;
}

function startStreamForTrip(tripId) {
  stopStream();
  if (!tripId || !platform.session.getToken()) return;
  _streamHandle = platform.net.openStream('/api/trip/stream', (msg) => {
    // 仅当推送属于当前激活行程时才触发刷新
    if (getState().activeTripId === tripId) {
      loadSnapshot();
    }
  });
}

// 统一只读权限守卫：在所有修改行程数据的 actions 入口处调用
function guardEditable() {
  const role = getState().data?.me?.role;
  if (role === 'viewer') {
    mutate((s) => { s.toast = { message: '当前为只读预览模式，无法修改', type: 'warn' }; });
    return false;
  }
  return true;
}

// 1. 启动引导 boot()：缓存优先 -> 静默微信登录 -> 登录页兜底
export async function boot() {
  const token = platform.session.getToken();
  const savedTripId = platform.session.getTripId();
  const savedUser = platform.session.getUser?.() || null;

  if (token && savedTripId) {
    // 优先同步加载本地快照缓存，实现 <30ms 零白屏首屏渲染
    const cached = persist?.storage?.loadSnapshot(savedTripId) || null;
    mutate((s) => {
      s.user = savedUser;
      s.activeTripId = savedTripId;
      if (cached) {
        s.data = cached;
        s.phase = 'ready';
      }
    });
    // 后台并发拉取行程列表与最新快照
    refreshTrips().catch(() => {});
    await switchTrip(savedTripId);
    return;
  }

  // 本地无 Token 时，尝试微信小程序静默登录
  if (typeof platform.session.getWxLoginCode === 'function') {
    try {
      const code = await platform.session.getWxLoginCode();
      if (code) {
        const res = await api.wxLogin(code);
        platform.session.setToken(res.token);
        platform.session.setUser?.(res.user);
        platform.session.setTripId(res.activeTripId);
        mutate((s) => {
          s.user = res.user;
          s.trips = res.trips || [];
          s.activeTripId = res.activeTripId;
        });
        await switchTrip(res.activeTripId);
        return;
      }
    } catch (e) {
      // 静默登录失败（如无网或服务端未就绪），平滑降级至 login 页
    }
  }

  mutate((s) => { s.phase = 'login'; });
}

// 2. 毫秒级安全切换时间线 switchTrip(targetTripId)
export async function switchTrip(targetTripId) {
  if (!targetTripId) return;
  const seq = ++_switchSeq;
  stopStream();
  platform.session.setTripId(targetTripId);

  // 先尝试用本地分桶快照立即替换视图（支持离线秒切）
  const cached = persist?.storage?.loadSnapshot(targetTripId) || null;
  mutate((s) => {
    s.activeTripId = targetTripId;
    s.switchingTrip = true;
    if (cached) {
      s.data = cached;
      s.phase = 'ready';
    }
  });

  try {
    const snap = await api.snapshot();
    if (seq !== _switchSeq) return; // 竞态丢弃：用户已在期间切往其他行程
    persist?.storage?.saveSnapshot(targetTripId, snap);
    mutate((s) => {
      s.data = snap;
      s.phase = 'ready';
      s.switchingTrip = false;
      s.error = null;
    });
    startStreamForTrip(targetTripId);
    flushQueue().catch(() => {});
  } catch (err) {
    if (seq !== _switchSeq) return;
    mutate((s) => { s.switchingTrip = false; });
    // 若该行程已被删除或无权限 (403/404)，自动自愈切换到剩余行程
    if (err?.status === 403 || err?.status === 404) {
      persist?.storage?.dropSnapshot(targetTripId);
      const listRes = await api.listTrips().catch(() => null);
      if (listRes?.trips?.length > 0) {
        const fallbackId = listRes.trips[0].id;
        mutate((s) => {
          s.trips = listRes.trips;
          s.toast = { message: '原行程已不可用，已自动切换', type: 'info' };
        });
        if (fallbackId !== targetTripId) await switchTrip(fallbackId);
      }
    } else if (!cached) {
      mutate((s) => { s.phase = 'login'; });
    }
  }
}
```

#### (3) `actions` 新增导出方法规范
在 `web/src/store/store.js` 的 `actions` 对象中新增以下方法，并在所有原有写方法开头加入 `if (!guardEditable()) return;`：

```javascript
export const actions = {
  // ...保留原有 login, logout, setTripInfo, addNode, updateNode 等全部方法
  switchTrip,
  async refreshTrips() {
    const res = await api.listTrips();
    mutate((s) => { s.trips = res.trips || []; });
    return res.trips;
  },
  async updateUserProfile({ nickname, avatarUrl }) {
    const res = await api.updateProfile({ nickname, avatarUrl });
    platform.session.setUser?.(res.user);
    mutate((s) => {
      s.user = res.user;
      if (s.data?.me) {
        s.data.me.name = res.user.nickname;
        s.data.me.avatarUrl = res.user.avatarUrl;
      }
      s.toast = { message: '个人资料已更新', type: 'ok' };
    });
    await loadSnapshot();
  },
  async createTrip(payload) {
    const res = await api.createNewTrip(payload);
    await actions.refreshTrips();
    await switchTrip(res.tripId);
    mutate((s) => { s.toast = { message: '新行程已创建', type: 'ok' }; });
    return res.tripId;
  },
  async cloneCurrentTrip({ name, startDate }) {
    const curId = getState().activeTripId;
    if (!curId) return;
    const res = await api.cloneTrip(curId, { name, startDate });
    await actions.refreshTrips();
    await switchTrip(res.tripId);
    mutate((s) => { s.toast = { message: '已生成备选行程分支', type: 'ok' }; });
    return res.tripId;
  },
  async patchTripStatus(tripId, status) {
    await api.patchTripMeta(tripId, { status });
    await actions.refreshTrips();
    if (tripId === getState().activeTripId) await loadSnapshot();
  },
  async deleteOrLeaveTrip(tripId) {
    const res = await api.deleteOrLeaveTrip(tripId);
    persist?.storage?.dropSnapshot(tripId);
    await actions.refreshTrips();
    if (res.nextTripId) {
      await switchTrip(res.nextTripId);
    }
    mutate((s) => {
      s.toast = { message: res.deleted ? '行程已删除' : '已退出该行程', type: 'ok' };
    });
  },
  async previewJoin({ code = '', passphrase = '' }) {
    return await api.joinPreview({ code, passphrase });
  },
  async confirmJoin({ code = '', passphrase = '', claimMemberId = '', nickname = '' }) {
    const res = await api.joinTrip({ code, passphrase, claimMemberId, nickname });
    await actions.refreshTrips();
    await switchTrip(res.tripId);
    mutate((s) => { s.toast = { message: '已加入行程', type: 'ok' }; });
    return res;
  },
  async addVirtualMember({ name, color }) {
    if (!guardEditable()) return;
    await api.addVirtualMember({ name, color });
    await loadSnapshot();
    mutate((s) => { s.toast = { message: `已添加同伴「${name}」`, type: 'ok' }; });
  },
  async removeTripMember(memberId) {
    if (!guardEditable()) return;
    await api.removeMember(memberId);
    await loadSnapshot();
    mutate((s) => { s.toast = { message: '成员已移除', type: 'ok' }; });
  },
};
```

### 4. 第四层：小程序端页面级精确改造规范（`miniprogram/pages/`）

#### (1) 首页 `miniprogram/pages/timeline/index.js` 精确改造

在保持原有 `sync()`、`buildView(s)`、节点打卡与拖拽逻辑不变的前提下，增量合入以下字段与方法：

```javascript
// 1. 在 Page({ data: { ... } }) 中新增状态字段：
tripDrawerOpen: false,        // 顶部多时间线切换抽屉开关
tripFilterTab: 'active',      // 'active' (进行中/计划中) | 'archived' (已归档)
createModalOpen: false,       // 新建/克隆行程弹窗
createMode: 'new',            // 'new' | 'clone'
tripForm: { name: '', destination: '', startDate: '', endDate: '' },
joinModalOpen: false,         // 加入/认领行程弹窗
joinCodeInput: '',
joinPreview: null,            // { trip, mode, alreadyJoined, claimableMembers }
selectedClaimId: '',          // 选中的虚拟成员 ID，'' 代表作为新成员加入
busyModal: false,

// 2. 在 onLoad(options) 中增加分享码捕获：
if (options?.inviteCode || options?.viewCode) {
  this._pendingShareCode = options.inviteCode || options.viewCode;
}

// 3. 在 sync() 中，当 s.data 就绪后同步更新多时间线与权限视图字段：
const myRole = s.data?.me?.role || 'editor';
const isReadOnly = myRole === 'viewer';
const allTrips = s.trips || [];
this.setData({
  trips: allTrips,
  activeTripId: s.activeTripId || s.data?.trip?.id || '',
  myRole,
  isReadOnly,
  switchingTrip: !!s.switchingTrip,
  user: s.user || null,
});
// 若从微信分享卡片进入且尚未处理分享码，自动拉起加入预览弹窗
if (this._pendingShareCode && s.phase === 'ready') {
  const codeToOpen = this._pendingShareCode;
  this._pendingShareCode = '';
  this.openJoinWithCode(codeToOpen);
}

// 4. 新增事件处理方法：
onToggleTripDrawer() {
  const next = !this.data.tripDrawerOpen;
  this.setData({ tripDrawerOpen: next });
  if (next) actions.refreshTrips().catch(() => {});
},

async onSelectTrip(e) {
  const id = e.currentTarget.dataset.id;
  if (!id || id === this.data.activeTripId) {
    this.setData({ tripDrawerOpen: false });
    return;
  }
  this.setData({ tripDrawerOpen: false });
  await actions.switchTrip(id);
},

onOpenCreateModal(e) {
  const mode = e.currentTarget.dataset.mode || 'new'; // 'new' | 'clone'
  const curTrip = getState().data?.trip;
  const today = new Date().toISOString().slice(0, 10);
  this.setData({
    tripDrawerOpen: false,
    createModalOpen: true,
    createMode: mode,
    tripForm: {
      name: mode === 'clone' ? `${curTrip?.name || '行程'} (Plan B)` : '',
      destination: curTrip?.destination || '',
      startDate: curTrip?.startDate || today,
      endDate: curTrip?.endDate || today,
    },
  });
},

async onSubmitCreateTrip() {
  if (this.data.busyModal) return;
  const { name, destination, startDate, endDate } = this.data.tripForm;
  if (!name.trim()) {
    wx.showToast({ title: '请输入行程名称', icon: 'none' });
    return;
  }
  this.setData({ busyModal: true });
  try {
    if (this.data.createMode === 'clone') {
      await actions.cloneCurrentTrip({ name: name.trim(), startDate });
    } else {
      await actions.createTrip({ name: name.trim(), destination: destination.trim(), startDate, endDate });
    }
    this.setData({ createModalOpen: false });
  } finally {
    this.setData({ busyModal: false });
  }
},

async openJoinWithCode(code) {
  this.setData({ tripDrawerOpen: false, joinModalOpen: true, joinCodeInput: code, joinPreview: null, selectedClaimId: '' });
  if (code) await this.onQueryJoinPreview();
},

async onQueryJoinPreview() {
  const raw = this.data.joinCodeInput.trim();
  if (!raw) return;
  this.setData({ busyModal: true });
  try {
    // 8位纯大写字母数字视为分享码 code，否则视为传统口令 passphrase
    const isShareCode = /^[A-Z0-9]{8}$/.test(raw.toUpperCase());
    const preview = await actions.previewJoin(
      isShareCode ? { code: raw.toUpperCase() } : { passphrase: raw }
    );
    this.setData({
      joinPreview: preview,
      selectedClaimId: preview.claimableMembers?.[0]?.id || '',
    });
  } finally {
    this.setData({ busyModal: false });
  }
},

async onConfirmJoinTrip() {
  if (this.data.busyModal || !this.data.joinPreview) return;
  const raw = this.data.joinCodeInput.trim();
  const isShareCode = /^[A-Z0-9]{8}$/.test(raw.toUpperCase());
  this.setData({ busyModal: true });
  try {
    await actions.confirmJoin({
      code: isShareCode ? raw.toUpperCase() : '',
      passphrase: isShareCode ? '' : raw,
      claimMemberId: this.data.selectedClaimId,
    });
    this.setData({ joinModalOpen: false, joinPreview: null, joinCodeInput: '' });
  } finally {
    this.setData({ busyModal: false });
  }
},

onShareAppMessage(res) {
  const trip = getState().data?.trip || {};
  const mode = res?.target?.dataset?.mode || 'view';
  if (mode === 'invite' && trip.inviteCode && !this.data.isReadOnly) {
    return {
      title: `邀请你共同编辑「${trip.name || '我们的旅行'}」行程与记账`,
      path: `/pages/timeline/index?inviteCode=${trip.inviteCode}`,
    };
  }
  return {
    title: `分享「${trip.name || '旅行助手'}」行程时间线给你`,
    path: `/pages/timeline/index?viewCode=${trip.viewCode || ''}`,
  };
},
```

#### (2) 首页 `miniprogram/pages/timeline/index.wxml` 关键新增结构

在 `timeline/index.wxml` 顶部的 `<view class="header">` 中嵌入**行程切换胶囊**，并在页面末尾嵌入**多时间线工作台半屏抽屉**与**加入/认领弹窗**：

```xml
<!-- 1. 顶部行程切换胶囊（嵌入原有 header 标题位置） -->
<view class="trip-switcher-bar" bindtap="onToggleTripDrawer">
  <text class="trip-switcher-title">{{tripName}}</text>
  <text class="trip-role-badge" wx:if="{{isReadOnly}}">只读预览</text>
  <text class="trip-switcher-arrow">{{tripDrawerOpen ? '▴' : '▾'}} 切换/新建</text>
</view>

<!-- 2. 只读围观模式顶部提示条 -->
<view class="readonly-banner" wx:if="{{isReadOnly}}">
  <text>当前为只读预览模式</text>
  <view class="readonly-clone-btn" data-mode="clone" bindtap="onOpenCreateModal">复制为我的行程</view>
</view>

<!-- 3. 多时间线工作台半屏抽屉 -->
<view class="drawer-mask" wx:if="{{tripDrawerOpen}}" bindtap="onToggleTripDrawer">
  <view class="drawer-sheet" catchtap="noop">
    <view class="drawer-header">
      <text class="drawer-title">我的旅行时间线 ({{trips.length}})</text>
      <text class="drawer-close" bindtap="onToggleTripDrawer">✕</text>
    </view>

    <scroll-view scroll-y class="drawer-trip-list">
      <view
        wx:for="{{trips}}"
        wx:key="id"
        class="drawer-trip-card {{item.id === activeTripId ? 'is-active' : ''}}"
        data-id="{{item.id}}"
        bindtap="onSelectTrip"
      >
        <view class="drawer-trip-main">
          <view class="drawer-trip-name-row">
            <text class="drawer-trip-name">{{item.name}}</text>
            <text class="drawer-trip-badge">{{item.role === 'owner' ? '创建者' : (item.role === 'viewer' ? '只读' : '协作')}}</text>
          </view>
          <text class="drawer-trip-meta">{{item.destination || '未设目的地'}} · {{item.startDate}} 至 {{item.endDate}}</text>
        </view>
        <text class="drawer-trip-check" wx:if="{{item.id === activeTripId}}">当前</text>
      </view>
    </scroll-view>

    <view class="drawer-actions">
      <button class="btn-primary" data-mode="new" bindtap="onOpenCreateModal">+ 新建时间线</button>
      <button class="btn-secondary" data-mode="clone" bindtap="onOpenCreateModal">衍生备选分支 (Plan B)</button>
      <button class="btn-outline" bindtap="openJoinWithCode">输入口令 / 邀请码加入行程</button>
    </view>
  </view>
</view>

<!-- 4. 加入行程与历史/虚拟成员认领弹窗 -->
<view class="drawer-mask" wx:if="{{joinModalOpen}}" bindtap="onCloseJoinModal">
  <view class="drawer-sheet" catchtap="noop">
    <view class="drawer-header">
      <text class="drawer-title">加入或认领行程</text>
    </view>
    <view class="form-group">
      <input
        class="form-input"
        placeholder="输入8位邀请码或历史旅行口令"
        value="{{joinCodeInput}}"
        bindinput="onJoinCodeInput"
      />
      <button class="btn-secondary" bindtap="onQueryJoinPreview">查询行程</button>
    </view>

    <block wx:if="{{joinPreview}}">
      <view class="preview-box">
        <text class="preview-title">{{joinPreview.trip.name}} ({{joinPreview.mode === 'viewer' ? '只读预览' : '协作编辑'}})</text>
        <block wx:if="{{joinPreview.mode === 'editor' && joinPreview.claimableMembers.length > 0}}">
          <text class="preview-subtitle">检测到行程中有以下未绑定微信的成员，点击可直接认领并接管其账单与打卡：</text>
          <view class="claim-list">
            <view
              wx:for="{{joinPreview.claimableMembers}}"
              wx:key="id"
              class="claim-chip {{selectedClaimId === item.id ? 'is-selected' : ''}}"
              data-id="{{item.id}}"
              bindtap="onSelectClaimMember"
            >
              我是「{{item.name}}」
            </view>
            <view
              class="claim-chip {{selectedClaimId === '' ? 'is-selected' : ''}}"
              data-id=""
              bindtap="onSelectClaimMember"
            >
              作为新成员加入
            </view>
          </view>
        </block>
        <button class="btn-primary" loading="{{busyModal}}" bindtap="onConfirmJoinTrip">确认进入行程</button>
      </view>
    </block>
  </view>
</view>
```

#### (3) 设置页 `miniprogram/pages/settings/index.{js,wxml}` 精确改造

在 `settings/index.wxml` 的 `<view class="page"><block wx:if="{{ready}}">` 内，在原有行程信息卡片上方插入**微信个人资料卡**与**虚实成员协作卡**：

1. **微信头像与昵称合规采集实现（`settings/index.js`）**：
   ```javascript
   async onChooseAvatar(e) {
     const tempFilePath = e.detail?.avatarUrl;
     if (!tempFilePath) return;
     // 复用现有的 uploadPhotos 上传头像文件获取永久 URL，若失败则降级保存本地路径
     try {
       const res = await api.uploadPhotos({ files: [tempFilePath], fields: { type: 'avatar' } });
       const remoteUrl = res?.photos?.[0]?.url || tempFilePath;
       await actions.updateUserProfile({
         nickname: this.data.userNickname || getState().user?.nickname || '旅行者',
         avatarUrl: remoteUrl,
       });
     } catch {
       await actions.updateUserProfile({
         nickname: this.data.userNickname || '旅行者',
         avatarUrl: tempFilePath,
       });
     }
   },

   async onNicknameChange(e) {
     const nickname = (e.detail?.value || '').trim();
     if (!nickname) return;
     this.setData({ userNickname: nickname });
     await actions.updateUserProfile({
       nickname,
       avatarUrl: getState().user?.avatarUrl || '',
     });
   },
   ```
2. **双模式微信分享与成员管理卡片（`settings/index.wxml`）**：
   * 在成员列表中，为每个成员显示身份状态标签：`{{item.userId ? '已绑微信' : '虚拟记账同伴（待认领）'}}`。
   * 提供两个明确的微信原生转发按钮：
     * `<button class="btn-primary" open-type="share" data-mode="invite" wx:if="{{!isReadOnly}}">邀请同游伙伴（可共同编辑/记账）</button>`
     * `<button class="btn-secondary" open-type="share" data-mode="view">分享只读行程（仅供亲友预览/生成海报）</button>`

## 五、 极端边界情况与容错矩阵（Edge Case Matrix）

为确保上线后零崩溃、零数据污染，前后端必须覆盖以下 6 类极端边界场景：

| 边界场景 | 触发条件 | 确定性处理策略 |
| :--- | :--- | :--- |
| **1. 弱网/断网连续切换时间线** | 用户在地铁或飞行模式下从行程 A 切换到行程 B，并在行程 A 和 B 中分别勾选了待办节点 | 1. `switchTrip` 同步读取 `persist.storage.loadSnapshot(tripB)` 实现无网秒切；<br>2. 离线队列项各自携带产生时的 `tripId`；<br>3. 恢复网络后 `flushQueue` 按每项自带的 `item.tripId` 设置请求头 `Trip-Id` 依次重放，绝不串台 |
| **2. 快速连点切换多条时间线** | 用户在 1 秒内连续点击行程 A $\rightarrow$ 行程 B $\rightarrow$ 行程 C | 全局递增 `_switchSeq` 竞态锁；当行程 A 或 B 的慢速 `/snapshot` 响应返回时，因 `seq !== _switchSeq` 被直接丢弃，界面稳定停留在行程 C |
| **3. 正在浏览的行程被创建者删除** | 协作者打开小程序时，原激活的 `activeTripId` 已被 `owner` 删除（接口返回 `404`） | `switchTrip` 捕获 `403`/`404` 后自动清理本地失效快照 `dropSnapshot(id)`，拉取最新 `listTrips()` 并自动切换到第一条可用行程；若用户已无任何行程，后端自动为其生成一条默认行程 |
| **4. 同一用户重复点击分享卡或认领** | 已经在行程内的微信用户再次点击群里的邀请卡片或重复提交 `POST /api/trips/join` | 后端通过 `UNIQUE INDEX (trip_id, user_id)` 拦截重复插入，直接幂等返回该用户已有的 `memberId`（若原为 `viewer` 现点 `inviteCode` 则自动升级为 `editor`），前端直接切入该行程 |
| **5. 试图删除已有记账的成员** | 在设置页点击删除某位虚拟成员或协作者，但该成员已作为 `expenses` 的付款人或分摊人 | 后端校验 `expenses` 表关联关系，返回 `409 MEMBER_HAS_EXPENSES`；前端弹出明确提示：“该成员已有记账记录，请先修改相关账单归属后再移除” |
| **6. 微信审核员首屏冷启动检查** | 微信提审机首次冷启动小程序，不进行任何点击操作观察首屏是否违规强制登录 | `boot()` 自动静默完成 `wx.login` 并加载内置示例时间线直接渲染 `pages/timeline/index` 完整功能界面，全程 0 登录弹窗拦截，100% 符合微信小程序提审规范 |

## 六、 四阶段开发执行顺序与命令速查

1. **阶段一（后端 Schema 与鉴权）**：修改 `server/src/db.js`、`server/src/auth.js`、`server/src/routes/auth.js`。
2. **阶段二（后端多时间线路由）**：新增 `server/src/routes/trips.js`，在 `server/src/index.js` 注册 `/api/trips`，并在 `routes/{trip,nodes,money,checkins,photos,vocab}.js` 的写接口挂载 `requireTripAccess('editor')`。
3. **阶段三（前端单源 Store 与平台层同步）**：
   * 修改 `miniprogram/scripts/check-platform.mjs`、`miniprogram/platform/wx/{session.js,net.js}`、`web/src/platform/{session.js,net.js}`；
   * 修改 `web/src/store/api.js` 与 `web/src/store/store.js`；
   * 运行同步与校验命令：
     ```bash
     node miniprogram/scripts/sync-shared.mjs
     node miniprogram/scripts/check-platform.mjs
     ```
4. **阶段四（小程序 UI 落地与联调）**：修改 `miniprogram/pages/timeline/index.{js,wxml,wxss}`、`miniprogram/pages/settings/index.{js,wxml,wxss}`、`miniprogram/pages/login/index.{js,wxml}` 及子页面 `isReadOnly` 禁用态绑定。
