import React, { useLayoutEffect, useRef } from 'react';
import { Icon } from './bits.jsx';
import { newItem, CHECKLIST_MAX } from '../core/checklist.js';

/**
 * 代办输入：一条一行，写完回车当场开下一行并把光标送进去。
 * 原来是一个大 textarea 、一行一条 —— 写到第三条就得停下来看哪行是哪行，
 * 删一条得整行选中再删，容易连着上一行一起清掉。
 * 列表空着的时候也留一行空输入框：不用先点「再加一条」才能开始打字。
 */
/* 待聚焦的代办行号。必须待在这个组件外面，原因见下面 useLayoutEffect 那段注释。 */
let ckPendingFocus = null;

export default function ChecklistInput({ items, onChange }) {
  const refs = useRef([]);
  const list = items.length ? items : [newItem()];
  const atMax = list.length >= CHECKLIST_MAX;

  /*
   * 光标要落在刚插进来的那一行上，所以得等它真的进了 DOM。两个细节都不是随便写的：
   * 一、useLayoutEffect 而不是 useEffect —— 前者在提交期同步跑，跑在 ref 挂上之后、
   *   浏览器绘制之前；后者是异步的，等它跑起来屏幕上已经闪过一帧。一开始用
   *   requestAnimationFrame 等下一帧，焦点直接丢了，光标停在 body 上，接着打的字
   *   全进了黑洞。
   * 二、待聚焦的行号存在组件外面。这个组件一度被误写进了 NodeEditor 的函数体里，
   *   于是每次渲染都产生新的函数身份，React 判定「类型变了」把整棵子树重挂载，
   *   useRef 活不过那次重挂。定义已经搬回模块级，但变量放在外面不依赖这个前提——
   *   以后谁再不小心嵌套进来，也不会静默失效。
   */
  useLayoutEffect(() => {
    if (ckPendingFocus == null) return;
    const i = ckPendingFocus;
    ckPendingFocus = null;
    refs.current[i]?.focus();
  });
  const focusAt = (i) => {
    ckPendingFocus = i;
  };

  /*
   * 顺序要紧：先记下要聚焦哪一行，再触发重渲染。反过来的话 onChange 会在同步
   * flush 里先把上面的 layoutEffect 跑完（那时还没记下目标），等 focusAt 记完，
   * 又没有下一次渲染了 —— 焦点就永远送不出去。
   */
  const addAt = (i) => {
    if (list.length >= CHECKLIST_MAX) return;
    const next = [...list];
    next.splice(i + 1, 0, newItem());
    focusAt(i + 1);
    onChange(next);
  };

  const removeAt = (i) => {
    // 最后一条删空了就把光标放回原地，而不是只留一个不能打字的空壳
    if (list.length === 1) {
      focusAt(0);
      onChange([newItem()]);
      return;
    }
    focusAt(Math.max(0, i - 1));
    onChange(list.filter((_, k) => k !== i));
  };

  return (
    <div className="cklist">
      {list.map((it, i) => (
        <div className="cklist-row" key={it.id}>
          <span className="cklist-dot" />
          <input
            ref={(el) => { refs.current[i] = el; }}
            className="input cklist-input"
            value={it.text}
            placeholder={i === 0 ? '例如：充电宝放随身（不能托运）' : ''}
            onChange={(e) => {
              const next = [...list];
              next[i] = { ...it, text: e.target.value };
              onChange(next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!atMax) addAt(i);
              } else if (e.key === 'Backspace' && !it.text && list.length > 1) {
                // 空行上按退格就是「删掉这一行」，比框里没字却只能移动光标顺手
                e.preventDefault();
                removeAt(i);
              }
            }}
          />
          {list.length > 1 && (
            <button
              type="button"
              className="cklist-del"
              onClick={() => removeAt(i)}
              aria-label={`删掉第 ${i + 1} 条`}
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      ))}
      {atMax ? (
        // 服务端最多留 20 条（见 server/src/checklist.js），超了会被悄悄截掉，
        // 不如在这里把话说明白
        <div className="tiny dim">最多 {CHECKLIST_MAX} 条，删一条才能再加</div>
      ) : (
        <button type="button" className="cklist-add" onClick={() => addAt(list.length - 1)}>
          <Icon name="plus" size={12} /> 再加一条
        </button>
      )}
    </div>
  );
}
