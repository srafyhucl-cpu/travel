import React, { useEffect, useRef } from 'react';
import { glyph, hasGlyph } from './glyphs.js';

/* ------------------------------ 图标 ------------------------------ */

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };

/**
 * 线性图标。名字对不上返回 null，由调用方决定怎么兜底。
 * 常规尺寸 13–18px —— 再大就喧宾夺主了，图标是配角，文字才是主角。
 */
export function Icon({ name, size = 18, style, ...rest }) {
  const parts = glyph(name);
  if (!parts) return null;
  const p = { width: size, height: size, viewBox: '0 0 24 24', style, ...rest, ...S };
  return (
    <svg {...p} aria-hidden="true">
      {parts.map((s, i) => {
        if (s.t === 'c') return <circle key={i} cx={s.cx} cy={s.cy} r={s.r} />;
        if (s.t === 'e') return <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill="currentColor" stroke="none" />;
        if (s.t === 'r') return <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.rx} />;
        return <path key={i} d={s.d} />;
      })}
    </svg>
  );
}

/**
 * 词表图标。vocab.icon 存的是图标名；如果读到的是旧数据里的 emoji，
 * 或者用户自己敲的字符，就当普通文字渲染，保证任何值都不会显示成空白。
 */
export function Glyph({ icon, size = 14, style }) {
  if (hasGlyph(icon)) return <Icon name={icon} size={size} style={style} />;
  if (!icon) return null;
  return (
    <span className="glyph-fallback" style={{ fontSize: size * 0.95, lineHeight: 1, ...style }}>
      {icon}
    </span>
  );
}

/* ------------------------------ 底部弹层 ------------------------------ */

export function Sheet({ title, onClose, children, footer }) {
  const ref = useRef(null);
/*
* 手机键盘弹起来会吃掉屏幕下面一截，而弹层本身不会自动让位，
* 于是正在输入的那个框常常正好躲在键盘后面 —— 看得见光标，看不见自己写的字。
* 盯住 visualViewport 的高度，它一缩就把焦点元素滚到可视区中间。
*/
useEffect(() => {
  const vv = window.visualViewport;
  if (!vv) return undefined;
  const bd = ref.current?.closest('.sheet-backdrop');
  let t = 0;
  /*
   * 键盘弹起时 iOS 缩的是 visualViewport，布局视口纹丝不动 —— position:fixed 的
   * 弹层不会自己让位，底部那条常驻的「保存」正好躲在键盘后面：字写完了，
   * 想点保存得先低一下头把键盘收起来。把可视区的高度和偏移写进 CSS 变量，
   * 遮罩连着弹层一起抬到键盘上沿（见 .sheet-backdrop.kb）。
   *
   * 变量写在遮罩上而不是弹层上：弹层是遮罩的孩子，写在遮罩才两边都读得到。
   * 安卓是直接缩布局视口的，这时 hidden 算出来接近 0，.kb 不会加，
   * 系统自己已经处理好了，我们不插手。
   */
  const sync = () => {
    const hidden = window.innerHeight - vv.height - vv.offsetTop;
    bd?.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    bd?.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
    bd?.classList.toggle('kb', hidden > 80);
  };
  const onResize = () => {
    sync();
    clearTimeout(t);
    // 键盘是带动画推上来的，等它落定再滚，中途算出来的位置是错的
    t = setTimeout(() => {
      const el = document.activeElement;
      if (!el || !ref.current?.contains(el)) return;
      el.scrollIntoView({ block: 'center' });
    }, 120);
  };
  sync();
  vv.addEventListener('resize', onResize);
  vv.addEventListener('scroll', onResize);
  return () => {
    clearTimeout(t);
    vv.removeEventListener('resize', onResize);
    vv.removeEventListener('scroll', onResize);
    bd?.style.removeProperty('--vvh');
    bd?.style.removeProperty('--vvt');
    bd?.classList.remove('kb');
  };
}, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 设置页里还会再开子弹层（编辑行程、改成员…），每一层都往 document 挂了
      // keydown，不挡一下的话一次 Escape 把内外层一起关掉，用户白退回设置首页。
      // 所有 .sheet-backdrop 的 z-index 相同，DOM 里最后一个就是最上面那层。
      const all = document.querySelectorAll('.sheet-backdrop');
      if (all[all.length - 1] !== ref.current?.closest('.sheet-backdrop')) return;
      onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
<div className={`sheet${footer ? ' has-foot' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grab" />
        <div className="sheet-head">
          <h3 className="grow truncate">{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
{footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ 表单件 ------------------------------ */

export function Field({ label, children, hint, action, required }) {
return (
<div className={`field${required ? ' req' : ''}`}>
{label && (
<div className="field-head">
<label>
{label}
{required && <span className="req-star" aria-hidden="true">必填</span>}
</label>
{action}
</div>
)}
{children}
{hint && <div className="tiny dim">{hint}</div>}
</div>
);
}


export function Input(props) {
  return <input className="input" {...props} />;
}

/** 两种用法：传 options 数组，或直接传 <option> 子节点 */
export function Select({ options, children, ...props }) {
  return (
    <select className="select" {...props}>
      {options
        ? options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))
        : children}
    </select>
  );
}

export function Switch({ on, onChange, label, desc }) {
  return (
    <button className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} style={{ width: '100%', textAlign: 'left' }}>
      <span className="grow">
        <span className="strong" style={{ fontSize: 14 }}>
          {label}
        </span>
        {desc && <div className="tiny dim">{desc}</div>}
      </span>
      <span className="track">
        <span className="knob" />
      </span>
    </button>
  );
}

/* ------------------------------ 空态 ------------------------------ */

export function Empty({ icon = 'sparkle', title, hint, action }) {
  return (
    <div className="empty">
      <div className="big">
        <Icon name={icon} size={26} />
      </div>
      <div className="strong" style={{ color: 'var(--ink-2)' }}>
        {title}
      </div>
      {hint && <div className="tiny" style={{ marginTop: 6 }}>{hint}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

/* ------------------------------ 进度条 ------------------------------ */

export function Bar({ value, max, dangerAt = 1 }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const over = max > 0 && value > max;
  return (
    <div className="bar">
      <i className={over ? 'over' : ''} style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }} />
    </div>
  );
}
