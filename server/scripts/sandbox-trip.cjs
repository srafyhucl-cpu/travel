#!/usr/bin/env node
/**
 * 沙盒行程：把某个真实行程整份克隆成一个独立的「测试」行程，供随便折腾。
 *
 *   - 只读源行程：克隆不写、不改、不删源行程的任何一行/一个文件；
 *   - 沙盒有自己的口令与自己的照片文件（删沙盒照片不会碰源照片）；
 *   - 重置 = 再跑一次 clone（内部先删旧沙盒再拷一份新的）；
 *   - 用完 drop 掉，数据库里不留痕。
 *
 * 用法（在服务器上；本地也可以用，--data 指向一份数据副本）：
 *   node server/scripts/sandbox-trip.cjs clone --data /opt/apps/travel/data \
 *        --from-pass yunnan2026 --sandbox-pass 1234
 *   node server/scripts/sandbox-trip.cjs drop --data /opt/apps/travel/data \
 *        --sandbox-pass 1234
 *
 * 退出码：0 成功 / 1 用法或数据问题。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0];
const DATA_DIR = path.resolve(args.data || '/opt/apps/travel/data');
const DB_FILE = path.join(DATA_DIR, 'travel.db');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DERIVED_DIR = path.join(PHOTO_DIR, 'derived');

if (!['clone', 'drop'].includes(mode) || !args['sandbox-pass']) {
  console.error('用法：node sandbox-trip.cjs clone|drop --data <数据目录> --sandbox-pass <沙盒口令> [--from-pass <源行程口令>]');
  process.exit(1);
}
if (!fs.existsSync(DB_FILE) || !fs.existsSync(path.join(DATA_DIR, '.pepper'))) {
  console.error(`数据目录不完整（缺 travel.db 或 .pepper）：${DATA_DIR}`);
  process.exit(1);
}

/* ------------------------------ 基础 ------------------------------ */

const db = new Database(DB_FILE);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const uid = () => crypto.randomUUID();

const PEPPER = fs.readFileSync(path.join(DATA_DIR, '.pepper'), 'utf8').trim();
const hashPass = (p) => crypto.createHash('sha256').update(`${PEPPER}:${p}`, 'utf8').digest('hex');

function findTripByPass(pass) {
  const k = db.prepare('SELECT * FROM trip_keys WHERE key_hash = ?').get(hashPass(pass));
  return k ? db.prepare('SELECT * FROM trips WHERE id = ?').get(k.trip_id) : null;
}

/* 行程指纹：证明「克隆前后源行程一个字节都没动」 */
const FP_TABLES = ['trip_keys', 'members', 'vocab', 'nodes', 'checkins', 'expenses', 'budgets', 'photos'];
function fingerprint(tripId) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId)));
  for (const table of FP_TABLES) {
    for (const r of db.prepare(`SELECT * FROM ${table} WHERE trip_id = ? ORDER BY id`).all(tripId)) {
      h.update(JSON.stringify(r));
    }
  }
  return h.digest('hex');
}

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* 不存在最正常不过 */
  }
}

function insertRow(table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`).run(row);
}

/** 只重映射这一行里确实存在的引用列（老库没有的列别硬塞） */
function remapRefs(row, { nodeMap, memberMap }) {
  const out = { ...row };
  if ('node_id' in row) out.node_id = row.node_id ? nodeMap.get(row.node_id) || null : null;
  if ('member_id' in row) out.member_id = row.member_id ? memberMap.get(row.member_id) || null : null;
  return out;
}

/* ------------------------------ drop ------------------------------ */

function dropSandbox(quiet = false) {
  const trip = findTripByPass(args['sandbox-pass']);
  if (!trip) {
    if (!quiet) console.log('没有找到沙盒行程（口令不对，或已经删过了）');
    return false;
  }
  // 先删文件（行删了就找不到文件名了），再按表清行
  const photos = db.prepare('SELECT id, filename FROM photos WHERE trip_id = ?').all(trip.id);
  for (const p of photos) {
    unlinkQuiet(path.join(PHOTO_DIR, p.filename));
    for (const v of ['thumb', 'display']) unlinkQuiet(path.join(DERIVED_DIR, `${p.id}-${v}.jpg`));
  }
  const tx = db.transaction(() => {
    for (const table of ['checkins', 'photos', 'expenses', 'budgets', 'nodes', 'vocab', 'members', 'trip_keys']) {
      db.prepare(`DELETE FROM ${table} WHERE trip_id = ?`).run(trip.id);
    }
    db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
  });
  tx();
  if (!quiet) console.log(`沙盒已删除：「${trip.name}」· 行已清、${photos.length} 张照片文件已删`);
  return true;
}

/* ------------------------------ clone ------------------------------ */

function clone() {
  const src = findTripByPass(args['from-pass']);
  if (!src) {
    console.error('找不到源行程：--from-pass 不对？');
    process.exit(1);
  }
  const before = fingerprint(src.id);

  // 旧沙盒先清掉（重复跑 = 重置）
  dropSandbox(true);

  const newTripId = uid();

  /* --- 第一步：全部只读，把映射和数据备齐（此时不动库也不动文件） --- */
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(src.id);
  const members = db.prepare('SELECT * FROM members WHERE trip_id = ?').all(src.id);
  const memberMap = new Map(members.map((m) => [m.id, uid()]));
  const vocab = db.prepare('SELECT * FROM vocab WHERE trip_id = ?').all(src.id);
  const nodes = db.prepare('SELECT * FROM nodes WHERE trip_id = ?').all(src.id);
  const nodeMap = new Map(nodes.map((n) => [n.id, uid()]));
  const checkins = db.prepare('SELECT * FROM checkins WHERE trip_id = ?').all(src.id);
  const expenses = db.prepare('SELECT * FROM expenses WHERE trip_id = ?').all(src.id);
  const budgets = db.prepare('SELECT * FROM budgets WHERE trip_id = ?').all(src.id);
  const srcPhotos = db.prepare('SELECT * FROM photos WHERE trip_id = ?').all(src.id);
  const srcKey = db.prepare('SELECT * FROM trip_keys WHERE trip_id = ? LIMIT 1').get(src.id);

  /* --- 第二步：先把照片原图复制成新文件名（成功一张收一张） --- */
  const photoJobs = [];
  for (const p of srcPhotos) {
    const from = path.join(PHOTO_DIR, p.filename);
    if (!fs.existsSync(from)) continue; // 源文件缺了就跳过这张，别让整次克隆失败
    const to = `${uid()}${path.extname(p.filename) || ''}`;
    const dest = path.join(PHOTO_DIR, to);
    try {
      fs.copyFileSync(from, dest);
    } catch {
      continue;
    }
    photoJobs.push({
      row: { ...remapRefs(p, { nodeMap, memberMap }), id: uid(), trip_id: newTripId, filename: to },
      file: dest,
    });
  }

  /* --- 第三步：一把事务全部入库；失败就把刚复制的文件清掉，不留孤儿 --- */
  try {
    const tx = db.transaction(() => {
      insertRow('trips', { ...trip, id: newTripId, name: `【测试】${trip.name}` });
      for (const m of members) insertRow('members', { ...m, id: memberMap.get(m.id), trip_id: newTripId });
      for (const v of vocab) insertRow('vocab', { ...v, id: uid(), trip_id: newTripId });
      for (const n of nodes) insertRow('nodes', { ...n, id: nodeMap.get(n.id), trip_id: newTripId });
      for (const c of checkins) insertRow('checkins', { ...remapRefs(c, { nodeMap, memberMap }), id: uid(), trip_id: newTripId });
      for (const e of expenses) insertRow('expenses', { ...remapRefs(e, { nodeMap, memberMap }), id: uid(), trip_id: newTripId });
      for (const b of budgets) insertRow('budgets', { ...b, id: uid(), trip_id: newTripId });
      for (const j of photoJobs) insertRow('photos', j.row);
      insertRow('trip_keys', { ...srcKey, id: uid(), trip_id: newTripId, key_hash: hashPass(args['sandbox-pass']) });
    });
    tx();
  } catch (e) {
    for (const j of photoJobs) unlinkQuiet(j.file);
    throw e;
  }

  const after = fingerprint(src.id);
  const same = before === after;
  console.log(`沙盒行程已就绪：${newTripId}`);
  console.log(`  口令：${args['sandbox-pass']}`);
  console.log(
    `  内容：${nodes.length} 行程 · ${expenses.length} 消费 · ${photoJobs.length} 照片（源缺文件跳过 ${srcPhotos.length - photoJobs.length}）· ${checkins.length} 打卡 · ${members.length} 成员 · ${budgets.length} 预算 · ${vocab.length} 词汇`
  );
  console.log(`  源行程指纹：${before.slice(0, 12)} → ${after.slice(0, 12)} ${same ? '（未改动 ✓）' : '（!! 变了，停下检查）'}`);
  if (!same) process.exit(1);
}

/* ------------------------------ 入口 ------------------------------ */

console.log(`数据目录：${DATA_DIR}`);
if (mode === 'clone') clone();
else dropSandbox();
db.close();
