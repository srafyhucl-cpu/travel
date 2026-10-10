/**
 * agent（微信AI 原子接口）自动化检查：不开开发者工具，直接把 SKILL 的原子接口跑一遍。
 *
 * 两种模式：
 *
 *   默认（只读，打生产）：
 *     PASS=你的口令 node scripts/check-agent.mjs
 *     - mock wx（含 modelContext）后加载各 SKILL 的 index.js，拿到全部注册接口；
 *     - 用真实后端登录（只登录、不建成员；默认用生产已有成员「龙哥」）；
 *     - 断言：接口注册齐全、返回结构、content 模板、错误分支、
 *       未登录引导、汇总数字与快照手算一致；所有"拒绝类"分支都是纯本地校验，
 *       不会给生产发任何写请求。
 *
 *   --local（全链路，不碰生产）：
 *     PASS=你的口令 node scripts/check-agent.mjs --local
 *     （口令不想给脚本用时可以加 --fresh-trip：用任意 6 位以上口令，在副本库里新建一趟测试旅行跑全链路）
 *     - 把 server/data 整份复制到临时目录，另起 7042 端口的后端；
 *     - 把 agent 的 travel.base 指向它，跑完整写链路：
 *       建项 → 改项 → 勾待办 → 打卡 → 记账 → 改账（核对原值保留）→ 删账 → 删项 + 清理打卡；
 *     - 每步断言副本库里的真实变化，跑完核对数量复原；
 *     - 结束时关掉临时后端、删掉临时数据；生产一个字节都不动。
 *
 * 退出码：0 全通 / 1 有失败 / 2 脚本自己炸了（用法、缺依赖等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // miniprogram/
const REPO_ROOT = path.resolve(ROOT, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const SRC_DATA = path.join(SERVER_DIR, 'data');
const TEMP_DATA = path.join(path.parse(REPO_ROOT).root.replace(/[\\/]$/, ''), 'Temp', 'agent-check-testdata');

const LOCAL_PORT = 7042;
const LOCAL_BASE = `http://127.0.0.1:${LOCAL_PORT}`;
/** 只读模式默认打生产；验证脚本本身或指向测试环境时可以用 AGENT_CHECK_BASE 覆盖 */
const PROD_BASE = process.env.AGENT_CHECK_BASE || 'https://travel.hclstudio.cn'; // 与 agent/lib/net.js 保持一致
const LOCAL = process.argv.includes('--local');
const FRESH_TRIP = process.argv.includes('--fresh-trip');

const PASS = process.env.PASS;
if (!PASS) {
  console.error('缺少 PASS 环境变量：PASS=你的口令 node scripts/check-agent.mjs');
  process.exit(2);
}
const NAME = (process.env.NAME || '龙哥').trim() || '龙哥';

/* ------------------------------------------------------------------ */
/* SKILL 清单：新增 SKILL 时在这里补一行（接口名要与 mcp.json 完全一致） */
/* ------------------------------------------------------------------ */
const SKILLS = [
  { path: 'agent/skills/itinerary', apis: ['getTripOverview', 'getDaySchedule', 'findItems', 'getTodos'] },
  { path: 'agent/skills/tripPlan', apis: ['createItem', 'updateItem', 'setTodo', 'deleteItem'] },
  { path: 'agent/skills/checkin', apis: ['checkIn'] },
  { path: 'agent/skills/money', apis: ['addExpense', 'updateExpense', 'deleteExpense', 'getExpenseSummary', 'listExpenses'] },
];

/* ------------------------------------------------------------------ */
/* wx mock：只实现 agent 用到的部分（storage / request / modelContext） */
/* ------------------------------------------------------------------ */

const kv = new Map();
const handlers = {}; // "skillPath::apiName" -> 实现函数

function mockRequest({ url, method = 'GET', header = {}, data, success, fail }) {
  fetch(url, {
    method,
    headers: header,
    body: data === undefined ? undefined : JSON.stringify(data),
  })
    .then(async (res) => {
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      success({ statusCode: res.status, data: parsed });
    })
    .catch((e) => fail({ errMsg: String((e && e.message) || e) }));
}

globalThis.wx = {
  getStorageSync: (k) => (kv.has(k) ? kv.get(k) : ''),
  setStorageSync: (k, v) => kv.set(k, v),
  removeStorageSync: (k) => kv.delete(k),
  request: mockRequest,
  modelContext: {
    createSkill(skillPath) {
      return {
        use() {},
        registerAPI(name, fn) {
          handlers[`${skillPath}::${name}`] = fn;
        },
      };
    },
  },
};

const require_ = createRequire(import.meta.url);
for (const skill of SKILLS) {
  require_(path.join(ROOT, skill.path, 'index.js'));
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!ok) failures += 1;
  return !!ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(skillPath, name, args = {}) {
  const fn = handlers[`${skillPath}::${name}`];
  if (!fn) throw new Error(`接口未注册：${skillPath}::${name}`);
  return fn(args);
}

/** 登录。401（口令不存在）返回 null，交给调用方决定；其它错误直接抛 */
async function login(base, name) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: PASS, name }),
  });
  if (res.status === 401) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(`登录失败（${res.status}）：${body.message || ''}`);
  return body;
}

/** --local --fresh-trip 专用：在副本库上新建一趟测试旅行（生产绝不会走到这里） */
async function createFreshTrip(base, name) {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const res = await fetch(`${base}/api/auth/trips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: PASS, name, tripName: '[agent 检查] 测试旅行', startDate: today }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(`副本库新建旅行失败（${res.status}）：${body.message || ''}`);
  return body;
}

async function fetchSnapshotDirect(base, token) {
  const res = await fetch(`${base}/api/trip/snapshot`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`拉快照失败（${res.status}）`);
  return res.json();
}

async function direct(base, token, method, path_, body) {
  const res = await fetch(`${base}${path_}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ------------------------------------------------------------------ */
/* 只读检查（生产）                                                     */
/* ------------------------------------------------------------------ */

async function runReadOnlyChecks() {
  console.log('\n== 接口注册 ==');
  for (const skill of SKILLS) {
    for (const name of skill.apis) {
      check(`${skill.path}::${name} 已注册`, !!handlers[`${skill.path}::${name}`]);
    }
  }

  console.log('\n== 登录（只读；默认成员「龙哥」） ==');
  const session = await login(PROD_BASE, NAME);
  if (!session) {
    console.error('登录返回 401：口令不对，或这趟旅行不存在。');
    process.exit(2);
  }
  kv.set('travel.token', session.token);
  // 让 agent/lib/net.js 指向同一个服务；生产直跑时这正是它的默认值，
  // 用 AGENT_CHECK_BASE 指测试环境时两边才一致（否则接口会悄悄打回生产）
  kv.set('travel.base', PROD_BASE);
  check('登录成功', !!session.token, `trip=${session.trip && session.trip.name}`);

  const snap = await fetchSnapshotDirect(PROD_BASE, session.token);
  const timelineNodes = (snap.nodes || []).filter((n) => n.role !== 'module');

  console.log('\n== tripItinerary 读接口 ==');
  const overview = await api('agent/skills/itinerary', 'getTripOverview');
  check(
    'getTripOverview 结构',
    !overview.isError &&
      overview.structuredContent &&
      overview.structuredContent.progress.total === timelineNodes.length &&
      Array.isArray(overview.structuredContent.members),
    `total=${overview.structuredContent && overview.structuredContent.progress.total}`
  );
  check('getTripOverview 文案引导卡片', /时间线/.test(overview.content[0].text));

  const today = (() => {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const todayNodes = timelineNodes.filter((n) => n.date === today);
  const day = await api('agent/skills/itinerary', 'getDaySchedule', {});
  const dayItems = (day.structuredContent && day.structuredContent.items) || null;
  check(
    'getDaySchedule(date 缺省=今天)',
    !day.isError && !!dayItems && day.structuredContent.date === today && dayItems.length === todayNodes.length,
    `${today} items=${dayItems ? dayItems.length : '—'}`
  );
  const dayBad = await api('agent/skills/itinerary', 'getDaySchedule', { date: '明天' });
  check('getDaySchedule 拒绝自然语言日期', dayBad.isError === true);

  const keyword = timelineNodes.length ? String(timelineNodes[0].title).slice(0, 2) : 'zzz';
  const found = await api('agent/skills/itinerary', 'findItems', { keyword });
  check(
    `findItems("${keyword}")`,
    timelineNodes.length ? !found.isError && found.structuredContent.total >= 1 : found.isError === true,
    `total=${found.structuredContent && found.structuredContent.total}`
  );
  const foundNone = await api('agent/skills/itinerary', 'findItems', { keyword: 'zzz这个词不存在zzz' });
  check('findItems 零命中给错误引导', foundNone.isError === true);
  const foundEmpty = await api('agent/skills/itinerary', 'findItems', {});
  check('findItems 空关键词被拒', foundEmpty.isError === true);

  const todos = await api('agent/skills/itinerary', 'getTodos', {});
  const todoItems = (todos.structuredContent && todos.structuredContent.items) || [];
  check(
    'getTodos 只含未完成待办',
    !todos.isError && todoItems.every((t) => t.itemId && t.itemText),
    `total=${todos.structuredContent && todos.structuredContent.total}`
  );

  console.log('\n== tripCheckin 本地校验（不发写请求） ==');
  const ciNoArgs = await api('agent/skills/checkin', 'checkIn', {});
  check('checkIn 缺 nodeId 被拒', ciNoArgs.isError === true);
  const ciBadId = await api('agent/skills/checkin', 'checkIn', { nodeId: 'zzz-not-exist', action: 'done' });
  check('checkIn 不存在的 nodeId 被拒', ciBadId.isError === true);

  console.log('\n== tripPlan 本地校验（不发写请求） ==');
  const createBad = await api('agent/skills/tripPlan', 'createItem', { date: '2099/01/01', title: 'x' });
  check('createItem 非法日期被拒', createBad.isError === true);
  const updateBad = await api('agent/skills/tripPlan', 'updateItem', { nodeId: 'zzz-not-exist', title: 'x' });
  check('updateItem 不存在的 nodeId 被拒', updateBad.isError === true);
  const todoNoArgs = await api('agent/skills/tripPlan', 'setTodo', {});
  check('setTodo 缺参数被拒', todoNoArgs.isError === true);
  if (timelineNodes.length) {
    const delMismatch = await api('agent/skills/tripPlan', 'deleteItem', {
      nodeId: timelineNodes[0].id,
      title: 'zzz名称肯定对不上zzz',
    });
    check('deleteItem 名称不匹配被拒（防误删闸门）', delMismatch.isError === true);
  }

  console.log('\n== tripMoney 本地校验 + 汇总核对 ==');
  const addBadAmount = await api('agent/skills/money', 'addExpense', { amount: 0 });
  check('addExpense 金额 0 被拒', addBadAmount.isError === true);
  const addBadCategory = await api('agent/skills/money', 'addExpense', { amount: 1, category: 'zzz-不存在' });
  check('addExpense 未知类别被拒', addBadCategory.isError === true);
  const addBadPayer = await api('agent/skills/money', 'addExpense', { amount: 1, payer: 'zzz不存在的人' });
  check('addExpense 未知付款人被拒', addBadPayer.isError === true);
  const updBad = await api('agent/skills/money', 'updateExpense', { expenseId: 'zzz-not-exist', amount: 1 });
  check('updateExpense 不存在的 id 被拒', updBad.isError === true);
  if ((snap.expenses || []).length) {
    const real = snap.expenses[0];
    const delBad = await api('agent/skills/money', 'deleteExpense', {
      expenseId: real.id,
      amount: round2(real.amount) + 1000,
    });
    check('deleteExpense 金额不匹配被拒（防误删闸门）', delBad.isError === true);
  }

  const summary = await api('agent/skills/money', 'getExpenseSummary', {});
  const expectTotal = round2((snap.expenses || []).reduce((s, e) => s + (+e.amount || 0), 0));
  check(
    'getExpenseSummary 总额与快照手算一致',
    !summary.isError && summary.structuredContent.total === expectTotal,
    `接口=${summary.structuredContent && summary.structuredContent.total} 手算=${expectTotal}`
  );
  const list = await api('agent/skills/money', 'listExpenses', { limit: 5 });
  check(
    'listExpenses 尊重 limit（≤5 且倒序）',
    !list.isError && list.structuredContent.items.length <= 5,
    `count=${list.structuredContent && list.structuredContent.count}`
  );

  console.log('\n== 未登录引导 ==');
  const token = kv.get('travel.token');
  kv.delete('travel.token');
  const notLogged = await api('agent/skills/itinerary', 'getDaySchedule', {});
  check(
    '未登录返回登录引导 + 登录页卡片',
    notLogged.isError === true && notLogged.handoff && notLogged.handoff.path === '/pages/login/index',
    notLogged.handoff && notLogged.handoff.path
  );
  kv.set('travel.token', token);
  check('登录态已还原', kv.get('travel.token') === token);
}

/* ------------------------------------------------------------------ */
/* --local 全链路（临时后端）                                           */
/* ------------------------------------------------------------------ */

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function bootLocalServer() {
  console.log('\n== 准备本机临时后端 ==');
  if (!fs.existsSync(path.join(SRC_DATA, 'travel.db'))) {
    throw new Error(`没找到 ${SRC_DATA}\\travel.db，先确认 server/data 是否完整`);
  }
  fs.rmSync(TEMP_DATA, { recursive: true, force: true });
  copyDir(SRC_DATA, TEMP_DATA);
  console.log(`数据副本：${TEMP_DATA}`);

  const child = spawn('node', ['src/index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATA_DIR: TEMP_DATA, PORT: String(LOCAL_PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) {
        throw new Error(`临时后端进程已退出（code ${child.exitCode}）——先确认 ${LOCAL_PORT} 端口没被别的服务占着`);
      }
      let ok = false;
      try {
        ok = (await fetch(`${LOCAL_BASE}/api/health`)).ok;
      } catch {
        /* 还没起来 */
      }
      if (ok) {
        await sleep(200);
        if (child.exitCode !== null) {
          throw new Error(`${LOCAL_PORT} 端口上已有别的服务；临时后端起不来，也不该复用别人的`);
        }
        console.log(`临时后端就绪：${LOCAL_BASE}`);
        return child;
      }
      await sleep(250);
    }
    throw new Error('临时后端 15 秒内没有就绪');
  } catch (e) {
    try {
      child.kill();
    } catch {
      /* 可能已经退了 */
    }
    await sleep(600);
    try {
      fs.rmSync(TEMP_DATA, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 留着也不影响结果 */
    }
    throw e;
  }
}

async function shutdownLocalServer(child) {
  const exited = new Promise((r) => child.once('exit', r));
  try {
    child.kill();
  } catch {
    /* 已经退了 */
  }
  await Promise.race([exited, sleep(4000)]);
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(TEMP_DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      break;
    } catch {
      await sleep(300);
    }
  }
}

async function runLocalChecks() {
  const child = await bootLocalServer();
  try {
    kv.set('travel.base', LOCAL_BASE);

    let session = await login(LOCAL_BASE, NAME);
    if (!session) {
      if (!FRESH_TRIP) {
        throw new Error('副本库登录返回 401：先确认 PASS 是这趟旅行的口令；或加 --fresh-trip，用任意 6 位以上的口令在副本里新建一趟测试旅行');
      }
      console.log('副本库没有这个口令对应的旅行：--fresh-trip 新建一趟测试旅行');
      session = await createFreshTrip(LOCAL_BASE, NAME);
    }
    kv.set('travel.token', session.token);
    check('临时库登录成功', !!session.token, `trip=${session.trip && session.trip.name}`);

    const before = await fetchSnapshotDirect(LOCAL_BASE, session.token);
    const baseCounts = {
      nodes: (before.nodes || []).length,
      expenses: (before.expenses || []).length,
    };

    const TEST_DATE = '2099-12-30';
    const TITLE = '[agent 检查] 测试项';
    const TITLE2 = '[agent 检查] 测试项（改）';

    console.log('\n== tripPlan 写链路 ==');
    const created = await api('agent/skills/tripPlan', 'createItem', {
      date: TEST_DATE,
      title: TITLE,
      startTime: '10:00',
      endTime: '11:00',
      location: '测试地点',
      checklist: ['测试待办A', '测试待办B'],
    });
    check('createItem 成功', !created.isError && !!created.structuredContent.nodeId, created.isError ? created.content[0].text : '');
    const nodeId = created.structuredContent && created.structuredContent.nodeId;

    const dayAfterCreate = await api('agent/skills/itinerary', 'getDaySchedule', { date: TEST_DATE });
    check('新项出现在当天排期里', !dayAfterCreate.isError && dayAfterCreate.structuredContent.items.some((i) => i.nodeId === nodeId));

    const updated = await api('agent/skills/tripPlan', 'updateItem', { nodeId, title: TITLE2 });
    check('updateItem 成功', !updated.isError && updated.structuredContent.title === TITLE2);

    const todo1 = await api('agent/skills/tripPlan', 'setTodo', { nodeId, itemText: '测试待办A', done: true });
    check('setTodo 勾选成功', !todo1.isError && todo1.structuredContent.done === true, `remaining=${todo1.structuredContent && todo1.structuredContent.remaining}`);
    const todoNoop = await api('agent/skills/tripPlan', 'setTodo', { nodeId, itemText: '测试待办A', done: true });
    check('setTodo 重复勾选是 noop（不硬调接口）', !todoNoop.isError && todoNoop.structuredContent.noop === true);

    console.log('\n== tripCheckin 写链路 ==');
    const ci = await api('agent/skills/checkin', 'checkIn', { nodeId, action: 'arrived' });
    check('checkIn(arrived) 成功', !ci.isError, ci.isError ? ci.content[0].text : '');
    const ciDone = await api('agent/skills/checkin', 'checkIn', { nodeId, action: 'done' });
    check('checkIn(done) 成功', !ciDone.isError);
    const ciDup = await api('agent/skills/checkin', 'checkIn', { nodeId, action: 'done' });
    check('重复 done 提示已完成', !ciDup.isError && ciDup.structuredContent.alreadyDone === true);

    console.log('\n== tripMoney 写链路 ==');
    const added = await api('agent/skills/money', 'addExpense', {
      amount: 12.34,
      note: '[agent 检查] 测试消费',
      category: 'misc',
      payer: session.member.name,
      nodeId,
    });
    check('addExpense 成功', !added.isError && !!added.structuredContent.expenseId, added.isError ? added.content[0].text : '');
    const expenseId = added.structuredContent && added.structuredContent.expenseId;

    const snapAfterAdd = await fetchSnapshotDirect(LOCAL_BASE, session.token);
    const row1 = (snapAfterAdd.expenses || []).find((e) => e.id === expenseId);
    check('服务端已写入且挂到了节点', !!row1 && row1.node_id === nodeId, row1 ? `amount=${row1.amount}` : '未找到');

    const upd = await api('agent/skills/money', 'updateExpense', { expenseId, amount: 56.78 });
    check('updateExpense 成功', !upd.isError, upd.isError ? upd.content[0].text : '');
    const snapAfterUpd = await fetchSnapshotDirect(LOCAL_BASE, session.token);
    const row2 = (snapAfterUpd.expenses || []).find((e) => e.id === expenseId);
    check(
      '改账后原值保留（occurred_at 不被重置、node_id 不被清空）',
      !!row2 && row2.node_id === nodeId && row2.occurred_at === row1.occurred_at,
      row2 ? `node_id=${row2.node_id} occurred=${row2.occurred_at === row1.occurred_at}` : '未找到'
    );
    check('改账金额生效', !!row2 && round2(row2.amount) === 56.78);

    const listed = await api('agent/skills/money', 'listExpenses', { limit: 30 });
    check('listExpenses 含新账', !listed.isError && listed.structuredContent.items.some((i) => i.expenseId === expenseId));

    const summary = await api('agent/skills/money', 'getExpenseSummary', {});
    check('汇总包含新账', !summary.isError && summary.structuredContent.total >= 56.78);

    const delExp = await api('agent/skills/money', 'deleteExpense', { expenseId, amount: 56.78 });
    check('deleteExpense 成功', !delExp.isError);
    const snapAfterDel = await fetchSnapshotDirect(LOCAL_BASE, session.token);
    check('账目已删除', !(snapAfterDel.expenses || []).some((e) => e.id === expenseId));

    console.log('\n== 清理 ==');
    // 打卡记录没有原子接口（AI 不暴露），这里用直连 API 清理测试数据
    const checkins = (await direct(LOCAL_BASE, session.token, 'GET', '/api/checkins')).data || [];
    for (const c of checkins.filter((c) => c.node_id === nodeId)) {
      await direct(LOCAL_BASE, session.token, 'DELETE', `/api/checkins/${c.id}`);
    }
    const delNode = await api('agent/skills/tripPlan', 'deleteItem', { nodeId, title: TITLE2 });
    check('deleteItem 成功', !delNode.isError, delNode.isError ? delNode.content[0].text : '');

    const after = await fetchSnapshotDirect(LOCAL_BASE, session.token);
    check(
      '副本库数量复原（节点/账目）',
      (after.nodes || []).length === baseCounts.nodes && (after.expenses || []).length === baseCounts.expenses,
      `nodes ${baseCounts.nodes}→${(after.nodes || []).length}，expenses ${baseCounts.expenses}→${(after.expenses || []).length}`
    );
    const leftoverCheckins = (after.checkins || []).filter((c) => c.node_id === nodeId);
    check('测试打卡已清理', leftoverCheckins.length === 0);
  } finally {
    await shutdownLocalServer(child);
    console.log(`临时后端已关闭，数据副本已删除：${TEMP_DATA}`);
  }
}

/* ------------------------------------------------------------------ */

(async () => {
  console.log(`模式：${LOCAL ? '--local（临时库全链路）' : '默认（只读）'}${FRESH_TRIP && LOCAL ? ' + --fresh-trip' : ''}`);
  if (LOCAL) await runLocalChecks();
  else await runReadOnlyChecks();

  console.log('\n----------------------------------------');
  if (failures) {
    console.log(`结果：${failures} 项未通过`);
    process.exit(1);
  }
  console.log('结果：全部通过');
})().catch((e) => {
  console.error('\n脚本自己炸了：', e);
  process.exit(2);
});
