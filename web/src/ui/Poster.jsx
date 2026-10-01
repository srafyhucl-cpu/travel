import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './useStore.js';
import { toast } from '../store/store.js';
import { photoUrl } from '../store/api.js';
import { TEMPLATES, ACCENTS, renderPoster, savePoster, canvasToBlob } from '../core/vlog.js';
import { formatDate, formatMoney } from '../core/format.js';
import { computeBudget } from '../core/budget.js';
import { Icon, Sheet, Field, Input } from './bits.jsx';

/** 把这趟旅行的照片排成一张能发朋友圈的图。 */
export default function Poster({ photos, trip, onClose }) {
  const state = useStore();
  const data = state.data;
  const canvasRef = useRef(null);
  const [template, setTemplate] = useState('classic');
  const [accent, setAccent] = useState(ACCENTS[0]);
  const [title, setTitle] = useState(trip?.name || '旅行记录');
  const [subtitle, setSubtitle] = useState(trip?.destination || '');
  const [count, setCount] = useState(4);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  const stats = useMemo(() => {
    if (!data) return [];
    const t = data.trip;
    const days = Math.max(1, Math.round((new Date(t.end_date) - new Date(t.start_date)) / 86400000) + 1);
    const b = computeBudget({ budgets: data.budgets, expenses: data.expenses, members: data.members });
    return [
      { label: '天数', value: `${days} 天` },
      { label: '消费', value: `¥${formatMoney(b.actualTotal)}` },
      { label: '照片', value: `${photos.length} 张` },
    ];
  }, [data, photos.length]);

  const chosen = photos.slice(0, count);

  async function generate() {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const srcs = [];
      for (const p of chosen) {
        const u = await photoUrl(p.id);
        if (u) srcs.push(u);
      }
      const canvas = await renderPoster({
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
      const blob = await canvasToBlob(canvas);
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
      canvasRef.current = canvas;
    } catch (e) {
      toast('出图失败：' + (e?.message || '未知错误'), 'error');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, accent, count, photos.length]);

  return (
    <Sheet title="生成 vlog 图" onClose={onClose}>
      <div className="stack">
        {!photos.length && <div className="tiny dim">还没有照片，先在时间线上传几张。</div>}

        <div className="pill-row">
          {TEMPLATES.map((t) => (
            <button key={t.id} className={`pill${template === t.id ? ' on' : ''}`} onClick={() => setTemplate(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
        <div className="tiny dim">{TEMPLATES.find((t) => t.id === template)?.hint}</div>

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

        {preview ? (
          <>
            <img src={preview} alt="vlog 预览" className="vlog-preview" />
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await savePoster(canvasRef.current, `vlog-${trip?.start_date || 'trip'}.png`);
                  toast('已保存到手机相册', 'success');
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

        <button className="btn" onClick={generate} disabled={busy || !photos.length}>
          {busy ? '生成中…' : '重新生成'}
        </button>
      </div>
    </Sheet>
  );
}
