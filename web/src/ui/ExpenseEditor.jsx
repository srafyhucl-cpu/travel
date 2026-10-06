import React, { useState } from 'react';
import { Sheet, Field, Input, Glyph } from './bits.jsx';
import { DateTimeField, NodePickField } from './pickers.jsx';

/*
 * 时间选择框收发的都是本地墙钟时间（YYYY-MM-DDTHH:mm），库里存的是 UTC。
 * 必须走这一层转换：以前直接把库里的 UTC 时间 slice 出来当本地时间显示，保存时
 * 又按本地时间转一次 UTC，同一笔每打开保存一轮就早 8 小时。
 */
const localInputValue = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};

export default function ExpenseEditor({ draft, vocab, members, me, nodes, onClose, onSave, onDelete }) {
  const e = draft.expense;
  const isNew = !e;
  const [form, setForm] = useState({
    amount: e?.amount ?? '',
    category: e?.category || 'food',
    payer: e?.payer || me || members[0]?.name || '我',
    note: e?.note || '',
    occurredAt: localInputValue(e?.occurred_at),
    nodeId: e?.node_id || draft.node?.id || '',
  });
  // 同上：DateTimeField / NodePickField 回传字符串，其余原生框回传事件。
  const set = (k) => (x) => setForm((f) => ({ ...f, [k]: x?.target ? x.target.value : x }));

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
                  {m.name === me && <span className="me-tag">我</span>}
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
            <DateTimeField value={form.occurredAt} onChange={set('occurredAt')} />
          </Field>
          <Field label="挂在">
            <NodePickField nodes={nodes} value={form.nodeId} onChange={set('nodeId')} emptyLabel="不指定" />
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
