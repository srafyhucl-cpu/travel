/**
 * 小程序本地配置。
 *
 * TENCENT_MAP_KEY：腾讯位置服务（https://lbs.qq.com/）的 WebServiceAPI key。
 * 「导航」按钮用它调地理编码接口把地名解析成坐标，再交给 wx.openLocation。
 *
 * 使用前要办三件事（缺一不可，任何一步没做都会自动回退成「复制地名」）：
 * 1. 在腾讯位置服务控制台申请 key，并为这个 key 开启「WebServiceAPI」能力、
 *    绑定本小程序的 AppID（见 project.config.json，当前为 wx991808af7e9a8e9c）；
 * 2. 在微信公众平台「开发管理 → 开发设置 → 服务器域名」把
 *    https://apis.map.qq.com 加进 request 合法域名（真机不配会被拦截）；
 * 3. 把 key 填到下面。留空则保持旧行为：复制地名 + 提示去地图 App 里搜。
 */
export const TENCENT_MAP_KEY = '';
