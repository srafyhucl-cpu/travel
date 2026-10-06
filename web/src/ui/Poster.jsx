import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './useStore.js';
import { toast } from '../store/store.js';
import { photoUrl } from '../store/api.js';
import { TEMPLATES, ACCENTS, renderPoster, renderTripLongImage, savePoster, canvasToBlob } from '../core/vlog.js';
import { formatDate, formatMoney } from '../core/format.js';
import { computeBudget } from '../core/budget.js';
import { Icon, Sheet, Field, Input } from './bits.jsx';

function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 把这趟旅行的照片排成一张能发朋友圈的图。 */
export default function Poster({ photos, trip, onClose }) {
  const state = useStore();
  const data = state.data;
  const canvasRef = useRef(null);
  const [mode, setMode] = useState('long');
  const [template, setTemplate] = useState('classic');
  const [accent, setAccent] = useState(ACCENTS[0]);
  const [title, setTitle] = useState(trip?.name || '旅行记录');
  const [subtitle, setSubtitle] = useState(trip?.destination || '');
  const [count, setCount] = useState(4);
  const [includePhotos, setIncludePhotos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  const stats = useMemo(() => {
    if (!data) return [];
    const t = data.trip;
    const days = Math.max(1, Math.round((new Date(t.end_date) - new Date(t.start_date)) / 86400000) + 1);
    const b = computeBudget({ budgets: data.budgets, expenses: data.expenses });
    return [
      { label: '天数', value: `${days} 天` },
      { label: '消费', value: `¥${formatMoney(b.actualTotal)}` },
      { label: '照片', value: `${photos.length} 张` },
    ];
  }, [data, photos.length]);

  const chosen = photos.slice(0, count);
  /*
   * 每次生成发一个号。慢的那次（带照片）跑完时如果号已经旧了，说明用户又改过
   * 配置，结果直接作废 —— 否则预览和 canvasRef 会被旧配置覆盖，按「保存」
   * 存下去的是上一次的图。
   */
  const genRef = useRef(0);

  async function generate() {
    if (!data) return;
    if (mode === 'photo' && !chosen.length) return;
    const gen = ++genRef.current;
    setBusy(true);
    try {
      let canvas;
      if (mode === 'long') {
        canvas = await renderTripLongImage({
          trip: data.trip,
          nodes: data.nodes,
          expenses: data.expenses,
          photos: data.photos,
          checkins: data.checkins,
          members: data.members,
          budgets: data.budgets,
          vocab: data.vocab,
          accent,
          includePhotos: includePhotos && photos.length > 0,
          loadPhoto: async (id) => {
            const u = await photoUrl(id);
            return u ? loadImageEl(u) : null;
          },
        });
      } else {
        const srcs = [];
        for (const p of chosen) {
          const u = await photoUrl(p.id);
          if (u) srcs.push(u);
        }
        canvas = await renderPoster({
          template,
          accent,
          title: title.trim() || '旅行记录',
          subtitle: subtitle.trim(),
          dateLabel: `${formatDate(trip?.start_date, { short: true })} – ${formatDate(trip?.end_date, { short: true })}`,
          location: trip?.destination || '',
          stats,
          footer: 'Made with 旅行助手',
          photoSrcs: srcs,
        });
      }
      if (gen !== genRef.current) return; // 已经有更新的一次生成，旧结果丢掉
      const blob = await canvasToBlob(canvas);
      if (gen !== genRef.current) return;
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
      canvasRef.current = canvas;
    } catch (e) {
      if (gen === genRef.current) toast('出图失败：' + (e?.message || '未知错误'), 'error');
    } finally {
      if (gen === genRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, template, accent, count, includePhotos, photos.length]);

  return (
    <Sheet title="生成 vlog 图" onClose={onClose}>
      <div className="stack">
        <div className="pill-row">
          <button className={`pill${mode === 'long' ? ' on' : ''}`} onClick={() => setMode('long')}>
            行程长图
          </button>
          <button
            className={`pill${mode === 'photo' ? ' on' : ''}`}
            disabled={!photos.length}
            title={photos.length ? '' : '还没有照片'}
            onClick={() => photos.length && setMode('photo')}
          >
            照片拼图
          </button>
        </div>
        <div className="tiny dim">
          {mode === 'long'
            ? '把每天的行程、消费和记录排成一张长图，直接存到相册。'
            : TEMPLATES.find((t) => t.id === template)?.hint}
        </div>

        {mode === 'long' ? (
          <>
            <div className="swatches">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  style={{ background: c, outline: accent === c ? `2px solid ${c}` : 'none', outlineOffset: 2 }}
                  onClick={() => setAccent(c)}
                  aria-label={`主色 ${c}`}
                />
              ))}
            </div>

            <div className="pill-row">
              <button
                className={`pill${includePhotos && photos.length ? ' on' : ''}`}
                disabled={!photos.length}
                onClick={() => setIncludePhotos((v) => !v)}
              >
                <Icon name="camera" size={13} /> 带照片（最多 6 张，会慢一些）
              </button>
            </div>
            {!photos.length && <div className="tiny dim">还没有照片，长图会只带文字记录。</div>}
            {photos.length > 0 && <div className="tiny dim">照片按原图下载，会慢一些；不带照片出图很快。</div>}
          </>
        ) : (
          <>
            <div className="pill-row">
              {TEMPLATES.map((t) => (
                <button key={t.id} className={`pill${template === t.id ? ' on' : ''}`} onClick={() => setTemplate(t.id)}>
                  {t.name}
                </button>
              ))}
            </div>

            <div className="swatches">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  style={{ background: c, outline: accent === c ? `2px solid ${c}` : 'none', outlineOffset: 2 }}
                  onClick={() => setAccent(c)}
                  aria-label={`主色 ${c}`}
                />
              ))}
            </div>

            <Field label="大标题">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={40} />
            </Field>
            <Field label="副标题">
              <Input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} maxLength={40} placeholder="丽江 · 大理" />
            </Field>

            <Field label={`用几张（现有 ${photos.length} 张）`}>
              <div className="pill-row">
                {[1, 2, 3, 4, 6, 8, 9].map((n) => (
                  <button key={n} className={`pill${count === n ? ' on' : ''}`} disabled={n > photos.length} onClick={() => setCount(n)}>
                    {n} 张
                  </button>
                ))}
              </div>
            </Field>
          </>
        )}

        {preview ? (
          <>
            {mode === 'long' ? (
              <div className="vlog-scroll">
                <img src={preview} alt="行程长图预览" className="vlog-preview" />
              </div>
            ) : (
              <img src={preview} alt="vlog 预览" className="vlog-preview" />
            )}
            {mode === 'long' && <div className="tiny dim">长图可能有好几屏，保存后在相册里看完整版。</div>}
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  const fname = mode === 'long' ? `vlog-长图-${trip?.start_date || 'trip'}.png` : `vlog-${trip?.start_date || 'trip'}.png`;
                  const r = await savePoster(canvasRef.current, fname);
                  if (r?.ok) toast('已保存到相册', 'success');
                } catch {
                  toast('保存失败，可以长按上面的图手动保存', 'warn');
                }
              }}
            >
              <Icon name="download" size={15} /> 保存到相册
            </button>
          </>
        ) : (
          <div className="skeleton" style={{ height: 240 }} />
        )}

        <button className="btn" onClick={generate} disabled={busy || (mode === 'photo' && !photos.length)}>
          {busy ? '生成中…' : '重新生成'}
        </button>
      </div>
    </Sheet>
  );
}
