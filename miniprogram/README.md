# 旅行助手 · 微信小程序（骨架）

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
   - **没有 AppID**：去 [测试号页面](https://developers.weixin.qq.com/miniprogram/dev/devtools/sandbox.html)
     用微信扫码拿一个（免费，两分钟），把 appid 填进 `project.config.json`，
     或在导入对话框里直接粘贴
   - 有正式注册的小程序：直接填自己的 AppID
   - `project.config.json` 里已关「校验合法域名」（开发期用）

   填好 AppID 之后也可以用命令直接打开（IDE 已在运行时不用重复启动）：

   ```powershell
   & 'D:\微信web开发者工具\cli.bat' open --project 'D:\Project\travel\miniprogram'
   ```

4. 编译后进入登录页：输入口令和名字 → 行程页（「现在」卡 + 按天时间线）。

## 这一版有什么

- 登录（真实调 `/api/auth/login`）
- 行程一屏：本地快照秒开 → 拉最新；「现在」卡；按天分组；下拉刷新；
  勾选待办（真实写接口）；每 20 秒轮询近似实时
- 深色模式：跟随系统（`app.json` darkmode + `theme.json`，WXSS 变量与 Web 同一套值）
- 类型图标：与 Web 共用 `core/glyphs.js`，运行时生成 SVG data URI
- 平台实现：session / persist / net / device 已可用

## 还没做（占位）

- 照片、长图、记账、拖拽编辑
- 上传（`platform/wx/net.js` 的 `upload` 占位）、照片文件（`files.js` 占位）
- 导航（要接地图插件或坐标）、分享

## 真机预览

需要一个小程序 AppID，并在「开发管理 → 开发设置 → 服务器域名」里把
`https://travel.hclstudio.cn` 加进 **request 合法域名**（域名需 ICP 备案）。
在此之前，开发者工具里开发/调试不受影响。

## 规则

- `core/`、`store/` 是同步生成物，**不要手改**；改 `web/src` 再跑同步脚本
- `platform/wx/` 是手写的，接口形状对照 `web/src/platform/web/`
- 页面（`pages/`）每端各写一套，逻辑尽量沉到 `core/` 和 `store/`
