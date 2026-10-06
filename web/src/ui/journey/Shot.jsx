import React, { useEffect, useState } from 'react';
import { platform } from '../../platform/index.js';

/** 时间线上的照片缩略图：只拉缩略图，点开才看原图 */
export default function Shot({ photo, onClick }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
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
      {url ? <img src={url} alt={photo.caption || ''} loading="lazy" /> : <span className="shot-skel" />}
      {photo.caption && <span className="shot-cap">{photo.caption}</span>}
    </button>
  );
}
