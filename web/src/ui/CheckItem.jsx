import React, { useState } from 'react';
import { Icon } from './bits.jsx';

/**
 * 一条可勾选的待办。时间线卡片和首页的「前置准备」模块共用这一个。
 *
 * 勾完先本地生效，等服务端确认（或者失败）完再落回服务端的状态：
 * 弱网下点下去立刻有反馈，失败了自己也会退回真相，不用一直盯着转圈。
 */
export default function CheckItem({ item, onToggle }) {
  const [pending, setPending] = useState(null);
  const done = pending ?? item.done;

  const toggle = (e) => {
    e.stopPropagation();
    const next = !done;
    setPending(next);
    Promise.resolve(onToggle(next))
      .catch(() => {})
      .finally(() => setPending(null));
  };

  return (
    <button className={`tl-check${done ? ' on' : ''}`} onClick={toggle} aria-pressed={done}>
      <span className="box">{done && <Icon name="check" size={10} />}</span>
      <span className="truncate">{item.text}</span>
    </button>
  );
}
