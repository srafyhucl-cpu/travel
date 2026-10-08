import React, { useMemo, useRef, useState } from 'react';
import { useStore } from './useStore.js';
import { backupUrl, icsUrl, templateUrl } from '../store/api.js';
import { actions, askConfirm, toast } from '../store/store.js';
import { platform } from '../platform/index.js';
import { getThemeMode, setThemeMode } from './theme.js';
import { computeAchievements } from '../core/achievements.js';
import Achievements from './Achievements.jsx';
import { Icon, Glyph, Sheet, Field, Input, Empty } from './bits.jsx';
import { DateField } from './pickers.jsx';
import { PICKABLE } from '../core/glyphs.js';
import { formatDate, daysBetween, todayStr, tintOf } from '../core/format.js';
const MEMBER_COLORS = ['#2F80ED', '#E2574C', '#27AE60', '#F2994A', '#9B51E0', '#00897B', '#111827'];


export default function Settings({ embedded, onOpenPoster }) {
  const state = useStore();
  const data = state.data;
  const [sheet, setSheet] = useState(null); // 'trip' | 'members' | 'vocab' | null
  const [addingVocab, setAddingVocab] = useState(null); // 'node_type' | 'expense_category'
  const [themeMode, setThemeModeState] = useState(() => getThemeMode());
  const [importDraft, setImportDraft] = useState(null); // { template, fileName }
  const importRef = useRef(null);

  /** 成就解锁数：入口的副标题用；徽章明细在弹层里现算 */
  const achvCounts = useMemo(() => {
    if (!data) return null;
    const achv = computeAchievements(data);
    const meId = data.meId || achv.memberList.find((m) => m.name === data.me)?.id;
    const mine = achv.byMember[meId] || [];
    return {
      mine: mine.filter((b) => b.done).length,
      mineTotal: mine.length,
      team: achv.team.filter((b) => b.done).length,
      teamTotal: achv.team.length,
    };
  }, [data]);

  /** 选了模板文件：解析 + 粗验格式，之后交给弹层确认怎么铺 */
  async function pickTemplate(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const tpl = JSON.parse(await file.text());
      if (!tpl || tpl.kind !== 'travel-template' || !Array.isArray(tpl.days)) {
        toast('这不是本 App 导出的行程模板', 'warn');
        return;
      }
      setImportDraft({ template: tpl, fileName: file.name });
    } catch {
      toast('文件读不出来，或者不是有效的 JSON', 'warn');
    }
  }

  if (!data) {
    return (
      <div className="page">
        <div className="stack">
          <div className="skeleton" />
          <div className="skeleton" style={{ height: 100 }} />
        </div>
      </div>
    );
  }

  const { trip, members, vocab, nodes, expenses, photos, me } = data;
  const dayCount = Math.max(1, daysBetween(trip.start_date, trip.end_date) + 1);

  async function logout() {
    if (await askConfirm('退出后要重新输入旅行口令才能进来，确定吗？', { danger: true, confirmText: '退出' })) {
      await actions.logout();
    }
  }

  return (
    <>
      {!embedded && (
        <header className="topbar">
          <div className="grow">
            <h1>我的</h1>
            <div className="sub">
              {state.live ? '实时同步中' : state.online ? '已连接' : '离线中（改动会排队）'}
            </div>
          </div>
        </header>
      )}

      <div className={embedded ? 'stack tight' : 'page'}>
        {/* 旅行信息 */}
        <div className="card-flat" style={{ padding: 16 }}>
          <div className="row-between">
            <div className="grow">
              <div className="strong" style={{ fontSize: 17 }}>{trip.name}</div>
              <div className="tiny dim" style={{ marginTop: 3 }}>
                {trip.destination} · {formatDate(trip.start_date, { short: true })} – {formatDate(trip.end_date, { short: true })} ·{' '}
                {dayCount} 天
              </div>
            </div>
            <button className="chip-btn" onClick={() => setSheet('trip')}>
              编辑
            </button>
          </div>

          <div className="row-between" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
            <span className="tiny dim">数据都在你自己的服务器上</span>
            <span className="tiny dim">
              {nodes.length} 行程 · {expenses.length} 消费 · {photos.length} 照片
            </span>
          </div>
        </div>

        {/* 成员 */}
        <div className="section-title">
          同行成员
          <button className="act" onClick={() => setSheet('members')}>
            改名 / 颜色
          </button>
        </div>
        <div className="card-flat">
          {members.map((m) => (
            <div key={m.id} className="cat-row" style={{ borderBottom: 'none' }}>
              {/*
               * 原来是一个纯色实心点，两个人（甚至三个人）全是不同颜色的圆，
               * 扫一眼根本认不出哪个是谁。改成写首字的头像，一眼就对上名字。
               */}
              <span
                className="member-avatar"
                style={{ color: m.color || '#2F80ED', background: tintOf(m.color || '#2F80ED') }}
              >
                {(m.name || '?').trim().slice(0, 1)}
              </span>
              <span className="grow small strong">
                {m.name}
                {m.name === me && m.name !== '我' && <span className="me-tag">我</span>}
              </span>
            </div>
          ))}
        </div>

        {/* 类型与类别 */}
        <div className="section-title">行程类型与消费类别</div>
        <div className="card-flat">
          <div className="small dim" style={{ padding: '4px 0 10px' }}>
            决定时间线上的图标配色和记账分类，也能加「露营」「油费」这类自定义项。
          </div>
          <div className="section-title" style={{ margin: '6px 0 8px', fontSize: 12 }}>行程类型</div>
          <div className="pill-row">
            {vocab.nodeTypes.map((t) => (
              <span key={t.key} className="pill soft-chip" style={{ color: t.color, background: t.soft }}>
                <Glyph icon={t.icon} size={13} /> {t.label}
              </span>
            ))}
            <button className="pill add" onClick={() => setAddingVocab('node_type')}>
              <Icon name="plus" size={13} /> 类型
            </button>
          </div>

          <div className="section-title" style={{ margin: '14px 0 8px', fontSize: 12 }}>消费类别</div>
          <div className="pill-row">
            {vocab.categories.map((c) => (
              <span key={c.key} className="pill soft-chip" style={{ color: c.color, background: c.soft }}>
                <Glyph icon={c.icon} size={13} /> {c.label}
              </span>
            ))}
            <button className="pill add" onClick={() => setAddingVocab('expense_category')}>
              <Icon name="plus" size={13} /> 类别
            </button>
          </div>

          {vocab.nodeTypes.some((t) => t.custom) || vocab.categories.some((c) => c.custom) ? (
            <button className="chip-btn" style={{ marginTop: 12 }} onClick={() => setSheet('vocab')}>
              管理自定义项
            </button>
          ) : null}
        </div>

        {/* 导出 */}
        <div className="section-title">导出与提醒</div>
        <div className="card-flat">
          <a className="cat-row" href={icsUrl()} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Icon name="calendar" size={19} />
            <div className="grow">
              <div className="small strong">订阅日历（.ics）</div>
              <div className="tiny dim">把航班、酒店、每天出发时间加进手机自带日历，关掉 App 也会响</div>
            </div>
            <Icon name="download" size={16} />
          </a>

          <a className="cat-row" href={templateUrl()} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Icon name="download" size={19} />
            <div className="grow">
              <div className="small strong">导出行程模板</div>
              <div className="tiny dim">存成 JSON，以后去新地方可以导入复用结构</div>
            </div>
            <Icon name="download" size={16} />
          </a>

          <button
            className="cat-row"
            style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, borderBottom: '1px solid var(--line)' }}
            onClick={() => importRef.current?.click()}
          >
            <Icon name="upload" size={19} />
            <div className="grow">
              <div className="small strong">导入行程模板</div>
              <div className="tiny dim">选一个之前导出的 JSON，按天铺到当前行程（只新增）</div>
            </div>
            <Icon name="chevron" size={16} />
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={pickTemplate}
          />

          <a className="cat-row" href={backupUrl()} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
            <Icon name="download" size={19} />
            <div className="grow">
              <div className="small strong">下载完整备份</div>
              <div className="tiny dim">行程 + 消费 + 打卡的 JSON 存档（不含照片本体）</div>
            </div>
            <Icon name="download" size={16} />
          </a>

          <button
            className="cat-row"
            style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, borderBottom: '1px solid var(--line)' }}
            onClick={onOpenPoster}
          >
            <Icon name="sparkle" size={19} />
            <div className="grow">
              <div className="small strong">生成 vlog 图</div>
              <div className="tiny dim">行程 + 消费 + 记录导出长图，也可以拼照片海报</div>
            </div>
            <Icon name="chevron" size={16} />
          </button>

          <button className="cat-row" style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, borderBottom: '1px solid var(--line)' }} onClick={async () => {
            const r = await platform.services.copyText(window.location.origin);
            toast(r === 'copied' ? '网址已复制' : '复制失败', r === 'copied' ? 'success' : 'warn');
          }}>
            <Icon name="plus" size={19} />
            <div className="grow">
              <div className="small strong">复制网址</div>
              <div className="tiny dim">发给同伴，他用同一个口令就能进来看</div>
            </div>
          </button>
        </div>

        {/* 外观 */}
        <div className="section-title">外观</div>
        <div className="card-flat" style={{ padding: '4px 16px 14px' }}>
          <div className="small dim" style={{ padding: '10px 0' }}>
            整体配色；「跟随系统」会跟着手机的深色模式自动切。
          </div>
          <div className="pill-row">
            {[
              ['system', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`pill${themeMode === key ? ' on' : ''}`}
                onClick={() => {
                  setThemeMode(key);
                  setThemeModeState(key);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 成就 */}
        <div className="section-title">成就</div>
        <div className="card-flat">
          <button
            className="cat-row"
            style={{ width: '100%', textAlign: 'left', background: 'none', border: 0 }}
            onClick={() => setSheet('achv')}
          >
            <Icon name="sparkle" size={19} />
            <div className="grow">
              <div className="small strong">旅行成就</div>
              <div className="tiny dim">
                {achvCounts
                  ? `我的 ${achvCounts.mine}/${achvCounts.mineTotal} · 全队 ${achvCounts.team}/${achvCounts.teamTotal}`
                  : '从行程、打卡、照片和记账里自动算'}
              </div>
            </div>
            <Icon name="chevron" size={16} />
          </button>
        </div>

        <div className="section-title">账号</div>
        <div className="card-flat">
          <button
            className="cat-row"
            style={{ width: '100%', textAlign: 'left', background: 'none', border: 0, borderBottom: '1px solid var(--line)' }}
            onClick={() => setSheet('pass')}
          >
            <Icon name="lock" size={19} />
            <div className="grow">
              <div className="small strong">修改旅行口令</div>
              <div className="tiny dim">口令就是这趟旅行的钥匙，换一把；已登录的设备不会掉线</div>
            </div>
            <Icon name="chevron" size={16} />
          </button>
          <button className="btn danger" style={{ width: '100%', marginTop: 12 }} onClick={logout}>
            <Icon name="logout" size={16} /> 退出登录
          </button>
        </div>

        <div style={{ height: 12 }} />
      </div>

      {sheet === 'trip' && <TripEditor trip={trip} onClose={() => setSheet(null)} />}
      {sheet === 'members' && <MemberEditor members={members} onClose={() => setSheet(null)} />}
      {sheet === 'pass' && <PassphraseEditor onClose={() => setSheet(null)} />}
      {sheet === 'vocab' && <VocabManager vocab={vocab} onClose={() => setSheet(null)} />}
      {sheet === 'achv' && <Achievements onClose={() => setSheet(null)} />}
      {addingVocab && <VocabCreator kind={addingVocab} onClose={() => setAddingVocab(null)} />}
      {importDraft && <TemplateImportSheet draft={importDraft} trip={trip} onClose={() => setImportDraft(null)} />}
    </>
  );
}

/* ------------------------------ 旅行信息 ------------------------------ */

function TripEditor({ trip, onClose }) {
  const [form, setForm] = useState({
    name: trip.name || '',
    destination: trip.destination || '',
    startDate: trip.start_date || '',
    endDate: trip.end_date || '',
  });
  // DateField 回传字符串，其余原生框回传事件，两种都收。
  const set = (k) => (x) => setForm((f) => ({ ...f, [k]: x?.target ? x.target.value : x }));

  return (
    <Sheet title="编辑旅行信息" onClose={onClose}>
      <div className="stack">
        <Field label="名称">
          <Input value={form.name} onChange={set('name')} maxLength={60} />
        </Field>
        <Field label="目的地">
          <Input value={form.destination} onChange={set('destination')} placeholder="丽江 · 大理" maxLength={60} />
        </Field>
        <div className="grid-2">
          <Field label="出发日">
            <DateField value={form.startDate} onChange={set('startDate')} min={todayStr()} />
          </Field>
          <Field label="回来日">
            <DateField value={form.endDate} onChange={set('endDate')} min={form.startDate || todayStr()} />
          </Field>
        </div>
        <button
          className="btn primary"
          disabled={!form.name.trim() || !form.startDate || !form.endDate}
          onClick={async () => {
            await actions.patchTrip({
              name: form.name.trim(),
              destination: form.destination.trim(),
              startDate: form.startDate,
              endDate: form.endDate,
            });
            onClose();
          }}
        >
          保存
        </button>
      </div>
    </Sheet>
  );
}

/* ------------------------------ 成员 ------------------------------ */

function MemberEditor({ members, onClose }) {
  const [rows, setRows] = useState(members.map((m) => ({ id: m.id, name: m.name, color: m.color })));

  return (
    <Sheet title="同行成员" onClose={onClose}>
      <div className="stack">
        <div className="tiny dim">改名后，账本和分摊会跟着更新。</div>
        {rows.map((r, i) => (
          <div key={r.id} className="card-flat" style={{ padding: 12 }}>
            <Field label={`成员 ${i + 1}`}>
              <Input
                value={r.name}
                onChange={(e) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))}
                maxLength={24}
              />
            </Field>
            <div className="swatches" style={{ marginTop: 8 }}>
              {MEMBER_COLORS.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  style={{ background: c, outline: r.color === c ? `2px solid ${c}` : 'none', outlineOffset: 2 }}
                  onClick={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, color: c } : x)))}
                  aria-label={`颜色 ${c}`}
                />
              ))}
            </div>
          </div>
        ))}
        <button
          className="btn primary"
          onClick={async () => {
            for (const r of rows) await actions.patchMember(r.id, { name: r.name.trim() || r.name, color: r.color });
            onClose();
          }}
        >
          保存
        </button>
      </div>
    </Sheet>
  );
}

/* ------------------------------ 导入模板 ------------------------------ */

function TemplateImportSheet({ draft, trip, onClose }) {
  const [startDate, setStartDate] = useState(trip.start_date || todayStr());
  const [busy, setBusy] = useState(false);
  const days = draft.template.days || [];
  const total = days.reduce((s, d) => s + (d.nodes?.length || 0), 0);

  return (
    <Sheet title="导入行程模板" onClose={onClose}>
      <div className="stack">
        <div className="card-flat" style={{ padding: 14 }}>
          <div className="small strong truncate">{draft.fileName}</div>
          <div className="tiny dim" style={{ marginTop: 4 }}>
            共 {days.length} 天 · {total} 项行程。只新增节点，不动已有内容。
          </div>
        </div>
        <Field label="从哪一天开始铺" hint="模板的第 1 天对齐这一天，依次往后排">
          <DateField value={startDate} onChange={setStartDate} />
        </Field>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await actions.importTemplate({ template: draft.template, startDate });
              onClose();
            } catch {
              /* store 已经弹过提示 */
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '导入中…' : `导入 ${total} 项`}
        </button>
      </div>
    </Sheet>
  );
}

/* ------------------------------ 修改口令 ------------------------------ */

function PassphraseEditor({ onClose }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const tooShort = form.next.length > 0 && form.next.length < 6;
  const mismatch = form.confirm.length > 0 && form.next !== form.confirm;
  const same = form.next.length > 0 && form.next === form.current;
  const canSave = form.current && form.next.length >= 6 && !mismatch && !same;

  async function save() {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      await actions.changePassphrase(form.current, form.next);
      toast('口令已更新，下次登录用新口令', 'success');
      onClose();
    } catch {
      /* store 已经弹过提示了，面板留着让用户改完重试 */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="修改旅行口令" onClose={onClose}>
      <div className="stack">
        <p className="tiny dim" style={{ margin: 0 }}>
          改完立即生效。已经登录的设备不受影响，同伴下次登录要用新口令。
        </p>
        <Field label="当前口令">
          <Input
            type="password"
            autoComplete="current-password"
            value={form.current}
            onChange={set('current')}
          />
        </Field>
        <Field label="新口令" hint="至少 6 位，别用会被猜到的生日或手机号">
          <Input
            type="password"
            autoComplete="new-password"
            value={form.next}
            onChange={set('next')}
          />
        </Field>
        <Field label="再输一遍">
          <Input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
        </Field>
        {tooShort && <div className="tiny" style={{ color: 'var(--danger)' }}>新口令至少 6 位</div>}
        {mismatch && <div className="tiny" style={{ color: 'var(--danger)' }}>两遍新口令不一样</div>}
        {same && <div className="tiny" style={{ color: 'var(--danger)' }}>新口令和当前口令一样</div>}
        <button className="btn primary" disabled={!canSave || busy} onClick={save}>
          {busy ? '提交中…' : '更新口令'}
        </button>
      </div>
    </Sheet>
  );
}

/* ------------------------------ 词汇表 ------------------------------ */

function VocabManager({ vocab, onClose }) {
  const custom = [
    ...vocab.nodeTypes.filter((t) => t.custom).map((t) => ({ ...t, kind: 'node_type' })),
    ...vocab.categories.filter((c) => c.custom).map((c) => ({ ...c, kind: 'expense_category' })),
  ];

  return (
    <Sheet title="管理自定义项" onClose={onClose}>
      <div className="stack">
        <div className="tiny dim">只有你自定义的项能改或删。删掉之后，已经用这个类型的行程/消费会保留，只是失去图标和配色。</div>
        {custom.length === 0 ? (
          <Empty icon="bag" title="还没有自定义项" hint="在上一页可以加「露营」「油费」这类" />
        ) : (
          custom.map((c) => (
            <div key={`${c.kind}-${c.key}`} className="card-flat" style={{ padding: 12 }}>
              <div className="row-between">
                <span className="small strong" style={{ color: c.color }}>
                  <Glyph icon={c.icon} size={13} /> {c.label}
                </span>
                <span className="tiny dim">{c.kind === 'node_type' ? '行程类型' : '消费类别'}</span>
              </div>
              <div className="tiny dim" style={{ marginTop: 3 }}>key: {c.key}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="chip-btn"
                  onClick={async () => {
                    const label = prompt('改成什么名字？', c.label);
                    if (!label) return;
                    await actions.patchVocab(c.id, { label: label.trim() });
                  }}
                >
                  改名
                </button>
                <button
                  className="chip-btn"
                  onClick={async () => {
                    if (!(await askConfirm(`删掉「${c.label}」？`, { danger: true, confirmText: '删除' }))) return;
                    await actions.deleteVocab(c.id);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </Sheet>
  );
}

function VocabCreator({ kind, onClose }) {
  const [form, setForm] = useState({ label: '', icon: kind === 'node_type' ? 'pin' : 'wallet', color: '#00897B', leadMinutes: 30 });
  const isType = kind === 'node_type';

  return (
    <Sheet title={isType ? '新增行程类型' : '新增消费类别'} onClose={onClose}>
      <div className="stack">
        <Field label="名字">
          <Input autoFocus value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder={isType ? '比如：露营' : '比如：油费'} maxLength={20} />
        </Field>
        <Field label="图标" hint="直接粘一个 emoji">
          <div className="icongrid">
            {PICKABLE.map((k) => (
              <button
                key={k}
                type="button"
                className={`iconcell${form.icon === k ? ' on' : ''}`}
                onClick={() => setForm((f) => ({ ...f, icon: k }))}
                aria-label={k}
              >
                <Icon name={k} size={16} />
              </button>
            ))}
          </div>
        </Field>
        <Field label="颜色">
          <div className="swatches">
            {MEMBER_COLORS.map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c, outline: form.color === c ? `2px solid ${c}` : 'none', outlineOffset: 2 }}
                onClick={() => setForm((f) => ({ ...f, color: c }))}
                aria-label={`颜色 ${c}`}
              />
            ))}
          </div>
        </Field>
        {isType && (
          <Field label="提前多久出发（分钟）" hint="用来算「该出发了」的提醒，比如机场 120">
            <Input
              type="number"
              inputMode="numeric"
              value={form.leadMinutes}
              onChange={(e) => setForm((f) => ({ ...f, leadMinutes: e.target.value }))}
            />
          </Field>
        )}
        <button
          className="btn primary"
          disabled={!form.label.trim()}
          onClick={async () => {
            await actions.addVocab({
              kind,
              label: form.label.trim(),
              icon: form.icon,
              color: form.color,
              leadMinutes: Number(form.leadMinutes) || 0,
            });
            onClose();
          }}
        >
          添加
        </button>
      </div>
    </Sheet>
  );
}
