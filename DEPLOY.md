# 部署备忘

线上地址 **https://travel.hclstudio.cn** —— 手机浏览器打开后「添加到主屏幕」即可像 App 一样用。

## 服务器上的东西在哪

| 东西 | 位置 |
| --- | --- |
| 代码 + 依赖 | `/opt/apps/travel` |
| 数据库 | `/opt/apps/travel/data/travel.db` |
| 上传的照片 | `/opt/apps/travel/data/photos/` |
| 日志 | `/opt/apps/travel/logs/app.log`、`app.error.log` |
| 环境变量 | `/opt/apps/travel/.env` |
| systemd 单元 | `/etc/systemd/system/travel.service` |
| nginx 站点 | `/etc/nginx/sites-available/travel.hclstudio.cn` |
| 证书 | `/etc/letsencrypt/live/travel.hclstudio.cn/` |

后端只监听 `127.0.0.1:7020`，公网一律走 nginx 的 443。

## 常用命令

```bash
systemctl status travel          # 看状态
systemctl restart travel         # 改完代码后重启
journalctl -u travel -f          # 跟日志（其实直接 tail logs/app.log 更方便）
tail -f /opt/apps/travel/logs/app.error.log

nginx -t && systemctl reload nginx   # 改完 nginx 配置
```

## 改代码后怎么更新

服务器内存只有 1.6G，**不要在服务器上 build**。在本地打包再推：

```powershell
cd D:\Project\travel\web
npm run build            # 产物直接落到 server/frontend/dist

cd D:\Project\travel
tar -cf - -C server --exclude=data --exclude=node_modules --exclude='.testdata*' --exclude=scripts src frontend/dist package.json package-lock.json `
  | ssh root@47.94.102.250 "tar -xf - -C /opt/apps/travel"

# server/package.json 有变动的版本：先在服务器装依赖，再重启
ssh root@47.94.102.250 "cd /opt/apps/travel && npm install --omit=dev"

ssh root@47.94.102.250 "systemctl restart travel"
```

清旧包（可选，只为省磁盘）。**别手写文件名，也别只 grep index.html** —— 海报是
动态 import 的分包，只在 JS 里被引用（只看 index.html 误删过一次）；而「grep 所有
js」同样不行：Vite 会在 chunk 里内嵌一张依赖清单，旧包的清单里正写着旧主包的名字，
旧文件会互相"保命"（真保过一次）。正确做法是从 index.html 出发做一次可达性分析：

```bash
cd /opt/apps/travel/frontend/dist
keep="index.html"; changed=1
while [ $changed -eq 1 ]; do
  changed=0
  for f in $keep; do
    for ref in $(grep -o "assets/[A-Za-z0-9._-]*" "$f" 2>/dev/null); do
      case " $keep " in *" $ref "*) ;; *) keep="$keep $ref"; changed=1;; esac
    done
  done
done
for f in assets/*; do
  case " $keep " in *" assets/$(basename "$f") "*) ;; *) rm -f "$f";; esac
done
ls assets
```

注：取不到的旧包会由 nginx 的 SPA 回退返成 `index.html`（HTTP 200 + `text/html`），
所以「URL 返回 200」不代表文件还在，要看磁盘或 `Content-Type`。
懒加载分包的 hash 变了同样要重新部署，`ls assets` 出来的文件数和本地构建产物对得上才算干净。

数据库结构有变动时，schema 在 `server/src/db.js` 的 `SCHEMA` 里，字段追加写在 `ensureColumn()`，
重启时自动迁移，老数据不用管。

## 本地回归测试

改完前端先自己跑一遍再推。全都在 `web/scripts/`，`cd web` 之后跑：

```powershell
npm run build            # 大多数测试要对着构建产物跑，先得 build

npm run check:imports    # 具名 import 能不能对上（最快，先跑这个）
npm run check:core       # 纯逻辑自测：node 直跑 core/，不需要浏览器/后端
npm run smoke            # 每个界面走一遍，收集控制台报错
npm run check:editor     # 卡片类型色 / 代办逐条输入 / 必填标注 / 日期自动
npm run check:fields     # 记账弹层输入框有没有被挤爆
npm run check:drag       # 长按拖拽排序
npm run check:shortcuts  # PWA 主屏长按的三个快捷方式
npm run check:order      # 时间倒流检查（只读，默认直接打生产）
npm run check:prep       # 前置模块卡：位置 / 勾选同步 / 全完成折叠 / 编辑器开关
npm run check:vlog       # 行程长图：默认长图能出、带照片开关生效
npm run check:money      # 总预算合并成一条 / meId 贯通
npm run check:theme      # 暗色模式：跟随系统 / 手动切换 / 记住选择
```

退出码：0 = 全通，1 = 有失败或报错，2 = 脚本自己炸了。环境变量：`BASE` 改目标地址、
`SHOTS` 指定截图目录、`FROM` / `DOWN` 换拖拽位置；`PASS` **必填**（口令不再写进仓库）。

```powershell
$env:PASS = "你的口令"
npm run smoke
```

除 `check:order` 和 `check:core` 外都会**自己复制一份 `server/data` 到临时目录、另起一个端口的后端、
测完连数据一起删**，真库一个字节都不会动 —— 因为有一半会改数据（敲表单、拖拽），而
落点、表单这类操作没法靠「改完再改回去」复原。共用流程写在 `web/scripts/_harness.cjs`。

`check:order` 是纯只读 API 检查，默认直接打生产：当初 10-02「丽江古城」排在「玉龙雪山」
后面那条时间倒流就是它查出来的。它不改任何数据，放心跑。

浏览器装在 `D:\Tools\playwright-browsers`（用户级环境变量 `PLAYWRIGHT_BROWSERS_PATH` 指定，
全机器共用，**不要**再往临时目录里下一份 —— 曾经重复下过 705 MB）。

## 口令

- 登录口令就是这趟旅行的钥匙，**只有你自己知道，别外传**。
- 同伴输入同一个口令，再填自己的名字，就会自动建一个成员身份。
- 在 App「我的 → 修改旅行口令」里可以换口令：改完已登录的设备不会掉线，同伴下次登录用新口令。
  新口令至少 6 位；登录没有次数焦虑，但服务端对连续输错有 15 分钟限速。
- 服务端 pepper 和 session secret 存在 `data/.pepper`、`data/.session-secret`。
  **这两个文件丢了就登不了录了**，备份 `data/` 目录时务必一起带上。
- 测试脚本的口令必须由 `PASS` 环境变量给（见上）；仓库里不落任何默认口令 ——
  默认值等于把钥匙写在门上。

## 微信小程序（骨架已立）

代码分四层（详见 `docs/specs/2026-10-06-frontend-polish-design.md` 与
`docs/specs/2026-10-07-miniprogram-spike-design.md`）：

- `core/` 纯逻辑，不许碰 DOM / 平台；`npm run check:core` 用 node 直接跑
- `platform/` 唯一平台入口；Web 实现在 `platform/web/`，小程序实现在 `miniprogram/platform/wx/`
- `store/` 只依赖 platform 的接口，两端共用
- `ui/` 每端各写一套（Web 是 React，小程序是 `miniprogram/pages/`）

小程序工程在 `miniprogram/`。改完 web 的 `core/` 或 `store/` 之后：

```powershell
cd D:\Project\travel\miniprogram
node scripts\sync-shared.mjs      # 从 web/src 同步 core/store，顺带全量语法检查
$env:PASS = "你的口令"
node scripts\check-platform.mjs   # 不用开发者工具，先在 Node 里把 platform/wx 跑一遍（只读）
```

然后用微信开发者工具导入 `miniprogram/`（没 AppID 选测试号）。真机预览前要把
`https://travel.hclstudio.cn` 加进 request 合法域名。`miniprogram/core|store` 是生成物，
**勿手改**。

## 几个容易踩的坑

- **SSE 必须关缓冲。** nginx 里的 `proxy_buffering off` 和后端代码里的 `X-Accel-Buffering: no`
  少一个，「实时同步中」就会一直转圈。改 nginx 时别把这行删了。
- **`streamAuth` 必须注册在 `router.use(requireAuth)` 前面。** Express 按注册顺序匹配，
  放后面的话 `/api/trip/stream` 会被先拒掉，前端无限重连。
- **预算是一个总数，不再按类别分行。** 「已花」明细直接按实际记账类别汇总，不做预算行冲抵；
  界面上只维护一条 `budgets` 记录（类别写「总预算」），改预算就是改那一个数。
- **token 会出现在 URL 里。** SSE 流、`.ics` 订阅、模板下载没法带请求头，只能走 `?token=`，
  于是会进 nginx 的 access log。要么给这几条路径单独关日志，要么定期换口令（App 里现在能换）。
- **HEIC 原样进原样出。** iPhone 传的 HEIC 只有苹果设备能解码，安卓看是破图、长图也画不出。
  在意的话让上传方在系统设置里选「兼容性最佳」（拍 JPEG）。
- **深色主题的挂载点是 `<html data-theme>`**（`styles/tokens.css` 里两套 token）。
  首屏前置脚本在 `index.html`，「跟随系统」的解析在 `ui/theme.js`——改主题逻辑时两处都要动。
  海报/长图是给相册看的图片，固定浅色，不跟主题。
- **打卡/照片的 `member_id`** 是成就的个人归属依据：新写入从 token 的 `mid` 落，
  老数据启动时追认给「创建者」（最早加入的成员）。换 token 格式（auth.js 的
  signToken）时别忘了继续带 `mid`，否则归属会退化成按名字反查。
- **照片派生图。** `data/photos/derived/` 里是服务端生成的缩略图（320）与展示图（2048，
  HEIC 也在这里转成 JPEG）；原图永远不动，删除照片会连派生一起删。改过派生参数
  （尺寸/质量）要清掉 `derived/` 重新生成；存量照片预热：`node src/tools/warm-derivatives.js`
  （串行执行——12MP HEIC 解码峰值内存约 400MB，服务器只有 1.6G）。
