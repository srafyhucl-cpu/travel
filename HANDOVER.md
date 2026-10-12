# 交接文档 · 旅行助手小程序

> 给下一位（Codex）接手人：这份文档讲清楚「这是什么、现在到哪了、怎么跑、别踩什么坑、接下来打磨什么」。
> 更细的设计理由见 `docs/specs/`，部署运维见 `DEPLOY.md`，小程序用法见 `miniprogram/README.md`。

---

## 1. 一句话定位

一趟真实旅行（云南线）的多人协作助手：行程时间线 + 待办打卡 + 记账 + 照片 + 成就 + 长图分享。
**后端一套，Web 与微信小程序两个前端共用逻辑。** 现在主战场是**微信小程序**，Web 已冻结只作参考。

---

## 2. 当前状态快照（截至 2026-10-12）

| 项 | 值 |
| --- | --- |
| 工作目录 | `D:\Project\travel` |
| 分支 | **`feature/wechat-ai-agent`**（微信AI 开发模式；`main`=b1306e9 未动，本分支领先 13 个提交；同时落后 `main` 3 个提交——`45b828c` rev 轮询 / `8ceadde` checkup.mjs / `b1306e9` nginx 日志遮蔽，**发布或合并前要先并回来**；现算用 `git rev-list --count main..HEAD` 与 `git log --oneline HEAD..main`） |
| 远端 | **未配置 remote**（纯本地仓库，推服务器靠 `scp/tar`，见 `DEPLOY.md`） |
| 工作区 | 干净（Logo 已提交 `b0409e2`） |
| 线上后端 | `https://travel.hclstudio.cn`（nginx 443 → 本机 7020，systemd `travel`） |
| 微信AI | `agent/` 独立分包已实现并大量实测；**唯一挂起**：真实账号扫码后的对话级验收（见 §5.5） |

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
    agent/         微信AI 开发模式的独立分包（4 SKILL / 14 原子接口；详见 §5.5）
    scripts/       sync-shared.mjs / check-platform.mjs / check-devtools.mjs / check-agent.mjs
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

### 本地私密配置：腾讯位置服务 key 不进 git

`miniprogram/config.js` 里的 `TENCENT_MAP_KEY` 是**本机私密配置**，用 `git update-index --skip-worktree miniprogram/config.js` 钉住：
本地文件里是真 key，仓库里那一行永远是空串（`git show HEAD:miniprogram/config.js` 可验证）。

- key 来源：团队密钥 `TENCENT_MAP_KEY`（DSH 里读 `$env:DSH_SECRET_TENCENT_MAP_KEY`），填 `config.js:14`。
- 换机器 / 重新 clone 后：`git update-index --no-skip-worktree miniprogram/config.js` → 从密钥把 key 填回第 14 行 → 再 `git update-index --skip-worktree miniprogram/config.js`。
- 换 key：同上流程（key 在腾讯位置服务控制台可轮换）。
- 注意：`skip-worktree` 只挡本机提交；`git pull` / `checkout` 碰到这个文件会提示冲突，按上面流程重填即可。
- 这个 key 会随小程序包一起发布，按「可轮换的客户端 key」管：**不写进 commit、不贴群、不打印**。

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

## 5.5 微信AI 开发模式（`agent/` 独立分包，beta）

把旅行助手接进微信AI（小微）：4 个 SKILL / 14 个原子接口——行程查询、行程编辑、打卡、
记账（读+写都覆盖；删除类接口带防误删硬闸门）。全部在分支 `feature/wechat-ai-agent`。
**beta 红线：不要合入正式提审版本**（官方内测期不允许提审该模式代码）。

- 结构：`miniprogram/agent/`（`AGENTS.md` 全局提示词 / `page-meta.json` / `skills/*/`）；
  独立分包不能 require 主包，`agent/lib/core/` 是 `sync-shared.mjs` 从 `web/src/core` 转
  CommonJS 的生成物（勿手改，改共享逻辑照旧去 `web/src`）。
- 自动化检查（不开开发者工具，已全绿）：`PASS=... node scripts\check-agent.mjs`（只读）/
  `check-agent.mjs --local`（临时库全链路写测试）；`check-devtools.mjs --local --fresh-seed`
  可对副本库预填测试行程后跑全 UI 回归。
- 开发者工具：agent 能力要用 **Nightly**（本机：`D:\微信开发者工具-Nightly`；与稳定版
  **互斥**，同时只能开一个）。`cli agent tool` 单接口直调两版通用；`cli agent chat` 对话级
  回环只有 Nightly 跑得通（实测稳定版 2.02.2608 会卡在工具派发）。
- 登录：agent 需要**真实微信账号**（游客态没有 access_token，权限校验过不去）。
  远程拿码：`cli login --qr-output x.png`；微信只允许**摄像头实拍扫**（长按/相册/链接全被拒）。
- ⚠️ Agent 运行时读的登录态就是 IDE 里小程序的 `travel.token`——**写测试前先切到测试行程**
  （1234 沙盒口令）；注入做法：IDE 关闭时把 token 写进 `WeappStorage\storage_*.json` 的
  `travel.token/tripId/memberName`。
- 评测：`agent/eval/cases.json` 已备 52 条（自测起步可先跑子集）；Nightly 评测插件自测，
  提审评测等官方开放开发模式提审后再说。
- 对话级验收（2026-10-11 夜，真实账号 + 1234 沙盒，实测 Nightly 2.02.2610092）：4 个 SKILL 全通——
  查询（空日分支/卡片/接力）、记账全链路（记→汇总→改→删，金额硬闸门生效）、建/删行程项、
  模糊表达「优化一下」✓ 不触发任何写操作；沙盒净零残留。
  深夜复测校准（bcff1f9）：打卡「到了」照打 arrived ✓；删除两步确认 ✓（复述轮零调用、确认轮才删）。
- 对话调试两把钥匙（不掌握的话，chat 问什么都是"去小程序页面操作"的兜底卡）：
  ① 面板 **Skill 选择器是多选**，默认只勾 `tripItinerary`——想测别的技能先勾上（勾选集决定云端下发的工具）；
  ② `cli agent debug --enabled false` 关「单步确认」——否则工具调用停在"等待开发者确认执行"，
     CLI 端表现为一直 running 直到超时（面板里手点「确认执行」也可放行）。
- 无头遥控技法：`微信开发者工具.exe --remote-debugging-port=9222` 启动 → CDP 直连 agent 面板
  webview（target 标题「Agent 运行时」，agentPage.html 页）：可查/改技能勾选、点「确认执行」、
  读整段对话轨迹、往输入框灌提问。适合屏幕锁着时继续调。原生菜单也能全无头操作：
  CDP 调标题栏按钮的 React `onMouseDown` 弹菜单 → `PrintWindow` 截被遮挡窗口 → `PostMessage`
  投递菜单项点击。
- 开发版：2026-10-11 夜已用 CLI 无头上传 **`1.0.1`**（desc 标注 beta 自测勿提审），总包 301KB
  （主包 213KB + `/agent/` 88KB）；评测版本就绪。
- 评测入口：AI 编译模式的工具栏最右「评测」图标（DOM：`.ui-icon-eval`，CDP 可无头点击）。
  ⚠️ 2026-10-11 实测：评测窗口在**息屏/无人环境**下自举失败（模拟器组件不启动：
  `simulator not found s1` / `unknown service 'ISimulatorResourceService'`，三次复现），
  需解锁屏幕后重试。
- 待办：① 评测插件第一轮自测（版本 1.0.1 已就绪；跑前先勾 4 个技能、关单步确认；解锁屏幕后
  打开评测窗口走 选择版本→选 SKILL→传 cases（`agent/eval/cases.json`）→检测→生成用例）；
  ② 真机体验打磨；③ 原子组件（小微当前不渲染组件，暂缓）；④ 知识库（可选）。

## 6. 还没做 / 待打磨（接手切入点）

**明确遗留：**

- **分享到聊天 / 相册、导入模板的系统面板**：自动化测不到，需要在真机上手动点一遍验收。
- **Logo 已生成但还没上传到微信后台**（`tools/logo/dist/logo-144.png`）。上传后注意微信会裁圆。
- **腾讯位置服务 key 为空**（`miniprogram/config.js` 的 `TENCENT_MAP_KEY`）。要真正启用导航，需：
  1. 控制台申请 key、开 WebServiceAPI、绑定 AppID；
  2. 微信后台把 `https://apis.map.qq.com` 加进 request 合法域名；
  3. 填 key 到 config.js。
  三步缺一都会静默回退成「复制地名」。
- **提审前把地理编码改成走自家后端代理（P1）**：`https://travel.hclstudio.cn` 已经在 request 合法域名里、后端也在跑；
  改由后端持 key 调 `apis.map.qq.com`、小程序只打自家接口 —— 好处是 key 不进包、可随时轮换、配额也看得住。
  现在不做，提审前别忘。

**可继续打磨的方向（建议排期，非硬性）：**

- 真机体验打磨：真机预览边距、安全区、键盘顶起、下拉刷新手感、长按触发时长。
- 性能：大行程首屏、`wx storage` 单 key 1MB 上限（过大只丢缓存、不丢功能）、照片派生图预热。
- 交互一致性：核对小程序与 Web 在「时间线卡片 / 记账 / 成就」上的文案与操作是否对齐。
- 自动化补强：`check-devtools.mjs --local` 还没覆盖的真机路径（分享面板、导入系统面板）。
- 微信AI 行为校准两处（2026-10-11 对话实测发现，**已修并复测通过**，bcff1f9）：
  ① 打卡：「到 X 了」先查节点存在即照打（arrived/departed 可多次，完成态只挡 done）——已写进
     `checkin/SKILL.md` 与 mcp.json；
  ② 删除：改为**强制两步确认**（用户点名后本轮只复述、禁止调用删除接口；下一轮确认才删，
     明确说"不用确认/直接删"除外）——已写进 tripPlan / money 的 SKILL.md、mcp.json 与 AGENTS.md。

---

## 7. 容易踩的坑（血泪清单）

- **生产登录只能用「龙哥」**：用「我」测试会凭空建一个空壳成员（`check-devtools.mjs` 默认模式已固化此约束）。
- **真机域名白名单**：微信后台「开发管理 → 开发设置 → 服务器域名」必须把 `https://travel.hclstudio.cn`
  加进 **request / uploadFile / downloadFile 三类**；导航还要加 `https://apis.map.qq.com` 到 request。
- **提审 / 发布没有面向普通小程序的 API**：`wxa/submit_audit` / `wxa/get_latest_auditstatus` / `wxa/release`
  仅「第三方平台」（服务商）可调，普通账号用 AppSecret 调一律报 `86000 should be called only from third party`
  （2026-10-10 实测；开放平台文档核实：这组接口挂在「第三方平台 API → 代商家管理小程序」目录下，
  「适用范围」写明其他账号类型均不可调用）。流程：上传（开发者工具；或 miniprogram-ci——官方只支持上传/预览）→
  mp 后台手动提交审核（备注写登录方式，否则审核员停在登录页会被打回）→ 通过后手动发布（管理员微信会收到通知；
  手机上的「小程序助手」也能发布）。全自动只剩一条官方路：注册开放平台「第三方平台」做服务商（企业主体，大工程，不值得）。
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
- **两套开发者工具互斥**：稳定版与 Nightly 共用单实例锁，同时只能开一个（换用时先退另一个）。
- **微信AI 必须真实账号登录**：游客态没有 access_token、agent 权限校验过不去；扫码只支持
  摄像头实拍（相册/长按/分享链接都会被微信拒绝），远程可用 `cli login --qr-output` 出图让手机扫屏。
- **agent 写测试别打真实行程**：Agent 运行时用的就是 IDE 里小程序的登录态，先切到 1234
  沙盒行程再跑；HTTP 层全链路写测试用 `check-agent.mjs --local`（临时库，绝不碰线上）。
- **agent chat 一直 running 不结束**：多半是「单步确认」开着——每次工具调用都等面板点
  「确认执行」；`cli agent debug --enabled false` 即可自动执行（日志里
  `MessageChannelPortMessagerProxy originSend error` 只是症状，与编译模式无关）。
- **对话只会返回"去小程序页面操作"兜底卡**：面板 Skill 多选里没勾中对应技能（默认只勾
  `tripItinerary`）；另注意 CLI 的 `--skill` 对 chat 无效（只对 tool/render 生效）。

---

## 8. 给下一位的开场建议

1. 先读：`HANDOVER.md`（本文）→ `miniprogram/README.md` → `DEPLOY.md` → `docs/specs/2026-10-07-miniprogram-spike-design.md`。
2. 先 `git status` 确认工作区干净；微信AI 工作都在 `feature/wechat-ai-agent` 分支上（见 §5.5），其余工作以 `main` 为基线。
3. 跑一遍基线：`cd miniprogram && node scripts\sync-shared.mjs && $env:PASS="..."; node scripts\check-devtools.mjs --local`，确认全绿再动手。
4. 动手时守三铁律：**不改生成物、共享逻辑只改 `web/src`、Web 不加新功能**。
5. 每改一处，同步脚本 + 对应检查脚本 + `--local` 全链路，通过再提交；提交信息沿用仓库现有的
   `feat/fix/test/docs/chore(scope): 中文描述` 风格。
6. 对接外部平台能力（API / SDK / CLI）**先核实再定方向**：① 这个账号类型能不能调（教训：小程序提审 /
   发布仅「第三方平台」可用，普通账号报 `86000`，见第 7 节）；② 字段与请求方式；③ 前置条件
   （类目 / 白名单 / 密钥）。再用一个最小只读调用做探针验证权限，最后才写功能——别凭记忆或旧博客直接搭。
7. 微信AI 分支还剩最后一哆嗦：真实账号扫码 → `cli agent chat` 对话级验收（细节见 §5.5）。
