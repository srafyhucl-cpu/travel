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
  console.log(`✓ 截图成功: ${filename} (${Math.round(buf.length / 1024)} KB)`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  console.log('== 连接开发者工具 (ws://127.0.0.1:9420) ==');
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420', timeout: 30000 });

  // 1. 跳转到设置页
  console.log('1. 导航到设置页...');
  await mp.evaluate(() => {
    return new Promise((resolve) => {
      wx.navigateTo({ url: '/pages/settings/index', success: resolve, fail: resolve });
    });
  });
  await sleep(1500);

  // 2. 展开设置页折叠项并滚动
  console.log('2. 展开设置页 Accordion 折叠项并滚动截图...');
  await mp.evaluate(() => {
    try {
      const pages = getCurrentPages();
      const p = pages[pages.length - 1];
      p.setData({ vocabFolded: false, exportFolded: false });
      wx.pageScrollTo({ scrollTop: 500, duration: 100 });
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  });
  await sleep(1000);
  await capture(mp, '04_settings_accordion_expanded.png');

  // 3. 删除当前行程
  console.log('3. 删除行程，触发返回首页...');
  await mp.evaluate(async () => {
    try {
      const { actions, getState } = await import('./store/store.js');
      const tid = getState().activeTripId;
      if (tid) {
        await actions.deleteOrLeaveTrip(tid);
      }
      return new Promise((resolve) => {
        wx.reLaunch({ url: '/pages/timeline/index', success: resolve, fail: resolve });
      });
    } catch (e) {
      return { error: e.message };
    }
  });
  await sleep(2500);

  // 4. 截图空状态
  console.log('4. 捕获零时间线空状态截图...');
  await capture(mp, '05_empty_welcome.png');

  // 5. 点击一键生成示例行程
  console.log('5. 点击一键生成示例行程...');
  await mp.evaluate(async () => {
    try {
      const pages = getCurrentPages();
      const p = pages[pages.length - 1];
      await p.onCreateDemoTrip();
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  });
  await sleep(4000);

  // 6. 截图动态未来日期示例行程
  console.log('6. 捕获动态未来示例行程截图...');
  await capture(mp, '06_future_demo_timeline.png');

  console.log('\n全部目标截图已完成！');
  await mp.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
