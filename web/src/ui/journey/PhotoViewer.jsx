import React, { useEffect, useState } from 'react';
import { platform } from '../../platform/index.js';
import { actions, askConfirm } from '../../store/store.js';
import { Icon } from '../bits.jsx';

/** 全屏看照片：左右翻页、写一句话、删掉 */
export default function PhotoViewer({ photo, photos, onClose, onEdit }) {
  const [caption, setCaption] = useState(photo.caption || '');
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const idx = photos.findIndex((p) => p.id === photo.id);

  useEffect(() => {
    let alive = true;
    platform.files
      .url(photo.id)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
      platform.files.forget(photo.id);
    };
  }, [photo.id]);

  const go = (d) => {
    const next = photos[idx + d];
    if (next) onEdit(next);
  };

  return (
    <div className="viewer" onClick={onClose}>
      {url ? <img src={url} alt={caption} onClick={(e) => e.stopPropagation()} /> : <div className="shot-skel big" />}
      <button className="icon-btn viewer-close" onClick={onClose} aria-label="关闭">
        <Icon name="close" size={18} />
      </button>
      {idx > 0 && (
        <button className="icon-btn viewer-nav l" onClick={() => go(-1)} aria-label="上一张">
          <Icon name="back" size={18} />
        </button>
      )}
      {idx < photos.length - 1 && (
        <button className="icon-btn viewer-nav r" onClick={() => go(1)} aria-label="下一张">
          <Icon name="chevron" size={18} />
        </button>
      )}
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <input
          className="input"
          value={caption}
          placeholder="给这张照片写句话"
          onChange={(e) => setCaption(e.target.value)}
          onBlur={async () => {
            if (caption === (photo.caption || '')) return;
            setBusy(true);
            try {
              await actions.patchPhoto(photo.id, { caption: caption.trim() });
            } finally {
              setBusy(false);
            }
          }}
        />
        <button
          className="chip-btn"
          disabled={busy}
          onClick={async () => {
            if (!(await askConfirm('删掉这张照片？', { danger: true, confirmText: '删除' }))) return;
            await actions.deletePhoto(photo.id);
            onClose();
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  );
}
