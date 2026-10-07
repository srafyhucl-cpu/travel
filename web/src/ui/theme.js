/**
 * 主题：跟随系统 / 浅色 / 深色。
 *
 * CSS 只认 <html data-theme>（见 styles/tokens.css）；系统偏好在这里解析，
 * 媒体监听也只在这里。首屏前置脚本（index.html 里那一小段）负责在画面
 * 之前就把属性定好，避免深色偏好下先闪一帧亮色 —— 逻辑与这里保持一致。
 */
const KEY = 'travel.theme';
const MODES = ['system', 'light', 'dark'];
const media = window.matchMedia('(prefers-color-scheme: dark)');

let mode = 'system';

export function getThemeMode() {
  return mode;
}

function resolve() {
  return mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
}

function apply() {
  const theme = resolve();
  document.documentElement.dataset.theme = theme;
  // PWA 状态栏 / 地址栏配色跟着走
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0F1115' : '#F5F6F8');
}

export function setThemeMode(next) {
  if (!MODES.includes(next)) return;
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* 隐身模式等存不了就算了，本次生效 */
  }
  apply();
}

export function initTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (MODES.includes(saved)) mode = saved;
  } catch {
    /* 忽略 */
  }
  apply();
  media.addEventListener('change', () => {
    if (mode === 'system') apply();
  });
}
