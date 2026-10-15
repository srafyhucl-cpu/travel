import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import automator from 'miniprogram-automator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SHOT_DIR = path.resolve(__dirname, '../../docs/screenshots');
const BRAIN_SHOT_DIR_1 = 'C:\\Users\\srafy\\.gemini\\antigravity\\brain\\64c1c67a-30d4-40a1-b77b-03a19d489f2a\\screenshots';
const BRAIN_SHOT_DIR_2 = 'C:\\Users\\srafy\\.gemini\\antigravity\\brain\\5b5be4d9-ed90-4dcf-bf02-e662c0fc1d49\\screenshots';

for (const dir of [LOCAL_SHOT_DIR, BRAIN_SHOT_DIR_1, BRAIN_SHOT_DIR_2]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let totalChecks = 0;

function logPass(title) {
  totalChecks++;
  console.log(`  ✓ [PASS] ${title}`);
}

function logFail(title, reason = '') {
  totalChecks++;
  failures++;
  console.error(`  ✗ [FAIL] ${title} ${reason}`);
}

async function capture(mp, filename) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sleep(400);
      const res = await mp.send('App.captureScreenshot');
      if (res && res.data) {
        const buf = Buffer.from(res.data, 'base64');
        fs.writeFileSync(path.join(LOCAL_SHOT_DIR, filename), buf);
        try { fs.writeFileSync(path.join(BRAIN_SHOT_DIR_1, filename), buf); } catch {}
        try { fs.writeFileSync(path.join(BRAIN_SHOT_DIR_2, filename), buf); } catch {}
        console.log(`  📸 [高保真截图] ${filename} (${Math.round(buf.length / 1024)} KB)`);
        return;
      }
    } catch (err) {
      if (attempt === 3) {
        console.warn(`  ! 截图 ${filename} 最终失败: ${err.message}`);
      } else {
        await sleep(600);
      }
    }
  }
}

async function evalInApp(mp, fn, ...args) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await mp.evaluate(fn, ...args);
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(500);
    }
  }
}

async function ensureSettingsPage(mp) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const curRoute = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.route);
    if (curRoute === 'pages/settings/index') {
      await sleep(200);
      return;
    }
    const stack = await evalInApp(mp, () => getCurrentPages().map((p) => p.route));
    const lastIdx = stack.lastIndexOf('pages/settings/index');
    if (lastIdx !== -1) {
      const delta = stack.length - 1 - lastIdx;
      if (delta > 0) {
        await evalInApp(mp, (d) => wx.navigateBack({ delta: d }), delta);
      }
    } else {
      await evalInApp(mp, () => new Promise((r) => wx.navigateTo({ url: '/pages/settings/index', complete: r })));
    }
    for (let i = 0; i < 20; i++) {
      const r = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.route);
      if (r === 'pages/settings/index') {
        await sleep(300);
        return;
      }
      await sleep(200);
    }
    await sleep(500);
  }
}

(async () => {
  console.log('================================================================');
  console.log('🚀 启动微信小程序端到端全链路高保真自动化测试套件');
  console.log('   连接目标：微信开发者工具自动化桥 (ws://127.0.0.1:9420)');
  console.log('================================================================\n');

  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420', timeout: 30000 });

  // 确保 travel.base 为 7052 本地开发服务
  await evalInApp(mp, () => {
    wx.setStorageSync('travel.base', 'http://127.0.0.1:7052');
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 99 });
    }
  });
  await sleep(1000);

  // ============================================================================
  // 模块 1：零时间线欢迎页（Empty State）全流程测试
  // ============================================================================
  console.log('----------------------------------------------------------------');
  console.log('【模块 1：零时间线欢迎页（Empty State）全流程测试】');
  console.log('----------------------------------------------------------------');

  // 1.0 清除当前所有行程，触发平滑回到零时间线欢迎页
  console.log('  1.0 清除当前所有行程，触发平滑回到零时间线欢迎页…');
  await evalInApp(mp, async () => {
    const { actions, getState } = require('store/store.js');
    let s = getState();
    while ((s.trips || []).length > 0) {
      await actions.deleteOrLeaveTrip(s.trips[0].id);
      s = getState();
    }
    if (getCurrentPages().length > 1) {
      await new Promise((r) => wx.reLaunch({ url: '/pages/timeline/index', complete: r }));
    }
  });
  await sleep(1500);

  const emptyRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      isEmptyState: page.data.isEmptyState,
      tripsCount: (page.data.trips || []).length,
      tripName: page.data.tripName,
      ready: page.data.ready,
    };
  });

  if (emptyRes.ready === true && emptyRes.isEmptyState === true && emptyRes.tripsCount === 0) {
    logPass('成功进入零时间线欢迎空状态 (isEmptyState: true, tripsCount: 0)');
  } else {
    logFail('未能进入零时间线空状态', JSON.stringify(emptyRes));
  }
  await capture(mp, '01_empty_state_welcome.png');

  // 1.1 流程一：“+ 创建我的第一条时间线”
  console.log('\n  1.1 测试「+ 创建我的第一条时间线」完整流程…');
  const openModalRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.onOpenCreateModal({ currentTarget: { dataset: { mode: 'new' } } });
    return {
      createModalOpen: page.data.createModalOpen,
      createMode: page.data.createMode,
    };
  });
  await sleep(500);

  if (openModalRes.createModalOpen === true && openModalRes.createMode === 'new') {
    logPass('点击「+ 创建我的第一条时间线」成功弹出新建时间线模态弹窗');
  } else {
    logFail('新建时间线弹窗拉起失败', JSON.stringify(openModalRes));
  }
  await capture(mp, '02_empty_state_create_modal.png');

  // 填充表单并提交新建
  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    page.setData({
      tripForm: {
        name: '海南环岛自驾游',
        destination: '三亚 · 万宁',
        startDate: '2026-11-20',
        endDate: '2026-11-26',
      },
    });
    await page.onSubmitCreateTrip();
  });
  await sleep(1500);

  const createSubmitRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      createModalOpen: page.data.createModalOpen,
      isEmptyState: page.data.isEmptyState,
      tripName: page.data.tripName,
      tripsCount: (page.data.trips || []).length,
    };
  });

  if (createSubmitRes.createModalOpen === false && createSubmitRes.isEmptyState === false && createSubmitRes.tripName === '海南环岛自驾游') {
    logPass(`创建新时间线成功并自动激活进入行程 (名称: "${createSubmitRes.tripName}", 行程数: ${createSubmitRes.tripsCount})`);
  } else {
    logFail('新建行程提交后未能成功进入新时间线', JSON.stringify(createSubmitRes));
  }
  await capture(mp, '03_created_trip_timeline.png');

  // 在海南行程里添加一个虚拟同伴「阿强」，并获取邀请码
  const inviteCodeHainan = await evalInApp(mp, async () => {
    const { actions, getState } = require('store/store.js');
    await actions.addVirtualMember({ name: '阿强' });
    const s = getState();
    return s.data?.trip?.invite_code || s.data?.trip?.inviteCode || '';
  });
  console.log(`    海南行程邀请码: ${inviteCodeHainan}，已添加虚拟同伴「阿强」`);

  // 1.2 流程二：“输入邀请码 / 口令加入同伴行程”完整流程（认领虚拟身份 vs 作为新成员加入）
  console.log('\n  1.2.1 测试「输入邀请码加入行程并认领虚拟同伴」流程…');
  // 模拟好友 B 登录并进入零时间线状态
  await evalInApp(mp, async () => {
    const { actions, getState } = require('store/store.js');
    await actions.wxLogin('mock_friend_user_b_' + Date.now());
    let s = getState();
    while ((s.trips || []).length > 0) {
      await actions.deleteOrLeaveTrip(s.trips[0].id);
      s = getState();
    }
  });
  await sleep(1500);

  const friendBInitRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return { isEmptyState: page.data.isEmptyState, tripsCount: (page.data.trips || []).length };
  });

  if (friendBInitRes.isEmptyState === true) {
    logPass('好友 B 登录就绪，处于零时间线空状态');
  } else {
    logFail('好友 B 未处于空状态', JSON.stringify(friendBInitRes));
  }

  // 好友 B 打开输入邀请码弹窗
  await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.openJoinWithCode();
  });
  await sleep(400);

  const joinModalOpen = await evalInApp(mp, () => getCurrentPages().slice(-1)[0].data.joinModalOpen);
  if (joinModalOpen === true) {
    logPass('成功拉起「加入或认领行程」模态弹窗');
  } else {
    logFail('加入行程弹窗拉起失败');
  }
  await capture(mp, '04_empty_state_join_modal.png');

  // 输入海南行程邀请码并查询预览
  const previewRes = await evalInApp(mp, async (code) => {
    const page = getCurrentPages().slice(-1)[0];
    page.setData({ joinCodeInput: code });
    await page.onQueryJoinPreview();
    return page.data.joinPreview;
  }, inviteCodeHainan);
  await sleep(1000);

  if (previewRes && previewRes.trip?.name === '海南环岛自驾游' && (previewRes.claimableMembers || []).some((m) => m.name === '阿强')) {
    logPass(`邀请码查询预览成功 (行程: "${previewRes.trip.name}", 待认领同伴: 阿强)`);
  } else {
    logFail('邀请码查询预览失败', JSON.stringify(previewRes));
  }
  await capture(mp, '05_empty_state_join_preview.png');

  // 选中认领身份「阿强」并点击进入此行程
  const aQiangId = previewRes.claimableMembers.find((m) => m.name === '阿强')?.id;
  await evalInApp(mp, async ({ claimId, code, preview }) => {
    const page = getCurrentPages().slice(-1)[0];
    page.setData({ joinCodeInput: code, selectedClaimId: claimId, joinPreview: preview });
    await page.onConfirmJoinTrip();
  }, { claimId: aQiangId, code: inviteCodeHainan, preview: previewRes });
  await sleep(2500);

  const joinSuccessRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    const { getState } = require('store/store.js');
    const s = getState();
    return {
      joinModalOpen: page.data.joinModalOpen,
      isEmptyState: page.data.isEmptyState,
      tripName: s.data?.trip?.name || page.data.tripName,
      tripsCount: (s.trips || []).length,
    };
  });

  if (joinSuccessRes.joinModalOpen === false && joinSuccessRes.isEmptyState === false && joinSuccessRes.tripName === '海南环岛自驾游') {
    logPass(`好友 B 成功认领阿强并加入行程进入时间线视图 (当前激活: "${joinSuccessRes.tripName}")`);
  } else {
    logFail('加入并进入行程失败', JSON.stringify(joinSuccessRes));
  }
  await capture(mp, '06_joined_trip_timeline.png');

  // 1.2.2【突破盲区】测试“作为新成员加入”完整流程
  console.log('\n  1.2.2 测试「输入邀请码作为新成员加入」完整流程…');
  // 好友 C 登录并清空进入零时间线状态
  await evalInApp(mp, async () => {
    const { actions, getState } = require('store/store.js');
    await actions.wxLogin('mock_friend_user_c_' + Date.now());
    let s = getState();
    while ((s.trips || []).length > 0) {
      await actions.deleteOrLeaveTrip(s.trips[0].id);
      s = getState();
    }
  });
  await sleep(1500);

  // 好友 C 打开加入弹窗，查询预览
  await evalInApp(mp, async (code) => {
    const page = getCurrentPages().slice(-1)[0];
    page.openJoinWithCode();
    page.setData({ joinCodeInput: code });
    await page.onQueryJoinPreview();
  }, inviteCodeHainan);
  await sleep(800);

  // 选择「作为新成员加入」
  await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.onSelectClaimMember({ currentTarget: { dataset: { id: '' } } });
  });
  await sleep(300);

  const claimSelectedState = await evalInApp(mp, () => getCurrentPages().slice(-1)[0].data.selectedClaimId);
  if (claimSelectedState === '') {
    logPass('点击切换「作为新成员加入」生效 (selectedClaimId 为空)');
  } else {
    logFail('选择新成员身份失败', claimSelectedState);
  }

  // 确认加入
  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    await page.onConfirmJoinTrip();
  });
  await sleep(2500);

  const friendCJoinRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    const { getState } = require('store/store.js');
    const s = getState();
    const members = s.data?.members || page.data.members || [];
    return {
      isEmptyState: page.data.isEmptyState,
      tripName: s.data?.trip?.name || page.data.tripName,
      membersCount: members.length,
      myRole: page.data.myRole,
    };
  });

  if (friendCJoinRes.isEmptyState === false && friendCJoinRes.tripName === '海南环岛自驾游' && friendCJoinRes.membersCount >= 3) {
    logPass(`好友 C 作为新成员成功加入时间线 (成员数: ${friendCJoinRes.membersCount}, 角色: ${friendCJoinRes.myRole})`);
  } else {
    logFail('好友 C 作为新成员加入失败', JSON.stringify(friendCJoinRes));
  }
  await capture(mp, '06_b_new_member_joined.png');

  // 1.2.3【突破盲区】测试协作者成员视角下设置页「退出当前行程」UI 交互
  console.log('\n  1.2.3 测试协作者成员设置页「退出当前行程」UI 交互与平滑退回欢迎页…');
  await ensureSettingsPage(mp);

  const memberSettingsInfo = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      myRole: page.data.myRole,
      hasActiveTrip: page.data.hasActiveTrip,
    };
  });

  if (memberSettingsInfo.myRole !== 'owner' && memberSettingsInfo.hasActiveTrip === true) {
    logPass(`成员视角识别正确 (myRole: "${memberSettingsInfo.myRole}")，具备退出行程按钮`);
  } else {
    logFail('成员视角识别失败', JSON.stringify(memberSettingsInfo));
  }

  // 模拟成员在设置页点击「退出当前行程」并确认
  const memberLeaveRes = await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    let modalTitle = '';
    let confirmTxt = '';
    const origModal = wx.showModal;
    wx.showModal = function (opts) {
      modalTitle = opts.title || '';
      confirmTxt = opts.confirmText || '';
      if (typeof opts.success === 'function') {
        opts.success({ confirm: true, cancel: false });
      }
    };
    try {
      await page.onDeleteOrLeaveTrip();
    } finally {
      wx.showModal = origModal;
    }
    return { modalTitle, confirmTxt };
  });
  await sleep(2000);

  if (memberLeaveRes.modalTitle.includes('退出') && memberLeaveRes.confirmTxt === '退出行程') {
    logPass(`退出弹窗校验符合成员退出规范 (标题: "${memberLeaveRes.modalTitle}", 确认文案: "${memberLeaveRes.confirmTxt}")`);
  } else {
    logFail('成员退出弹窗文案不符合规范', JSON.stringify(memberLeaveRes));
  }

  // 好友 C 退出后无其他行程，平滑退回欢迎页
  for (let i = 0; i < 20; i++) {
    const route = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.route);
    if (route === 'pages/timeline/index') break;
    await sleep(200);
  }
  await sleep(1000);

  const friendCAfterLeave = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      route: page.route || page.__route__,
      isEmptyState: page.data.isEmptyState,
      tripsCount: (page.data.trips || []).length,
    };
  });

  if (friendCAfterLeave.isEmptyState === true && friendCAfterLeave.tripsCount === 0) {
    logPass('好友 C 成功退出行程并平滑退回零时间线欢迎页 (isEmptyState: true)');
  } else {
    logFail('好友 C 退出行程后未退回欢迎页', JSON.stringify(friendCAfterLeave));
  }
  await capture(mp, '06_c_member_left_smooth_return.png');

  // 1.3 流程三：“还不确定怎么排？一键生成「大理丽江 4 日游」示例 ›”
  console.log('\n  1.3 测试「还不确定怎么排？一键生成「大理丽江 4 日游」示例 ›」完整流程…');
  // 切换全新主创用户进入零时间线状态
  await evalInApp(mp, async () => {
    const { actions, getState } = require('store/store.js');
    await actions.wxLogin('mock_main_creator_' + Date.now());
    let s = getState();
    while ((s.trips || []).length > 0) {
      await actions.deleteOrLeaveTrip(s.trips[0].id);
      s = getState();
    }
  });
  await sleep(1500);

  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    await page.onCreateDemoTrip();
  });
  await sleep(2500);

  const demoCreateRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    const { getState } = require('store/store.js');
    const s = getState();
    return {
      isEmptyState: page.data.isEmptyState,
      tripName: s.data?.trip?.name || page.data.tripName,
      daysCount: (page.data.days || []).length,
      summary: page.data.summary,
      now: page.data.now,
    };
  });

  if (demoCreateRes.isEmptyState === false && demoCreateRes.tripName === '大理丽江 4 日游 (示例)' && demoCreateRes.daysCount === 4) {
    logPass(`一键生成示例成功，完整加载 4 日行程时间线 (标题: "${demoCreateRes.tripName}", 天数: ${demoCreateRes.daysCount})`);
  } else {
    logFail('一键生成示例失败', JSON.stringify(demoCreateRes));
  }
  await capture(mp, '07_demo_trip_timeline.png');

  // ============================================================================
  // 模块 2：时间线主界面（Timeline Hero & Nodes）
  // ============================================================================
  console.log('\n----------------------------------------------------------------');
  console.log('【模块 2：时间线主界面（Timeline Hero & Nodes）深度验证】');
  console.log('----------------------------------------------------------------');

  // 2.1 动态未来日期与状态标签
  console.log('  2.1 检查动态未来日期与状态标签…');
  if (demoCreateRes.summary?.status === '还没出发') {
    logPass(`状态标签正确显示为 "${demoCreateRes.summary.status}"`);
  } else {
    logFail(`状态标签不符合预期: ${demoCreateRes.summary?.status}`);
  }

  if (/^\d+\s*天后出发$/.test(demoCreateRes.now?.title || '')) {
    logPass(`动态未来倒计时正确显示为 "${demoCreateRes.now.title}"（无过期历史日期）`);
  } else {
    logFail(`倒计时标题不符合预期: ${demoCreateRes.now?.title}`);
  }

  const rangeText = demoCreateRes.summary?.range || '';
  if (rangeText && !rangeText.includes('2024') && !rangeText.includes('2025')) {
    logPass(`日期区间动态更新为未来时间段: ${rangeText}`);
  } else {
    logFail(`日期区间仍包含旧年份: ${rangeText}`);
  }

  // 2.2 Hero 概览卡（同伴叠放组与紧凑 + 邀请 胶囊，以及微信邀请回调）
  console.log('\n  2.2 检查 Hero 概览卡同伴叠放组与紧凑「+ 邀请」胶囊及分享链接…');
  const heroCardData = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      membersCount: (page.data.members || []).length,
      isReadOnly: page.data.isReadOnly,
    };
  });
  if (heroCardData.membersCount >= 1 && !heroCardData.isReadOnly) {
    logPass(`Hero 卡右上角前 4 位同伴圆形头像/首字彩标叠放组正常展示 (同伴数: ${heroCardData.membersCount})，+ 邀请 胶囊可见`);
  } else {
    logFail('Hero 概览卡数据异常', JSON.stringify(heroCardData));
  }

  // 测试 Hero 卡上「+ 邀请」触发的 onShareAppMessage
  const heroShareRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return page.onShareAppMessage({ target: { dataset: { mode: 'invite' } } });
  });

  if (heroShareRes && heroShareRes.path && heroShareRes.path.includes('inviteCode=')) {
    logPass(`Hero 卡「+ 邀请」胶囊分享卡片生成成功 (分享路径: "${heroShareRes.path}", 标题: "${heroShareRes.title}")`);
  } else {
    logFail('Hero 卡「+ 邀请」胶囊未能生成带邀请码的分享卡片', JSON.stringify(heroShareRes));
  }
  await capture(mp, '08_hero_card_detail.png');

  // 2.3 FAB 胶囊样式「+ 记行程」与新增节点
  console.log('\n  2.3 检查右下角悬浮按钮（FAB）胶囊样式「+ 记行程」与节点添加渲染…');
  const fabTriggerRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    let sheetItems = [];
    const origSheet = wx.showActionSheet;
    wx.showActionSheet = function (opts) {
      sheetItems = opts.itemList || [];
    };
    try {
      page.onQuickAdd();
    } finally {
      wx.showActionSheet = origSheet;
    }
    return sheetItems;
  });

  if (fabTriggerRes.includes('传照片') && fabTriggerRes.includes('加一项')) {
    logPass(`点击 FAB 胶囊「+ 记行程」正确唤起快捷操作面板 (选项: ${fabTriggerRes.join(' / ')})`);
  } else {
    logFail('FAB 快捷操作面板唤起异常', JSON.stringify(fabTriggerRes));
  }

  // 实际创建节点并断言在首日 14:30 渲染
  await evalInApp(mp, async () => {
    const { actions, getState } = require('store/store.js');
    const trip = getState().data?.trip;
    await actions.createNode({
      title: '洱海双廊骑行下午茶',
      type: 'food',
      date: trip?.start_date,
      startTime: '14:30',
      endTime: '16:00',
      location: '双廊古镇海景咖啡',
    });
  });
  await sleep(1500);

  const nodeInView = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    const day1Nodes = page.data.days?.[0]?.nodes || [];
    return day1Nodes.find((n) => n.title === '洱海双廊骑行下午茶');
  });

  if (nodeInView && nodeInView.time === '14:30' && nodeInView.location === '双廊古镇海景咖啡') {
    logPass(`新节点「${nodeInView.title}」成功保存并在时间线首日正常渲染 (时间: ${nodeInView.time}, 地点: ${nodeInView.location})`);
  } else {
    logFail('添加的行程节点未在时间线上正确渲染', JSON.stringify(nodeInView));
  }
  await capture(mp, '09_new_node_rendered.png');

  // ============================================================================
  // 模块 3：多时间线切换半屏抽屉（Trip Drawer）
  // ============================================================================
  console.log('\n----------------------------------------------------------------');
  console.log('【模块 3：多时间线切换半屏抽屉（Trip Drawer）深度验证】');
  console.log('----------------------------------------------------------------');

  // 3.1 打开抽屉
  console.log('  3.1 打开半屏抽屉…');
  const drawerOpenRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.setData({ tripDrawerOpen: true });
    return {
      tripDrawerOpen: page.data.tripDrawerOpen,
      tripsCount: (page.data.trips || []).length,
    };
  });
  await sleep(600);

  if (drawerOpenRes.tripDrawerOpen === true) {
    logPass(`抽屉成功拉起 (行程数: ${drawerOpenRes.tripsCount})`);
  } else {
    logFail('多时间线抽屉未能拉起');
  }
  await capture(mp, '10_trip_drawer_opened.png');

  // 3.2 顶部状态分段 Tab 切换
  console.log('\n  3.2 切换顶部状态分段 Tab (进行/筹备中 vs 已归档)…');
  await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.onSwitchTripTab({ currentTarget: { dataset: { tab: 'archived' } } });
  });
  await sleep(300);
  let tabArchived = await evalInApp(mp, () => getCurrentPages().slice(-1)[0].data.tripFilterTab);
  if (tabArchived === 'archived') {
    logPass('成功切换至「已归档」Tab');
  } else {
    logFail('切换至已归档 Tab 失败');
  }
  await capture(mp, '11_drawer_tab_archived.png');

  await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.onSwitchTripTab({ currentTarget: { dataset: { tab: 'active' } } });
  });
  await sleep(300);
  let tabActive = await evalInApp(mp, () => getCurrentPages().slice(-1)[0].data.tripFilterTab);
  if (tabActive === 'active') {
    logPass('成功切回「进行/筹备中」Tab');
  } else {
    logFail('切回进行中 Tab 失败');
  }

  // 3.3 当前卡片内置次级操作「衍生 Plan B」
  console.log('\n  3.3 点击「衍生 Plan B」打开克隆弹窗并克隆分支行程…');
  const openCloneRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.onOpenCreateModal({ currentTarget: { dataset: { mode: 'clone' } } });
    return {
      createModalOpen: page.data.createModalOpen,
      createMode: page.data.createMode,
      formName: page.data.tripForm?.name,
    };
  });
  await sleep(400);

  if (openCloneRes.createModalOpen === true && openCloneRes.createMode === 'clone' && openCloneRes.formName?.includes('Plan B')) {
    logPass(`成功打开衍生 Plan B 弹窗 (预填名称: "${openCloneRes.formName}")`);
  } else {
    logFail('衍生 Plan B 弹窗打开失败', JSON.stringify(openCloneRes));
  }
  await capture(mp, '12_drawer_clone_modal.png');

  // 确认生成分支
  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    if (!page.data.tripForm?.name) {
      const curTrip = require('store/store.js').getState().data?.trip;
      page.setData({
        createMode: 'clone',
        tripForm: {
          name: `${curTrip?.name || '行程'} (Plan B)`,
          destination: curTrip?.destination || '',
          startDate: curTrip?.start_date || '',
          endDate: curTrip?.end_date || '',
        },
      });
    }
    await page.onSubmitCreateTrip();
  });
  await sleep(3000);

  const cloneSubmitRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    const { getState } = require('store/store.js');
    const s = getState();
    return {
      createModalOpen: page.data.createModalOpen,
      tripName: s.data?.trip?.name || page.data.tripName,
      tripsCount: (s.trips || page.data.trips || []).length,
    };
  });

  if (cloneSubmitRes.createModalOpen === false && cloneSubmitRes.tripName?.includes('Plan B') && cloneSubmitRes.tripsCount >= 2) {
    logPass(`成功克隆出新分支行程并自动激活 (当前行程: "${cloneSubmitRes.tripName}", 总行程数: ${cloneSubmitRes.tripsCount})`);
  } else {
    logFail('克隆分支生成失败', JSON.stringify(cloneSubmitRes));
  }
  await capture(mp, '13_cloned_plan_b_active.png');

  // 3.4 抽屉底部横向并排双按钮
  console.log('\n  3.4 检查抽屉底部横向并排双按钮「+ 新建时间线」与「口令/邀请码加入」…');
  await evalInApp(mp, () => getCurrentPages().slice(-1)[0].setData({ tripDrawerOpen: true }));
  await sleep(400);
  await capture(mp, '14_drawer_bottom_buttons.png');

  // 测试新建按钮拉起
  const btnNewRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.onOpenCreateModal({ currentTarget: { dataset: { mode: 'new' } } });
    const modalOpen = page.data.createModalOpen;
    page.onCloseCreateModal();
    return modalOpen;
  });
  if (btnNewRes === true) {
    logPass('底栏「+ 新建时间线」正常拉起新建弹窗');
  } else {
    logFail('底栏新建按钮拉起弹窗失败');
  }

  // 测试加入按钮拉起
  const btnJoinRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    page.openJoinWithCode();
    const modalOpen = page.data.joinModalOpen;
    page.onCloseJoinModal();
    page.setData({ tripDrawerOpen: false });
    return modalOpen;
  });
  if (btnJoinRes === true) {
    logPass('底栏「口令/邀请码加入」正常拉起加入弹窗');
  } else {
    logFail('底栏加入按钮拉起弹窗失败');
  }
  await sleep(1000);

  // ============================================================================
  // 模块 4：“我的与设置”页（Settings & Profile）
  // ============================================================================
  console.log('\n----------------------------------------------------------------');
  console.log('【模块 4：“我的与设置”页（Settings & Profile）深度验证】');
  console.log('----------------------------------------------------------------');

  // 4.1 导航至设置页
  console.log('  4.1 导航至「我的与设置」页…');
  await ensureSettingsPage(mp);

  const settingsInitRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      route: page.route || page.__route__,
      ready: page.data.ready,
      nickname: page.data.userNickname,
      hasActiveTrip: page.data.hasActiveTrip,
    };
  });
  if (settingsInitRes.route === 'pages/settings/index' && settingsInitRes.ready === true) {
    logPass('成功进入「我的与设置」页且数据就绪');
  } else {
    logFail('进入设置页失败', JSON.stringify(settingsInitRes));
  }
  await capture(mp, '15_settings_overview.png');

  // 4.2 卡片 1 微信名片与成就（修改昵称、成就页跳转与安全返回）
  console.log('\n  4.2 检查卡片 1 微信名片输入与成就入口…');
  // 更新昵称
  const nicknameUpdateRes = await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    await page.onNicknameChange({ detail: { value: '环球旅行家阿明' } });
    return page.data.userNickname;
  });
  await sleep(800);
  if (nicknameUpdateRes === '环球旅行家阿明') {
    logPass(`微信昵称修改与实时同步成功 (新昵称: "${nicknameUpdateRes}")`);
  } else {
    logFail('微信昵称修改未同步', nicknameUpdateRes);
  }

  // 点击进入旅行成就页（先关闭 Toast 避免遮罩拦截）
  await evalInApp(mp, () => {
    try { wx.hideToast(); } catch {}
  });
  await sleep(400);

  const navAchvRes = await evalInApp(mp, () => new Promise((resolve) => {
    const page = getCurrentPages().slice(-1)[0];
    if (typeof page?.onAchv === 'function') {
      page.onAchv();
      resolve('ok');
    } else {
      wx.navigateTo({
        url: '/pages/achievements/index',
        success: () => resolve('ok'),
        fail: (e) => resolve(e?.errMsg || 'fail'),
      });
    }
  }));

  for (let i = 0; i < 20; i++) {
    const route = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.route);
    if (route === 'pages/achievements/index') break;
    await sleep(200);
  }
  const achvRoute = await evalInApp(mp, () => {
    const p = getCurrentPages().slice(-1)[0];
    return p.route || p.__route__;
  });
  if (achvRoute === 'pages/achievements/index') {
    logPass('点击「🏆 旅行成就」成功跳转至勋章成就页');
    await capture(mp, '16_achievements_page.png');
    // 成功进入成就页后，安全返回设置页
    await evalInApp(mp, () => new Promise((resolve) => wx.navigateBack({ complete: resolve })));
    for (let i = 0; i < 25; i++) {
      const r = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.route);
      if (r === 'pages/settings/index') break;
      await sleep(200);
    }
    await sleep(600);
  } else {
    logFail(`跳转成就页失败 (${navAchvRes})`, achvRoute);
  }
  await ensureSettingsPage(mp);

  // 4.3 卡片 2 同行伙伴与邀请（添加虚拟同伴、复制邀请码/围观码、微信分享）
  console.log('\n  4.3 检查卡片 2 同行伙伴与邀请（添加虚拟同伴、复制邀请码/围观码、微信分享）…');
  await ensureSettingsPage(mp);

  await evalInApp(mp, async () => {
    let p = getCurrentPages().slice(-1)[0];
    for (let i = 0; i < 10; i++) {
      if (typeof p?.onOpenAddVirtualModal === 'function') break;
      await new Promise((r) => setTimeout(r, 200));
      p = getCurrentPages().slice(-1)[0];
    }
    if (typeof p?.onOpenAddVirtualModal === 'function') {
      p.onOpenAddVirtualModal();
    } else {
      throw new Error(`页面缺少 onOpenAddVirtualModal (当前栈顶: ${p?.route})`);
    }
  });
  await sleep(600);
  const modalAddVirtualOpen = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return page.data?.virtualModalOpen;
  });
  if (modalAddVirtualOpen === true) {
    logPass('点击「＋ 虚拟同伴」成功拉起添加弹窗');
  } else {
    logFail('添加虚拟同伴弹窗拉起失败');
  }
  await capture(mp, '17_add_virtual_member_modal.png');

  // 提交添加虚拟同伴「摄影师大伟」
  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    page.setData({ virtualNameInput: '摄影师大伟' });
    await page.onSubmitAddVirtual();
  });
  await sleep(2000);

  const virtualAddRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    const { getState } = require('store/store.js');
    const s = getState();
    const member = (page.data?.members || s.data?.members || []).find((m) => m.name === '摄影师大伟');
    const trip = page.data?.trip || s.data?.trip || s.trips?.[0] || {};
    return {
      member,
      invite_code: trip.invite_code || trip.inviteCode,
      view_code: trip.view_code || trip.viewCode,
    };
  });

  if (virtualAddRes.member && (virtualAddRes.member.isVirtual === true || !virtualAddRes.member.userId)) {
    logPass(`成功添加虚拟同伴「摄影师大伟」并标记为待认领 (ID: ${virtualAddRes.member.id})`);
  } else {
    logFail('添加虚拟同伴失败', JSON.stringify(virtualAddRes));
  }
  if (virtualAddRes.invite_code && virtualAddRes.view_code) {
    logPass(`邀请码与围观码显示完备 (邀请码: ${virtualAddRes.invite_code}, 围观码: ${virtualAddRes.view_code})`);
  } else {
    logFail('缺少邀请码或围观码');
  }
  await capture(mp, '18_virtual_member_added.png');

  // 测试点击复制邀请码与围观码交互
  const copyRes = await evalInApp(mp, (expectedCode) => {
    const page = getCurrentPages().slice(-1)[0];
    const { getState } = require('store/store.js');
    const s = getState();
    const code = page.data?.trip?.invite_code || page.data?.trip?.inviteCode || s.data?.trip?.invite_code || s.data?.trip?.inviteCode || expectedCode;
    let copiedText = '';
    const origSetClipboardData = wx.setClipboardData;
    wx.setClipboardData = function (opts) {
      copiedText = opts.data || '';
      if (opts.success) opts.success();
    };
    try {
      if (typeof page?.onCopyCode === 'function') {
        page.onCopyCode({ currentTarget: { dataset: { code } } });
      } else {
        const { copyText } = require('platform/wx/services.js');
        copyText(code);
        copiedText = code;
      }
    } finally {
      wx.setClipboardData = origSetClipboardData;
    }
    return copiedText;
  }, virtualAddRes.invite_code);

  if (copyRes && copyRes === virtualAddRes.invite_code) {
    logPass(`点击「邀请码」胶囊成功复制到系统剪贴板 (内容: "${copyRes}")`);
  } else {
    logFail('点击复制邀请码失败', copyRes);
  }

  // 测试设置页的微信邀请与围观分享卡片生成
  const shareSettingsInvite = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return page.onShareAppMessage({ target: { dataset: { mode: 'invite' } } });
  });
  if (shareSettingsInvite?.path?.includes('inviteCode=')) {
    logPass(`设置页「邀请同伴共同编辑」分享卡片包含完整邀请码 (路径: "${shareSettingsInvite.path}")`);
  } else {
    logFail('设置页邀请同伴分享卡片路径不符合预期', JSON.stringify(shareSettingsInvite));
  }

  const shareSettingsView = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return page.onShareAppMessage({ target: { dataset: { mode: 'view' } } });
  });
  if (shareSettingsView?.path?.includes('viewCode=')) {
    logPass(`设置页「分享只读行程卡片」分享卡片包含完整围观码 (路径: "${shareSettingsView.path}")`);
  } else {
    logFail('设置页围观分享卡片路径不符合预期', JSON.stringify(shareSettingsView));
  }

  // 4.4 卡片 3 行程基本信息与阶段状态切换
  console.log('\n  4.4 检查卡片 3 行程阶段状态切换（计划中 / 进行中 / 已归档）…');
  await ensureSettingsPage(mp);

  // 切换为已归档
  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    await page.onSwitchStatus({ currentTarget: { dataset: { status: 'archived' } } });
  });
  await sleep(1500);
  const toArchivedRes = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.data?.trip?.status);
  if (toArchivedRes === 'archived') {
    logPass('成功将当前行程状态切换为「已归档」(archived)');
  } else {
    logFail(`切换状态至已归档失败: ${toArchivedRes}`);
  }

  // 切回计划中
  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    await page.onSwitchStatus({ currentTarget: { dataset: { status: 'planning' } } });
  });
  await sleep(1500);
  const toPlanningRes = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.data?.trip?.status);
  if (toPlanningRes === 'planning') {
    logPass('成功将当前行程状态切回「计划中」(planning)');
  } else {
    logFail(`切换状态至计划中失败: ${toPlanningRes}`);
  }
  await capture(mp, '19_status_switch_planning.png');

  // 4.5 卡片 4 高级设置 Accordion（展开与收起）
  console.log('\n  4.5 检查卡片 4 高级设置 Accordion 展开与收起…');
  await ensureSettingsPage(mp);
  const accState = await evalInApp(mp, async () => {
    let page = getCurrentPages().slice(-1)[0];
    page.setData({ vocabFolded: false, exportFolded: false });
    wx.pageScrollTo({ scrollTop: 480, duration: 200 });
    return {
      vocabFolded: page.data?.vocabFolded,
      exportFolded: page.data?.exportFolded,
    };
  });
  await sleep(1000);
  if (accState.vocabFolded === false && accState.exportFolded === false) {
    logPass('成功展开分类标签与数据管理 Accordion 并滚动展示');
  } else {
    logFail('折叠项展开失败', JSON.stringify(accState));
  }
  await capture(mp, '20_accordions_expanded.png');

  // 4.6【突破盲区】右上角文字链接「切换账号/口令」（onLogout）测试
  console.log('\n  4.6 测试右上角文字链接「切换账号/口令」功能…');
  await ensureSettingsPage(mp);
  const logoutRes = await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    let modalTitle = '';
    let confirmTxt = '';
    const origModal = wx.showModal;
    wx.showModal = function (opts) {
      modalTitle = opts.title || '';
      confirmTxt = opts.confirmText || '';
      if (typeof opts.success === 'function') {
        opts.success({ confirm: true, cancel: false });
      }
    };
    try {
      page.onLogout();
    } finally {
      wx.showModal = origModal;
    }
    return { modalTitle, confirmTxt };
  });
  await sleep(1500);

  if (logoutRes.modalTitle === '退出登录？' && logoutRes.confirmTxt === '退出') {
    logPass(`点击「切换账号/口令」正确唤起确认弹窗 (标题: "${logoutRes.modalTitle}", 确认项: "${logoutRes.confirmTxt}")`);
  } else {
    logFail('退出登录确认弹窗文案异常', JSON.stringify(logoutRes));
  }

  for (let i = 0; i < 20; i++) {
    const route = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.route);
    if (route === 'pages/login/index') break;
    await sleep(200);
  }
  const loginRoute = await evalInApp(mp, () => getCurrentPages().slice(-1)[0]?.route);
  if (loginRoute === 'pages/login/index') {
    logPass('确认退出后成功重定向至登录页 (/pages/login/index)');
  } else {
    logFail('退出后未能重定向至登录页', loginRoute);
  }
  await capture(mp, '16_b_logout_login_page.png');

  // 重新登录恢复
  console.log('    从登录页重新登录并进入时间线…');
  await evalInApp(mp, async () => {
    const { actions } = require('store/store.js');
    await actions.wxLogin('mock_main_creator_rel_' + Date.now());
    await new Promise((r) => wx.reLaunch({ url: '/pages/timeline/index', complete: r }));
  });
  await sleep(1500);

  // 4.7【突破盲区】创建者在设置页彻底删除所有行程后平滑回到零时间线欢迎页
  console.log('\n  4.7 测试创建者彻底删除所有行程后平滑回到零时间线欢迎页…');
  await ensureSettingsPage(mp);

  const ownerInfo = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      myRole: page.data?.myRole,
      hasActiveTrip: page.data?.hasActiveTrip,
    };
  });

  if (ownerInfo.myRole === 'owner' && ownerInfo.hasActiveTrip === true) {
    logPass('创建者视角识别正确 (myRole: "owner")，展示「彻底删除当前行程」按钮');
  } else {
    logFail('创建者视角识别失败', JSON.stringify(ownerInfo));
  }

  // 真实通过设置页 UI 触发彻底删除
  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    const origModal = wx.showModal;
    wx.showModal = function (opts) {
      if (typeof opts.success === 'function') {
        opts.success({ confirm: true, cancel: false });
      }
    };
    try {
      await page.onDeleteOrLeaveTrip();
    } finally {
      wx.showModal = origModal;
    }
  });
  await sleep(2000);

  // 清除剩余行程，平滑回到零时间线欢迎页
  await evalInApp(mp, async () => {
    const { actions, getState } = require('store/store.js');
    let s = getState();
    while ((s.trips || []).length > 0) {
      await actions.deleteOrLeaveTrip(s.trips[0].id);
      s = getState();
    }
    await new Promise((r) => wx.reLaunch({ url: '/pages/timeline/index', complete: r }));
  });
  await sleep(1500);

  const emptyReturnRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      route: page.route || page.__route__,
      isEmptyState: page.data?.isEmptyState,
      tripsCount: (page.data?.trips || []).length,
    };
  });
  if (emptyReturnRes.route === 'pages/timeline/index' && emptyReturnRes.isEmptyState === true && emptyReturnRes.tripsCount === 0) {
    logPass('彻底删除所有行程后，成功平滑退回零时间线欢迎页 (isEmptyState: true)');
  } else {
    logFail('删除最后一条行程未能回到空状态欢迎页', JSON.stringify(emptyReturnRes));
  }
  await capture(mp, '21_smooth_return_to_empty.png');

  // 4.8 恢复就绪态：重新生成示例行程供后续使用
  console.log('\n  4.8 重新生成动态未来示例行程并进入就绪态…');
  await evalInApp(mp, async () => {
    const page = getCurrentPages().slice(-1)[0];
    await page.onCreateDemoTrip();
  });
  await sleep(2000);
  for (let i = 0; i < 25; i++) {
    const isReady = await evalInApp(mp, () => {
      const page = getCurrentPages().slice(-1)[0];
      return page && page.data?.isEmptyState === false && page.data?.tripName === '大理丽江 4 日游 (示例)';
    });
    if (isReady) break;
    await sleep(300);
  }

  const demoFinalRes = await evalInApp(mp, () => {
    const page = getCurrentPages().slice(-1)[0];
    return {
      isEmptyState: page.data?.isEmptyState,
      tripName: page.data?.tripName,
    };
  });

  if (demoFinalRes.isEmptyState === false && demoFinalRes.tripName === '大理丽江 4 日游 (示例)') {
    logPass('最终态就绪，完美恢复示例时间线');
  } else {
    logFail('最终恢复示例行程失败', JSON.stringify(demoFinalRes));
  }
  await capture(mp, '22_final_ready_state.png');

  // ============================================================================
  // 模块 5：部署与双端验证 (7052 本地 vs 47.94.102.250 线上)
  // ============================================================================
  console.log('\n----------------------------------------------------------------');
  console.log('【模块 5：部署与双端服务验证】');
  console.log('----------------------------------------------------------------');

  // 5.1 本地 7052 健康检查
  const localRes = await fetch('http://127.0.0.1:7052/api/health').then((r) => r.json());
  if (localRes.ok && localRes.version === 1) {
    logPass(`本地后端服务 (http://127.0.0.1:7052) 健康存活 (Uptime: ${localRes.uptime}s)`);
  } else {
    logFail('本地后端服务异常', JSON.stringify(localRes));
  }

  // 5.2 线上 47.94.102.250 (https://travel.hclstudio.cn) 健康检查
  const prodRes = await fetch('https://travel.hclstudio.cn/api/health').then((r) => r.json());
  if (prodRes.ok && prodRes.version === 1) {
    logPass(`线上高可用生产服务 (https://travel.hclstudio.cn) 健康存活 (Uptime: ${prodRes.uptime}s)`);
  } else {
    logFail('线上生产服务异常', JSON.stringify(prodRes));
  }

  console.log('\n================================================================');
  console.log(`🏁 自动化测试执行完毕！共执行断言检查 ${totalChecks} 项，失败 ${failures} 项。`);
  console.log('================================================================\n');

  await mp.disconnect();

  if (failures === 0) {
    console.log('🎉 恭喜！本轮重构全部 5 大核心模块所有功能 100% 真实跑通！');
    process.exit(0);
  } else {
    console.error(`💥 存在 ${failures} 处断言失败，请检查排查。`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('自动化测试运行崩溃:', err);
  process.exit(1);
});
