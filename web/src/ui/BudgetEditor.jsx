import React, { useState } from 'react';
import { Sheet, Field, Input } from './bits.jsx';
import { actions, toast } from '../store/store.js';

export default function BudgetEditor({ budgets, onClose }) {
  const current = budgets.reduce((s, b) => s + (+b.planned_amount || 0), 0);
  const [amount, setAmount] = useState(current > 0 ? String(current) : '');
  const [busy, setBusy] = useState(false);

  async function save() {
    const value = Number(amount || 0);
    if (!Number.isFinite(value) || value < 0) {
      toast('填一个有效的金额', 'warn');
      return;
    }
    setBusy(true);
    try {
      await actions.setTotalBudget(value, budgets);
      onClose();
    } catch {
      /* store 已经弹过提示了 */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="总预算" onClose={onClose}>
      <div className="stack">
        <Field label="总预算" hint="整趟一个数，0 表示不设">
          <Input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(ev) => setAmount(ev.target.value)}
            placeholder="0"
          />
        </Field>
        <button className="btn primary" disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </Sheet>
  );
}
