# 交接文档 · 旅行助手小程序

> 给下一位（Codex）接手人：这份文档讲清楚「这是什么、现在到哪了、怎么跑、别踩什么坑、接下来打磨什么」。
> 更细的设计理由见 `docs/specs/`，部署运维见 `DEPLOY.md`，小程序用法见 `miniprogram/README.md`。

---

## 1. 一句话定位

一趟真实旅行（云南线）的多人协作助手：行程时间线 + 待办打卡 + 记账 + 照片 + 成就 + 长图分享。
**后端一套，Web 与微信小程序两个前端共用逻辑。** 现在主战场是**微信小程序**，Web 已冻结只作参考。

---

## 2. 当前状态快照（截至 2026-10-09）

| 项 | 值 |
| --- | --- |
| 工作目录 | `D:\Project\travel` |
| 分支 | `main`（纯本地仓库，最新提交看 `git log`） |
| 远端 | **未配置 remote**（纯本地仓库，推服务器靠 `scp/tar`，见 `DEPLOY.md`） |
| 工作区 | 有**已 staged、未提交**的改动：小程序 Logo（见下），可直接 commit |
| 线上后端 | `https://travel.hclstudio.cn`（nginx 443 → 本机 7020，systemd `travel`） |

**待提交的 staged 内容**（就是最近一次工作，接手先决定是否 commit）：

- `tools/logo/logo.svg` + `tools/logo/render.mjs`（resvg 渲染脚本）
- `tools/logo/dist/logo-144.png`（小程序头像主交付物）/ 288 / 576
- `docs/superpowers/specs/2026-10-08-miniprogram-logo-design.md`（定稿说明）
- `.gitignore` 加了一行，忽略裁圆校验图

---

## 3. 目录结构与分层（最重要的一节）

```
travel/
  server/          Node + Express + SQLite 后端（改 schema 见 server/src/db.js 的 SCHEMA/ensureColumn）
  web/             React + Vite 前端。★已冻结★ 只当参考实现与共享源，不再加新功能
    src/core/      纯逻辑，零平台依赖：format/timeline/checklist/budget/achievements/glyphs/vlog-model
    src/store/     api.js（工厂）+ store.js，只依赖 platform 接口
    src/platform/web/  Web 平台实现
    src/ui/        React 页面
  miniprogram/     微信原生小程序（当前主战场）
    core/ store/   ← 自动同步生成物，勿手改
    platform/wx/   手写的平台实现（session/persist/net/files/device/services/canvas/icons）
    pages/         每端各写一套 UI：login/timeline/expense/node/nodepick/budget/achievements/settings/poster
    scripts/       sync-shared.mjs / check-platform.mjs / check-devtools.mjs
  docs/specs/      设计文档（前端打磨、小程序骨架、照片派生图、成就系统）
  docs/superpowers/specs/  Logo 设计稿
  tools/logo/      Logo 矢量源 + 渲染脚本 + 成品
```

**铁律（改之前先记牢）：**

1. **`miniprogram/core/`、`miniprogram/store/` 是生成物，永远不要手改。**
   共享逻辑的**唯一源是 `web/src/core` 和 `web/src/store`**；改完在 `miniprogram/` 下跑
   `node scripts/sync-shared.mjs` 重新生成 + 全量语法检查。
2. **`core/` 不许碰 DOM / 平台 API；`store/` 不许直接调浏览器或 wx。** 平台能力一律走 `platform/` 接口。
   两端 `platform` 接口形状对照：`web/src/platform/web/` ↔ `miniprogram/platform/wx/`。
3. **Web 已冻结（2026-10-08）**：不得再往 Web 加新功能，新功能只进小程序；但共享逻辑仍在 `web/src` 改。

---

## 4. 怎么跑起来（命令速查）

### 小程序

```powershell
cd D:\Project\travel\miniprogram

# 1) 改了 web/src/core 或 web/src/store 之后必须跑：复制 + 语法检查
node scripts\sync-shared.mjs

# 2) 不开开发者工具先验一遍（内存 mock wx，只读打真实服务器）
$env:PASS = "你的口令"
node scripts\check-platform.mjs

# 3) 打开开发者工具（IDE 已在运行时不用重复启动）
& 'D:\微信web开发者工具\cli.bat' open --project 'D:\Project\travel\miniprogram'

# 4) 自动化检查
$env:PASS = "你的口令"
node scripts\check-devtools.mjs           # 只读：登录 → 行程页 → 无控制台报错（打生产）
node scripts\check-devtools.mjs --local   # 全链路：临时库上跑全功能闭环（不碰生产）

# 5) 提审 / 发布：没有面向普通账号的 API（仅第三方平台，实测 86000）——
#    上传后在 mp.weixin.qq.com「版本管理」手动提交审核、手动发布，备注写登录方式；见 miniprogram/README.md
```

- AppID 已填：`wx991808af7e9a8e9c`（`project.config.json`）。
- 开发时指向本机后端：`wx.setStorageSync('travel.base', 'http://127.0.0.1:7020')`，清掉回生产。
- `--local` 覆盖：打卡、行程增改删/上移、照片上传删除、HEIC 全链路、记账增改删、总预算、
  设置（旅行信息/口令）、成就、海报（长图 + 照片海报）；跑完还原会话与 base。
- HEIC 全链路需要样本：把 `.heic` 放进 `scripts/fixtures/`（不入库）或设 `HEIC_SAMPLE=<路径>`，没有则自动跳过。

### Web（改共享逻辑后自测）

```powershell
cd D:\Project\travel\web
npm run build          # 大多数测试要对着构建产物跑
npm run check:imports  # 最快，先跑
npm run check:core     # 纯逻辑，node 直跑 core/
npm run smoke          # 每界面走一遍收控制台报错
# 其它专项：check:editor / check:fields / check:drag / check:shortcuts / check:order / check:prep / check:vlog / check:money / check:theme
```

退出码：`0` 全通 / `1` 有失败 / `2` 脚本自己炸。除 `check:order`、`check:core` 外都会**复制一份
`server/data` 到临时目录另起后端、测完连数据一起删**，真库不动。

### 部署

见 `DEPLOY.md`。要点：服务器只有 1.6G，**不要在服务器 build**，本地 build 后 tar 推送再重启。
（小程序本身在微信后台发版，不走服务器部署。）

---

## 5. 这一版小程序已有什么

- 登录（真实 `/api/auth/login`，口令 + 名字）
- 行程一屏：本地快照秒开 → 拉最新；**总结卡**（状态日期/进度条/完成·已花·照片三格统计，
  点已花看明细与改预算）；自定义导航栏；按天分组；下拉刷新；勾选待办；20s 轮询近似实时；右下角「＋」
- 出行准备卡：`role=module` 的「前置准备」不在按天列表里（它没时间，塞进去只有「—」），
  改坐总结卡下面一张自己的卡：进度 + 展开勾选 + 编辑清单，勾完自动收起；无时间的普通项写「待定」
- 打卡（出发 / 完成，与 Web 同一套动作）
- 行程编辑：标题/类型/日期时间/地点与导航词/车程/待办；新建、删除、新建后自动滚到该卡
- 拖动排序 v2：长按抬起变迷你卡跟手、原位虚线占位、双指滚动、松手先弹**落点确认**
  （只重排下手那一天，其它天不动），确认才写入；没填起止时间的项不能拖
- 照片：时间线缩略图（落盘离线可看）、点开原生预览、长按保存原图/挂到某项/删除、卡片直接加照片
- 记账：增改删，可改金额/类别/谁付的/备注/时间/挂在；时间线逐行可点开改；「随手记」收无主账目与散照片
- 「挂在哪一项」选择页（可搜、按天分组、顶部不指定，记账与照片归位共用）
- 我的（设置）：旅行信息、成员改名配色、自定义类型/类别、导出（模板/备份转发到聊天）、导入模板、改口令、退出
- 成就页（与 Web 共用 `core/achievements`）
- vlog 图：行程长图 + 照片海报（四模板），canvas 2d 渲染，保存相册/分享
- 导航：接腾讯位置服务（地理编码 → 打开地图），无 key/失败回退复制地名
- 深色模式（跟随系统，`app.json` darkmode + `theme.json`，与 Web 同一套 token 值）
- 类型图标与 Web 共用 `core/glyphs.js`，运行时生成 SVG data URI

---

## 6. 还没做 / 待打磨（接手切入点）

**明确遗留：**

- **分享到聊天 / 相册、导入模板的系统面板**：自动化测不到，需要在真机上手动点一遍验收。
- **Logo 已生成但还没上传到微信后台**（`tools/logo/dist/logo-144.png`）。上传后注意微信会裁圆。
- **腾讯位置服务 key 为空**（`miniprogram/config.js` 的 `TENCENT_MAP_KEY`）。要真正启用导航，需：
  1. 控制台申请 key、开 WebServiceAPI、绑定 AppID；
  2. 微信后台把 `https://apis.map.qq.com` 加进 request 合法域名；
  3. 填 key 到 config.js。
  三步缺一都会静默回退成「复制地名」。

**可继续打磨的方向（建议排期，非硬性）：**

- 真机体验打磨：真机预览边距、安全区、键盘顶起、下拉刷新手感、长按触发时长。
- 性能：大行程首屏、`wx storage` 单 key 1MB 上限（过大只丢缓存、不丢功能）、照片派生图预热。
- 交互一致性：核对小程序与 Web 在「时间线卡片 / 记账 / 成就」上的文案与操作是否对齐。
- 自动化补强：`check-devtools.mjs --local` 还没覆盖的真机路径（分享面板、导入系统面板）。

---

## 7. 容易踩的坑（血泪清单）

- **生产登录只能用「龙哥」**：用「我」测试会凭空建一个空壳成员（`check-devtools.mjs` 默认模式已固化此约束）。
- **真机域名白名单**：微信后台「开发管理 → 开发设置 → 服务器域名」必须把 `https://travel.hclstudio.cn`
  加进 **request / uploadFile / downloadFile 三类**；导航还要加 `https://apis.map.qq.com` 到 request。
- **提审 / 发布没有面向普通小程序的 API**：`wxa/submit_audit` / `wxa/get_latest_auditstatus` / `wxa/release`
  仅「第三方平台」（服务商）可调，普通账号用 AppSecret 调一律报 `86000 should be called only from third party`
  （2026-10-10 实测；`miniprogram-ci`、开发者工具 CLI 只能上传）。流程：开发者工具上传 → mp 后台手动提交审核
  （备注写登录方式：沙盒口令 `1234` + 成员名随便填，否则审核员停在登录页会被打回）→ 通过后手动发布。
- **token 会出现在 URL 里**：SSE、`.ics` 订阅、模板下载带不了请求头只能走 `?token=`，会进 nginx access log。
- **HEIC 原样进原样出**：iPhone 的 HEIC 后端不会自动转原图（派生图会转 JPEG）；在意就让上传方选「兼容性最佳」拍 JPEG。
- **照片派生图**：`data/photos/derived/` 是缩略图(320)与展示图(2048)，原图不动，删照片连派生一起删；
  改派生参数要清 `derived/` 重新生成并跑 `node src/tools/warm-derivatives.js`（串行，12MP 峰值内存约 400MB）。
- **服务端两个易错点**：SSE 必须 `proxy_buffering off` + `X-Accel-Buffering: no`；`streamAuth` 必须注册在
  `router.use(requireAuth)` **前面**。
- **拖拽只重排目标那一天**：`server` 有 `move-preview` 试算接口，改拖拽逻辑时别破坏「其它天不动」。
- **token 里的 `mid`**：打卡/照片的个人归属靠它；改 `auth.js` 的 `signToken` 时必须继续带 `mid`，
  否则成就归属退化成按名字反查。
- **深色主题挂载点是 `<html data-theme>`**（Web）；小程序靠 `app.json` darkmode + `theme.json` + WXSS 变量，
  值要和 Web 的 `styles/tokens.css` 保持一致。
- **浏览器已装在 `D:\Tools\playwright-browsers`**（用户级 `PLAYWRIGHT_BROWSERS_PATH`），别再往临时目录下一份（曾重复下 705MB）。
- **口令/password 不入库**：测试脚本口令走 `PASS` 环境变量；`data/.pepper`、`data/.session-secret` 丢了就登不了录，备份 `data/` 必须带上。

---

## 8. 给下一位的开场建议

1. 先读：`HANDOVER.md`（本文）→ `miniprogram/README.md` → `DEPLOY.md` → `docs/specs/2026-10-07-miniprogram-spike-design.md`。
2. 决定 staged 的 Logo 改动是否先 commit（`git status` 可见）。
3. 跑一遍基线：`cd miniprogram && node scripts\sync-shared.mjs && $env:PASS="..."; node scripts\check-devtools.mjs --local`，确认全绿再动手。
4. 动手时守三铁律：**不改生成物、共享逻辑只改 `web/src`、Web 不加新功能**。
5. 每改一处，同步脚本 + 对应检查脚本 + `--local` 全链路，通过再提交；提交信息沿用仓库现有的
   `feat/fix/test/docs/chore(scope): 中文描述` 风格。
