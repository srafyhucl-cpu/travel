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

ssh root@47.94.102.250 "systemctl restart travel"
```

清旧包（可选，只为省磁盘）。**别照着上一次的名字手写 rm** —— 改 JSX 不改 CSS 时
CSS 的 hash 不会变，上一次的 CSS 正是这一次还在用的那一份，手写名字会把它删掉。
让脚本自己判断：只删「线上 index.html 里没提到」的文件。

```bash
cd /opt/apps/travel/frontend/dist && for f in assets/*; do b=$(basename "$f"); \
  grep -q "$b" index.html || rm -f "$f"; done; ls assets
```

注：取不到的旧包会由 nginx 的 SPA 回退返成 `index.html`（HTTP 200 + `text/html`），
所以「URL 返回 200」不代表文件还在，要看磁盘或 `Content-Type`。

数据库结构有变动时，schema 在 `server/src/db.js` 的 `SCHEMA` 里，字段追加写在 `ensureColumn()`，
重启时自动迁移，老数据不用管。

## 口令

- 登录口令就是这趟旅行的钥匙，**只有你自己知道，别外传**。
- 同伴输入同一个口令，再填自己的名字，就会自动建一个成员身份。
- 服务端 pepper 和 session secret 存在 `data/.pepper`、`data/.session-secret`。
  **这两个文件丢了就登不了录了**，备份 `data/` 目录时务必一起带上。

## 几个容易踩的坑

- **SSE 必须关缓冲。** nginx 里的 `proxy_buffering off` 和后端代码里的 `X-Accel-Buffering: no`
  少一个，「实时同步中」就会一直转圈。改 nginx 时别把这行删了。
- **`streamAuth` 必须注册在 `router.use(requireAuth)` 前面。** Express 按注册顺序匹配，
  放后面的话 `/api/trip/stream` 会被先拒掉，前端无限重连。
- **预算行的 `vocab_key`。** 预算显示的是自由文字（如「机票·去程」），消费记的是类别 key（如 `flightfee`），
  靠 `vocab_key` 关联。新增预算行时一定要填上，否则这笔预算永远是 0。
