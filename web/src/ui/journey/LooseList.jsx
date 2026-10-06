import React from 'react';
import { categoryMeta, formatMoney } from '../../core/format.js';
import { Glyph } from '../bits.jsx';
import Shot from './Shot.jsx';

/** 「随手记」：没挂到具体行程上的消费和照片 */
export default function LooseList({ photos, expenses, vocab, nodes, onViewPhoto, onEditExpense }) {
  return (
    <div className="card-flat">
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
      {photos.map((p) => (
        <div key={p.id} className="mrow">
          <Shot photo={p} onClick={() => onViewPhoto(p)} />
        </div>
      ))}
    </div>
  );
}
