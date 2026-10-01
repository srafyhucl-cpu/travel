/**
 * 旅行助手 Service Worker
 *
 * 只做两件事：
 *   1. 缓存 App 外壳（HTML/JS/CSS/图标），断网时还能打开
 *   2. 静态资源走「缓存优先」，HMR 开发时自动绕过
 *
 * 明确不碰的：
 *   - /api/*  一律直连网络。行程数据由 IndexedDB 快照负责离线，
 *              SSE 长连接（/api/trip/stream）更不能被缓存，否则实时同步会卡死。
 *   - 照片流 /api/photos/:id/file 体积大，走浏览器 HTTP 缓存即可。
 */

const VERSION = 'travel-v5';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

// 外壳：安装时预缓存。带 hash 的构建产物由下面的「缓存优先」逻辑自动收进来。
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // 单个资源失败不该让整个安装挂掉
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API、SSE、照片流：完全不拦截
  if (url.pathname.startsWith('/api/')) return;
  // Vite 开发服务器的模块与 HMR
  if (url.pathname.startsWith('/@') || url.pathname.includes('hot-update') || url.pathname.startsWith('/src/')) return;

  // 页面导航：网络优先，断网回退到缓存的外壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 静态资源：缓存优先，命中后后台顺手更新
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
