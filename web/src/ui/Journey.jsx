import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './useStore.js';
import { actions } from '../store/store.js';
import { photoUrl, forgetPhotoUrl } from '../store/api.js';
import { computeNow, nodeState, decorate } from '../core/timeline.js';
import {
  formatDate, relativeDay, typeMeta, categoryMeta, humanizeDuration, formatMoney, addDays,
} from '../core/format.js';
import { openAmap } from '../core/nav.js';
import CheckItem from './CheckItem.jsx';
import Deck from './Deck.jsx';
import { computeBudget } from '../core/budget.js';
import { Icon, Glyph } from './bits.jsx';
import NodeEditor from './NodeEditor.jsx';
import ExpenseEditor from './ExpenseEditor.jsx';
import BudgetEditor from './BudgetEditor.jsx';
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
                  if (confirm(`删除「${editing.node.title}」？`)) {
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
                  if (confirm('删掉这笔？')) {
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

/* ------------------------------ 时间线 ------------------------------ */

function DaySection({
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

function NodeCard({ node, prev, clock, vocab, photos, expenses, dragging, onEdit, onAddExpense, onEditExpense, onViewPhoto, ...hold }) {
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
      const fd = new FormData();
      for (const f of files) fd.append('photos', f);
      fd.append('nodeId', node.id);
      await actions.uploadPhotos(fd);
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
                onClick={() => openAmap(node.navKeyword, '')}
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


function Shot({ photo, onClick }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    photoUrl(photo.id)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [photo.id]);

  return (
    <button className="shot" onClick={onClick}>
      {url ? <img src={url} alt={photo.caption || ''} loading="lazy" /> : <span className="shot-skel" />}
      {photo.caption && <span className="shot-cap">{photo.caption}</span>}
    </button>
  );
}

function LooseList({ photos, expenses, vocab, nodes, onViewPhoto, onEditExpense }) {
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

/* ------------------------------ 照片查看 ------------------------------ */

function PhotoViewer({ photo, photos, onClose, onEdit }) {
  const [caption, setCaption] = useState(photo.caption || '');
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const idx = photos.findIndex((p) => p.id === photo.id);

  useEffect(() => {
    let alive = true;
    photoUrl(photo.id)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
      forgetPhotoUrl(photo.id);
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
            if (!confirm('删掉这张照片？')) return;
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
