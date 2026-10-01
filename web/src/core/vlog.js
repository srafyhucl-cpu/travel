/**
 * 旅行 vlog 海报生成器。
 * 纯 Canvas 2D，不联网、不调 AI —— 照片在本地拼，山区没信号也能出图。
 *
 * 所有图片请先由调用方加载成 HTMLImageElement（blob: 或同源 URL 均可）再传进来。
 */

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
    const consumed = lines.join('').length;
    if (consumed < String(text).length) {
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
  const out = [];
  const queue = [...srcs.filter(Boolean)];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const src = queue.shift();
      try {
        out.push(await loadImage(src));
      } catch {
        /* 跳过 */
      }
    }
  });
  await Promise.all(workers);
  return out;
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
