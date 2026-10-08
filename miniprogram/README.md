# 旅行助手 · 微信小程序

同一个后端、同一份 `core/` 与 `store/`（来自 `web/src`，靠隔离层复用）；
这里只写小程序自己的 `platform/wx` 实现与页面。

## 跑起来

1. **同步共享代码**（改了 `web/src/core` 或 `web/src/store` 之后都要跑）：

   ```powershell
   cd D:\Project\travel\miniprogram
   node scripts\sync-shared.mjs
   ```

   会顺带做一遍全量语法检查（用 web 的 esbuild），有错不会放过。

2. **不开开发者工具也先验一遍**（只读，用的是真实服务器）：

   ```powershell
   $env:PASS = "你的口令"
   node scripts\check-platform.mjs
   ```

   它用内存 mock 掉 `wx`，把 `platform/wx` + 共享 store 的登录、快照、队列链路跑通。

3. **打开开发者工具**：导入项目 → 选择 `D:\Project\travel\miniprogram`。
   AppID 已填在 `project.config.json`（`wx991808af7e9a8e9c`）。也可以用命令直接打开
   （IDE 已在运行时不用重复启动）：

   ```powershell
   & 'D:\微信web开发者工具\cli.bat' open --project 'D:\Project\travel\miniprogram'
   ```

4. **自动化检查**（开发者工具装在这台机器上才可用；`--local` 会起本机临时后端，
   绝不动生产数据）：

   ```powershell
   $env:PASS = "你的口令"
   node scripts\check-devtools.mjs            # 只读：登录 → 行程页 → 无控制台报错
   node scripts\check-devtools.mjs --local    # 全链路：临时库上跑照片上传/删除往返
   ```

   可选：把任意一张 `.heic` 样本放进 `scripts/fixtures/`（不入库），`--local` 会多跑
   一段「HEIC 上传 → 类型按魔数归一 → 服务端转 JPEG → 缩略图渲染」的全链路验证；
   没有样本时自动跳过。

5. 编译后进入登录页：输入口令和名字 → 行程页（「现在」卡 + 按天时间线）。

   开发时可以让小程序指向本机后端（改完不用重启）：

   ```js
   wx.setStorageSync('travel.base', 'http://127.0.0.1:7020')  // 清掉则回生产
   ```

## 这一版有什么

- 登录（真实调 `/api/auth/login`）
- 行程一屏：本地快照秒开 → 拉最新；「现在」卡；按天分组；下拉刷新；
  勾选待办；每 20 秒轮询近似实时
- 照片：时间线缩略图（缩略图落盘、离线可看）、点开系统预览、长按
  「保存原图 / 删除」、卡片上直接加照片（`wx.chooseMedia` → 服务端变体链路）
- 记一笔：金额 / 类别 / 谁付的 / 备注，挂在对应行程卡下（编辑删除下一轮）
- 深色模式：跟随系统（`app.json` darkmode + `theme.json`，WXSS 变量与 Web 同一套值）
- 类型图标：与 Web 共用 `core/glyphs.js`，运行时生成 SVG data URI

## 还没做

- 长图 / 海报（要用小程序 canvas 2d 重写渲染）
- 记一笔的编辑与删除；照片随手拍的「挂到某项」
- 拖拽排序 / 增删改行程编辑器
- 导航（要坐标或地图插件）、分享、日历订阅 / 模板导出

## 真机预览

在「开发管理 → 开发设置 → 服务器域名」里把 `https://travel.hclstudio.cn` 加进
**request、uploadFile、downloadFile 三类合法域名**（域名需 ICP 备案）。
在此之前，开发者工具里开发/调试不受影响。

## 规则

- `core/`、`store/` 是同步生成物，**不要手改**；改 `web/src` 再跑同步脚本
- `platform/wx/` 是手写的，接口形状对照 `web/src/platform/web/`
- 页面（`pages/`）每端各写一套，逻辑尽量沉到 `core/` 和 `store/`
