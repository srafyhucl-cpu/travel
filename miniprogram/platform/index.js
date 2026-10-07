/**
 * 平台入口：微信小程序实现。
 *
 * 分层与 web 端一致（见 web/src/platform/index.js）：
 *   core/  store/    由 scripts/sync-shared.mjs 从 web/src 同步生成，勿手改
 *   platform/wx/     手写的小程序实现；接口形状照 platform/web/
 *   pages/           每端各写一套
 */
import { session } from './wx/session.js';
import { storage, queue } from './wx/persist.js';
import * as net from './wx/net.js';
import { files } from './wx/files.js';
import { device } from './wx/device.js';
import * as services from './wx/services.js';

export const platform = {
  session,
  storage,
  queue,
  net,
  files,
  device,
  services,
};
