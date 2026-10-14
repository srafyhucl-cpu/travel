import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, db } from './db.js';
import authRoutes from './routes/auth.js';
import tripsRoutes from './routes/trips.js';
import tripRoutes from './routes/trip.js';
import nodeRoutes from './routes/nodes.js';
import moneyRoutes from './routes/money.js';
import checkinRoutes from './routes/checkins.js';
import vocabRoutes from './routes/vocab.js';
import photoRoutes from './routes/photos.js';
import exportRoutes from './routes/exports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');

const PORT = Number(process.env.PORT || 7020);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${res.statusCode} ${req.method} ${req.originalUrl} ${Date.now() - started}ms`);
    }
  });
  next();
});

app.get('/api/health', (req, res) => {
  // 只要一个「活着」的信号就够了；路径、行程名这些不对外说
  res.json({
    ok: true,
    version: 1,
    uptime: Math.round(process.uptime()),
    node: process.version,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/trips', tripsRoutes);
app.use('/api/trip', tripRoutes);
app.use('/api/nodes', nodeRoutes);
app.use('/api/money', moneyRoutes);
app.use('/api/checkins', checkinRoutes);
app.use('/api/vocab', vocabRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/export', exportRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: '接口不存在' }));

// 前端静态资源
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(
    express.static(FRONTEND_DIST, {
      index: false,
      setHeaders(res, filePath) {
        // index.html 和 sw.js 不缓存，带 hash 的静态资源可以长缓存
        if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.[0-9a-f]{8,}\.(js|css|png|jpg|svg|woff2?)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send('前端还没构建。先在 web/ 目录执行 npm run build。');
  });
}

app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err.message);
  if (res.headersSent) return next(err);
  const isMulter = err.code?.startsWith?.('LIMIT_');
  // 对外只给一句能懂的话；堆栈和 SQL 细节留在服务端日志里
  res.status(400).json({
    error: isMulter ? 'upload_too_large' : 'server_error',
    message: isMulter ? '图片太大了，单张请控制在 25MB 以内' : '服务器出错了，请稍后再试',
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`旅行助手后端已启动  http://${HOST}:${PORT}`);
  console.log(`数据目录 ${DATA_DIR}`);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`);
  server.close(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
