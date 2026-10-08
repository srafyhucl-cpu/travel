import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, nowISO, uid, PHOTO_DIR } from '../db.js';
import { memberIdOf, requireAuth } from '../auth.js';
import { broadcast } from '../events.js';
import { ensureDerivative, isVariant, removeDerivatives, warmPhoto } from '../derivatives.js';

const router = express.Router();

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/heic', '.heic'],
  ['image/heif', '.heic'],
  ['image/gif', '.gif'],
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTO_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOWED.get(file.mimetype) || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) return cb(new Error('只支持 JPG / PNG / WebP / HEIC / GIF 图片'));
    cb(null, true);
  },
});

/*
 * mimetype 是客户端自己填的，不能只信它：把一段 HTML 改名 .png 传上来，
 * 光靠 multer 的 fileFilter 拦不住。落盘后再对一次魔数，对不上就删掉。
 * HEIC 只认文件头里的 ftyp 盒（MOV/MP4 也长这样，但 fileFilter 已经先把
 * 非图片类型挡在外面了）。
 */
const SNIFF = [
  (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, // jpeg
  (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, // png
  (b) => b.slice(0, 6).toString('latin1').startsWith('GIF8'), // gif87a / gif89a
  (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  (b) => b.slice(4, 8).toString('latin1') === 'ftyp', // heic
];

function looksLikeImage(filename) {
  const fd = fs.openSync(path.join(PHOTO_DIR, filename), 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    return SNIFF.some((match) => match(head));
  } finally {
    fs.closeSync(fd);
  }
}

function dropFiles(files) {
  for (const f of files) fs.promises.unlink(path.join(PHOTO_DIR, f.filename)).catch(() => {});
}

router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(
    db
      .prepare('SELECT id, node_id, member_id, filename, mime, size, width, height, caption, taken_at, created_at FROM photos WHERE trip_id = ? ORDER BY created_at DESC')
      .all(req.auth.tid)
  );
});

router.post('/', upload.array('photos', 12), (req, res) => {
  const tripId = req.auth.tid;
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'bad_request', message: '没有收到图片' });

  const bad = files.find((f) => !looksLikeImage(f.filename));
  if (bad) {
    dropFiles(files);
    return res.status(400).json({ error: 'bad_image', message: '有一个文件不是有效的图片' });
  }

  let nodeId = null;
  if (req.body?.nodeId) {
    const n = db.prepare('SELECT id FROM nodes WHERE id = ? AND trip_id = ?').get(String(req.body.nodeId), tripId);
    nodeId = n?.id ?? null;
  }

  const now = nowISO();
  const takenAt = req.body?.takenAt && !Number.isNaN(Date.parse(req.body.takenAt)) ? new Date(req.body.takenAt).toISOString() : null;
  const caption = req.body?.caption ? String(req.body.caption).slice(0, 200) : null;

  const ins = db.prepare(
    `INSERT INTO photos (id, trip_id, node_id, member_id, filename, mime, size, width, height, caption, taken_at, created_at)
     VALUES (@id, @trip_id, @node_id, @member_id, @filename, @mime, @size, @width, @height, @caption, @taken_at, @created_at)`
  );

  const uploaderId = memberIdOf(req);
  const rows = [];
  const tx = db.transaction(() => {
    for (const f of files) {
      const row = {
        id: uid(),
        trip_id: tripId,
        node_id: nodeId,
        member_id: uploaderId,
        filename: f.filename,
        mime: f.mimetype,
        size: f.size,
        width: Number.isFinite(+req.body?.width) ? +req.body.width : null,
        height: Number.isFinite(+req.body?.height) ? +req.body.height : null,
        caption,
        taken_at: takenAt,
        created_at: now,
      };
      ins.run(row);
      rows.push(row);
    }
  });
  tx();

  // 后台预热两个派生：上传响应不等它。旧照片没预热也没关系，看的时候按需生成。
  for (const row of rows) warmPhoto(row).catch(() => {});

  broadcast(tripId, { type: 'photos' });
  res.status(201).json(rows);
});

/**
 * 取图：
 *   ?variant=thumb    长边 320 的 JPEG（时间线）
 *   ?variant=display  长边 2048 的 JPEG（查看器/长图）；HEIC 在这里转成 JPEG
 *   不带参数 = 原图（老客户端兼容，「存原图」也走这里）
 * 派生生成失败兜底发原图，并留在日志里。
 */
router.get('/:id/file', async (req, res) => {
  const tripId = req.auth.tid;
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!photo) return res.status(404).json({ error: 'not_found' });

  const variant = String(req.query.variant || '');
  if (variant) {
    if (!isVariant(variant)) return res.status(400).json({ error: 'bad_variant' });
    const derived = await ensureDerivative(photo, variant);
    if (derived) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      fs.createReadStream(derived).pipe(res);
      return;
    }
    /* 生成不出来（原图损坏等）：掉到下面发原图 */
  }

  const file = path.join(PHOTO_DIR, photo.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'file_missing' });

  res.setHeader('Content-Type', photo.mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
});

router.patch('/:id', (req, res) => {
  const tripId = req.auth.tid;
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!photo) return res.status(404).json({ error: 'not_found' });

  const caption = req.body?.caption !== undefined ? (String(req.body.caption).slice(0, 200) || null) : photo.caption;
  let nodeId = photo.node_id;
  if (req.body?.nodeId !== undefined) {
    if (req.body.nodeId === null || req.body.nodeId === '') nodeId = null;
    else {
      const n = db.prepare('SELECT id FROM nodes WHERE id = ? AND trip_id = ?').get(String(req.body.nodeId), tripId);
      nodeId = n?.id ?? nodeId;
    }
  }

  db.prepare('UPDATE photos SET caption = ?, node_id = ? WHERE id = ?').run(caption, nodeId, photo.id);
  broadcast(tripId, { type: 'photos' });
  res.json(db.prepare('SELECT id, node_id, member_id, filename, mime, size, width, height, caption, taken_at, created_at FROM photos WHERE id = ?').get(photo.id));
});

router.delete('/:id', (req, res) => {
  const tripId = req.auth.tid;
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!photo) return res.status(404).json({ error: 'not_found' });

  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  fs.promises.unlink(path.join(PHOTO_DIR, photo.filename)).catch(() => {});
  removeDerivatives(photo.id);
  broadcast(tripId, { type: 'photos' });
  res.json({ ok: true });
});

export default router;
