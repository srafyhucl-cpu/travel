/**
 * 类型图标 → data URI。
 *
 * 图标数据在 core/glyphs.js（与 Web 共用同一份，sync-shared 同步过来）；
 * 小程序不能内联 SVG，这里把同一个 24×24 视框的图形编码成 base64 的 data URI，
 * <image> 直接用。颜色/尺寸不同的组合做缓存。
 */
import { glyph } from '../../core/glyphs.js';

const cache = new Map();

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* SVG 全是 ASCII，手写一个 base64 就够（小程序里没有可靠的 btoa） */
function base64(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const c1 = s.charCodeAt(i);
    const c2 = s.charCodeAt(i + 1);
    const c3 = s.charCodeAt(i + 2);
    out += B64[c1 >> 2];
    out += B64[((c1 & 3) << 4) | ((c2 >> 4) & 15)];
    out += i + 1 < s.length ? B64[((c2 & 15) << 2) | ((c3 >> 6) & 3)] : '=';
    out += i + 2 < s.length ? B64[c3 & 63] : '=';
  }
  return out;
}

export function iconDataUri(name, color = '#6B7280', size = 24) {
  const key = `${name}|${color}|${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts = glyph(name);
  if (!parts) return '';

  const body = parts
    .map((s) => {
      if (s.t === 'c') return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}"/>`;
      if (s.t === 'e') return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${color}" stroke="none"/>`;
      if (s.t === 'r') return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.rx}"/>`;
      return `<path d="${s.d}"/>`;
    })
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"` +
    ` fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
    body +
    '</svg>';

  const uri = `data:image/svg+xml;base64,${base64(svg)}`;
  cache.set(key, uri);
  return uri;
}
