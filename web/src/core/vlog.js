/**
 * 旅行 vlog 海报生成器。
 * 纯 Canvas 2D，不联网、不调 AI —— 照片在本地拼，山区没信号也能出图。
 *
 * 所有图片请先由调用方加载成 HTMLImageElement（blob: 或同源 URL 均可）再传进来。
 */
import { formatMoney, formatDate, tintOf, categoryMeta, typeMeta } from './format.js';
import { computeBudget } from './budget.js';


const W = 1080;
const H = 1440;
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", sans-serif';

export const TEMPLATES = [
  { id: 'classic', name: '大图 · 经典', hint: '一张主图占上方，下面是大标题' },
  { id: 'grid', name: '四宫格', hint: '四张照片拼贴，适合一天拍了很多' },
  { id: 'minimal', name: '留白 · 单图', hint: '一张图 + 一句话，最耐看' },
  { id: 'ticket', name: '登机牌', hint: '仿机票样式，标题和日期像票根' },
];

export const ACCENTS = ['#2F80ED', '#E2574C', '#27AE60', '#F2994A', '#9B51E0', '#00897B', '#111827'];

/* ----------------------------- 基础绘制 ----------------------------- */

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 把图按 cover 方式裁切填满某个区域 */
function drawCover(ctx, img, x, y, w, h) {
  if (!img) return;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** 按 contain 方式放进区域（不裁切） */
function drawContain(ctx, img, x, y, w, h) {
  if (!img) return;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** 按宽度折行，返回实际画了几行 */
function wrapLines(ctx, text, maxWidth, maxLines = 3) {
  if (!text) return [];
  const chars = [...String(text)];
  const lines = [];
  let cur = '';
  for (const ch of chars) {
    const test = cur + ch;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = ch;
      if (lines.length >= maxLines) break;
    } else {
      cur = test;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);

  if (lines.length === maxLines && chars.length > 0) {
    // 按码点比，别用 UTF-16 长度：emoji 标题会差一位，省略号判断就错了
    const consumed = [...lines.join('')].length;
    if (consumed < chars.length) {
      let last = lines[maxLines - 1];
      while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = last + '…';
    }
  }
  return lines;
}

function drawLines(ctx, lines, x, y, lineHeight) {
  lines.forEach((ln, i) => ctx.fillText(ln, x, y + i * lineHeight));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) return reject(new Error('empty src'));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 并发加载，失败的跳过，不让一张坏图毁掉整张海报 */
async function loadAll(srcs, limit = 4) {
  const queue = srcs.filter(Boolean);
  const out = new Array(queue.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (next < queue.length) {
      const i = next++;
      try {
        out[i] = await loadImage(queue[i]);
      } catch {
        /* 跳过 */
      }
    }
  });
  await Promise.all(workers);
  // 保持传入顺序：照片顺序就是相册里的先后，不能让加载快慢决定谁在前
  return out.filter(Boolean);
}

/* ----------------------------- 各模板 ----------------------------- */

function drawStats(ctx, stats, x, y, w, accent, opts = {}) {
  if (!stats || !stats.length) return;
  const labelSize = opts.labelSize || 24;
  const valueSize = opts.valueSize || 42;
  const gap = w / stats.length;

  ctx.textAlign = 'left';
  stats.slice(0, 4).forEach((s, i) => {
    const cx = x + i * gap;
    ctx.fillStyle = opts.valueColor || '#111827';
    ctx.font = `600 ${valueSize}px ${FONT}`;
    ctx.fillText(s.value, cx, y);
    ctx.fillStyle = opts.labelColor || '#9CA3AF';
    ctx.font = `400 ${labelSize}px ${FONT}`;
    ctx.fillText(s.label, cx, y + labelSize + 12);
    if (i > 0 && opts.dividers !== false) {
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - gap * 0.08, y - valueSize * 0.7);
      ctx.lineTo(cx - gap * 0.08, y + labelSize + 4);
      ctx.stroke();
    }
  });
}

function templateClassic(ctx, o, photos) {
  const accent = o.accent;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  // 主图
  const photoH = 860;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, photoH);
  ctx.clip();
  if (photos[0]) drawCover(ctx, photos[0], 0, 0, W, photoH);
  else {
    const g = ctx.createLinearGradient(0, 0, W, photoH);
    g.addColorStop(0, accent);
    g.addColorStop(1, '#FFFFFF');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, photoH);
  }
  ctx.restore();

  // 底部信息区
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, photoH, W, H - photoH);

  // 强调色块
  ctx.fillStyle = accent;
  ctx.fillRect(80, photoH + 90, 88, 10);

  // 日期
  ctx.fillStyle = accent;
  ctx.font = `600 30px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(o.dateLabel || '', 80, photoH + 165);

  // 标题
  ctx.fillStyle = '#111827';
  ctx.font = `700 72px ${FONT}`;
  const titleLines = wrapLines(ctx, o.title || '旅行记录', W - 160, 2);
  drawLines(ctx, titleLines, 80, photoH + 275, 88);

  // 地点
  const afterTitle = photoH + 275 + (titleLines.length - 1) * 88;
  if (o.location) {
    ctx.fillStyle = '#6B7280';
    ctx.font = `400 32px ${FONT}`;
    ctx.fillText(`◎ ${o.location}`, 80, afterTitle + 78);
  }

  // 分隔线
  const lineY = H - 230;
  ctx.strokeStyle = 'rgba(0,0,0,0.1)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, lineY);
  ctx.lineTo(W - 80, lineY);
  ctx.stroke();

  drawStats(ctx, o.stats, 80, lineY + 90, W - 160, accent);

  // 页脚
  if (o.footer) {
    ctx.fillStyle = '#9CA3AF';
    ctx.font = `400 26px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(o.footer, W - 80, H - 48);
    ctx.textAlign = 'left';
  }
}

function templateGrid(ctx, o, photos) {
  const accent = o.accent;
  ctx.fillStyle = '#F7F8FA';
  ctx.fillRect(0, 0, W, H);

  const M = 44;
  const GAP = 14;
  const cell = (W - M * 2 - GAP) / 2;
  const gridTop = M;
  const gridBottom = gridTop + cell * 2 + GAP;

  const picks = photos.length >= 4 ? [0, 1, 2, 3] : [0, 1, 2, 3].map((i) => (photos.length ? i % photos.length : i));
  ctx.save();
  roundRect(ctx, M, gridTop, W - M * 2, cell * 2 + GAP, 24);
  ctx.clip();
  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = M + col * (cell + GAP);
    const y = gridTop + row * (cell + GAP);
    const img = photos[picks[i]];
    if (img) drawCover(ctx, img, x, y, cell, cell);
    else {
      ctx.fillStyle = i % 2 ? '#E9EDF2' : '#DFE5EC';
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.restore();

  // 渐变过渡
  const fadeH = 150;
  const g = ctx.createLinearGradient(0, gridBottom - fadeH, 0, gridBottom + 40);
  g.addColorStop(0, 'rgba(247,248,250,0)');
  g.addColorStop(1, '#F7F8FA');
  ctx.fillStyle = g;
  ctx.fillRect(0, gridBottom - fadeH, W, fadeH + 40);

  let y = gridBottom + 130;
  ctx.fillStyle = accent;
  ctx.font = `600 30px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(o.dateLabel || '', M, y);

  ctx.fillStyle = '#111827';
  ctx.font = `700 66px ${FONT}`;
  const titleLines = wrapLines(ctx, o.title || '', W - M * 2, 2);
  y += 96;
  drawLines(ctx, titleLines, M, y, 82);
  y += (titleLines.length - 1) * 82;

  if (o.location) {
    ctx.fillStyle = '#6B7280';
    ctx.font = `400 30px ${FONT}`;
    ctx.fillText(`◎ ${o.location}`, M, y + 66);
    y += 66;
  }

  const lineY = H - 230;
  ctx.strokeStyle = 'rgba(0,0,0,0.1)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(M, lineY);
  ctx.lineTo(W - M, lineY);
  ctx.stroke();
  drawStats(ctx, o.stats, M, lineY + 90, W - M * 2, accent);

  if (o.footer) {
    ctx.fillStyle = '#9CA3AF';
    ctx.font = `400 26px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(o.footer, W - M, H - 48);
    ctx.textAlign = 'left';
  }
}

function templateMinimal(ctx, o, photos) {
  const accent = o.accent;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  const M = 70;
  const imgH = 760;

  // 小图，居中留白
  ctx.save();
  roundRect(ctx, M, M, W - M * 2, imgH, 20);
  ctx.clip();
  if (photos[0]) drawContain(ctx, photos[0], M, M, W - M * 2, imgH);
  else {
    ctx.fillStyle = '#F0F2F5';
    ctx.fillRect(M, M, W - M * 2, imgH);
  }
  ctx.restore();

  let y = M + imgH + 130;
  ctx.fillStyle = accent;
  ctx.fillRect(M, y - 46, 64, 8);

  ctx.font = `600 28px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(o.dateLabel || '', M, y);

  ctx.fillStyle = '#111827';
  ctx.font = `500 62px ${FONT}`;
  const titleLines = wrapLines(ctx, o.title || '', W - M * 2, 3);
  y += 100;
  drawLines(ctx, titleLines, M, y, 80);

  if (o.location) {
    ctx.fillStyle = '#9CA3AF';
    ctx.font = `400 28px ${FONT}`;
    ctx.fillText(`◎ ${o.location}`, M, y + 62 + 20);
  }

  if (o.footer) {
    ctx.fillStyle = '#D1D5DB';
    ctx.font = `400 26px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(o.footer, W - M, H - 60);
    ctx.textAlign = 'left';
  }

  if (o.stats?.length) {
    drawStats(ctx, o.stats.slice(0, 3), M, H - 150, W - M * 2, accent, { valueSize: 36, labelSize: 22 });
  }
}

function templateTicket(ctx, o, photos) {
  const accent = o.accent;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  const M = 48;
  const cardW = W - M * 2;
  const cardH = H - M * 2;
  const cardY = M;

  ctx.save();
  roundRect(ctx, M, cardY, cardW, cardH, 28);
  ctx.clip();

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(M, cardY, cardW, cardH);

  // 顶部色带
  ctx.fillStyle = accent;
  ctx.fillRect(M, cardY, cardW, 150);

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `600 30px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(o.footer || 'TRAVEL', M + 44, cardY + 92);

  ctx.textAlign = 'right';
  ctx.font = `500 26px ${FONT}`;
  ctx.fillText(o.dateLabel || '', M + cardW - 44, cardY + 92);
  ctx.textAlign = 'left';

  // 主图
  const imgY = cardY + 150;
  const imgH = 560;
  if (photos[0]) {
    drawCover(ctx, photos[0], M, imgY, cardW, imgH);
  } else {
    ctx.fillStyle = '#EEF1F5';
    ctx.fillRect(M, imgY, cardW, imgH);
  }

  // 撕线
  const tearY = imgY + imgH + 56;
  ctx.strokeStyle = '#D7DCE3';
  ctx.lineWidth = 3;
  ctx.setLineDash([12, 14]);
  ctx.beginPath();
  ctx.moveTo(M + 20, tearY);
  ctx.lineTo(M + cardW - 20, tearY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 齿孔
  for (let i = 0; i < 14; i++) {
    const x = M + 12 + i * ((cardW - 24) / 13);
    ctx.beginPath();
    ctx.arc(x, tearY, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  }

  // 标题
  ctx.fillStyle = '#111827';
  ctx.font = `700 64px ${FONT}`;
  const titleLines = wrapLines(ctx, o.title || '', cardW - 88, 2);
  drawLines(ctx, titleLines, M + 44, tearY + 130, 80);

  // 地点
  if (o.location) {
    ctx.fillStyle = '#6B7280';
    ctx.font = `400 30px ${FONT}`;
    ctx.fillText(`◎ ${o.location}`, M + 44, tearY + 130 + (titleLines.length - 1) * 80 + 62);
  }

  // 底部统计
  drawStats(ctx, o.stats, M + 44, cardY + cardH - 90, cardW - 88, accent, { valueSize: 38, labelSize: 22 });

  ctx.restore();
}

/* ----------------------------- 对外接口 ----------------------------- */

const RENDERERS = {
  classic: templateClassic,
  grid: templateGrid,
  minimal: templateMinimal,
  ticket: templateTicket,
};

/**
 * 生成海报。
 * @param {object} opts
 * @param {'classic'|'grid'|'minimal'|'ticket'} opts.template
 * @param {string} opts.title       大标题
 * @param {string} [opts.dateLabel] 日期
 * @param {string} [opts.location]  地点
 * @param {string[]} photoSrcs      图片地址（blob: 或同源）
 * @param {{label:string,value:string}[]} [opts.stats]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderPoster(opts = {}) {
  const templateId = RENDERERS[opts.template] ? opts.template : 'classic';
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  const photos = await loadAll(opts.photoSrcs || []);

  RENDERERS[templateId](ctx, {
    title: opts.title || '旅行记录',
    subtitle: opts.subtitle || '',
    dateLabel: opts.dateLabel || '',
    location: opts.location || '',
    stats: opts.stats || [],
    footer: opts.footer || '',
    accent: opts.accent || ACCENTS[0],
  }, photos);

  return canvas;
}

/** 导出为 PNG Blob */
export function canvasToBlob(canvas, type = 'image/png', quality = 0.95) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), type, quality);
  });
}

/** 优先用系统分享（iOS 会弹出「存储到照片」），否则下载 */
export async function savePoster(canvas, filename = 'travel-vlog.png') {
  const blob = await canvasToBlob(canvas);

  if (navigator.canShare?.({ files: [new File([blob], filename, { type: 'image/png' })] }) && navigator.share) {
    try {
      await navigator.share({ files: [new File([blob], filename, { type: 'image/png' })] });
      return { ok: true, method: 'share' };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, method: 'cancelled' };
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { ok: true, method: 'download' };
}

/* ----------------------------- 行程长图 ----------------------------- */

/*
 * 把整趟旅行排成一张长图：行程 + 消费 + 记录。
 * 高度不固定，所以分两步：先量、后画。照片槽位先记下来，画完底子再一张一张
 * 加载、贴上去 —— 相册里的图动辄几千万像素，同时解开十几张会把手机内存烧穿。
 */
const LONG = {
  M: 56,
  R: 26,
  BG: '#F4F5F7',
  CARD: '#FFFFFF',
  INK: '#111827',
  INK2: '#6B7280',
  INK3: '#9CA3AF',
  LINE: 'rgba(17,24,39,0.08)',
  OK: '#27AE60',
  DANGER: '#E2574C',
  MAX_H: 15000,
  MAX_PHOTOS: 6,
  MAX_PER_NODE: 2,
  PHOTO_TIMEOUT: 25000,
  PHOTO_BUDGET: 90000,
};

const money = (n) => `¥${formatMoney(n)}`;

function liText(ctx, s, x, y, { font = `400 28px ${FONT}`, color = LONG.INK, align = 'left' } = {}) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
  ctx.textAlign = 'left';
}

function truncate(ctx, text, maxWidth) {
  const s = String(text || '');
  if (ctx.measureText(s).width <= maxWidth) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
  return out + '…';
}

function dayOffset(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

function buildTripBlocks(ctx, model, opts) {
  const { accent } = opts;
  const M = LONG.M;
  const CW = W - M * 2;
  const blocks = [];
  const push = (h, draw) => blocks.push({ h: Math.round(h), draw });
  const { trip, vocab, days, loose, expenseByNode, photoByNode, photoPick, doneByNode } = model;
  const budget = model.budget;

  /* ---------- 封面 ---------- */
  const title = (opts.title || trip.name || '旅行记录').trim() || '旅行记录';
  const subtitle = (opts.subtitle || trip.destination || '').trim();
  const range = trip.start_date
    ? `${formatDate(trip.start_date, { short: true })} – ${formatDate(trip.end_date, { short: true })}`
    : '';
  const subLine = [subtitle, range].filter(Boolean).join(' · ');
  ctx.font = `700 64px ${FONT}`;
  const titleLines = wrapLines(ctx, title, CW, 2);
  const stats = [
    { label: '天数', value: `${model.totalDays} 天` },
    { label: '行程', value: `${model.nodeCount} 项` },
    { label: '照片', value: `${model.photoTotal} 张` },
    { label: '已花', value: money(model.actualTotal) },
  ];
  const headH = 40 + 30 + 34 + titleLines.length * 84 + (subLine ? 24 + 38 : 0) + 40 + 96 + 44;
  push(headH, (c, y) => {
    let cy = y + 40 + 24;
    liText(c, '旅行助手 · 行程长图', M, cy, { font: `600 26px ${FONT}`, color: accent });
    cy += 30 + 34;
    c.font = `700 64px ${FONT}`;
    c.fillStyle = LONG.INK;
    titleLines.forEach((ln, i) => c.fillText(ln, M, cy + i * 84));
    cy += (titleLines.length - 1) * 84 + 24;
    if (subLine) {
      cy += 38;
      liText(c, subLine, M, cy, { font: `400 30px ${FONT}`, color: LONG.INK2 });
    }
    cy += 40;
    drawStats(c, stats, M, cy + 46, CW, accent, { valueSize: 40, labelSize: 22 });
  });

  /* ---------- 消费总览 ---------- */
  const cats = budget.spent || [];
  const paid = budget.paid || [];
  const barW = CW - 72;
  const budH =
    36 + 30 + 64 + (budget.plannedTotal > 0 ? 34 + 40 : 8) + 28 + cats.length * 54 + (paid.length ? 24 + 74 : 0) + 36;
  push(budH, (c, y) => {
    c.save();
    c.fillStyle = LONG.CARD;
    roundRect(c, M, y, CW, budH, LONG.R);
    c.fill();
    c.strokeStyle = LONG.LINE;
    c.lineWidth = 2;
    roundRect(c, M, y, CW, budH, LONG.R);
    c.stroke();
    c.restore();
    const px = M + 36;
    let cy = y + 36;
    liText(c, '已花', px, cy + 24, { font: `400 26px ${FONT}`, color: LONG.INK3 });
    if (budget.plannedTotal > 0) {
      liText(c, `预算 ${money(budget.plannedTotal)}`, W - M - 36, cy + 24, { font: `400 26px ${FONT}`, color: LONG.INK3, align: 'right' });
      const remainTxt = budget.remaining >= 0 ? `还剩 ${money(budget.remaining)}` : `超支 ${money(-budget.remaining)}`;
      liText(c, remainTxt, W - M - 36, cy + 74, {
        font: `600 34px ${FONT}`,
        color: budget.remaining >= 0 ? LONG.OK : LONG.DANGER,
        align: 'right',
      });
    }
    liText(c, money(budget.actualTotal), px, cy + 90, { font: `700 58px ${FONT}`, color: LONG.INK });
    cy += 106;
    if (budget.plannedTotal > 0) {
      const rate = Math.max(0, Math.min(1, (budget.actualTotal || 0) / budget.plannedTotal));
      roundRect(c, px, cy, barW, 16, 8);
      c.fillStyle = '#E9EDF2';
      c.fill();
      if (rate > 0) {
        roundRect(c, px, cy, Math.max(16, barW * rate), 16, 8);
        c.fillStyle = budget.over ? LONG.DANGER : accent;
        c.fill();
      }
      cy += 40;
    }
    cy += 28;
    for (const row of cats) {
      const meta = categoryMeta(vocab, row.category);
      c.beginPath();
      c.arc(px + 9, cy + 16, 9, 0, Math.PI * 2);
      c.fillStyle = meta.color || '#6B7280';
      c.fill();
      liText(c, meta.label || row.category, px + 34, cy + 26, { font: `400 28px ${FONT}`, color: LONG.INK });
      liText(c, `${row.count} 笔`, px + 34 + 96, cy + 26, { font: `400 22px ${FONT}`, color: LONG.INK3 });
      liText(c, money(row.actual), W - M - 36, cy + 26, { font: `600 28px ${FONT}`, color: LONG.INK, align: 'right' });
      cy += 54;
    }
    if (paid.length) {
      cy += 12;
      c.strokeStyle = LONG.LINE;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(px, cy);
      c.lineTo(W - M - 36, cy);
      c.stroke();
      cy += 34;
      liText(c, '各自花的', px, cy, { font: `400 24px ${FONT}`, color: LONG.INK3 });
      const colW = (barW - (paid.length - 1) * 20) / paid.length;
      paid.forEach((p, i) => {
        const cx = px + i * (colW + 20);
        const m = (model.members || []).find((x) => x.name === p.name);
        const color = m?.color || accent;
        c.beginPath();
        c.arc(cx + 20, cy + 44, 20, 0, Math.PI * 2);
        c.fillStyle = tintOf(color);
        c.fill();
        liText(c, (p.name || '?').slice(0, 1), cx + 20, cy + 52, { font: `600 22px ${FONT}`, color, align: 'center' });
        c.font = `600 26px ${FONT}`;
        const nameTxt = truncate(c, p.name || '未记', colW - 130);
        liText(c, nameTxt, cx + 52, cy + 52, { font: `600 26px ${FONT}`, color: LONG.INK });
        liText(c, money(p.paid), cx + colW - 4, cy + 52, { font: `600 26px ${FONT}`, color: LONG.INK, align: 'right' });
      });
    }
  });

  /* ---------- 每天的行程 ---------- */
  for (const day of days) {
    const off = dayOffset(trip.start_date || day.date, day.date);
    const dayTag = off == null || off < 0 ? '出发前' : `第 ${off + 1} 天`;
    const dateLabel = formatDate(day.date);
    const cntLabel = `${day.nodes.length} 项`;
    push(96, (c, y) => {
      const cy = y + 40;
      liText(c, dayTag, M, cy, { font: `700 30px ${FONT}`, color: accent });
      c.font = `700 30px ${FONT}`;
      const tagW = c.measureText(dayTag).width;
      liText(c, dateLabel, M + tagW + 22, cy, { font: `400 28px ${FONT}`, color: LONG.INK2 });
      c.font = `400 28px ${FONT}`;
      const dateW = c.measureText(dateLabel).width;
      const cntW = c.measureText(cntLabel).width;
      c.strokeStyle = LONG.LINE;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(M + tagW + 22 + dateW + 22, cy - 10);
      c.lineTo(W - M - cntW - 20, cy - 10);
      c.stroke();
      liText(c, cntLabel, W - M, cy, { font: `400 24px ${FONT}`, color: LONG.INK3, align: 'right' });
    });

    for (const node of day.nodes) {
      blocks.push(
        buildNodeCard(ctx, node, {
          ...opts,
          vocab,
          expenseByNode,
          photoByNode,
          photoPick,
          doneByNode,
        })
      );
    }
    push(10, () => {});
  }

  /* ---------- 没挂行程的账 ---------- */
  if (loose.length) {
    push(70 + loose.length * 52 + 36, (c, y) => {
      liText(c, '随手记（没挂行程）', M, y + 40, { font: `700 30px ${FONT}`, color: LONG.INK });
      let cy = y + 70 + 20;
      for (const e of loose) {
        const meta = categoryMeta(vocab, e.category);
        c.beginPath();
        c.arc(M + 9, cy + 12, 9, 0, Math.PI * 2);
        c.fillStyle = meta.color || '#6B7280';
        c.fill();
        c.font = `400 28px ${FONT}`;
        liText(c, truncate(c, e.note || meta.label, CW - 220), M + 34, cy + 22, { font: `400 28px ${FONT}`, color: LONG.INK });
        liText(c, money(e.amount), W - M - 8, cy + 22, { font: `600 28px ${FONT}`, color: LONG.INK, align: 'right' });
        cy += 52;
      }
    });
  }

  /* ---------- 页脚 ---------- */
  const today = new Date();
  push(150, (c, y) => {
    liText(c, `旅行助手 · 行程与消费记录 · 生成于 ${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`, W / 2, y + 80, {
      font: `400 24px ${FONT}`,
      color: LONG.INK3,
      align: 'center',
    });
  });

  return blocks;
}

function buildNodeCard(ctx, node, opts) {
  const { accent, usePhotos, vocab, expenseByNode, photoByNode, photoPick, doneByNode, photoSlots } = opts;
  const M = LONG.M;
  const padY = 30;
  const contentX = M + 12 + 30;
  const rightX = W - M - 36;
  const contentW = rightX - contentX;
  const meta = typeMeta(vocab, node.type);
  const exp = expenseByNode.get(node.id) || [];
  const allPhotos = photoByNode.get(node.id) || [];
  const picked = usePhotos ? photoPick.get(node.id) || [] : [];
  const isDone = node.status === 'done' || doneByNode.has(node.id);
  const timeStr = [node.start_time, node.end_time].filter(Boolean).join('–') || '全天';
  const checks = (node.checklist || []).slice(0, 6);
  const moreChecks = Math.max(0, (node.checklist || []).length - checks.length);

  ctx.font = `700 36px ${FONT}`;
  const titleLines = wrapLines(ctx, node.title || '', contentW, 2);
  ctx.font = `400 26px ${FONT}`;
  const showLoc = node.location && !(node.title || '').includes(node.location);
  const locTxt = showLoc ? truncate(ctx, node.location, contentW - 180) : '';
  const noteLines = node.notes ? wrapLines(ctx, node.notes, contentW, 4) : [];

  const metaTxt = [isDone ? '✓ 完成' : '', allPhotos.length ? `照片 ${allPhotos.length}` : ''].filter(Boolean).join('   ');
  let h = padY + 42;
  h += 14 + titleLines.length * 46;
  if (locTxt) h += 10 + 34;
  if (noteLines.length) h += 12 + noteLines.length * 38;
  if (checks.length || moreChecks) h += 10 + checks.length * 44 + (moreChecks ? 32 : 0);
  if (exp.length) h += 12 + exp.length * 50;
  if (picked.length) h += 12 + 200;
  h += padY;

  return {
    h,
    draw(c, y) {
      c.save();
      c.fillStyle = LONG.CARD;
      roundRect(c, M, y, W - M * 2, h, LONG.R);
      c.fill();
      c.save();
      roundRect(c, M, y, W - M * 2, h, LONG.R);
      c.clip();
      c.fillStyle = meta.color || '#6B7280';
      c.fillRect(M, y, 12, h);
      c.restore();
      c.strokeStyle = LONG.LINE;
      c.lineWidth = 2;
      roundRect(c, M, y, W - M * 2, h, LONG.R);
      c.stroke();
      c.restore();

      let cy = y + padY;
      c.font = `600 26px ${FONT}`;
      const tw = c.measureText(timeStr).width;
      liText(c, timeStr, contentX, cy + 28, { font: `600 26px ${FONT}`, color: LONG.INK2 });
      const typeLabel = meta.label || '其他';
      c.font = `500 22px ${FONT}`;
      const labelW = c.measureText(typeLabel).width + 34;
      roundRect(c, contentX + tw + 22, cy + 2, labelW, 36, 18);
      c.fillStyle = meta.soft || tintOf(meta.color || '#6B7280');
      c.fill();
      liText(c, typeLabel, contentX + tw + 22 + 17, cy + 28, { font: `500 22px ${FONT}`, color: meta.color || '#6B7280' });
      if (metaTxt) liText(c, metaTxt, rightX, cy + 28, { font: `500 24px ${FONT}`, color: isDone ? LONG.OK : LONG.INK3, align: 'right' });
      cy += 56;

      c.font = `700 36px ${FONT}`;
      c.fillStyle = LONG.INK;
      titleLines.forEach((ln, i) => c.fillText(ln, contentX, cy + i * 46));
      cy += titleLines.length * 46;

      if (locTxt) {
        cy += 10;
        liText(c, locTxt, contentX, cy + 26, { font: `400 26px ${FONT}`, color: LONG.INK2 });
        cy += 34;
      }

      if (noteLines.length) {
        cy += 12;
        c.font = `400 26px ${FONT}`;
        c.fillStyle = LONG.INK2;
        noteLines.forEach((ln, i) => c.fillText(ln, contentX, cy + 26 + i * 38));
        cy += noteLines.length * 38 + 4;
      }

      if (checks.length || moreChecks) {
        cy += 10;
        for (const it of checks) {
          const bx = contentX + 2;
          const by = cy + 8;
          c.beginPath();
          c.arc(bx + 11, by + 11, 11, 0, Math.PI * 2);
          if (it.done) {
            c.fillStyle = LONG.OK;
            c.fill();
            c.strokeStyle = '#FFFFFF';
            c.lineWidth = 3;
            c.beginPath();
            c.moveTo(bx + 5, by + 11.5);
            c.lineTo(bx + 10, by + 16);
            c.lineTo(bx + 17, by + 6.5);
            c.stroke();
          } else {
            c.strokeStyle = 'rgba(17,24,39,0.25)';
            c.lineWidth = 3;
            c.stroke();
          }
          c.font = `400 26px ${FONT}`;
          liText(c, truncate(c, it.text, contentW - 46), contentX + 38, cy + 28, {
            font: `400 26px ${FONT}`,
            color: it.done ? LONG.INK3 : LONG.INK2,
          });
          cy += 44;
        }
        if (moreChecks) {
          liText(c, `还有 ${moreChecks} 条`, contentX + 38, cy + 24, { font: `400 24px ${FONT}`, color: LONG.INK3 });
          cy += 32;
        }
      }

      if (exp.length) {
        cy += 12;
        for (const e of exp) {
          const cm = categoryMeta(vocab, e.category);
          c.beginPath();
          c.arc(contentX + 8, cy + 16, 8, 0, Math.PI * 2);
          c.fillStyle = cm.color || '#6B7280';
          c.fill();
          c.font = `400 28px ${FONT}`;
          liText(c, truncate(c, e.note || cm.label, contentW - 200), contentX + 32, cy + 26, {
            font: `400 28px ${FONT}`,
            color: LONG.INK,
          });
          liText(c, money(e.amount), rightX, cy + 26, { font: `600 28px ${FONT}`, color: LONG.INK, align: 'right' });
          cy += 50;
        }
      }

      if (picked.length) {
        cy += 12;
        const gap = 16;
        const slotW = (contentW - gap) / 2;
        picked.forEach((photoId, i) => {
          const x = contentX + i * (slotW + gap);
          roundRect(c, x, cy, slotW, 200, 16);
          c.fillStyle = '#EEF1F5';
          c.fill();
          photoSlots.push({ photoId, x, y: cy, w: slotW, h: 200 });
          if (i === picked.length - 1 && allPhotos.length > picked.length) {
            const more = `+${allPhotos.length - picked.length}`;
            c.font = `600 24px ${FONT}`;
            const mw = c.measureText(more).width + 24;
            roundRect(c, x + slotW - mw - 12, cy + 200 - 46, mw, 34, 17);
            c.fillStyle = 'rgba(17,24,39,0.55)';
            c.fill();
            liText(c, more, x + slotW - 12 - mw / 2, cy + 200 - 22, { font: `600 24px ${FONT}`, color: '#FFFFFF', align: 'center' });
          }
        });
        cy += 200;
      }
    },
  };
}

/**
 * 生成整趟旅行的长图。
 * @param {object} opts
 * @param {object} opts.trip
 * @param {Array}  opts.nodes      快照里的节点（checklist 已解析）
 * @param {Array}  opts.expenses
 * @param {Array}  opts.photos
 * @param {Array}  opts.checkins
 * @param {Array}  opts.members
 * @param {object} opts.vocab
 * @param {string} opts.accent
 * @param {boolean} opts.includePhotos
 * @param {(id:string)=>Promise<HTMLImageElement>} opts.loadPhoto
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderTripLongImage(opts = {}) {
  const trip = opts.trip || {};
  const vocab = opts.vocab || {};
  const nodes = (opts.nodes || []).filter((n) => n && n.date);
  const expenses = opts.expenses || [];
  const photos = opts.photos || [];
  const checkins = opts.checkins || [];
  const accent = opts.accent || ACCENTS[0];

  const expenseByNode = new Map();
  for (const e of expenses) {
    if (!e.node_id) continue;
    if (!expenseByNode.has(e.node_id)) expenseByNode.set(e.node_id, []);
    expenseByNode.get(e.node_id).push(e);
  }
  const loose = expenses.filter((e) => !e.node_id);

  const photoByNode = new Map();
  for (const p of photos) {
    if (!p.node_id) continue;
    if (!photoByNode.has(p.node_id)) photoByNode.set(p.node_id, []);
    photoByNode.get(p.node_id).push(p);
  }
  const doneByNode = new Set(checkins.filter((c) => c.action === 'done').map((c) => c.node_id));

  const dates = [...new Set(nodes.map((n) => n.date))].sort();
  const days = dates.map((d) => ({ date: d, nodes: nodes.filter((n) => n.date === d) }));

  const budget = computeBudget({ budgets: opts.budgets || [], expenses });

  const buildPhotoPick = () => {
    const pick = new Map();
    let total = 0;
    for (const day of days) {
      for (const n of day.nodes) {
        const list = photoByNode.get(n.id) || [];
        const take = [];
        for (const p of list) {
          if (take.length >= LONG.MAX_PER_NODE || total >= LONG.MAX_PHOTOS) break;
          take.push(p.id);
          total += 1;
        }
        if (take.length) pick.set(n.id, take);
      }
    }
    return pick;
  };

  const scratch = document.createElement('canvas').getContext('2d');
  const modelBase = {
    trip,
    vocab,
    days,
    loose,
    expenseByNode,
    photoByNode,
    doneByNode,
    members: opts.members || [],
    budget,
    actualTotal: budget.actualTotal,
    totalDays: dates.length,
    nodeCount: nodes.length,
    photoTotal: photos.length,
  };

  const render = (usePhotos) => {
    const photoSlots = [];
    const blocks = buildTripBlocks(scratch, { ...modelBase, photoPick: usePhotos ? buildPhotoPick() : new Map() }, {
      accent,
      usePhotos,
      title: opts.title,
      subtitle: opts.subtitle,
      photoSlots,
    });
    const height = blocks.reduce((s, b) => s + b.h, 0);
    return { blocks, height, photoSlots };
  };

  let plan = render(!!opts.includePhotos);
  // 太长了就先把照片摘掉再来一遍；再长就认了，总比悄悄截掉内容强
  if (plan.height > LONG.MAX_H && opts.includePhotos) plan = render(false);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = LONG.BG;
  ctx.fillRect(0, 0, W, plan.height);
  let y = 0;
  for (const b of plan.blocks) {
    b.draw(ctx, y);
    y += b.h;
  }

  // 照片一张一张来：画完就放，别把整本相册都扣在内存里
  if (typeof opts.loadPhoto === 'function') {
    const startedAt = Date.now();
    for (const slot of plan.photoSlots) {
      if (Date.now() - startedAt > LONG.PHOTO_BUDGET) break; // 原图可能很慢，超时就先出图
      try {
        const img = await Promise.race([
          opts.loadPhoto(slot.photoId),
          new Promise((resolve) => setTimeout(() => resolve(null), LONG.PHOTO_TIMEOUT)),
        ]);
        if (!img) continue;
        ctx.save();
        roundRect(ctx, slot.x, slot.y, slot.w, slot.h, 16);
        ctx.clip();
        drawCover(ctx, img, slot.x, slot.y, slot.w, slot.h);
        ctx.restore();
        img.src = '';
      } catch {
        /* 单张失败就留底色，不让整张长图跟着塌 */
      }
    }
  }

  return canvas;
}
