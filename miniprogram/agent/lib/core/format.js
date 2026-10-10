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
  addDays: () => addDays,
  categoryMeta: () => categoryMeta,
  daysBetween: () => daysBetween,
  formatDate: () => formatDate,
  formatMoney: () => formatMoney,
  relativeDay: () => relativeDay,
  tintOf: () => tintOf,
  toMinutes: () => toMinutes,
  todayStr: () => todayStr,
  typeMeta: () => typeMeta
});
module.exports = __toCommonJS(stdin_exports);
const PAD = (n) => String(n).padStart(2, "0");
function toMinutes(t) {
  if (typeof t !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const WEEKDAY = ["\u5468\u65E5", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D"];
function formatDate(dateStr, opts = {}) {
  if (!dateStr) return "";
  const d = /* @__PURE__ */ new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const md = `${d.getMonth() + 1}\u6708${d.getDate()}\u65E5`;
  if (opts.short) return md;
  return `${md} ${WEEKDAY[d.getDay()]}`;
}
function todayStr(now = /* @__PURE__ */ new Date()) {
  return `${now.getFullYear()}-${PAD(now.getMonth() + 1)}-${PAD(now.getDate())}`;
}
function addDays(dateStr, n) {
  const d = /* @__PURE__ */ new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}
function daysBetween(a, b) {
  return Math.round((/* @__PURE__ */ new Date(`${b}T00:00:00`) - /* @__PURE__ */ new Date(`${a}T00:00:00`)) / 864e5);
}
function relativeDay(dateStr, now = /* @__PURE__ */ new Date()) {
  const diff = daysBetween(todayStr(now), dateStr);
  if (diff === 0) return "\u4ECA\u5929";
  if (diff === 1) return "\u660E\u5929";
  if (diff === 2) return "\u540E\u5929";
  if (diff === -1) return "\u6628\u5929";
  return diff > 0 ? `${diff} \u5929\u540E` : `${-diff} \u5929\u524D`;
}
function formatMoney(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const cents = Math.abs(v % 1) > 1e-4;
  return v.toLocaleString(
    "zh-CN",
    cents ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 }
  );
}
function tintOf(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return "rgba(47,128,237,0.12)";
  const n = parseInt(h, 16);
  return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, 0.12)`;
}
const FALLBACK = { key: "other", label: "\u5176\u4ED6", icon: "ring", color: "#6B7280", soft: "#F1F3F5", leadMinutes: 30, custom: false };
function typeMeta(vocab, key) {
  return vocab?.byKey?.[key] || { ...FALLBACK, key, label: key || FALLBACK.label };
}
function categoryMeta(vocab, key) {
  return vocab?.categories?.find((c) => c.key === key) || { ...FALLBACK, key, label: key || FALLBACK.label };
}
