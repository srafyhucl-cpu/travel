import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './useStore.js';
import { actions, toast } from '../store/store.js';
import { photoUrl, forgetPhotoUrl } from '../store/api.js';
import { computeNow, nodeState, decorate } from '../core/timeline.js';
import {
  formatDate, relativeDay, typeMeta, categoryMeta, humanizeDuration, formatMoney,
} from '../core/format.js';
import { openAmap } from '../core/nav.js';
import { computeBudget } from '../core/budget.js';
import { Icon, Glyph, Sheet, Field, Input, Textarea, Bar } from './bits.jsx';
import { useDragSort } from './useDragSort.js';

/**
 * 整个 App 就是这一页。
 *
 * 行程节点按时间从上到下排成一条线，日期只是插在流里的分隔标题，不再是 tab。
 * 照片和消费直接长在对应的那一项底下 —— 看到玉龙雪山，就在那儿拍一张、记一笔，
 * 不用跳去别的页面再想办法对上关系。
 */

export default function Journey({ addNodeSignal, onAdd, onOpenSettings }) {
  const state = useStore();
  const data = state.data;

  const [editing, setEditing] = useState(null); // {kind:'node'|'expense'|'budget', ...}
  const [viewer, setViewer] = useState(null);
  const [showBudget, setShowBudget] = useState(false);
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
    const budget = computeBudget({ budgets: data.budgets, expenses: data.expenses, members: data.members });
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

    // 日期 -> 当天的节点。空白日也保留，否则「第几天」会错位。
    const days = [];
    for (const d of clock.allDates) {
      days.push({ date: d, nodes: clock.decoratedByDate.get(d) || [] });
    }

    const loosePhotos = data.photos.filter((p) => !p.node_id);
    const looseExpenses = data.expenses.filter((e) => !e.node_id);

    return { budget, clock, days, photosByNode, expensesByNode, loosePhotos, looseExpenses };
  }, [data, now]);

  // 顶部那个 + 里点了「加一项」——新的一项默认落在今天，没在行程内就落在第一天
  useEffect(() => {
    if (!addNodeSignal || !view) return;
    const target =
      (view.clock.allDates.includes(view.clock.today) ? view.clock.today : null) ||
      view.clock.allDates[0] ||
      data?.trip?.start_date;
    if (target) setEditing({ kind: 'node', date: target });
  }, [addNodeSignal]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const { trip, vocab, members } = data;
  const { budget, clock, days, photosByNode, expensesByNode, loosePhotos, looseExpenses } = view;

  const totalNodes = data.nodes.length;
  const doneNodes = data.nodes.filter((n) => n.status === 'done').length;

  return (
    <>
      <header className="topbar sticky">
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

      <div className="page">
        <NowStrip clock={clock} vocab={vocab} />

        <MoneyStrip budget={budget} open={showBudget} onToggle={() => setShowBudget((v) => !v)} onEdit={() => setEditing({ kind: 'budget' })} />

        {showBudget && <BudgetDetail budget={budget} vocab={vocab} onEdit={() => setEditing({ kind: 'budget' })} />}

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

        {trip.overview && <Overview text={trip.overview} />}

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
          vocab={vocab}
          onClose={() => setEditing(null)}
        />
      )}

      {viewer && <PhotoViewer photo={viewer} photos={data.photos} onClose={() => setViewer(null)} onEdit={setViewer} />}
    </>
  );
}

/* ------------------------------ 现在的处境 ------------------------------ */

function NowStrip({ clock, vocab }) {
  const { headline, subline, tone, currentNode, dayNumber, totalDays, phase } = clock;

  return (
    <div className={`nowstrip tone-${tone}`}>
      <div className="ns-label">
        {phase === 'active' ? '现在' : phase === 'upcoming' ? '还没出发' : '已结束'}
        <span className="ns-day">
          第 {dayNumber}/{totalDays} 天
        </span>
      </div>
      <div className="ns-head truncate">{headline}</div>
      {subline && <div className="ns-sub truncate">{subline}</div>}
      {currentNode?.navKeyword && (
        <button className="chip-btn" onClick={() => openAmap(currentNode.navKeyword, '')}>
          <Icon name="pin" size={12} /> 导航
        </button>
      )}
    </div>
  );
}

/* ------------------------------ 钱 ------------------------------ */

function MoneyStrip({ budget, open, onToggle, onEdit }) {
  return (
    <div className="moneystrip">
      <button className="ms-top" onClick={onToggle} aria-expanded={open}>
        <span className="ms-fig">
          <span className="tiny dim">已花</span>
          <b className={budget.over ? 'danger' : ''}>{formatMoney(budget.actualTotal)}</b>
        </span>
        <span className="grow">
          <Bar value={budget.actualTotal} max={budget.plannedTotal} />
          <span className="tiny dim">
            预算 {formatMoney(budget.plannedTotal)} ·{' '}
            {budget.remaining >= 0 ? `还剩 ${formatMoney(budget.remaining)}` : `超支 ${formatMoney(-budget.remaining)}`}
          </span>
        </span>
        <Icon name="chevron" size={14} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
      </button>
    </div>
  );
}

function BudgetDetail({ budget, vocab, onEdit }) {
  if (!budget.byCategory.length) {
    return (
      <div className="card-flat">
        <div className="small dim">还没设预算。</div>
        <button className="btn primary btn-sm" style={{ marginTop: 10 }} onClick={onEdit}>
          填一下
        </button>
      </div>
    );
  }
  return (
    <div className="card-flat">
      {budget.byCategory.map((c) => {
        const meta = categoryMeta(vocab, c.vocabKey || c.category);
        const spent = c.actual > 0;
        return (
          <div key={c.category} className={`brow${spent ? '' : ' is-zero'}`}>
            <span className="brow-ic" style={{ background: meta.soft, color: meta.color }}>
              <Glyph icon={meta.icon} size={13} />
            </span>
            <div className="grow">
              <div className="row-between">
                {/* vocabKey === category 说明这行是「没进任何预算行」的孤儿消费，
                    budget.js 只能用原始 key 当名字 —— 得查回词汇表的中文标签，
                    否则用户会看到一行光秃秃的 food。 */}
                <span className={`small ${spent ? 'strong' : 'dim'}`}>
                  {c.vocabKey === c.category ? meta.label : c.category}
                </span>
                <span className="small mono-num dim">
                  {c.planned > 0 ? `${formatMoney(c.actual)}/${formatMoney(c.planned)}` : formatMoney(c.actual)}
                </span>
              </div>
              {/* 一分钱没花的类别不画进度条：六七行里五行是空灰条，纯噪音 */}
              {spent && (
                <div style={{ marginTop: 4 }}>
                  <Bar value={c.actual} max={c.planned} />
                </div>
              )}
            </div>
          </div>
        );
      })}
      <button className="chip-btn" style={{ marginTop: 10 }} onClick={onEdit}>
        改预算
      </button>
    </div>
  );
}

/** 行程备注。往往很长，默认收起，只留一个标题占一行。 */
function Overview({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="section-title overview-toggle" onClick={() => setOpen((v) => !v)}>
        <span>关键提示</span>
        <span className="ov-hint">{open ? '收起' : `${text.length} 字`}</span>
      </button>
      {open && (
        <div className="card-flat">
          <div className="small muted" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
            {text}
          </div>
        </div>
      )}
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
  const [notesOpen, setNotesOpen] = useState(false);
  // 提示里常有整段空行，折叠时先抹平，不然两行就被空行吃掉了，只剩一个孤零零的省略号
  const notePreview = useMemo(() => (node.notes || '').replace(/\n{2,}/g, '\n').trim(), [node.notes]);
  // 提示长了才需要展开开关
  const notesLong = notePreview.length > 44;
  const meta = typeMeta(vocab, node.type);
  // 标题里已经带了地点的，meta 里就不用再报一遍 —— 省一行，也少一处重复
  const locInTitle = !!node.location && node.title.includes(node.location);
  const st = nodeState(node, clock);
  /*
   * 「现在该做的那件事」用哪个，得跟顶部那张「现在」卡一致，否则视觉焦点会对不上。
   * 顶部在没有进行中节点时说的是「下一个」，所以这里也得把 nextNode 算进来。
   */
  const isNow = st === 'current' || (st === 'upcoming' && clock.nextNode?.id === node.id);
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
          style={st === 'current' ? { borderColor: meta.color, background: meta.color } : st === 'done' ? { borderColor: 'var(--ok)', background: 'var(--ok)' } : null}
        />

<div className={`tl-card s-${st}`}>
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

          {/*
           * 展开开关做成贴在提示右下角的小圆钮，不另占一行 —— 原来那个「展开」
           * 16 张卡加起来白占 133px，而且蓝色加粗比提示本身还跳。整块文字也能点，
           * 手机上按哪儿都算。
           */}
          {node.notes && (
            <div className={`tl-notes-wrap${notesLong ? ' has-more' : ''}`}>
              <div
                className={`tl-notes${notesOpen ? ' open' : ''}`}
                onClick={notesLong ? () => setNotesOpen((v) => !v) : undefined}
              >
                {notesOpen ? node.notes : notePreview}
              </div>
              {notesLong && (
                <button
                  className="tl-more"
                  onClick={() => setNotesOpen((v) => !v)}
                  aria-label={notesOpen ? '收起提示' : '展开提示'}
                >
                  <Icon
                    name="chevron"
                    size={13}
                    style={{ transform: notesOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }}
                  />
                </button>
              )}
            </div>
          )}

          {node.checklist?.length > 0 && (
            <div className="tl-checks">
              {node.checklist.map((c, i) => (
                <CheckItem key={i} nodeId={node.id} text={c} index={i} started={!!node.isStarted} />
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

function CheckItem({ nodeId, text, index, started }) {
  const [on, setOn] = useState(started && index === 0);
  return (
    <button
      className={`tl-check${on ? ' on' : ''}`}
      onClick={() => {
        setOn((v) => !v);
        if (!on && index === 0) actions.checkin(nodeId, 'departed').catch(() => setOn(false));
      }}
    >
      <span className="box">{on && <Icon name="check" size={10} />}</span>
      <span className="truncate">{text}</span>
    </button>
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

/* ------------------------------ 编辑器 ------------------------------ */

function NodeEditor({ draft, vocab, dates, onClose, onSave, onDelete }) {
  const isNew = !draft.node;
  const n = draft.node || {};
  const [form, setForm] = useState({
    title: n.title || '',
    type: n.type || 'spot',
    date: n.date || draft.date || dates[0],
    startTime: n.start_time || '',
    endTime: n.end_time || '',
    location: n.location || '',
    navKeyword: n.nav_keyword || '',
    transportMinutes: n.transport_minutes ?? '',
    notes: n.notes || '',
    checklist: (n.checklist || []).join('\n'),
  });
  const [showNav, setShowNav] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  /*
   * 提示框的两件事：还差几行（标在标签行上，不压正文）、写的时候能摊多开。
   * notesFocus 一开就把上限从 9 行提到 15 行 —— 键盘弹起来以后可视区只剩半屏，
   * 这时候 121px 的框只剩可视区的五分之一，写一句要盲写一句。
   */
  const [notesMore, setNotesMore] = useState(0);
  const [notesFocus, setNotesFocus] = useState(false);
  const onNotesOverflow = useCallback((n) => setNotesMore(n), []);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  /*
   * iOS 键盘弹起时缩的是 visualViewport，布局视口纹丝不动 —— 于是 position:fixed
   * 撑满全屏的面板会整块被键盘盖住，写到后面几行就看不见光标了。
   * 把 visualViewport 的实时高度和偏移写进 CSS 变量，面板照着缩。
   * （Sheet 用的是 max-height:90dvh + 滚动焦点元素绕开同一个问题，这里是
   *   flex 撑满、内部没东西可滚，只能直接改高度。）
   */
  useEffect(() => {
    if (!writeOpen) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const root = document.documentElement;
    const sync = () => {
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvt');
    };
  }, [writeOpen]);

  /*
   * 长文在底部弹层里写是件难受事：文本框跟着内容长高，很快比屏幕还高，
   * 下面的字段全被顶出去。这个模式让它占满整屏，写完点「完成」退回弹层。
   * 两边共用同一个 form.notes，改哪边另一边立刻同步。
   */
  /*
   * writeOpen 时整个弹层被 writefull 换掉了，Sheet 自己挂的那个 Escape 监听
   * 根本不在，键盘就再也关不掉它。补一道。
   */
  useEffect(() => {
    if (!writeOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setWriteOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [writeOpen]);

  if (writeOpen) {
    return (
      <div className="writefull">
        <div className="writefull-bar">
{/* 标题可能很长，顶栏就那么大一块，得给它 truncate 余地 */}
<span className="writefull-title truncate">{form.title.trim() || '提示'}</span>
{/* 弹层里报字数，全屏也得报 —— 写长文时反而更想知道写了多少 */}
<span className="writefull-right">
{form.notes.trim() && <span className="writefull-count">{form.notes.trim().length} 字</span>}
<button type="button" className="btn primary btn-sm" onClick={() => setWriteOpen(false)}>
完成
</button>
</span>
        </div>
        <textarea
          className="writefull-area"
          value={form.notes}
          onChange={set('notes')}
          placeholder="几点到、先去哪、要带什么、要留意什么…"
          autoFocus
        />
      </div>
    );
  }

  return (
    <Sheet
      title={isNew ? '新增行程' : '编辑行程'}
      onClose={onClose}
      footer={
        <button
          className="btn primary block"
          disabled={!form.title.trim() || !form.date}
          onClick={() =>
            onSave({
              title: form.title.trim(),
              type: form.type,
              date: form.date,
              startTime: form.startTime || null,
              endTime: form.endTime || null,
              location: form.location.trim() || null,
              navKeyword: form.navKeyword.trim() || form.location.trim() || null,
              transportMinutes: form.transportMinutes === '' ? null : Number(form.transportMinutes),
              notes: form.notes.trim() || null,
              checklist: form.checklist.split('\n').map((s) => s.trim()).filter(Boolean),
            })
          }
        >
          {isNew ? '添加' : '保存'}
        </button>
      }
    >
      <div className="stack">
        <Field label="标题">
          <Input
            value={form.title}
            onChange={set('title')}
            placeholder="例如：云杉坪索道"
            maxLength={80}
            autoFocus={isNew}
          />
        </Field>

        <Field
          label="提示"
          action={
            <>
            <button type="button" className="field-act" onClick={() => setWriteOpen(true)}>
              <Icon name="edit" size={12} />
              展开写
            </button>
            {form.notes.trim() && (
              <span className="field-act-note">
                {form.notes.trim().length} 字
                {/* 框里装不下时写明还差几行。以前这句压在右下角，盖住的正是最后半行字。 */}
                {notesMore > 0 && <span className="field-act-more">· 还有 {notesMore} 行</span>}
              </span>
            )}
            </>
          }
        >
          {/*
           * 提示是这一栏里唯一的长文，真实内容动辄十几行（实测航班那一项 18 行）。
           * 「输入不方便」大半出在这儿：框矮的时候写一句要盲一句。
           *
           * 两档高度：没在写的时候 9 行，弹层里一眼能看到这段提示有多长；
           * 点进去写就涨到 15 行 —— 那时候键盘已经吃掉半屏，正好把腾出来的高度
           * 让给正在写的那段话，不用再为了看清自己写了什么去切全屏。
           */}
          <Textarea
            autoGrow
            rows={4}
            maxRows={notesFocus ? 15 : 9}
            value={form.notes}
            onChange={set('notes')}
            onFocus={() => setNotesFocus(true)}
            onBlur={() => setNotesFocus(false)}
            onOverflow={onNotesOverflow}
            placeholder="例如：14:00 到古城东门，先去木府门口存包"
          />
        </Field>

        <Field label="待办" hint="一行一条，回车换行">
          {/* 待办一般 2–4 条，压到 5 行封顶；再多就用「展开写」那套全屏写。 */}
          <Textarea autoGrow rows={2} maxRows={5} value={form.checklist} onChange={set('checklist')} placeholder={'确认 late check-in\n充电宝放随身'} />
        </Field>

        <Field label="类型">
          <div className="pill-row scroll">
            {(vocab?.nodeTypes || []).map((t) => (
              <button
                key={t.key}
                type="button"
                className={`pill icon-pill${form.type === t.key ? ' on' : ''}`}
                style={form.type === t.key ? { color: t.color, borderColor: t.color } : null}
                onClick={() => setForm((f) => ({ ...f, type: t.key }))}
              >
                <Glyph icon={t.icon} size={13} />
                {t.label}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid-2">
          <Field label="日期">
            <Input type="date" value={form.date} onChange={set('date')} />
          </Field>
          <Field label="开始">
            <Input type="time" value={form.startTime} onChange={set('startTime')} />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="结束">
            <Input type="time" value={form.endTime} onChange={set('endTime')} />
          </Field>
          <Field label="车程（分钟）">
            <Input type="number" inputMode="numeric" value={form.transportMinutes} onChange={set('transportMinutes')} placeholder="40" />
          </Field>
        </div>

        <Field
          label="地点"
          action={
            <button type="button" className={`field-act${showNav ? ' on' : ''}`} onClick={() => setShowNav((v) => !v)}>
              {showNav ? '收起' : '导航词'}
            </button>
          }
        >
          <Input value={form.location} onChange={set('location')} placeholder="例如：玉龙雪山景区" />
          {/*
           * 导航词是少数人才填的低频字段。以前它跟地点一样占一个带标签的整块，
           * 白白多占 ~57px，把地点本身顶到折叠线以下。现在收进地点框里当第二行，
           * 需要时点右上角展开，不占默认位置。
           */}
          {showNav && (
            <Input
              className="input input-sub"
              value={form.navKeyword}
              onChange={set('navKeyword')}
              placeholder="导航关键词，留空就用地点"
            />
          )}
        </Field>

        {/*
         * 删除是低频且不可逆的操作，不该跟常驻的「保存」抢注意力 —— 以前两枚都是全宽
         * 实心大按钮，视线不知道该落哪儿。改成一行淡红文字：认得出、点得着，但不抢。
         */}
        {onDelete && (
          <button className="btn-text-danger" onClick={onDelete}>
            删除这一项
          </button>
        )}
      </div>
    </Sheet>
  );
}

function ExpenseEditor({ draft, vocab, members, nodes, onClose, onSave, onDelete }) {
  const e = draft.expense;
  const isNew = !e;
  const [form, setForm] = useState({
    amount: e?.amount ?? '',
    category: e?.category || 'food',
    payer: e?.payer || members[0]?.name || '我',
    note: e?.note || '',
    occurredAt: (e?.occurred_at || new Date().toISOString()).slice(0, 16),
    nodeId: e?.node_id || draft.node?.id || '',
  });
  const set = (k) => (ev) => setForm((f) => ({ ...f, [k]: ev.target.value }));

  return (
    <Sheet title={isNew ? '记一笔' : '改这笔'} onClose={onClose}>
      <div className="stack">
        <Field label="金额">
          <Input
            type="number"
            inputMode="decimal"
            value={form.amount}
            onChange={set('amount')}
            placeholder="0"
            style={{ fontSize: 24, fontWeight: 700, height: 52 }}
          />
        </Field>

        <Field label="类别">
          <div className="pill-row">
            {(vocab?.categories || []).map((c) => (
              <button
                key={c.key}
                type="button"
                className={`pill icon-pill${form.category === c.key ? ' on' : ''}`}
                style={form.category === c.key ? { color: c.color, borderColor: c.color } : null}
                onClick={() => setForm((f) => ({ ...f, category: c.key }))}
              >
                <Glyph icon={c.icon} size={13} />
                {c.label}
              </button>
            ))}
          </div>
        </Field>

        {members.length > 1 && (
          <Field label="谁付的">
            <div className="pill-row">
              {members.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`pill${form.payer === m.name ? ' on' : ''}`}
                  onClick={() => setForm((f) => ({ ...f, payer: m.name }))}
                >
                  {m.name}
                </button>
              ))}
            </div>
          </Field>
        )}

        {/*
         * 原来这两只是并排的 grid-2，各分 185px。datetime-local 光是
         * 「2026/10/01 18:45」加那个日历图标就要 197px，于是时间被压在
         * 图标底下，看不清到底几点（实测 185 < 197）。挂在那个下拉也只有
         * 185px，节点标题基本只露个开头。两个都摊开占满整行才读得出来 ——
         * 行间距跟 grid-2 一样是 10px，占地面没多花。
         */}
        <div className="stack">
          <Field label="时间">
            <Input type="datetime-local" value={form.occurredAt} onChange={set('occurredAt')} />
          </Field>
          <Field label="挂在">
            <select className="select" value={form.nodeId} onChange={set('nodeId')}>
              <option value="">不指定</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {[n.date.slice(5), n.start_time, n.title].filter(Boolean).join(' · ')}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="备注">
          <Input value={form.note} onChange={set('note')} placeholder="买了什么" maxLength={200} />
        </Field>

        <button
          className="btn primary"
          disabled={!(+form.amount > 0)}
          onClick={() =>
            onSave({
              amount: +form.amount,
              category: form.category,
              payer: form.payer,
              note: form.note.trim() || null,
              occurredAt: new Date(form.occurredAt).toISOString(),
              nodeId: form.nodeId || null,
            })
          }
        >
          {isNew ? '记下' : '保存'}
        </button>

        {onDelete && (
          <button className="btn danger" onClick={onDelete}>
            删掉
          </button>
        )}
      </div>
    </Sheet>
  );
}

function BudgetEditor({ budgets, vocab, onClose }) {
  const [rows, setRows] = useState(() => budgets.map((b) => ({ ...b })));
  const [adding, setAdding] = useState(null);

  const cats = vocab?.categories || [];

  async function save(b) {
    const amount = +b.planned_amount;
    if (!(amount >= 0)) return;
    if (b.id) await actions.patchBudget(b.id, { category: b.category, vocabKey: b.vocab_key, plannedAmount: amount });
    else await actions.addBudget({ category: b.category, vocabKey: b.vocab_key, plannedAmount: amount });
    setAdding(null);
  }

  return (
    <Sheet title="预算" onClose={onClose}>
      <div className="stack">
        <p className="tiny dim" style={{ margin: 0 }}>
          每行选一个消费类别，花的钱会自动对上去。留 0 就是不设上限。
        </p>

        {rows.map((b, i) => (
          <div key={b.id || i} className="brow-edit">
            <select
              className="select"
              value={b.vocab_key || ''}
              onChange={(ev) => {
                const c = cats.find((x) => x.key === ev.target.value);
                setRows((rs) => rs.map((r, j) => (j === i ? { ...r, vocab_key: ev.target.value, category: c?.label || b.category } : r)));
              }}
            >
              <option value="">不关联类别</option>
              {cats.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <Input
              className="input"
              type="number"
              inputMode="decimal"
              value={b.planned_amount}
              onChange={(ev) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, planned_amount: ev.target.value } : r)))}
              onBlur={() => save(b)}
              placeholder="0"
            />
            <button
              className="chip-btn icon-only"
              aria-label="删除"
              onClick={async () => {
                if (!b.id) {
                  setRows((rs) => rs.filter((_, j) => j !== i));
                  return;
                }
                if (!confirm(`删掉「${b.category}」的预算？`)) return;
                await actions.deleteBudget(b.id);
                setRows((rs) => rs.filter((_, j) => j !== i));
              }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}

        {adding ? (
          <div className="brow-edit">
            <select
              className="select"
              value={adding.vocab_key || ''}
              onChange={(ev) => {
                const c = cats.find((x) => x.key === ev.target.value);
                setAdding({ ...adding, vocab_key: ev.target.value, category: c?.label || '' });
              }}
            >
              <option value="">选类别</option>
              {cats.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <Input
              className="input"
              type="number"
              inputMode="decimal"
              value={adding.planned_amount}
              onChange={(ev) => setAdding({ ...adding, planned_amount: ev.target.value })}
              placeholder="金额"
            />
            <button
              className="chip-btn icon-only"
              aria-label="确认"
              onClick={() => {
                if (!adding.category) {
                  toast('先选个类别', 'warn');
                  return;
                }
                setRows((rs) => [...rs, adding]);
                setAdding(null);
              }}
            >
              <Icon name="check" size={13} />
            </button>
          </div>
        ) : (
          <button className="btn btn-sm" onClick={() => setAdding({ category: '', vocab_key: '', planned_amount: '' })}>
            <Icon name="plus" size={13} /> 加一行
          </button>
        )}

        {adding && (
          <button className="btn primary" onClick={() => save({ ...adding, id: null })}>
            保存这一行
          </button>
        )}
      </div>
    </Sheet>
  );
}
