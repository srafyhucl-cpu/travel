import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/tokens.css';
import './styles/timeline.css';
import './styles/forms.css';
import './styles/overlays.css';
import './styles/misc.css';
import { boot } from './store/store.js';
import { initTheme } from './ui/theme.js';

initTheme();
boot();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// 注册 Service Worker（离线能力）。开发环境不注册，避免缓存干扰。
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
