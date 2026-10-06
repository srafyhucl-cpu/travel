/**
 * 平台入口 —— 全项目唯一的交换点。
 *
 * 分层约定：
 *   core/     纯逻辑，不许 import 这里、不许碰 DOM
 *   platform/ 平台能力（存储/请求/实时/照片/设备/服务/Canvas）
 *   store/    业务与状态，只依赖 platform 的接口
 *   ui/       每端各写一套；只有 ui 和 platform/web 可以直接用浏览器 API
 *
 * 移植小程序：新建 platform/wx（接口形状照 web/index.js），把这里的实现换过去，
 * core/ 和 store/ 原样复用，ui/ 按小程序重写。
 */
import { createWebPlatform } from './web/index.js';

export const platform = createWebPlatform();
