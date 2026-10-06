/**
 * Web 平台实现：把七组能力组装成一个对象。
 * 小程序版照着这个形状写一份 platform/wx 即可。
 */
import { session } from './session.js';
import { storage, queue } from './persist.js';
import { createNet } from './net.js';
import { files } from './files.js';
import { device } from './device.js';
import * as services from './services.js';
import * as canvas from './canvas.js';

export function createWebPlatform() {
  return {
    session,
    storage,
    queue,
    net: createNet(),
    files,
    device,
    services,
    canvas,
  };
}
