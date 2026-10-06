import React from 'react';
import { formatDate, relativeDay } from '../../core/format.js';
import { Icon } from '../bits.jsx';
import NodeCard from './NodeCard.jsx';

/** 一天：日期分隔头 + 当天的卡片 + 卡间/末尾的拖拽空位 */
export default function DaySection({
  date, nodes, now, clock, vocab, photosByNode, expensesByNode, dnd,
  onEditNode, onAddNode, onEditExpense, onAddExpense, onViewPhoto,
}) {
  const done = nodes.filter((n) => n.isDone).length;
  const isToday = date === clock.today;
  const dragId = dnd.dragId;
  const isTarget = (beforeId) => dnd.target && dnd.target.date === date && dnd.target.beforeId === beforeId;

  // 卡片之间以及当天末尾各留一个空位。拖动的时候空位变高、亮起来，抬手指哪儿就落在哪儿。
  // 落位不靠空位自己收事件（触摸时指针被浏览器隐式捕获，空位收不到，详见 useDragSort），
  // 这里只负责把「哪天的哪个空位」写在 data 上，拖起来以后按手指坐标读回去。
  const slot = (beforeId) => (
    <div
      key={`slot-${beforeId || 'end'}`}
      className={`dropslot${isTarget(beforeId) ? ' on' : ''}${dragId ? ' live' : ''}`}
      data-drop-date={date}
      data-drop-before={beforeId || ''}
    />
  );

  return (
    <>
      <div className={`daymark${isToday ? ' now' : ''}`} onClick={onAddNode}>
        <span className="dm-date">{formatDate(date)}</span>
        <span className="dm-rel">{relativeDay(date, now)}</span>
        <span className="dm-line" />
        <span className="tiny dim mono-num">
          {done}/{nodes.length}
        </span>
        <button
          className="dm-add"
          onClick={(e) => {
            e.stopPropagation();
            onAddNode();
          }}
          aria-label={`给 ${formatDate(date)} 加一项`}
        >
          <Icon name="plus" size={11} />
        </button>
      </div>
      {nodes.length === 0 ? (
        <button className="dayempty" onClick={onAddNode}>
          <Icon name="plus" size={13} /> 这天还没安排
        </button>
      ) : (
        nodes.map((n, i) => (
          <React.Fragment key={n.id}>
            {slot(n.id)}
            <NodeCard
              node={n}
              prev={nodes[i - 1]}
              clock={clock}
              vocab={vocab}
              photos={photosByNode.get(n.id) || []}
              expenses={expensesByNode.get(n.id) || []}
              dragging={dragId === n.id}
              {...dnd.holdProps(n)}
              onEdit={() => onEditNode(n)}
              onAddExpense={() => onAddExpense(n)}
              onEditExpense={onEditExpense}
              onViewPhoto={onViewPhoto}
            />
          </React.Fragment>
        ))
      )}
      {slot(null)}
    </>
  );
}
