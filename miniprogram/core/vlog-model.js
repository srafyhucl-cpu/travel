/* 同步生成，勿手改：来源 web/src/core|store，跑 miniprogram/scripts/sync-shared.mjs 更新 */
/**
 * 行程长图的纯数据模型：分组、选片、预算行。
 * 不碰 DOM / Canvas —— 渲染在 platform/web/canvas.js，小程序端可以原样复用这里的逻辑。
 */
import { computeBudget } from './budget.js';

/** 每个节点最多带几张、整趟最多带几张 */
const LONG_MAX_PHOTOS = 6;
const LONG_MAX_PER_NODE = 2;

export function buildLongImageModel({ trip, nodes, expenses, photos, checkins, budgets, members, vocab } = {}) {
  const list = (nodes || []).filter((n) => n && n.date);
  const exps = expenses || [];
  const pics = photos || [];

  const expenseByNode = new Map();
  for (const e of exps) {
    if (!e.node_id) continue;
    if (!expenseByNode.has(e.node_id)) expenseByNode.set(e.node_id, []);
    expenseByNode.get(e.node_id).push(e);
  }
  const loose = exps.filter((e) => !e.node_id);

  const photoByNode = new Map();
  for (const p of pics) {
    if (!p.node_id) continue;
    if (!photoByNode.has(p.node_id)) photoByNode.set(p.node_id, []);
    photoByNode.get(p.node_id).push(p);
  }
  const doneByNode = new Set((checkins || []).filter((c) => c.action === 'done').map((c) => c.node_id));

  const dates = [...new Set(list.map((n) => n.date))].sort();
  const days = dates.map((d) => ({ date: d, nodes: list.filter((n) => n.date === d) }));

  const budget = computeBudget({ budgets: budgets || [], expenses: exps });

  return {
    trip: trip || {},
    vocab: vocab || {},
    members: members || [],
    days,
    loose,
    expenseByNode,
    photoByNode,
    doneByNode,
    budget,
    actualTotal: budget.actualTotal,
    totalDays: dates.length,
    nodeCount: list.length,
    photoTotal: pics.length,
  };
}

/** 哪些节点带头几张照片：每项最多 2 张、整趟最多 6 张 */
export function pickPhotosByNode(model) {
  const pick = new Map();
  let total = 0;
  for (const day of model.days) {
    for (const n of day.nodes) {
      const list = model.photoByNode.get(n.id) || [];
      const take = [];
      for (const p of list) {
        if (take.length >= LONG_MAX_PER_NODE || total >= LONG_MAX_PHOTOS) break;
        take.push(p.id);
        total += 1;
      }
      if (take.length) pick.set(n.id, take);
    }
  }
  return pick;
}
