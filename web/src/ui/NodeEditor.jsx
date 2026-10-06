import React, { useState } from 'react';
import { Sheet, Field, Input, Switch, Glyph } from './bits.jsx';
import { DateField, TimeField } from './pickers.jsx';
import ChecklistInput from './ChecklistInput.jsx';
import { normalizeItems } from '../core/checklist.js';

export default function NodeEditor({ draft, vocab, dates, onClose, onSave, onDelete }) {
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
    checklist: normalizeItems(n.checklist),
    role: n.role || null,
  });
  const [showNav, setShowNav] = useState(false);
  // 自有控件回传字符串、原生 input 回传事件，这里两种都收：
  // 判一下有没有 target，没有的话这个参数本身就是值。
  const set = (k) => (x) => setForm((f) => ({ ...f, [k]: x?.target ? x.target.value : x }));

  /*
   * 必填就是标题和日期。按钮置灰了却不说为什么，得让人知道是哪一格没填，
   * 而不是以为手机卡了。
   */
  const missing = [];
  if (!form.title.trim()) missing.push('标题');
  if (!form.date) missing.push('日期');
  return (
    <Sheet
      title={isNew ? '新增行程' : '编辑行程'}
      onClose={onClose}
      footer={
        <>
          {missing.length > 0 && <div className="req-missing tiny">还差：{missing.join('、')}</div>}
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
                // 存的是对象数组：编辑只动文字，勾没勾带着走（id 也是），
                // 不然每保存一次，模块里勾掉的就都白勾了。
                checklist: form.checklist
                  .map((it) => ({ ...it, text: it.text.trim() }))
                  .filter((it) => it.text)
                  .map((it) => ({ id: it.id, text: it.text, done: it.done, done_at: it.done ? it.done_at : null })),
                role: form.role === 'module' ? 'module' : null,
              })
            }
          >
            {isNew ? '添加' : '保存'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="标题" required>
          <Input
            value={form.title}
            onChange={set('title')}
            placeholder="例如：云杉坪索道"
            maxLength={80}
            autoFocus={isNew}
          />
        </Field>

        <Field label="代办" hint="回车加下一条，右边的 ✕ 删掉这一条">
          <ChecklistInput
            items={form.checklist}
            onChange={(checklist) => setForm((f) => ({ ...f, checklist }))}
          />
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

        <Field label="首页模块" hint="在「现在」卡下面单独显示一份，时间线上照常保留">
          <Switch
            on={form.role === 'module'}
            onChange={(v) => setForm((f) => ({ ...f, role: v ? 'module' : null }))}
            label="作为模块置顶显示"
          />
        </Field>

        <div className="grid-2">
          <Field label="日期" required>
            <DateField value={form.date} onChange={set('date')} />
          </Field>
          <Field label="开始">
            <TimeField value={form.startTime} onChange={set('startTime')} />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="结束">
            <TimeField value={form.endTime} onChange={set('endTime')} />
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
