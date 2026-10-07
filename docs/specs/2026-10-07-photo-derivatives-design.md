# 照片派生图（缩略图 / 展示图 / HEIC 转码） · 设计

日期：2026-10-07
状态：已批准，执行中

## 目标与策略

原图全部保留（`data/photos/` 不动）。服务端按需生成两种派生：

- `thumb`：长边 320，JPEG q78（约 20KB），时间线用
- `display`：长边 2048，JPEG q85（约 400KB），查看器 / 长图用

HEIC（iPhone）在派生时转成 JPEG，安卓/桌面也能看。**客户端不再下载原图来生成
缩略图**，省带宽省手机 CPU；原图通过「存原图」入口下载。

## 服务端

依赖：`sharp`（缩放/编码）+ `heic-convert`（WASM libheif + libde265）。

实测（本机，12MP iPhone 样张）：sharp 预编译**解不了 HEVC**，heic-convert 解码
1.3–2.6s、峰值 RSS ~400MB → **串行生成**，1.6G 服务器稳；展示图/缩略图再编码约
50–200ms。

模块 `server/src/derivatives.js`：

- `ensureDerivative(photo, variant)`：磁盘已存在直接返回；否则入**串行队列**生成；
  同 `id:variant` 的并发请求合并（in-flight map）；失败记日志返回 null
- 生成：HEIC → heic-convert → JPEG buffer，其余直接 sharp；`.rotate()` 按 EXIF；
  `resize inside` 不放大小；`flatten` 白底（PNG 透明）；落盘 `tmp` + `rename`
- 文件：`data/photos/derived/<id>-<variant>.jpg`；`removeDerivatives(id)` 供删除用

路由 `GET /api/photos/:id/file?variant=thumb|display`：

- 无参数 = 原图（老客户端不受影响）
- 有参数 = 确保派生后发 JPEG，失败兜底发原图并记日志
- 沿用 `private, max-age=31536000, immutable`

其它：

- `image/heif` 加入允许上传的 MIME（魔数校验已认 ftyp）
- 上传成功后**后台预热**两个派生（响应不等它）；删除照片时删派生
- 新增 `server/scripts/warm-derivatives.mjs`：给存量照片跑一遍预热

## Web 客户端

- `platform/web/files.js`：`url(id,{thumb})` 改取 `variant=thumb|display`；
  IndexedDB 缓存键 `thumb:<id>` / `display:<id>`；旧的客户端缩略图（同键）继续可用；
  删除 `makeThumb`（不再客户端生成）；`forget` 只释放内存 URL（展示图很小，缓存留着，
  离线可看）；`drop` 清两个变体
- 查看器：加「存原图」入口（带令牌的下载链接）；查看器/长图用 display
- 桌面高 DPI 下 display 比原图略软，手机上无差别；要原图有入口

## 测试

- server smoke 增：上传 PNG → 两个变体 200、image/jpeg、比原图小；无参数仍是原图
- web `check:vlog` 增：上传一张 800×600 JPEG → 断言 thumb ≤320 且小于原图、
  display ≤2048、两者 content-type 是 image/jpeg；时间线缩略图照常渲染
- 手动：生产预热 33 张存量照片，curl 验证变体

## 部署

服务器要 `npm install`（新增依赖）；顺序：推包 → 服务器装依赖 → 重启 → 预热存量
→ 验证。回滚包照旧。DEPLOY.md 补「依赖有变动要 npm install」与派生目录说明。

## 不做

上传前客户端压缩（保留原图下无必要）、替换/删除原图、CDN 层。
