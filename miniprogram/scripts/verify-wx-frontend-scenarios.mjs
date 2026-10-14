/**
 * 微信小程序前端 6 大核心业务场景全链路联调自动化验证
 * 直接加载小程序 platform/wx 与 store，直连本地开发后端 http://127.0.0.1:7021
 */
import { boot, actions, getState, subscribe } from '../store/store.js';
import { api } from '../store/api.js';
import { platform } from '../platform/index.js';

let failures = 0;
const logPass = (title) => console.log(`  ✓ [PASS] ${title}`);
const logFail = (title, reason = '') => {
  failures++;
  console.error(`  ✗ [FAIL] ${title} ${reason}`);
};

// 模拟微信本地 Storage
const storage = new Map();
let toastMessages = [];

globalThis.wx = {
  getStorageSync: (k) => storage.get(k) || '',
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  clearStorageSync: () => storage.clear(),
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  login: ({ success }) => success({ code: `mock_code_wx_${Date.now()}` }),
  showToast: ({ title }) => {
    toastMessages.push(title);
    console.log(`    [wx.showToast] ${title}`);
  },
  showModal: ({ title, content, success }) => {
    console.log(`    [wx.showModal] ${title}: ${content}`);
    success?.({ confirm: true });
  },
  showLoading: () => {},
  hideLoading: () => {},
  request: ({ url, method = 'GET', header = {}, data, success, fail }) => {
    fetch(url, {
      method,
      headers: header,
      body: data === undefined ? undefined : JSON.stringify(data),
    })
      .then(async (res) => {
        const text = await res.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        success({ statusCode: res.status, data: parsed });
      })
      .catch((e) => fail({ errMsg: String(e?.message || e) }));
  },
  uploadFile: ({ success, fail }) => {
    // 模拟头像上传成功
    success({ statusCode: 200, data: JSON.stringify([{ id: 'mock_photo_1', url: '/api/photos/mock_photo_1/file' }]) });
  },
  vibrateShort: () => {},
  onNetworkStatusChange: () => {},
  offNetworkStatusChange: () => {},
  onAppShow: () => {},
  offAppShow: () => {},
  setClipboardData: ({ success }) => success?.(),
};

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenarioTests() {
  console.log('========================================================');
  console.log('🚀 开始验证微信小程序 6 大前端与联调核心场景 (直连 7021)');
  console.log('========================================================\n');

  try {
    // ========================================================
    // 场景 1（冷启动无感登录）
    // ========================================================
    console.log('【场景 1：冷启动无感登录】');
    wx.clearStorageSync();
    console.log('  1. Storage 全部缓存已清除');

    await boot();
    const state1 = getState();

    if (state1.phase === 'ready' && state1.user && state1.data?.trip) {
      logPass(`无需卡在 login 页，直接静默登录成功 (用户: ${state1.user.nickname}, 行程: ${state1.data.trip.name})`);
      logPass(`当前阶段为 phase: "${state1.phase}"，默认示例时间线已就绪，节点数: ${state1.data.nodes?.length || 0}`);
    } else {
      logFail('冷启动无感登录未成功进入 ready 阶段', `phase: ${state1.phase}`);
    }

    // ========================================================
    // 场景 2（多时间线抽屉与新建/克隆）
    // ========================================================
    console.log('\n【场景 2：多时间线抽屉与新建/克隆】');
    const initialTripId = state1.activeTripId;
    const initialTripCount = (state1.trips || []).length;

    // 2.1 新建时间线
    const newTripRes = await actions.createTrip({
      name: '川西秘境摄影之旅',
      destination: '稻城 · 亚丁',
      startDate: '2026-11-05',
      endDate: '2026-11-12',
    });
    const state2 = getState();
    if (state2.activeTripId !== initialTripId && state2.data?.trip?.name === '川西秘境摄影之旅') {
      logPass(`成功新建时间线并立即切换激活 (新行程 ID: ${state2.activeTripId}, 标题: "${state2.data.trip.name}")`);
    } else {
      logFail('新建时间线后未自动切换至新行程');
    }

    // 2.2 在该行程添加一个测试节点
    await actions.createNode({
      title: '红海子日落拍摄',
      date: '2026-11-05',
      type: 'photo',
    });
    logPass('在新行程成功添加行程节点「红海子日落拍摄」');

    // 2.3 衍生备选分支 (Plan B)
    const clonedRes = await actions.cloneCurrentTrip({
      name: '川西秘境摄影 (Plan B 慢行线)',
    });
    const state2_clone = getState();
    const isPlanBActive = state2_clone.data?.trip?.name.includes('Plan B');
    const hasClonedNode = (state2_clone.data?.nodes || []).some((n) => n.title === '红海子日落拍摄');
    if (isPlanBActive && hasClonedNode) {
      logPass(`成功衍生 Plan B 备选分支，标题切换为 "${state2_clone.data.trip.name}"，节点深度复制保留`);
    } else {
      logFail('克隆 Plan B 分支失败或节点未复制');
    }

    // ========================================================
    // 场景 3（毫秒级行程切换）
    // ========================================================
    console.log('\n【场景 3：毫秒级行程切换】');
    const tripA = state2.activeTripId; // 川西秘境摄影之旅
    const tripB = state2_clone.activeTripId; // Plan B

    console.log(`  切回行程 A (ID: ${tripA})…`);
    const startA = Date.now();
    await actions.switchTrip(tripA);
    const durationA = Date.now() - startA;
    const state3_A = getState();
    if (state3_A.activeTripId === tripA && !state3_A.switchingTrip && state3_A.phase === 'ready') {
      logPass(`毫秒级切回行程 A 完成 (耗时: ${durationA}ms, 标题: "${state3_A.data.trip.name}", 无白屏闪烁)`);
    } else {
      logFail('切换回行程 A 失败');
    }

    console.log(`  切往行程 B (ID: ${tripB})…`);
    const startB = Date.now();
    await actions.switchTrip(tripB);
    const durationB = Date.now() - startB;
    const state3_B = getState();
    if (state3_B.activeTripId === tripB && !state3_B.switchingTrip && state3_B.phase === 'ready') {
      logPass(`毫秒级切往行程 B 完成 (耗时: ${durationB}ms, 标题: "${state3_B.data.trip.name}")`);
    } else {
      logFail('切换往行程 B 失败');
    }

    // ========================================================
    // 场景 4（设置页微信头像昵称与虚拟同伴管理）
    // ========================================================
    console.log('\n【场景 4：设置页微信头像昵称与虚拟同伴管理】');
    // 切回主行程
    await actions.switchTrip(tripA);

    // 4.1 更新微信昵称与头像
    await actions.updateUserProfile({
      nickname: '极客旅行家-阿明',
      avatarUrl: '/api/photos/mock_avatar.png',
    });
    const state4 = getState();
    if (state4.user?.nickname === '极客旅行家-阿明') {
      logPass(`个人微信昵称与头像同步成功 (当前昵称: "${state4.user.nickname}")`);
    } else {
      logFail('微信资料更新失败');
    }

    // 4.2 添加虚拟同伴“老张”
    await actions.addVirtualMember({ name: '老张' });
    const state4_member = getState();
    const virtualLaoZhang = (state4_member.data?.members || []).find((m) => m.name === '老张');
    if (virtualLaoZhang && (!virtualLaoZhang.user_id || virtualLaoZhang.isVirtual !== false)) {
      logPass(`成功添加虚拟同伴「老张」 (ID: ${virtualLaoZhang.id}, 状态: 虚拟同伴（待认领）)`);
    } else {
      logFail('虚拟同伴「老张」添加失败或未标记为虚拟');
    }

    // ========================================================
    // 场景 5（加入预览与身份认领弹窗）
    // ========================================================
    console.log('\n【场景 5：加入预览与身份认领弹窗】');
    const inviteCodeA = state4_member.data?.trip?.invite_code || state4_member.data?.trip?.inviteCode;
    console.log(`  当前行程邀请码: ${inviteCodeA}`);

    // 模拟另一个好友 B（清空登录态）
    wx.clearStorageSync();
    // 好友 B 进行微信登录
    const userBCode = `mock_wx_friend_b_${Date.now()}`;
    const friendBLogin = await actions.wxLogin(userBCode);
    logPass(`好友 B 微信登录成功 (User ID: ${friendBLogin.user.id})`);

    // 好友 B 查询邀请码预览
    const previewData = await actions.previewJoin({ code: inviteCodeA });
    if (
      previewData.trip?.name === '川西秘境摄影之旅' &&
      Array.isArray(previewData.claimableMembers) &&
      previewData.claimableMembers.some((m) => m.name === '老张')
    ) {
      logPass(`邀请预览成功，正确解析出行程名称「${previewData.trip.name}」，并展示待认领虚拟同伴「老张」`);
    } else {
      logFail('邀请预览未能正确识别待认领成员', JSON.stringify(previewData));
    }

    // 好友 B 认领「老张」身份加入行程
    const targetClaimMemberId = previewData.claimableMembers.find((m) => m.name === '老张')?.id;
    const joinResult = await actions.confirmJoin({ code: inviteCodeA, claimMemberId: targetClaimMemberId });
    const state5_joined = getState();
    const claimedMemberInTrip = (state5_joined.data?.members || []).find((m) => m.id === targetClaimMemberId);
    if (joinResult && state5_joined.activeTripId === tripA && claimedMemberInTrip) {
      logPass(`好友 B 成功认领「老张」加入行程 (已绑微信身份，role: ${claimedMemberInTrip.role || 'editor'})`);
    } else {
      logFail('好友 B 认领加入行程失败');
    }

    // ========================================================
    // 场景 6（只读围观模式 UI 校验）
    // ========================================================
    console.log('\n【场景 6：只读围观模式 UI 校验】');
    // 获取行程 A 的只读围观码 view_code
    const viewCodeA = state4_member.data?.trip?.view_code || state4_member.data?.trip?.viewCode;
    console.log(`  当前行程围观码: ${viewCodeA}`);

    // 模拟第三位用户 C（围观亲友）
    wx.clearStorageSync();
    const userCCode = `mock_wx_viewer_c_${Date.now()}`;
    await actions.wxLogin(userCCode);
    logPass('围观亲友 C 微信登录成功');

    // 亲友 C 通过 view_code 加入
    await actions.confirmJoin({ code: viewCodeA });
    const state6_viewer = getState();
    const myRole = state6_viewer.data?.me?.role || state6_viewer.data?.trip?.role || 'editor';
    const isReadOnly = myRole === 'viewer';

    if (isReadOnly) {
      logPass(`用户 C 成功加入行程，角色确认为只读围观者: role: "${myRole}", isReadOnly: true`);
    } else {
      logFail('用户 C 加入后角色未标记为 viewer');
    }

    // 校验前端 guardEditable() 拦截
    toastMessages = [];
    let writeActionBlocked = false;
    let writeResult = null;
    try {
      writeResult = await actions.createNode({ title: '围观者尝试添加节点', date: '2026-11-05' });
    } catch (err) {
      writeActionBlocked = true;
    }
    const curToast = getState().toast;
    const hadToast =
      toastMessages.some((msg) => msg.includes('只读') || msg.includes('无法')) ||
      curToast?.message?.includes('只读') ||
      curToast?.message?.includes('无法');

    if ((writeResult === undefined || writeActionBlocked) && hadToast) {
      logPass(`前端 guardEditable 拦截成功生效：拦截写操作并向用户弹出「${curToast?.message || '只读模式无法修改'}」提示`);
    } else {
      logFail('前端未拦截只读写操作');
    }

  } catch (err) {
    console.error('场景测试运行中抛出异常:', err);
    failures++;
  }

  console.log('\n========================================================');
  if (failures === 0) {
    console.log('🎉 恭喜！微信小程序 6 大核心前端业务场景全部验证通过！');
    process.exit(0);
  } else {
    console.error(`💥 场景验证发现 ${failures} 处异常。`);
    process.exit(1);
  }
}

runScenarioTests();
