/**
 * Web 平台实现：把六组常驻能力组装成一个对象。
 * 小程序版照着这个形状写一份 platform/wx 即可。
 *
 * 注意：Canvas（海报/长图）不在这个单例里 —— 它 ~950 行且只用一次，
 * 由 UI 直接 import platform/web/canvas.js，交给 bundler 懒加载。
 */
import { session } from './session.js';
import { storage, queue } from './persist.js';
import { createNet } from './net.js';
import { files } from './files.js';
import { device } from './device.js';
import * as services from './services.js';

export function createWebPlatform() {
  return {
    session,
    storage,
    queue,
    net: createNet(),
    files,
    device,
    services,
  };
}
