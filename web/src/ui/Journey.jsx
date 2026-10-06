import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './useStore.js';
import { actions, askConfirm } from '../store/store.js';
import { computeNow, decorate } from '../core/timeline.js';
import { addDays } from '../core/format.js';
import Deck from './Deck.jsx';
import { computeBudget } from '../core/budget.js';
import { Icon } from './bits.jsx';
import NodeEditor from './NodeEditor.jsx';
import ExpenseEditor from './ExpenseEditor.jsx';
import BudgetEditor from './BudgetEditor.jsx';
import DaySection from './journey/DaySection.jsx';
import LooseList from './journey/LooseList.jsx';
import PhotoViewer from './journey/PhotoViewer.jsx';
import { useDragSort } from './useDragSort.js';

/**
 * 整个 App 就是这一页。
 *
 * 行程节点按时间从上到下排成一条线，日期只是插在流里的分隔标题，不再是 tab。
 * 照片和消费直接长在对应的那一项底下 —— 看到玉龙雪山，就在那儿拍一张、记一笔，
 * 不用跳去别的页面再想办法对上关系。
 */

/*
 * 顶部那块只放得下一条「前置」。正常库里也就一条（服务端收着），但老数据、
 * 离线队列重放都可能留下两条：所以只把真正上墙的那条从时间线上拿掉，多出来的
 * 那条老实留在行程里 —— 两条都藏起来等于凭空丢一条。
 */
function deckModule(nodes) {
  return nodes.find((n) => n.role === 'module') || null;
}

export default function Journey({ addNodeSignal, expenseSignal, onAdd, onOpenSettings }) {
  const state = useStore();
  const data = state.data;

  const [editing, setEditing] = useState(null); // {kind:'node'|'expense'|'budget', ...}
  const [viewer, setViewer] = useState(null);
  const [flash, setFlash] = useState(null); // 拖完之后的回执，飘在时间线顶上

  /* 长按拖动换位置。落位之后服务端会按新顺序把后面的时间整体顺延。 */
  const dnd = useDragSort({
    onDrop: async ({ nodeId, toDate, beforeNodeId }) => {
      try {
        const r = await actions.move({ nodeId, toDate, beforeNodeId });
        // 放回原位也是一种结果，说清楚比让用户猜「到底放没放进去」强
        if (r?.moved === false) setFlash('放回原来的位置了，没动');
        else if (r?.overflow) setFlash(`已插进去，后面 ${r.changed} 项顺延 · 这天装不下 ${r.overflow} 项`);
        else setFlash(`已插进去，后面 ${r.changed} 项自动顺延`);
      } catch (e) {
        if (e?.code === 'need_time') {
          const n = data?.nodes.find((x) => x.id === nodeId);
          setFlash(e.message);
          if (n) setEditing({ kind: 'node', node: n, focus: 'time' });
          return;
        }
        // 其它错误以前全被这里咽掉了：卡片弹回原位、屏幕上一个字都没有，
        // 看起来跟「怎么都放不下去」一模一样。至少给一句交代。
        setFlash(e?.message || '没放下去，稍后再试一次');
      }
    },
    onLiftBlocked: () => setFlash('得先落在两个东西中间才算数'),
    // 系统中途把手势收走了（抢去滚页面 / 长按弹了选词）。得说一声，
    // 否则用户只看到卡片弹回原位，会以为是自己没放对地方。
    onDropCanceled: () => setFlash('这一下被系统打断了，按住别动再拖一次'),
  });

  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), 3600);
    return () => clearTimeout(t);
  }, [flash]);

  const now = state.now;

  const view = useMemo(() => {
    if (!data) return null;
    const budget = computeBudget({ budgets: data.budgets, expenses: data.expenses });
    const clock = computeNow({ trip: data.trip, nodes: data.nodes, checkins: data.checkins }, now);

    const decorated = decorate(data.nodes, data.checkins);
    const photosByNode = new Map();
    for (const p of data.photos) {
      if (!p.node_id) continue;
      if (!photosByNode.has(p.node_id)) photosByNode.set(p.node_id, []);
      photosByNode.get(p.node_id).push(p);
    }
    const expensesByNode = new Map();
    for (const e of data.expenses) {
      if (!e.node_id) continue;
      if (!expensesByNode.has(e.node_id)) expensesByNode.set(e.node_id, []);
      expensesByNode.get(e.node_id).push(e);
    }

    /*
     * 日期 -> 当天的节点。空白日也保留，否则「第几天」会错位。
     * 打了「首页模块」标记的节点（前置准备）不在这里重复出现：顶部已经
     * 单独亮着一张卡，两边都显示反而像漏了同步。它要是占了某天全部内容，
     * 那天连日期头一起去掉——总不能留一个「9月30日」孤零零挂在那儿。
     */
    const shown = deckModule(data.nodes);
    const days = [];
    for (const d of clock.allDates) {
      const raw = clock.decoratedByDate.get(d) || [];
      const nodes = raw.filter((n) => n.id !== shown?.id);
      if (raw.length > 0 && nodes.length === 0) continue;
      days.push({ date: d, nodes });
    }

    const loosePhotos = data.photos.filter((p) => !p.node_id);
    const looseExpenses = data.expenses.filter((e) => !e.node_id);

    return { budget, clock, days, photosByNode, expensesByNode, loosePhotos, looseExpenses };
  }, [data, now]);

/*
* 打开就落在「现在这格」。
*
* 以前每次打开都停在最上面，第一眼全是已经过去的事 —— 行程走到两三天以后，得
* 自己先划半屏才看得到现在该干什么。锚点用 .tl-item.is-now：时间线上「现在
* 该做的那项」，跟顶部那张卡是同一个口径，两边焦点不会打架。落点贴着常驻块下沿
* 留 10px 缝，不让它滑到顶栏后面去。没有这一格（行程还没完但今天都做完了、或
* 已结束）就不动，留在顶部。
*
* 只在数据第一次就位时跳一次。SSE 每来一轮就重跑的话，用户正看着别处会被
* 反复拽回去。浏览器自己记住的滚动位置（页面中间刷新）也让它别插手。
*/
const jumped = useRef(false);
useEffect(() => {
if (!view || jumped.current) return undefined;
jumped.current = true;
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const raf = requestAnimationFrame(() => {
const target = document.querySelector('.tl-item.is-now');
if (!target) return;
const hudH = document.querySelector('.hud')?.offsetHeight || 0;
const top = target.getBoundingClientRect().top + window.scrollY - hudH - 10;
window.scrollTo({ top: Math.max(0, Math.round(top)), behavior: 'auto' });
});
return () => cancelAnimationFrame(raf);
}, [view]);

  /*
   * 顶部那个 + 里点了「加一项」——新的一项落在哪儿：
   *今天就在行程里就填今天；已经过去了或者还没到，就接在最后一项后面。
   * 以前不管哪种情况都往回找第一天，加第 5 项时日期会突然跳回出发那天。
   */
  useEffect(() => {
    if (!addNodeSignal || !view || !data) return;
    let target = null;
    if (view.clock.allDates.includes(view.clock.today)) {
      target = view.clock.today;
    } else {
      const last = data.nodes.reduce((acc, n) => (!acc || n.date > acc ? n.date : acc), null);
      target = last ? addDays(last, 1) : data.trip?.start_date;
    }
    if (target) setEditing({ kind: 'node', date: target });
  }, [addNodeSignal]); // eslint-disable-line react-hooks/exhaustive-deps

// 主屏快捷方式「记一笔」：直接开记账面板。expenses.node_id 可空，
// 所以不挂任何一项也能记（进去后在「挂在」里选或者留空）。
useEffect(() => {
if (!expenseSignal) return;
setEditing({ kind: 'expense' });
}, [expenseSignal]);

  if (!data || !view) {
    return (
      <div className="page">
        <div className="stack">
          <div className="skeleton" />
          <div className="skeleton" style={{ height: 80 }} />
        </div>
      </div>
    );
  }

  const { trip, vocab, members, me } = data;
  const { budget, clock, days, photosByNode, expensesByNode, loosePhotos, looseExpenses } = view;

  const totalNodes = data.nodes.length;
  const doneNodes = data.nodes.filter((n) => n.status === 'done').length;

  // 打了「首页模块」标记的节点（目前是「前置准备」）：只进顶部那块常驻的 Deck，
  // 时间线上不再显示（见下面的 days 过滤）。
  const modules = deckModule(data.nodes);
  return (
    <>
      {/*
       * 顶栏和下面那块「现在 / 前置 / 钱」合成一个常驻的 HUD，一起 sticky。
       * 出发前最该盯的两件事（现在在干嘛、还有什么没办）不该滚出屏幕。
       */}
      <div className="hud">
        <header className="topbar">
          <div className="grow">
            <h1 className="truncate">{trip.name}</h1>
            <div className="sub truncate">
              {trip.destination} · {doneNodes}/{totalNodes} 已完成
              <span className={`dot-live${state.live ? ' on' : ''}`} />
              {!state.online && ' · 离线'}
            </div>
          </div>
          <button className="icon-btn accent" onClick={onAdd} aria-label="加一笔">
            <Icon name="plus" size={18} />
          </button>
          <button className="icon-btn" onClick={onOpenSettings} aria-label="设置">
            <Icon name="sliders" size={17} />
          </button>
        </header>

        <Deck
          clock={clock}
          vocab={vocab}
          budget={budget}
          members={members}
          me={me}
          modules={modules ? [modules] : []}
          onEditModule={(m) => setEditing({ kind: 'node', node: m })}
          onEditBudget={() => setEditing({ kind: 'budget' })}
        />
      </div>

      <div className="page">
        <div className="timeline">
          {flash && <div className="flashbar">{flash}</div>}
          {days.map((d) => (
            <DaySection
              key={d.date}
              date={d.date}
              nodes={d.nodes}
              now={now}
              clock={clock}
              vocab={vocab}
              photosByNode={photosByNode}
              expensesByNode={expensesByNode}
              dnd={dnd}
              onEditNode={(n) => setEditing({ kind: 'node', node: n })}
              onAddNode={() => setEditing({ kind: 'node', date: d.date })}
              onEditExpense={(e) => setEditing({ kind: 'expense', expense: e })}
              onAddExpense={(node) => setEditing({ kind: 'expense', node })}
              onViewPhoto={setViewer}
            />
          ))}
        </div>

        {(loosePhotos.length > 0 || looseExpenses.length > 0) && (
          <>
            <div className="section-title">随手记</div>
            <p className="tiny dim" style={{ margin: '-4px 2px 8px' }}>
              这些还没挂到具体某一项上。点一下就能归位。
            </p>
            <LooseList
              photos={loosePhotos}
              expenses={looseExpenses}
              vocab={vocab}
              nodes={data.nodes}
              onViewPhoto={setViewer}
              onEditExpense={(e) => setEditing({ kind: 'expense', expense: e })}
            />
          </>
        )}

        <div style={{ height: 40 }} />
      </div>

      {editing?.kind === 'node' && (
        <NodeEditor
          draft={editing}
          vocab={vocab}
          dates={clock.allDates}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (editing.node) await actions.patchNode(editing.node.id, payload);
            else await actions.createNode(payload);
            setEditing(null);
          }}
          onDelete={
            editing.node
              ? async () => {
                  if (await askConfirm(`删除「${editing.node.title}」？`, { danger: true, confirmText: '删除' })) {
                    await actions.deleteNode(editing.node.id);
                    setEditing(null);
                  }
                }
              : null
          }
        />
      )}

      {editing?.kind === 'expense' && (
        <ExpenseEditor
          draft={editing}
          vocab={vocab}
          members={members}
          me={me}
          nodes={data.nodes}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            if (editing.expense) await actions.patchExpense(editing.expense.id, payload);
            else await actions.addExpense(payload);
            setEditing(null);
          }}
          onDelete={
            editing.expense
              ? async () => {
                  if (await askConfirm('删掉这笔？', { danger: true, confirmText: '删除' })) {
                    await actions.deleteExpense(editing.expense.id);
                    setEditing(null);
                  }
                }
              : null
          }
        />
      )}

      {editing?.kind === 'budget' && (
        <BudgetEditor
          budgets={data.budgets}
          onClose={() => setEditing(null)}
        />
      )}

      {viewer && <PhotoViewer photo={viewer} photos={data.photos} onClose={() => setViewer(null)} onEdit={setViewer} />}
    </>
  );
}

