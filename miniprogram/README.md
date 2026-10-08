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
   node scripts\check-devtools.mjs --local    # 全链路：临时库上跑全功能闭环
   ```

   `--local` 覆盖：打卡、行程编辑（改/新建/删除/上移）、照片上传删除、HEIC 全链路、
   记账增改删、总预算、设置页（旅行信息/口令）、成就页、vlog 图（长图 + 照片海报）。
   跑完会把小程序里的会话和 `travel.base` 原样还原。

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
- 行程一屏：本地快照秒开 → 拉最新；「现在」卡 + 「前置 / 已花」两格
  （点开看清单与消费明细、改预算）；按天分组；下拉刷新；勾选待办；
  每 20 秒轮询近似实时；右下角「＋」快捷传照片 / 加一项
- 打卡：出发 / 完成（与 Web 同一套动作）
- 行程编辑：标题 / 类型 / 日期时间 / 地点与导航词 / 车程 / 待办 / 首页模块；
  新建、删除、上移下移（跨天改日期）
- 照片：时间线缩略图（缩略图落盘、离线可看）、点开系统预览、长按
  「保存原图 / 删除」、卡片上直接加照片（`wx.chooseMedia` → 服务端变体链路）
- 记账：新增 / 编辑 / 删除；时间线卡片里逐行可点开改，卡片头显示合计；
  「随手记」收无主账目与散照片
- 我的（设置）：旅行信息、成员改名与配色、自定义类型/类别、导出（行程模板与
  完整备份转发到聊天、复制订阅链接/网址）、导入模板（从聊天里选 JSON）、
  修改旅行口令、退出登录
- 成就页：全队 / 个人徽章与进度（与 Web 共用 `core/achievements`）
- vlog 图：行程长图 + 照片海报（四种模板），canvas 2d 版渲染器，保存相册 / 分享
- 深色模式：跟随系统（`app.json` darkmode + `theme.json`，WXSS 变量与 Web 同一套值）
- 类型图标：与 Web 共用 `core/glyphs.js`，运行时生成 SVG data URI

## 还没做

- 拖拽排序（现在用编辑页的「上移 / 下移」代替）
- 导航：只复制地名（小程序没有按关键词搜地图的接口，接地图插件再说）
- 分享到聊天 / 相册、导入模板的系统面板，自动化测不到，需要在真机上点一遍
- 照片「随手拍」的挂到某项（现在可以传无主照片，但归位要改数据）

## 真机预览

在「开发管理 → 开发设置 → 服务器域名」里把 `https://travel.hclstudio.cn` 加进
**request、uploadFile、downloadFile 三类合法域名**（域名需 ICP 备案）。
在此之前，开发者工具里开发/调试不受影响。

## 规则

- `core/`、`store/` 是同步生成物，**不要手改**；改 `web/src` 再跑同步脚本
- `platform/wx/` 是手写的，接口形状对照 `web/src/platform/web/`
- 页面（`pages/`）每端各写一套，逻辑尽量沉到 `core/` 和 `store/`
- **Web 已冻结**（2026-10-08）：不再加新功能，只当小程序的参考实现与共享源。
  `core/`、`store/` 的**唯一源仍是 `web/src`**——改共享逻辑去那边改、跑同步脚本；
  Web 的页面/组件不再更新，新功能只进小程序。
