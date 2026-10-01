import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, nowISO, uid, PHOTO_DIR } from '../db.js';
import { requireAuth } from '../auth.js';
import { broadcast } from '../events.js';

const router = express.Router();

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/heic', '.heic'],
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

router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(
    db
      .prepare('SELECT id, node_id, filename, mime, size, width, height, caption, taken_at, created_at FROM photos WHERE trip_id = ? ORDER BY created_at DESC')
      .all(req.auth.tid)
  );
});

router.post('/', upload.array('photos', 12), (req, res) => {
  const tripId = req.auth.tid;
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'bad_request', message: '没有收到图片' });

  let nodeId = null;
  if (req.body?.nodeId) {
    const n = db.prepare('SELECT id FROM nodes WHERE id = ? AND trip_id = ?').get(String(req.body.nodeId), tripId);
    nodeId = n?.id ?? null;
  }

  const now = nowISO();
  const takenAt = req.body?.takenAt && !Number.isNaN(Date.parse(req.body.takenAt)) ? new Date(req.body.takenAt).toISOString() : null;
  const caption = req.body?.caption ? String(req.body.caption).slice(0, 200) : null;

  const ins = db.prepare(
    `INSERT INTO photos (id, trip_id, node_id, filename, mime, size, width, height, caption, taken_at, created_at)
     VALUES (@id, @trip_id, @node_id, @filename, @mime, @size, @width, @height, @caption, @taken_at, @created_at)`
  );

  const rows = [];
  const tx = db.transaction(() => {
    for (const f of files) {
      const row = {
        id: uid(),
        trip_id: tripId,
        node_id: nodeId,
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

  broadcast(tripId, { type: 'photos' });
  res.status(201).json(rows);
});

/** 缩略图：前端 canvas 拼图用小图，省流量 */
router.get('/:id/file', (req, res) => {
  const tripId = req.auth.tid;
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!photo) return res.status(404).json({ error: 'not_found' });

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
  res.json(db.prepare('SELECT id, node_id, filename, mime, size, width, height, caption, taken_at, created_at FROM photos WHERE id = ?').get(photo.id));
});

router.delete('/:id', (req, res) => {
  const tripId = req.auth.tid;
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND trip_id = ?').get(req.params.id, tripId);
  if (!photo) return res.status(404).json({ error: 'not_found' });

  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  fs.promises.unlink(path.join(PHOTO_DIR, photo.filename)).catch(() => {});
  broadcast(tripId, { type: 'photos' });
  res.json({ ok: true });
});

export default router;
