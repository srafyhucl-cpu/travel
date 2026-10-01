/**
 * 时间线长按拖拽排序。
 *
 * 手势：按住卡片不动约 0.3 秒就「捏起来」，跟着手指走，松开落到某两张卡中间。
 * 不是交换 —— 落位以后由服务端按它自己的时长把后面的整体往后推。
 *
 * 用 Pointer Events 手写而不是 HTML5 拖放：手机上 HTML5 拖放基本不可用，
 * 而且我们需要在拖的过程中实时判断「现在悬在哪个空位上」。
 *
 * 两份状态，分工别搞混：
 *   pending —— 手指还按着、还没到长按判定的那一下
 *   active  —— 已经捏起来了，正在拖
 * 交接点是长按计时器触发的那一刻。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const HOLD_MS = 300;   // 按住多久算捏起来
const SLOP = 8;         // 抖动容忍：按住后移动超过这个距离就是想滚动列表
const EDGE = 76;        // 距屏幕上下这个距离开始自动滚动
const EDGE_SPEED = 13;  // 自动滚动每帧的像素

/** 拖起来的那张卡，直接改它的 transform，不走 React 渲染 */
function ghost() {
  return document.querySelector('.tl-item.dragging');
}

/**
 * 落点判定：不再要求手指正好压在那条 26px 的缝上。
 *
 * 原来靠 elementFromPoint 找「脚下那块地是谁」，手机上等于让手指钻针眼：
 * 卡片有七八十像素高，缝只有 26px，空位左边还让开了时间列（手指最自然
 * 就落在那儿），于是看着能放、一松手就弹回来。
 *
 * 改成拿「被拖这张卡的中心」去找最近的空位。卡片一直粘在手指上、位置一直
 * 露在屏幕上，最近的那条缝就是眼睛看到的那条；选中哪条会提前高亮，
 * 落点在松手之前就定死了，不靠最后那一瞬间的精度。
 */
function nearestSlot(cy) {
  /*
   * 只认 data-drop-date，不挑 .live —— 空位平时高度是 0，位置正好落在两张卡
   * 之间，捏起来变高只是把它撑开，中心线并没有挪。所以两种状态下算出来的落点
   * 是同一个；但不挑 .live 就不用等那次重渲染把 class 挂上，真机上偶尔会差那么
   * 一两帧，那会儿查不到空位，落点就整个丢了，表现正是「怎么都放不下去」。
   */
  const slots = document.querySelectorAll('.dropslot[data-drop-date]');
  let best = null;
  let bestD = Infinity;
  for (const s of slots) {
    const r = s.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (!best) return null;
  return { date: best.dataset.dropDate, beforeId: best.dataset.dropBefore || null };
}

export function useDragSort({ onDrop, onLiftBlocked, onDropCanceled }) {
  const [dragId, setDragId] = useState(null);
  const [target, setTarget] = useState(null); // { date, beforeId }

  const pending = useRef(null);
  const active = useRef(null);
  const draggedAt = useRef(0); // 刚刚拖完的时间，用来吃掉紧随其后的那次点击
  const raf = useRef(0);
  const targetRef = useRef(null);
  targetRef.current = target;

  // 挂载期只跑一次的 touch 兜底监听要用到 apply / finish，放 ref 里跟着渲染更新
  const applyRef = useRef(null);
  const finishRef = useRef(null);

  // 落位要用的回调每次渲染都是新的，包一层让下面的 useCallback 拿到稳定的引用
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onBlockedRef = useRef(onLiftBlocked);
  onBlockedRef.current = onLiftBlocked;
  const onCancelRef = useRef(onDropCanceled);
  onCancelRef.current = onDropCanceled;

  const stopScroll = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  /**
   * 按当前手指位置刷新两件事：卡片跟手跑到哪、该落在哪条缝。
   * 手指移动、自动滚动、松手前三件事都走它，保证高亮和落点永远是同一套算法。
   */
  const apply = useCallback(() => {
    const a = active.current;
    if (!a) return;
    // 整段手势里离出发点最远过多少 —— 用来分辨「压根没想拖」和「拖出去又拖回来」
    a.far = Math.max(a.far, Math.abs(a.x - a.x0), Math.abs(a.y - a.y0));
    // 自动滚动时页面在动，把滚动的量扣掉，卡片才能一直粘在手指底下
    const dy = a.y - a.y0 - (window.scrollY - a.scrollY0);
    const el = ghost();
    if (el) {
      el.style.transform = `translate3d(${a.x - a.x0}px, ${dy}px, 0) scale(1.025)`;
    }
    const t = nearestSlot(a.cy0 + dy);
    /*
     * 查不到空位时保留上一个落点，别拿 null 把它抹掉。手指停在原地、页面自己
     * 滚了一小段、或者重渲染正好卡在中间，都会瞬时查不到；一抹掉，用户看到的
     * 蓝线就消失了，松手也只剩一句「得先落在两个东西中间才算数」。
     */
    if (t) {
      const cur = targetRef.current;
      if (t.date !== cur?.date || t.beforeId !== cur?.beforeId) {
        targetRef.current = t;
        setTarget(t);
      }
    }
  }, []);

  const tick = useCallback(() => {
    const a = active.current;
    if (!a) return;
    const h = window.innerHeight;
    let dy = 0;
    if (a.y < EDGE) dy = -EDGE_SPEED * Math.min(1, (EDGE - a.y) / EDGE);
    else if (a.y > h - EDGE) dy = EDGE_SPEED * Math.min(1, (a.y - (h - EDGE)) / EDGE);
    if (!dy) {
      raf.current = 0;
      return;
    }
    const before = window.scrollY;
    window.scrollBy(0, dy);
    // 页面滚了，手指底下的空位也就换了人，高亮必须跟着重算，
    // 不然手指停住不动的那一秒里，松手会落在早就滚走的位置上
    apply();
    // 滚到底了就不攒帧了，空转没有意义
    raf.current = window.scrollY !== before ? requestAnimationFrame(tick) : 0;
  }, []);

  /** 结束拖拽。commit=false 是中途取消（Esc、手指被打断）。 */
  const finish = useCallback(
    (commit) => {
      const a = active.current;
      active.current = null;
      stopScroll();
      const el = ghost();
      if (el) el.style.transform = '';
      document.body.classList.remove('is-dragging');
      setDragId(null);
      setTarget(null);
      if (!a) return;

      draggedAt.current = Date.now();
      /*
       * 手势里最远也没离开出发点 10px，那就不是拖，是长按着看了看。空位对称地卡在
       * 卡片上下两侧，一毫米不动的话最近的那条缝恰好是「上面那条」，不挡一下就会
       * 变成「长按一下 = 往上挪一位」。
       *
       * 用最远距离而不是松手位置：拖出去又拖回来是确实拖了，该给一句交代。
       */
      if (a.far < 10) return;
      /*
       * 关键在这：commit 不作废落点。
       *
       * iOS 在松手那一下有概率不送 pointerup，改送 pointercancel / touchcancel，
       * 拖到屏幕上下边缘、我们自己在自动滚页的时候尤其容易发生。系统一收走，
       * 从前这里是 finish(false) 全部丢掉：卡片已经跟着手指走到某条缝上、蓝线
       * 也亮着，用户抬手的意图明明白白，结果松手什么都没发生 —— 手机上「拖得动
       * 却放不下」就是这么来的。
       *
       * 现在只要真有落点就照样插进去。卡片停在哪儿用户看得见，插错了再拖回来
       * 就行，比什么都换不来强。真的一个落点都没有（列表一条缝都没铺开）才当
       * 取消，给一句交代。
       */
      const t = targetRef.current;
      if (t) onDropRef.current?.({ nodeId: a.id, toDate: t.date, beforeNodeId: t.beforeId });
      else if (commit) onBlockedRef.current?.(a.id);
      else onCancelRef.current?.(a.id);
    },
    [stopScroll],
  );

  applyRef.current = apply;
  finishRef.current = finish;

  // 拖起来之后，指针事件统一收到 window 上，卡片本身怎么动都不影响
  useEffect(() => {
    if (!dragId) return undefined;

    const move = (e) => {
      const a = active.current;
      if (!a) return;
      a.x = e.clientX;
      a.y = e.clientY;
      apply();
      stopScroll();
      raf.current = requestAnimationFrame(tick);
    };
    const up = (e) => {
      // 最后按松手的位置定一次落点：手指停住不动的那一两秒里页面可能还在滚，
      // 上一帧算出来的高亮早过期了，不重算就会落在早就滚走的位置上
      if (active.current && Number.isFinite(e.clientX)) {
        active.current.x = e.clientX;
        active.current.y = e.clientY;
        apply();
      }
      finish(true);
    };
    // 系统把这一段手势收走了 —— 落点在不在由 finish 自己判断，别在这儿替它决定
    const cancel = () => finish(false);
    const key = (e) => e.key === 'Escape' && finish(false);

    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [dragId, apply, finish, tick, stopScroll]);

  /*
   * touchmove 从组件挂上那一刻就一直挂着，而且必须非 passive —— 不能等「捏起来了」才补。
   *
   * 这一条是「拖得动、却放不下」的真正原因。触摸序列一开始，浏览器就决定了这根手指
   * 归谁管；iOS 上在这之后才补挂的 touchmove，preventDefault() 会被直接忽略。
   * 于是页面照滑，手指一动系统就发 pointercancel 把整段手势收走：卡还跟着手指跑
   *（pointermove 一直在来），松手却什么都不发生。模拟器里测不出来，只有真机会这样。
   *
   * 没在拖的时候不 preventDefault，列表照常上下滑。
   */
  useEffect(() => {
    const hold = (e) => {
      if (active.current) e.preventDefault();
    };
    /*
     * 松手那一侧的兜底。真机上只要 pointerup 没送到（被系统收走、或压根没发），
     * 至少还有 touch 事件能接住 —— 不至于跟了一路、松手什么也没发生。
     * 三条路径（pointerup / touchend / pointercancel）都收敛到同一个 finish()，
     * 它开头就把 active 清空，所以哪怕 pointerup 和 touchend 都来了，
     * 第二个也只会扑个空，不会放两次。
     */
    const endByTouch = (e) => {
      const a = active.current;
      if (!a) return;
      const t = e.changedTouches && e.changedTouches[0];
      if (t && Number.isFinite(t.clientX)) {
        a.x = t.clientX;
        a.y = t.clientY;
        applyRef.current();
      }
      finishRef.current(true);
    };
    // 系统把这一段手势收走了 —— 同样交给 finish：有落点就照样插进去
    const cancelByTouch = () => finishRef.current(false);

    window.addEventListener('touchmove', hold, { passive: false });
    window.addEventListener('touchend', endByTouch);
    window.addEventListener('touchcancel', cancelByTouch);
    return () => {
      window.removeEventListener('touchmove', hold);
      window.removeEventListener('touchend', endByTouch);
      window.removeEventListener('touchcancel', cancelByTouch);
    };
  }, []);

  /** 挂在卡片上的 pointerdown。长按判定和拖拽都从这里起头。 */
  const holdProps = useCallback(
    (node) => ({
      onPointerDown: (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // 按钮、输入框这些自己就有手势，别抢
        if (e.target.closest('button, a, input, textarea, select, label')) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const s = {
          id: node.id,
          el: e.currentTarget,
          top0: rect.top,
          cy0: rect.top + rect.height / 2, // 卡片中心：落点就看它离哪条缝最近
          x: e.clientX,
          y: e.clientY,
          x0: e.clientX,
          y0: e.clientY,
          far: 0, // 这一手势离出发点最远过的距离
          scrollY0: window.scrollY,
        };
        pending.current = s;

        s.timer = setTimeout(() => {
          if (pending.current !== s) return; // 已经抬手或者已经判定成滑动了
          pending.current = null;
          active.current = s;
          document.body.classList.add('is-dragging');
          setDragId(node.id);
          /*
           * 所有空位是同时张开的，卡片在流里被顶下去一截。
           * 把这个位移补进原点，它就还是牢牢粘在手指底下，不会飘。
           */
          requestAnimationFrame(() => {
            if (active.current !== s) return;
            const shift = s.el.getBoundingClientRect().top - s.top0;
            s.y0 += shift;
            s.cy0 += shift;
            s.scrollY0 = window.scrollY;
            s.el.style.transform = 'scale(1.025)';
          });
          if (navigator.vibrate) navigator.vibrate(8);
        }, HOLD_MS);
      },

      onPointerMove: (e) => {
        const s = pending.current;
        if (!s) return;
        if (Math.abs(e.clientX - s.x) > SLOP || Math.abs(e.clientY - s.y) > SLOP) {
          clearTimeout(s.timer); // 原来是想滚动列表，不是想拖
          pending.current = null;
        }
      },

      onPointerUp: () => {
        const s = pending.current;
        if (s) clearTimeout(s.timer);
        pending.current = null;
      },

      onPointerCancel: () => {
        const s = pending.current;
        if (s) clearTimeout(s.timer);
        pending.current = null;
      },

      // 安卓长按会弹「全选 / 复制 / 翻译」那套菜单，直接掐掉
      onContextMenu: (e) => e.preventDefault(),
      // 卡片里的 <img> 会被浏览器当成可拖对象，长按还能弹系统的图片菜单，一并掐掉
      onDragStart: (e) => e.preventDefault(),
/*
* 光靠 CSS 的 user-select: none 不够稳：部分安卓机长按文字仍然会起选词，
* 一旦选中文字就抢走了手势，这次长按判定直接失效。再掐一道。
*/
onSelectStart: (e) => e.preventDefault(),

      // 松手那一下浏览器还会补一个 click，吃掉它，不然编辑弹层自己就开了
      onClickCapture: (e) => {
        if (Date.now() - draggedAt.current < 400) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    }),
    [],
  );

return { dragId, target, holdProps };
}
