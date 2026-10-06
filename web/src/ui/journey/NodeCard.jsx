import React, { useRef, useState } from 'react';
import { platform } from '../../platform/index.js';
import { actions } from '../../store/store.js';
import { typeMeta, categoryMeta, formatMoney } from '../../core/format.js';
import { nodeState } from '../../core/timeline.js';
import { Icon, Glyph } from '../bits.jsx';
import CheckItem from '../CheckItem.jsx';
import Shot from './Shot.jsx';

/** 时间线上的一张行程卡：状态色、勾选、账、照片、操作按钮都在这里 */
export default function NodeCard({ node, prev, clock, vocab, photos, expenses, dragging, onEdit, onAddExpense, onEditExpense, onViewPhoto, ...hold }) {
  const meta = typeMeta(vocab, node.type);
  // 标题里已经带了地点的，meta 里就不用再报一遍 —— 省一行，也少一处重复
  const locInTitle = !!node.location && node.title.includes(node.location);
  const st = nodeState(node, clock);
  /*
   * 「现在该做的那件事」用哪个，得跟顶部那张「现在」卡一致，否则视觉焦点会对不上。
   * 顶部在没有进行中节点时说的是「下一个」，所以这里也得把 nextNode 算进来。
   */
  const isNow = st === 'current' || (st === 'upcoming' && clock.nextNode?.id === node.id);
  /*
   * 圆点用类型色而不是统一灰：航班、住宿、餐饮在时间轴上一眼能分出段落，
   * 而不是一片同样的小圆圈。
   * 优先级：「现在该做的那项」> 做完 > 类型。前两个是状态，类型只是背景信息，
   * 状态变了就该让位。
   * （这几个颜色得在 JS 里算：inline style 优先级比 .is-now 高，放 CSS 里会被它盖住，
   *   .is-now 就永远不亮了。）
   */
  const dotColor = isNow ? 'var(--accent)' : st === 'done' ? 'var(--ok)' : meta.color;
  const spent = expenses.reduce((s, e) => s + (+e.amount || 0), 0);
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  async function pickPhotos(ev) {
    const files = [...(ev.target.files || [])];
    ev.target.value = '';
    if (!files.length) return;
    setUploading(true);
    try {
      await actions.uploadPhotos({
        files: files.map((f) => ({ name: f.name, file: f })),
        fields: { nodeId: node.id },
      });
    } catch {
      /* store 弹过了 */
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={`tl-item${isNow ? ' is-now' : ''}${dragging ? ' dragging' : ''}`} {...hold}>
      <div className="tl-rail">
        <div className="tl-time">{node.start_time || '—'}</div>
      </div>

      <div className="tl-line">
        <span
          className={`tl-dot s-${st}`}
          style={{ borderColor: dotColor, background: dotColor }}
        />

        {/* 左侧那道彩色竖条是卡片类型的主标识。做完的整张退成灰色，不跟现在项抢 */}
        <div className={`tl-card s-${st}`} style={{ '--tc': st === 'done' ? 'var(--line-strong)' : meta.color }}>
          <div className="tl-head" onClick={onEdit} role="button">
            <span className="tl-ic" style={{ background: meta.soft, color: meta.color }}>
              <Glyph icon={meta.icon} size={12} />
            </span>
            <div className="grow">
              <div className="tl-title">{node.title}</div>
              <div className="tl-meta">
                <span style={{ color: meta.color }}>{meta.label}</span>
                {node.end_time && <span className="mono-num">{node.start_time}–{node.end_time}</span>}
                {node.location && !locInTitle && <span className="tl-loc">{node.location}</span>}
              </div>
            </div>
            {spent > 0 && <span className="tl-spend mono-num">{formatMoney(spent)}</span>}
          </div>

          {node.checklist?.length > 0 && (
            <div className="tl-checks">
              {node.checklist.map((c, i) => (
                <CheckItem
                  key={c.id}
                  item={c}
                  onToggle={(d) => actions.setChecklistItem(node.id, c.id, d, c.text)}
                />
              ))}
            </div>
          )}

          {expenses.length > 0 && (
            <div className="tl-money">
              {expenses.map((e) => {
                const cm = categoryMeta(vocab, e.category);
                return (
                  <button key={e.id} className="mrow" onClick={() => onEditExpense(e)}>
                    <span className="mrow-ic" style={{ background: cm.soft, color: cm.color }}>
                      <Glyph icon={cm.icon} size={12} />
                    </span>
                    <span className="grow truncate">{e.note || cm.label}</span>
                    <span className="mono-num strong">{formatMoney(e.amount)}</span>
                  </button>
                );
              })}
            </div>
          )}

          {photos.length > 0 && (
            <div className="tl-shots">
              {photos.map((p) => (
                <Shot key={p.id} photo={p} onClick={() => onViewPhoto(p)} />
              ))}
            </div>
          )}

          <div className="tl-acts">
            {/*
             * 车程原来自己占一整行。它不是命令，是一句交代，跟下面那排按钮归为
             * 同一类「这张卡的附注」，收进同一行 —— 16 张卡各省一行，这一屏就多出
             * 整整一张卡的高度。
             */}
            {!node.isDone && node.transport_minutes > 0 && prev && (
              <span className="drive-hint">
                <Icon name="car" size={11} /> 约 {node.transport_minutes} 分钟车程
              </span>
            )}
            {!node.isDone && !node.isStarted && (
              <button className="chip-btn primary" onClick={() => actions.checkin(node.id, 'departed')}>
                出发
              </button>
            )}
            {!node.isDone && node.isStarted && (
              <button className="chip-btn ok" onClick={() => actions.checkin(node.id, 'done')}>
                <Icon name="check" size={12} /> 完成
              </button>
            )}
            {node.isDone && (
              <span className="chip-btn ok static">
                <Icon name="check" size={12} />
                {node.actual_end ? new Date(node.actual_end).toTimeString().slice(0, 5) : '已完成'}
              </span>
            )}
            {/* 照片/记账/导航 收成纯图标。文字标签每张卡多占一截，16 张叠起来很可观 */}
            <button
              className="chip-btn icon-only"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              aria-label="加照片"
              title={uploading ? '上传中' : '加照片'}
            >
              <Icon name="camera" size={13} />
            </button>
            <button className="chip-btn icon-only" onClick={onAddExpense} aria-label="记一笔" title="记一笔">
              <Icon name="wallet" size={13} />
            </button>
            {node.navKeyword && (
              <button
                className="chip-btn icon-only"
                onClick={() => platform.services.openMap(node.navKeyword)}
                aria-label="导航过去"
                title="导航过去"
              >
                <Icon name="pin" size={13} />
              </button>
            )}
            <button className="chip-btn icon-only" onClick={onEdit} aria-label="编辑">
              <Icon name="edit" size={12} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/gif"
              multiple
              onChange={pickPhotos}
              style={{ display: 'none' }}
            />
          </div>
        </div>
      </div>

    </div>
  );
}
