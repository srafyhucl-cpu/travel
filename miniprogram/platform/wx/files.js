/**
 * 照片文件（微信实现）：本轮第一屏不带照片，先占位。
 *
 * 开做照片时的实现方向：
 *   url(id, {thumb})  wx.downloadFile 请求服务端变体
 *                     （/api/photos/<id>/file?variant=thumb|display，
 *                      HEIC 已在服务端转成 JPEG）拿临时路径，
 *                     再按需持久化到 FileSystemManager；
 *   forget/drop      释放/删除本地缓存文件。
 */
export const files = {
  async url() {
    return null;
  },
  forget() {},
  drop() {},
};
