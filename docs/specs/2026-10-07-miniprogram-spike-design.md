# 微信小程序 · 骨架一屏（Spike） · 设计

日期：2026-10-07
状态：已批准，执行中

## 目标

在不动服务端、不引入跨端框架的前提下，用原生小程序跑通「登录 → 行程一屏」，
验证平台隔离层（`core/` + `store/` 复用、`platform/wx` 实现）这条路走得通。

## 技术选型：原生（已确认）

- `core/`、`store/` 的复用由隔离层完成，原生只需写 `platform/wx` + WXML/WXSS
- DevTools 增强编译处理 ES 模块与现代语法；WXSS 自基础库 2.10.2 起支持 CSS 变量
- 对比 Taro：本 App 的 UI 依赖 DOM 能力（拖拽/弹层/Canvas），换框架也要重写；
  当前只有微信一个目标，Taro 的多端收益用不上

## 目录结构

```
miniprogram/
  app.js / app.json / app.wxss / project.config.json / sitemap.json
  pages/login/          口令 + 名字 → /api/auth/login
  pages/timeline/       核心一屏
  platform/index.js     指向 wx 实现
  platform/wx/          session · persist · net · device · files · services
  core/  store/         由 scripts/sync-shared.mjs 从 web/src 同步生成（勿手改）
  scripts/sync-shared.mjs
  README.md
```

## 同步策略

`web/src` 是单一事实来源。`node scripts/sync-shared.mjs` 把 `core/` 全目录与
`store/{store,api}.js` 复制进小程序，并加「同步生成，勿手改」头注释；复制完用
web 侧的 esbuild 做一遍语法检查（有则查，没有就跳过）。生成文件进版本库，
克隆下来即可被 DevTools 打开。

## platform/wx 实现

| 组 | 实现 |
|---|---|
| session | 同名 key 的 wx storage 读写；退出只清 token/tripId，名字留着 |
| persist | 快照/元数据存 wx storage（单 key 1MB，超了就放弃缓存）；照片二进制本轮不做 |
| queue | storage 里的数组，接口与 web 一致（离线写队列） |
| net | `wx.request` 包成 `{status, ok, text(), json()}`；base 固定为 `https://travel.hclstudio.cn`；`openStream` 用 20s 轮询实现（收 onMessage 就触发刷新）；`upload` 占位（照片阶段再做） |
| device | `onNetworkStatusChange` / `onAppShow` / `vibrateShort` |
| files | 占位：`url()` 返回 null（本轮无照片） |
| services | `copyText` 走 `wx.setClipboardData`；`openMap` 提示待接地图 |

## 第一屏范围

- 登录页：口令 + 名字，真实调 `/api/auth/login`；错误由全局 toast 呈现
- 行程页：本地快照秒开 → 网络刷新；「现在」卡（复用 `computeNow`）；
  按天分组时间线（`decorate` + `groupByDate` + `formatDate/relativeDay/typeMeta`）；
  下拉刷新；勾选待办（真实写接口，验证读写的完整路径）；20s 轮询近似实时
- 不做：照片、长图、记账、拖拽编辑、导航（或接地图插件另立）

## 验证边界

- 本地可验证：同步脚本、全量语法检查、`check:core`（纯逻辑）
- 需要你验证：DevTools 编译/渲染/交互；真机预览需 AppID + 把域名加进 request 合法域名
- 服务端零改动

## 风险

- 首次原生开发，编译细节（模块/语法/样式能力）可能需按 DevTools 报错微调
- wx storage 单 key 1MB：大行程快照可能存不下缓存，功能不受影响（只是不秒开）
- `wx.openLocation` 要坐标，导航需地图插件，本轮不做
