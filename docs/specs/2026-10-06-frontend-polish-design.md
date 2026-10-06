# 前端打磨与小程序隔离层 · 设计

日期：2026-10-06
状态：已批准，执行中

## 目标

1. 为将来移植小程序立好"地基"：平台相关能力全部走一层接口，`core/` 保持零平台依赖，`store/` 只认接口。
2. 在 Web 上把体验打磨到位：性能（首屏/缩略图/长图）、交互与状态、视觉 tokens、代码结构。

## 明确不做（本轮）

- 不引入 Taro/uni-app、UI 组件库：小程序技术路线未定；UI 与 DOM/Canvas 深度绑定，换框架也要适配；项目一直手写控件（见提交 `f35e6c2`）。
- 不做暗色模式：属于新功能而非打磨；tokens 收敛时会为以后留出空间，但本轮不实现。
- 不动服务端接口：任务边界是前端；缩略图选**本地生成 + IndexedDB 缓存**，不给 1.6G 服务器加 `sharp` 原生依赖；将来小程序端 `stream` 用轮询实现即可，也无须改服务端。
- 不做复杂分包：主包已 ~80KB gzip，只懒加载 Poster（含 ~950 行 Canvas 代码），按实测数据说话。

## 分层

```
web/src/
  core/      纯逻辑，零平台依赖
             format · timeline · checklist · budget · vlog-model（新）
  platform/  唯一平台入口
    index.js   组装并导出 web 实例（移植时的交换点）
    web/       session · persist · net · files · device · services · canvas
  store/     api（工厂 + 实例）· store（只依赖 platform 接口）
  ui/        React，每端各写一套；只有 ui 和 platform/web 可以直接用浏览器 API
```

规则：`core/` 不许 import `platform/` 或触碰 DOM；`store/` 不直接碰浏览器 API；将来移植 = 新建 `platform/wx` + 把 `platform/index.js` 指过去 + 重写 `ui/`，`core/` `store/` 原样复用。

## platform 接口（7 组）

| 组 | 职责 | Web 实现 |
|---|---|---|
| session | token / tripId / memberName | localStorage |
| storage | 快照 / blob（含缩略图）/ meta | IndexedDB（原 `store/idb.js` 搬家） |
| queue | 离线写队列 | IndexedDB |
| net | `send` / `upload` / `openStream` / `url` | fetch / FormData / EventSource |
| files | 照片 URL（`thumb|full`）/ `forget` / `drop` | blob→objectURL + 本地 320px 缩略图 |
| device | `isOnline` / `onNetwork` / `onResume` / `vibrate` | navigator + window 事件 |
| services | `openMap` / `shareText` / `copyText` | window.open + navigator.share/clipboard |
| canvas | 海报与长图渲染、保存 | 原 `core/vlog.js` 搬家 |

数据流与错误语义不变：写操作失败进队列；4xx 丢弃并计数；401 触发登出；SSE 断开退避重连。

## 阶段计划

### Phase 1 · 地基

1. `platform/` 目录与 web 实现（session/persist/net/files/device/services/canvas）。
2. `core/vlog-model.js`：从 vlog 抽出纯模型（分组、选片、预算行、统计），渲染留在 `platform/web/canvas.js`。
3. `store/api.js` 改工厂（`createApi(platform)` + 默认实例）；照片 URL 与导出 URL 迁入 platform。
4. `store/store.js` 去浏览器 API：网络/可见性/流/存储全走 platform。
5. UI 调用点改到 platform（照片、导航、剪贴板、上传参数）。
6. 新增 `check:core`：node 直跑 core 断言，作为移植安全网。

### Phase 2 · 性能

1. `Poster` 懒加载（React.lazy + Suspense 骨架），主包实测减重。
2. 时间线缩略图：`files.url(id, {thumb:true})`，首次本地生成 320px JPEG 存 IndexedDB；查看器与长图用原图；照片删除时连带清理；原图缓存沿用"关闭查看器即释放"的现状。
3. 长图分片绘制 + `onProgress`，Poster 上显示"生成中 n/N"。

### Phase 3 · 交互与视觉

1. 自定义确认弹窗（store 持状态 + UI host）替换 5 处 `window.confirm`。
2. `prefers-reduced-motion`；触控命中区 ≥40px；弹层关闭后焦点还原。
3. tokens 收敛（颜色/圆角/字号，为暗色模式留路但不实现）；`styles.css` 按序拆文件；`Journey.jsx` 拆 NodeCard/DaySection/PhotoViewer/LooseList。

## 验证

- 每阶段：`check:imports` + `build` + `check:core` + `smoke` + `check:vlog`（+ 受影响专项：editor/fields/prep/shortcuts/drag）。
- Phase 1 完成后跑一遍 server smoke 确认无服务端联动。
- 全部完成后合并部署，并补 DEPLOY.md 说明（check:core、分层约定）。

## 风险与对策

- 大范围搬家易漏调用点 → `check:imports` + 构建 + 全套 Playwright 回归兜底；每阶段独立提交、可上线。
- 缩略图增加 IndexedDB 占用 → 单张 JPEG ~20–50KB，上限约等于照片数；删除照片时同步清理。
- 懒加载引入首开延迟 → Poster 打开时显示 Sheet 骨架，加载通常 <200ms。
