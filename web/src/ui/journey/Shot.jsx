import React, { useEffect, useState } from 'react';
import { platform } from '../../platform/index.js';

/** 时间线上的照片缩略图：只拉缩略图，点开才看原图 */
export default function Shot({ photo, onClick }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    platform.files
      .url(photo.id, { thumb: true })
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [photo.id]);

  return (
    <button className="shot" onClick={onClick}>
      {url && !failed ? (
        // HEIC 这类当前浏览器解不开的图：给说明块，不摆一个破图
        <img src={url} alt={photo.caption || ''} loading="lazy" onError={() => setFailed(true)} />
      ) : failed ? (
        <span className="shot-bad">无法预览</span>
      ) : (
        <span className="shot-skel" />
      )}
      {photo.caption && <span className="shot-cap">{photo.caption}</span>}
    </button>
  );
}
