/**
 * 照片文件（微信实现）：本轮第一屏不带照片，先占位。
 *
 * 开做照片时的实现方向：
 *   url(id, {thumb})  wx.downloadFile 拿临时路径（或 FileSystemManager 持久化），
 *                     缩略图用 canvas 2d 生成后存本地；
 *   forget/drop      删除本地缓存文件。
 */
export const files = {
  async url() {
    return null;
  },
  forget() {},
  drop() {},
};
