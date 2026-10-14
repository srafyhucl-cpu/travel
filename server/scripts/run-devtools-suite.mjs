import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import automator from 'miniprogram-automator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = 'C:\\Users\\srafy\\.gemini\\antigravity\\brain\\5b5be4d9-ed90-4dcf-bf02-e662c0fc1d49\\screenshots';
const LOCAL_SHOT_DIR = path.resolve(__dirname, '../../miniprogram/screenshots');

async function capture(mp, filename) {
  const { data } = await mp.send('App.captureScreenshot');
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(path.join(ARTIFACT_DIR, filename), buf);
  fs.writeFileSync(path.join(LOCAL_SHOT_DIR, filename), buf);
  console.log(`✓ [截图成功] ${filename} (${Math.round(buf.length / 1024)} KB)`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  console.log('== 连接微信开发者工具 (ws://127.0.0.1:9420) ==');
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420', timeout: 30000 });

  // 确保 travel.base 为 7052
  await mp.evaluate(() => {
    wx.setStorageSync('travel.base', 'http://127.0.0.1:7052');
  });

  // 1. 首页时间线
  console.log('\n[1/6] 检查首页时间线视图...');
  await mp.evaluate(() => {
    return new Promise((r) => wx.reLaunch({ url: '/pages/timeline/index', success: r }));
  });
  await sleep(1800);
  await capture(mp, '01_active_timeline.png');

  // 2. 打开抽屉
  console.log('\n[2/6] 打开多时间线抽屉...');
  await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    p.setData({ tripDrawerOpen: true });
  });
  await sleep(800);
  await capture(mp, '02_timeline_drawer.png');
  // 关闭抽屉
  await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    p.setData({ tripDrawerOpen: false });
  });
  await sleep(400);

  // 3. 导航至设置页
  console.log('\n[3/6] 导航至「我的与设置」页...');
  await mp.evaluate(() => {
    return new Promise((r) => wx.navigateTo({ url: '/pages/settings/index', success: r }));
  });
  await sleep(1500);
  await capture(mp, '03_settings_card.png');

  // 4. 展开高级折叠项并滚动查看
  console.log('\n[4/6] 展开高级设置折叠项并滚动...');
  await mp.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    p.setData({ vocabFolded: false, exportFolded: false });
    wx.pageScrollTo({ scrollTop: 480, duration: 200 });
  });
  await sleep(1000);
  await capture(mp, '04_settings_accordion_expanded.png');

  // 5. 删除当前行程进入零时间线空状态
  console.log('\n[5/6] 删除行程，验证零时间线欢迎空状态...');
  await mp.evaluate(async () => {
    const { actions, getState } = await import('./store/store.js');
    const tid = getState().activeTripId;
    if (tid) {
      await actions.deleteOrLeaveTrip(tid);
    }
    return new Promise((r) => wx.reLaunch({ url: '/pages/timeline/index', success: r }));
  });
  await sleep(2200);
  await capture(mp, '05_empty_welcome.png');

  // 6. 空状态下点击「一键生成示例」体验行程
  console.log('\n[6/6] 点击「一键生成示例」，验证动态未来日期示例行程...');
  await mp.evaluate(async () => {
    const p = getCurrentPages().slice(-1)[0];
    await p.onCreateDemoTrip();
  });
  await sleep(3500);
  await capture(mp, '06_future_demo_timeline.png');

  console.log('\n===========================================');
  console.log('🎉 6 张全阶段高清效果图已全部采集完毕！');
  console.log('===========================================');
  await mp.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('自动化测试执行失败:', err);
  process.exit(1);
});
