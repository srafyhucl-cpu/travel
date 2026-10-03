/**
 * 自有表单控件：日历、时钟、行程挂载。
 *
 * 这三样原来是浏览器的原生控件：<input type="date">、<input type="time"> 和
 * <select>。它们的问题很具体 ——
 *
 * - 原生日期/时间框在安卓 Chrome 上点开是一整屏黑色滚轮，iOS 是灰色圆盘，
 *   都不是这个 App 的样子，也不跟顶部的「现在」块、胶囊按钮连成一片；
 *   在桌面 Chrome 上更糟，直接给一个方框加下划线，跟旁边所有控件都不像。
 * - 原生 <select> 的展开菜单是系统面板：黑底白字（或灰底），手机上是一整屏
 *   反色列表，选完才消失。想找「玉龙雪山」只能靠滚，没法搜。
 *
 * 所以改成自己画：外观跟其余表单一致（同样的框、同样的圆角、同样的字重），
 * 日期用月历网格 + 今天/明天/昨天快捷键，时间用 30 分钟一档的胶囊（行程卡上的
 * 时间本来就是这个粒度）+ 一个可以手输的框兜住 07:35 这种零头，挂载用可搜索
 * 的行程列表。都开在 Sheet 里，键盘、Esc、点遮罩关闭这些行为跟别的弹层一致。
 *
 * 值全部走字符串：日期 "YYYY-MM-DD"，时间 "HH:MM"，合起来的 "YYYY-MM-DDTHH:MM"
 * —— 跟原来的 input / datetime-local 一样，上层保存逻辑一行不用改。
 */
import React, { useMemo, useState } from 'react';
import { Sheet, Icon } from './bits.jsx';
import { formatDate, relativeDay, todayStr, addDays } from '../core/format.js';

const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'];

/* ------------------------------ 小工具 ------------------------------ */

/** "YYYY-MM-DD" -> 那一天 0 点。空串/坏值返回 null，不硬造一个 Invalid Date。 */
function parseDate(s) {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 月历的 42 格：上月末尾 + 本月 + 下月开头，周一开头。
 * 返回 {key, day, inMonth} —— inMonth=false 的格子画成灰字，但照样能点
 * （月初/月末不用为了「凑一个月」先翻页）。
 */
function monthCells(year, month) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // 周一 = 0
  const start = new Date(year, month, 1 - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { key: ymd(d), day: d.getDate(), inMonth: d.getMonth() === month };
  });
}

/** "HH:MM" -> "晚上 7:30"。分档说人话，比光一个 19:30 好认。 */
function spoken(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const period = h < 6 ? '凌晨' : h < 12 ? '早上' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
  return `${period} ${h % 12 || 12}:${String(m).padStart(2, '0')}`;
}

/** 一天里的常用时点：06:00–23:00 每 30 分钟。行程卡上的时间本来就是这个粒度。 */
const TIME_PRESETS = (() => {
  const out = [];
  for (let m = 6 * 60; m <= 23 * 60; m += 30) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
})();

/* ------------------------------ 触发按钮 ------------------------------ */

/**
 * 表单里那个「长得像 Input 的按钮」。跟输入框同一套框线（.picker-trigger），
 * 所以从 TextField 换到它，两行之间看不出接缝。右端一枚 chevron 表明可展开；
 * 没值时显示占位文字、字色淡下去，跟原来空输入框一样。
 */
function Trigger({ value, placeholder, onClick, sub, ariaLabel }) {
  return (
    <button type="button" className={`picker-trigger${value ? '' : ' empty'}`} onClick={onClick} aria-label={ariaLabel}>
      <span className="picker-trigger-main">{value || placeholder}</span>
      {sub && <span className="picker-trigger-sub">{sub}</span>}
      <Icon name="chevron" size={15} className="picker-trigger-chev" />
    </button>
  );
}

/* ------------------------------ 日期 ------------------------------ */

/**
 * 月历面板。footer 里是「今天 / 明天 / 后天 / 昨天」——行程九成是围绕今天前后
 * 排的，不用翻月。min/max 之外的格子直接灰掉点不动（设置页的出发日/回来日
 * 就靠这个顺手把「回来早于出发」堵在选择这一步）。
 */
function CalendarPanel({ value, onPick, min, max }) {
  const sel = parseDate(value);
  const [cursor, setCursor] = useState(() => sel || new Date());
  const cy = cursor.getFullYear();
  const cm = cursor.getMonth();
  const today = todayStr();
  const cells = useMemo(() => monthCells(cy, cm), [cy, cm]);
  const move = (delta) => setCursor(new Date(cy, cm + delta, 1));
  const allowed = (k) => (!min || k >= min) && (!max || k <= max);

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="cal-nav" onClick={() => move(-1)} aria-label="上个月">
          <Icon name="back" size={16} />
        </button>
        <div className="cal-title">
          {cy} 年 {cm + 1} 月
        </div>
        <button type="button" className="cal-nav flip" onClick={() => move(1)} aria-label="下个月">
          <Icon name="back" size={16} />
        </button>
      </div>
      <div className="cal-week">
        {WEEK_HEAD.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((c) => {
          const state = [
            c.key === today ? 'today' : '',
            c.key === value ? 'sel' : '',
            c.inMonth ? '' : 'out',
            allowed(c.key) ? '' : 'no',
          ].filter(Boolean).join(' ');
          return (
            <button
              key={c.key}
              type="button"
              className={`cal-cell ${state}`}
              disabled={!allowed(c.key)}
              onClick={() => onPick(c.key)}
            >
              {c.day}
            </button>
          );
        })}
      </div>
      <div className="cal-foot">
        {[0, 1, 2, -1].map((d) => {
          const k = addDays(today, d);
          return (
            <button key={d} type="button" className="pill" disabled={!allowed(k)} onClick={() => onPick(k)}>
              {relativeDay(k)} · {formatDate(k, { short: true })}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 日期框：值 "YYYY-MM-DD"。留空时保存键照样禁用（跟原来一致）。 */
export function DateField({ value, onChange, min, max, placeholder = '选日期' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Trigger
        value={formatDate(value)}
        placeholder={placeholder}
        sub={value ? relativeDay(value) : null}
        onClick={() => setOpen(true)}
        ariaLabel="选日期"
      />
      {open && (
        <Sheet title="选日期" onClose={() => setOpen(false)}>
          <CalendarPanel
            value={value}
            min={min}
            max={max}
            onPick={(k) => {
              onChange(k);
              setOpen(false);
            }}
          />
        </Sheet>
      )}
    </>
  );
}

/* ------------------------------ 时间 ------------------------------ */

/**
 * 时间面板：一屏 30 分钟一档的胶囊，下面一个可以手输的框。
 * 行程里 07:35 这种零头偶尔有，手输兜住；平时一颗就点好。
 * 只收 HH:MM，非法输入不给回传（onChange 不动），免得存进去一个空值。
 */
function TimePanel({ value, onPick }) {
  const [typed, setTyped] = useState('');
  const commit = () => {
    const m = /^(\d{1,2})\s*[:：.]\s*(\d{2})$/.exec(typed.trim());
    if (!m) return;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return;
    onPick(`${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
  };
  return (
    <div className="stack">
      <div className="picker-chips">
        {TIME_PRESETS.map((t) => (
          <button key={t} type="button" className={`pill${value === t ? ' on' : ''}`} onClick={() => onPick(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="picker-manual">
        <input
          className="input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="或者手输 7:35"
          inputMode="numeric"
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        <button type="button" className="btn primary" disabled={!typed.trim()} onClick={commit}>
          定
        </button>
      </div>
    </div>
  );
}

/** 时间框：值 "HH:MM"，可空。 */
export function TimeField({ value, onChange, placeholder = '不定' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Trigger
        value={value}
        placeholder={placeholder}
        sub={value ? spoken(value) : null}
        onClick={() => setOpen(true)}
        ariaLabel="选时间"
      />
      {open && (
        <Sheet
          title="选时间"
          onClose={() => setOpen(false)}
          footer={
            value ? (
              <button
                type="button"
                className="btn block"
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                清掉时间
              </button>
            ) : null
          }
        >
          <TimePanel
            value={value}
            onPick={(t) => {
              onChange(t);
              setOpen(false);
            }}
          />
        </Sheet>
      )}
    </>
  );
}

/* ------------------------------ 日期 + 时间 ------------------------------ */

/**
 * 日期和时间一起选（记账弹层那个字段就是它）。两个面板并排一张 Sheet：
 * 上面月历、下面时间胶囊，中间那条分隔线是唯一的层级线索 ——
 * 手机上竖着排会太挤，横排两列刚好都在拇指能扫到的范围里。
 */
export function DateTimeField({ value, onChange, placeholder = '选时间' }) {
  const [open, setOpen] = useState(false);
  const [date, time] = (value || '').split('T');
  const shown = date ? `${formatDate(date)}${time ? ` ${time}` : ''}` : '';
  const patch = (d, t) => onChange(`${d}T${t}`);
  return (
    <>
      <Trigger
        value={shown}
        placeholder={placeholder}
        sub={time ? spoken(time) : null}
        onClick={() => setOpen(true)}
        ariaLabel="选日期和时间"
      />
      {open && (
        <Sheet title="选时间" onClose={() => setOpen(false)}>
          <div className="dt-panel">
            <div className="dt-col dt-date">
              <CalendarPanel value={date} onPick={(d) => patch(d, time || '12:00')} />
            </div>
            <div className="dt-col dt-time">
              <div className="dt-time-label">几点</div>
              <TimePanel value={time} onPick={(t) => patch(date || todayStr(), t)} />
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}

/* ------------------------------ 行程挂载 ------------------------------ */

/**
 * 「挂在哪一项」的下拉。原生 <select> 展开的是系统菜单，手机上一整屏反色、
 * 没法搜；这里开一张可搜索的 Sheet：输入框过滤（标题、日期、类型都算），
 * 下面按日期分组的行程清单，标题省略号、右侧显示时间。
 * 空的那一项（不指定）排在最上面，不然每次都得划过整张表。
 */
export function NodePickField({ nodes, value, onChange, emptyLabel = '不指定' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const sel = nodes.find((n) => n.id === value);
  const shown = sel ? [sel.date.slice(5), sel.start_time, sel.title].filter(Boolean).join(' · ') : '';

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const hit = kw
      ? nodes.filter((n) => `${n.title} ${n.date} ${n.type} ${n.location || ''}`.toLowerCase().includes(kw))
      : nodes;
    const byDate = new Map();
    for (const n of hit) {
      if (!byDate.has(n.date)) byDate.set(n.date, []);
      byDate.get(n.date).push(n);
    }
    for (const arr of byDate.values()) arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [nodes, q]);

  return (
    <>
      <Trigger
        value={shown}
        placeholder={emptyLabel}
        onClick={() => {
          setQ('');
          setOpen(true);
        }}
        ariaLabel="选行程项"
      />
      {open && (
        <Sheet title="挂在哪一项" onClose={() => setOpen(false)}>
          <div className="picker-chips">
            <button
              type="button"
              className={`pill${value ? '' : ' on'}`}
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {emptyLabel}
            </button>
          </div>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜标题或日期（可不搜）" />
          <div className="pick-list">
            {list.length === 0 && (
              <div className="tiny dim" style={{ padding: '14px 2px' }}>
                没有匹配的行程项
              </div>
            )}
            {list.map(([date, arr]) => (
              <div key={date} className="pick-group">
                <div className="pick-group-head">
                  {formatDate(date)} <span className="dim">· {relativeDay(date)}</span>
                </div>
                {arr.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`pick-row${n.id === value ? ' on' : ''}`}
                    onClick={() => {
                      onChange(n.id);
                      setOpen(false);
                    }}
                  >
                    {n.start_time && <span className="pick-row-time">{n.start_time}</span>}
                    <span className="pick-row-title truncate">{n.title}</span>
                    {n.id === value && <Icon name="check" size={15} className="pick-row-ok" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
