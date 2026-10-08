import React, { useEffect, useState } from 'react';
import { Bar, Glyph, Icon } from './bits.jsx';
import { categoryMeta, formatMoney, tintOf, typeMeta } from '../core/format.js';
import { platform } from '../platform/index.js';
import { progress } from '../core/checklist.js';
import { actions } from '../store/store.js';
import CheckItem from './CheckItem.jsx';

/*
 * 顶部常驻的一整块：现在在做什么 + 前置准备 + 钱。
 *
 * 以前是三张卡竖着排（现在 / 前置 / 预算），加起来能吃掉小半屏，出发前最该
 * 盯的行程本身反被挤到下面去。现在合成一张：上面一行「现在」，下面一行两格
 * （前置、钱），点哪格就在卡下面展开哪格的明细，一次只开一个。
 * 整块跟顶栏一起常驻（外层 .hud 一起 sticky），滚到行程中间也还看得见
 * 「现在在干嘛、前置还差几条、钱花了多少」。
 */

function timeRange(n) {
  if (!n) return '';
  if (n.start_time && n.end_time) return `${n.start_time}–${n.end_time}`;
  return n.start_time || '';
}

/**
 * 把 computeNow 那一堆状态压成一行要显示的东西。
 *
 * 不直接用 clock.headline：它把「现在」塞在句子里（「你现在应该在：××」），
 * 挤成一行以后前缀和标题得拆开摆，句子一长标题就被挤没了。这里按结构化
 * 字段自己组，标签短、标题完整。
 */
function nowRow(clock) {
  const { phase, tone, currentNode, nextNode, headline, subline, dayNumber, totalDays, nowMin } = clock;
  const day = `第 ${dayNumber}/${totalDays} 天`;

  if (phase === 'upcoming') return { label: '还没出发', title: headline, sub: subline, right: '', tone };
  if (phase === 'finished') return { label: '已结束', title: headline, sub: subline, right: '', tone };
  if (currentNode) {
    return { label: '现在', title: currentNode.title, sub: currentNode.location || day, right: timeRange(currentNode), tone };
  }
  if (nextNode) {
    const gap = nextNode.plannedStart - nowMin;
    const sub = gap > 0 && gap <= 60 ? `还有 ${gap} 分钟 · ${day}` : `${day} · ${nextNode.start_time || ''} 开始`.trim();
    return { label: '下一个', title: nextNode.title, sub, right: timeRange(nextNode), tone };
  }
  return { label: tone === 'done' ? '已完成' : '空闲', title: headline, sub: subline || day, right: '', tone };
}

export default function Deck({ clock, vocab, budget, members, me, modules, onEditModule, onEditBudget }) {
  const [panel, setPanel] = useState(null); // 'prep' | 'money' | null，一次只开一个
  const toggle = (k) => setPanel((p) => (p === k ? null : k));

  const module = modules[0] || null;
  const prep = progress(module?.checklist || []);
  const now = nowRow(clock);
  const navNode = clock.currentNode || clock.nextNode;

  /*
   * 前置最后一条勾掉的瞬间把面板折起来：那时候正是「好了」手感最强的一下，
   * 留一屏划线反而把它冲掉。只在「完成状态变了」这一下看一眼面板开没开，
   * 所以依赖数组里只放 allDone —— open 每次渲染都是新函数值，跟着它跑会
   * 在面板开着的时候反复把它折起来。
   */
  useEffect(() => {
    if (prep.allDone && panel === 'prep') setPanel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prep.allDone]);

  return (
    <div className="deck">
      <div className={`dk-now tone-${now.tone}`}>
        <span className="dk-dot" />
        <div className="grow">
          <div className="dk-l1">
            <span className="dk-label">{now.label}</span>
            <span className="dk-title truncate">{now.title}</span>
          </div>
          <div className="dk-l2 truncate">{now.sub}</div>
        </div>
        {now.right && <span className="dk-time mono-num">{now.right}</span>}
        {navNode?.navKeyword && (
          <button className="dk-act" onClick={() => platform.services.openMap(navNode.navKeyword)} aria-label="导航过去">
            <Icon name="pin" size={13} />
          </button>
        )}
      </div>

      <div className="dk-segs">
        {module && (
          <button
            className={`dk-seg prep-seg${prep.allDone ? ' ok' : ''}${panel === 'prep' ? ' open' : ''}`}
            onClick={() => toggle('prep')}
            aria-expanded={panel === 'prep'}
          >
            <span className="grow">
              <span className="ds-l1">
                <span className="ds-ic" style={{ background: typeMeta(vocab, module.type).soft, color: typeMeta(vocab, module.type).color }}>
                  <Glyph icon={typeMeta(vocab, module.type).icon} size={11} />
                </span>
                <span className="ds-label">前置</span>
                <span className="ds-num mono-num">{prep.allDone ? '✓ 完成' : `${prep.done}/${prep.total}`}</span>
              </span>
              <Bar value={prep.done} max={prep.total} />
            </span>
            <Icon name="chevron" size={13} className={`dk-caret${panel === 'prep' ? ' open' : ''}`} />
          </button>
        )}

        <button
          className={`dk-seg money-seg${budget.over ? ' over' : ''}${panel === 'money' ? ' open' : ''}`}
          onClick={() => toggle('money')}
          aria-expanded={panel === 'money'}
        >
          <span className="grow">
            <span className="ds-l1">
              <span className="ds-ic plain">
                <Icon name="wallet" size={12} />
              </span>
              <span className="ds-label">已花</span>
              <span className={`ds-num mono-num${budget.over ? ' danger' : ''}`}>{formatMoney(budget.actualTotal)}</span>
            </span>
            <span className="ds-bar">
              <Bar value={budget.actualTotal} max={budget.plannedTotal} />
              <span className="tiny dim mono-num">{budget.plannedTotal > 0 ? `/${formatMoney(budget.plannedTotal)}` : '未设'}</span>
            </span>
          </span>
          <Icon name="chevron" size={13} className={`dk-caret${panel === 'money' ? ' open' : ''}`} />
        </button>
      </div>

      {panel === 'prep' && module && (
        <div className="dk-panel">
          <div className="dk-panel-head">
            <span className="small strong truncate grow">{module.title}</span>
            <button className="chip-btn icon-only" onClick={() => onEditModule(module)} aria-label={`编辑${module.title}`} title="编辑">
              <Icon name="edit" size={12} />
            </button>
          </div>
          <div className="dk-panel-body">
            {module.checklist?.length > 0 ? (
              <div className="tl-checks">
                {module.checklist.map((it) => (
<CheckItem key={it.id} item={it} onToggle={(d) => actions.setChecklistItem(module.id, it.id, d, it.text)} />
                ))}
              </div>
            ) : (
              <div className="small dim">还没写待办，点右边的 ✎ 加几条。</div>
            )}
          </div>
        </div>
      )}

      {panel === 'money' && (
        <div className="dk-panel">
          {/* 明细只按实际记账的类别汇总，预算是整趟一个总数；
              「还剩多少 / 改预算」留在滚动区外，展开就能看到 */}
          <div className="dk-panel-body">
            {budget.spent.length === 0 ? (
              <div className="dk-panel-row">
                <span className="small dim grow">还没记过账。</span>
              </div>
            ) : (
              budget.spent.map((c) => {
                const meta = categoryMeta(vocab, c.category);
                return (
                  <div key={c.category} className="brow">
                    <span className="brow-ic" style={{ background: meta.soft, color: meta.color }}>
                      <Glyph icon={meta.icon} size={13} />
                    </span>
                    <div className="grow">
                      <div className="row-between">
                        <span className="small strong">{meta.label}</span>
                        <span className="small mono-num">{formatMoney(c.actual)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            {budget.paid.length > 0 && (
              <div className="dk-split">
                <div className="dk-split-title tiny dim">各自花的</div>
                <div className="dk-split-grid">
                  {budget.paid.map((p) => {
                    const m = (members || []).find((x) => x.name === p.name);
                    const color = m?.color || '#2F80ED';
                    return (
                      <div key={p.name} className="dk-payer">
                        <span className="member-avatar sm" style={{ color, background: tintOf(color) }}>
                          {(p.name || '?').slice(0, 1)}
                        </span>
                        <span className="grow small strong truncate">
                          {p.name}
                          {me === p.name && p.name !== '我' && <span className="me-tag">我</span>}
                        </span>
                        <span className="small mono-num">{formatMoney(p.paid)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className="dk-panel-foot">
            <span className="tiny dim grow">
              {budget.plannedTotal > 0
                ? budget.remaining >= 0
                  ? `还剩 ${formatMoney(budget.remaining)}`
                  : `超支 ${formatMoney(-budget.remaining)}`
                : '还没设总预算'}
            </span>
            <button className="chip-btn" onClick={onEditBudget}>改预算</button>
          </div>
        </div>
      )}
    </div>
  );
}
