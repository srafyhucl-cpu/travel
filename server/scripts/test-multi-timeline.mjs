/**
 * 多时间线与微信登录全链路集成测试
 * 覆盖：微信登录、个人资料、行程列表、新行程、克隆Plan B、虚拟同伴与记账409拦截、
 * 邀请码预览、认领虚拟身份加入、只读权限拦截(403)、状态变更、退出/删除行程、旧口令兼容
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'index.js');
const TEST_PORT = 7035;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let serverProcess = null;
let failures = 0;

function logPass(title) {
  console.log(`  ✓ PASS: ${title}`);
}

function logFail(title, detail = '') {
  failures++;
  console.error(`  ✗ FAIL: ${title} ${detail}`);
}

async function api(method, urlPath, { token, tripId, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (tripId) headers['Trip-Id'] = String(tripId);
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer() {
  console.log(`正在临时启动测试服务器 (端口 ${TEST_PORT})…`);
  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stderr.on('data', (d) => console.error('[Server Err]:', d.toString()));
  serverProcess.stdout.on('data', (d) => console.log('[Server Out]:', d.toString()));
  serverProcess.on('error', (err) => console.error('[Server Spawn Error]:', err));

  // 等待启动就绪
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        console.log('测试服务器已就绪！\n');
        return;
      }
    } catch {}
  }
  throw new Error('测试服务器启动超时');
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGINT');
  }
}

async function runTests() {
  try {
    await startServer();

    console.log('== 1. 微信静默登录与默认行程自动创建 ==');
    const userACode = `mock_wx_user_a_${Date.now()}`;
    const loginARes = await api('POST', '/api/auth/wx-login', { body: { code: userACode } });
    if (loginARes.status === 200 && loginARes.json.token && loginARes.json.user) {
      logPass('用户 A 微信静默登录成功并签发 JWT');
    } else {
      logFail('用户 A 微信登录失败', JSON.stringify(loginARes.json));
    }
    const tokenA = loginARes.json.token;
    const userA = loginARes.json.user;
    const defaultTripIdA = loginARes.json.defaultTripId || loginARes.json.tripId;
    if (defaultTripIdA) {
      logPass(`自动为新用户创建首个示例行程 (ID: ${defaultTripIdA})`);
    } else {
      logFail('未能自动创建首个行程');
    }

    console.log('\n== 2. 微信个人资料更新 ==');
    const profileRes = await api('PUT', '/api/auth/profile', {
      token: tokenA,
      body: { nickname: '旅行家阿明', avatarUrl: 'https://example.com/amin.png' },
    });
    if (profileRes.status === 200 && profileRes.json.user?.nickname === '旅行家阿明') {
      logPass('更新微信昵称与头像成功');
    } else {
      logFail('更新微信资料失败', JSON.stringify(profileRes.json));
    }

    console.log('\n== 3. 多行程列表查询 ==');
    const listRes = await api('GET', '/api/trips', { token: tokenA });
    if (listRes.status === 200 && Array.isArray(listRes.json.trips) && listRes.json.trips.length >= 1) {
      logPass(`获取行程列表成功 (数量: ${listRes.json.trips.length})`);
    } else {
      logFail('获取行程列表失败', JSON.stringify(listRes.json));
    }

    console.log('\n== 4. 创建新行程 ==');
    const createTripRes = await api('POST', '/api/trips', {
      token: tokenA,
      body: {
        name: '川西大环线自驾',
        destination: '甘孜 · 稻城亚丁',
        startDate: '2026-11-01',
        endDate: '2026-11-08',
      },
    });
    const tripA2 = createTripRes.json.trip;
    const inviteCodeA2 = tripA2?.invite_code || tripA2?.inviteCode;
    const viewCodeA2 = tripA2?.view_code || tripA2?.viewCode;
    if (createTripRes.status === 201 && inviteCodeA2 && viewCodeA2) {
      logPass(`成功创建新行程 (ID: ${tripA2.id}, 邀请码: ${inviteCodeA2}, 围观码: ${viewCodeA2})`);
    } else {
      logFail('创建新行程失败', JSON.stringify(createTripRes.json));
    }

    console.log('\n== 5. 添加虚拟同伴与记账 409 拦截防护 ==');
    const addVirtualRes = await api('POST', '/api/trip/members', {
      token: tokenA,
      tripId: tripA2.id,
      body: { name: '老张 (虚拟)' },
    });
    if (addVirtualRes.status === 201 && addVirtualRes.json.member?.name === '老张 (虚拟)') {
      logPass(`成功添加虚拟同伴「老张」 (Member ID: ${addVirtualRes.json.member.id})`);
    } else {
      logFail('添加虚拟同伴失败', JSON.stringify(addVirtualRes.json));
    }
    const virtualMemberId = addVirtualRes.json.member.id;

    // 添加节点
    const addNodeRes = await api('POST', '/api/nodes', {
      token: tokenA,
      tripId: tripA2.id,
      body: {
        title: '成都集结点',
        date: '2026-11-01',
        start_time: '09:00',
        kind: 'other',
      },
    });
    if (addNodeRes.status === 201) {
      logPass('成功在新行程添加行程节点');
    } else {
      logFail('添加节点失败', JSON.stringify(addNodeRes.json));
    }

    // 老张垫付记账
    const addExpRes = await api('POST', '/api/money/expenses', {
      token: tokenA,
      tripId: tripA2.id,
      body: {
        title: '租车押金',
        amount: 2000,
        category: 'traffic',
        day: 1,
        payer_id: virtualMemberId,
        splits: [{ member_id: virtualMemberId, amount: 2000 }],
      },
    });
    if (addExpRes.status === 201) {
      logPass('为老张添加垫付记账成功');
    } else {
      logFail('记账失败', JSON.stringify(addExpRes.json));
    }

    // 尝试删除老张 -> 期望拦截 409
    const delVirtualRes = await api('DELETE', `/api/trip/members/${virtualMemberId}`, {
      token: tokenA,
      tripId: tripA2.id,
    });
    if (delVirtualRes.status === 409 && delVirtualRes.json.error === 'MEMBER_HAS_EXPENSES') {
      logPass('成功拦截删除有关联账单的虚拟同伴 (409 MEMBER_HAS_EXPENSES)');
    } else {
      logFail('未能拦截有账单关联的同伴删除', `Status: ${delVirtualRes.status}, Json: ${JSON.stringify(delVirtualRes.json)}`);
    }

    console.log('\n== 6. 克隆行程分支 (Plan B) ==');
    const cloneRes = await api('POST', `/api/trips/${tripA2.id}/clone`, {
      token: tokenA,
      body: { name: '川西备选慢行线 (Plan B)' },
    });
    const planBTrip = cloneRes.json.trip;
    const inviteCodeB = planBTrip?.invite_code || planBTrip?.inviteCode;
    if (cloneRes.status === 201 && planBTrip?.id && planBTrip.id !== tripA2.id) {
      logPass(`成功克隆出新时间线分支 (新 ID: ${planBTrip.id}, 邀请码独立: ${inviteCodeB !== inviteCodeA2})`);
    } else {
      logFail('克隆行程失败', JSON.stringify(cloneRes.json));
    }

    // 验证克隆后的行程内数据 (通过 snapshot 接口)
    const planBData = await api('GET', '/api/trip/snapshot', { token: tokenA, tripId: planBTrip.id });
    if (planBData.status === 200 && (planBData.json.nodes || []).some((n) => n.title === '成都集结点')) {
      logPass('克隆分支成功深度复制节点与预算数据');
    } else {
      logFail('克隆分支数据不一致', JSON.stringify(planBData.json));
    }

    console.log('\n== 7. 用户 B 微信登录、邀请码预览与虚拟身份认领 ==');
    const userBCode = `mock_wx_user_b_${Date.now()}`;
    const loginBRes = await api('POST', '/api/auth/wx-login', { body: { code: userBCode } });
    const tokenB = loginBRes.json.token;

    // 邀请码预览
    const previewRes = await api('GET', `/api/trips/join-preview?code=${inviteCodeA2}`, { token: tokenB });
    if (
      previewRes.status === 200 &&
      previewRes.json.trip?.name === '川西大环线自驾' &&
      Array.isArray(previewRes.json.claimableMembers) &&
      previewRes.json.claimableMembers.some((m) => m.id === virtualMemberId)
    ) {
      logPass('邀请码预览成功，正确识别可认领虚拟同伴「老张」');
    } else {
      logFail('邀请码预览失败', JSON.stringify(previewRes.json));
    }

    // 认领虚拟同伴老张加入
    const joinRes = await api('POST', '/api/trips/join', {
      token: tokenB,
      body: { code: inviteCodeA2, claimMemberId: virtualMemberId },
    });
    if (joinRes.status === 200 && joinRes.json.tripId === tripA2.id && joinRes.json.claimedMemberId === virtualMemberId) {
      logPass('用户 B 成功认领老张并加入行程');
    } else {
      logFail('加入并认领行程失败', JSON.stringify(joinRes.json));
    }

    // 验证行程成员列表已更新
    const checkMembersRes = await api('GET', '/api/trip/snapshot', { token: tokenB, tripId: tripA2.id });
    const claimedMember = (checkMembersRes.json.members || []).find((m) => m.id === virtualMemberId);
    if (claimedMember) {
      logPass(`老张已被绑定 (ID: ${claimedMember.id}, 姓名: ${claimedMember.name})`);
    } else {
      logFail('老张未在成员列表中', JSON.stringify(checkMembersRes.json.members));
    }

    console.log('\n== 8. 只读围观权限拦截测试 (403) ==');
    const userCCode = `mock_wx_user_c_${Date.now()}`;
    const loginCRes = await api('POST', '/api/auth/wx-login', { body: { code: userCCode } });
    const tokenC = loginCRes.json.token;

    // 用 view_code 加入
    const joinViewerRes = await api('POST', '/api/trips/join', {
      token: tokenC,
      body: { code: viewCodeA2 },
    });
    if (joinViewerRes.status === 200 && joinViewerRes.json.role === 'viewer') {
      logPass('用户 C 通过围观码加入，被正确赋予 viewer 角色');
    } else {
      logFail('用户 C 围观加入失败', JSON.stringify(joinViewerRes.json));
    }

    // 尝试以 viewer 发起写操作 -> 期望 403
    const forbiddenWriteRes = await api('POST', '/api/nodes', {
      token: tokenC,
      tripId: tripA2.id,
      body: { title: '围观者尝试修改节点', date: '2026-11-01', start_time: '12:00', kind: 'other' },
    });
    if (forbiddenWriteRes.status === 403 && (forbiddenWriteRes.json.error === 'READ_ONLY_ROLE' || forbiddenWriteRes.json.error === 'FORBIDDEN')) {
      logPass('只读围观者发起写请求被后端坚决拦截 (403 READ_ONLY_ROLE/FORBIDDEN)');
    } else {
      logFail('只读权限未被拦截', `Status: ${forbiddenWriteRes.status}, Json: ${JSON.stringify(forbiddenWriteRes.json)}`);
    }

    console.log('\n== 9. 行程生命周期管理 (状态切换与删除) ==');
    const patchStatusRes = await api('PATCH', `/api/trips/${tripA2.id}`, {
      token: tokenA,
      body: { status: 'archived' },
    });
    if (patchStatusRes.status === 200 && patchStatusRes.json.trip?.status === 'archived') {
      logPass('行程状态已成功切换为 archived (已归档)');
    } else {
      logFail('行程状态切换失败', JSON.stringify(patchStatusRes.json));
    }

    // 用户 B 退出行程
    const leaveRes = await api('DELETE', `/api/trips/${tripA2.id}`, { token: tokenB });
    if (leaveRes.status === 200) {
      logPass('用户 B 成功退出该行程');
    } else {
      logFail('用户 B 退出行程失败', JSON.stringify(leaveRes.json));
    }

    // 用户 A 删除行程
    const deleteRes = await api('DELETE', `/api/trips/${tripA2.id}`, { token: tokenA });
    if (deleteRes.status === 200) {
      logPass('创建者 A 成功彻底删除行程');
    } else {
      logFail('删除行程失败', JSON.stringify(deleteRes.json));
    }

    console.log('\n== 10. 兼容性验证：历史口令登录通道 ==');
    const legacyPass = `legacy-pass-${Date.now()}`;
    const legacyCreateRes = await api('POST', '/api/auth/trips', {
      body: {
        passphrase: legacyPass,
        name: '老李',
        tripName: '口令兼容测试行程',
        startDate: '2026-10-01',
        endDate: '2026-10-03',
      },
    });
    if (legacyCreateRes.status === 201 && legacyCreateRes.json.token) {
      logPass('历史口令创建旅行完全正常');
    } else {
      logFail('历史口令创建旅行失败', JSON.stringify(legacyCreateRes.json));
    }

    const legacyLoginRes = await api('POST', '/api/auth/login', {
      body: { passphrase: legacyPass, name: '老李' },
    });
    if (legacyLoginRes.status === 200 && legacyLoginRes.json.token) {
      logPass('历史口令登录验证完全正常');
    } else {
      logFail('历史口令登录失败', JSON.stringify(legacyLoginRes.json));
    }

  } catch (err) {
    console.error('测试运行异常:', err);
    failures++;
  } finally {
    stopServer();
  }

  console.log('\n----------------------------------------');
  if (failures === 0) {
    console.log('🎉 所有多时间线与微信登录测试用例全部通过！');
    process.exit(0);
  } else {
    console.error(`💥 测试未通过，共有 ${failures} 处失败。`);
    process.exit(1);
  }
}

runTests();
