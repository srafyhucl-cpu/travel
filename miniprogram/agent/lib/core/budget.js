/* 同步生成，勿手改：来源 web/src/core，由 sync-shared.mjs 转 CommonJS 落到 agent/lib/core */
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  computeBudget: () => computeBudget
});
module.exports = __toCommonJS(stdin_exports);
function computeBudget({ budgets = [], expenses = [] }) {
  const plannedTotal = budgets.reduce((s, b) => s + (+b.planned_amount || 0), 0);
  const actualTotal = expenses.reduce((s, e) => s + (+e.amount || 0), 0);
  const map = /* @__PURE__ */ new Map();
  for (const e of expenses) {
    const key = String(e.category || "misc");
    if (!map.has(key)) map.set(key, { category: key, actual: 0, count: 0 });
    const row = map.get(key);
    row.actual = round2(row.actual + (+e.amount || 0));
    row.count += 1;
  }
  const spent = [...map.values()].sort(
    (a, b) => b.actual - a.actual || a.category.localeCompare(b.category)
  );
  const paidMap = /* @__PURE__ */ new Map();
  for (const e of expenses) {
    const name = String(e.payer || "").trim() || "\u672A\u8BB0";
    if (!paidMap.has(name)) paidMap.set(name, { name, paid: 0, count: 0 });
    const row = paidMap.get(name);
    row.paid = round2(row.paid + (+e.amount || 0));
    row.count += 1;
  }
  const paid = [...paidMap.values()].sort((a, b) => b.paid - a.paid);
  return {
    plannedTotal,
    actualTotal,
    remaining: round2(plannedTotal - actualTotal),
    rate: plannedTotal > 0 ? actualTotal / plannedTotal : null,
    over: plannedTotal > 0 && actualTotal > plannedTotal,
    spent,
    paid
  };
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
