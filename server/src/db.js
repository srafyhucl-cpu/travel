import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
export const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_PATH = path.join(DATA_DIR, 'travel.db');

fs.mkdirSync(PHOTO_DIR, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  destination TEXT,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  theme       TEXT,
overview    TEXT,
  is_template INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 口令 = 这趟旅行的钥匙。key_hash 是 sha256(pepper + 口令)
CREATE TABLE IF NOT EXISTS trip_keys (
  id           TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  label        TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id                TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_index         INTEGER NOT NULL,
  date              TEXT NOT NULL,
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  start_time        TEXT,
  end_time          TEXT,
  location          TEXT,
  nav_keyword       TEXT,
  notes             TEXT,
  checklist         TEXT,
  transport_minutes INTEGER,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'planned',
  actual_start      TEXT,
  actual_end        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_trip ON nodes(trip_id, date, sort_order);

CREATE TABLE IF NOT EXISTS budgets (
  id             TEXT PRIMARY KEY,
  trip_id        TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  vocab_key      TEXT,
  planned_amount REAL NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expenses (
  id           TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  node_id      TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  category     TEXT NOT NULL,
  amount       REAL NOT NULL,
  payer        TEXT NOT NULL,
  participants TEXT,
  occurred_at  TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id, occurred_at);

CREATE TABLE IF NOT EXISTS checkins (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  at_time    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkins_node ON checkins(node_id, at_time);

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  node_id    TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  caption    TEXT,
  taken_at   TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_trip ON photos(trip_id, created_at);

-- 词汇表：行程类型、消费类别都是数据，不是代码。trip_id 为 NULL 表示全局默认。
CREATE TABLE IF NOT EXISTS vocab (
id          TEXT PRIMARY KEY,
trip_id     TEXT REFERENCES trips(id) ON DELETE CASCADE,
kind        TEXT NOT NULL,          -- node_type | expense_category
key         TEXT NOT NULL,
label       TEXT NOT NULL,
icon        TEXT,
color       TEXT,
soft        TEXT,
lead_minutes INTEGER NOT NULL DEFAULT 30,   -- 提醒/日历提前量
sort_order  INTEGER NOT NULL DEFAULT 0,
created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_unique
ON vocab(IFNULL(trip_id, ''), kind, key);
`;

db.exec(SCHEMA);

// 老库平滑升级：以后加字段在这里补一句 ALTER TABLE
function ensureColumn(table, column, definition) {
const cols = db.prepare(`PRAGMA table_info(${table})`).all();
if (!cols.some((c) => c.name === column)) {
db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
}

ensureColumn('trips', 'overview', 'TEXT');
// 预算行的自由名称（如「机票·去程」）要映射到消费类别 key，才能对得上账
ensureColumn('budgets', 'vocab_key', 'TEXT');
ensureColumn('vocab', 'created_at', "TEXT NOT NULL DEFAULT ''");

/*
* 默认词汇表。这里是「出厂设置」，用户可以在 App 里随时增删改，
* 所以行程类型和消费类别不是写死在代码里的枚举。
*/
const DEFAULT_VOCAB = [
  ['node_type', 'flight',   '航班', 'plane',  '#2F80ED', '#EAF2FE', 180],
  ['node_type', 'train',    '火车', 'train',  '#7B61FF', '#F0EDFF', 60],
  ['node_type', 'car',      '用车', 'car',    '#27AE60', '#E8F7EF', 60],
  ['node_type', 'hotel',    '住宿', 'bed',    '#E2574C', '#FDECEA', 90],
  ['node_type', 'spot',     '景点', 'pin',    '#F2994A', '#FEF3E6', 30],
  ['node_type', 'meal',     '用餐', 'bowl',   '#EB5757', '#FDECEC', 20],
  ['node_type', 'shopping', '购物', 'bag',    '#9B51E0', '#F4EDFF', 20],
  ['node_type', 'other',    '其他', 'ring',   '#6B7280', '#F1F3F5', 30],
  ['expense_category', 'food',      '餐饮', 'bowl',   '#EB5757', '#FDECEC', 0],
  ['expense_category', 'transit',   '交通', 'route',  '#27AE60', '#E8F7EF', 0],
  ['expense_category', 'ticket',    '门票', 'ticket', '#F2994A', '#FEF3E6', 0],
  ['expense_category', 'shop',      '购物', 'bag',    '#9B51E0', '#F4EDFF', 0],
  ['expense_category', 'stay',      '酒店', 'bed',    '#E2574C', '#FDECEA', 0],
  ['expense_category', 'fuel',      '油费', 'fuel',   '#2F80ED', '#EAF2FE', 0],
  ['expense_category', 'gear',      '装备', 'pack',   '#7B61FF', '#F0EDFF', 0],
  ['expense_category', 'flightfee', '机票', 'plane',  '#2F80ED', '#EAF2FE', 0],
  ['expense_category', 'misc',      '其他', 'ring',   '#6B7280', '#F1F3F5', 0],
];

{
const ins = db.prepare(
`INSERT OR IGNORE INTO vocab (id, trip_id, kind, key, label, icon, color, soft, lead_minutes, sort_order)
VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
);
DEFAULT_VOCAB.forEach((row, i) => ins.run(uid(), ...row, i * 10));
}

/*
 * 早期版本往 vocab.icon 里存的是 emoji，渲染出来和旁边的细线图标不是一套语言。
 * 这里把存量数据一次性换成图标名（对应 web/src/ui/glyphs.js），
 * 只动还在用出厂 emoji 的行，用户自己填的一律不碰。
 */
const EMOJI_TO_GLYPH = {
  '\u2708': 'plane',
  '\uD83D\uDE84': 'train',
  '\uD83D\uDE97': 'car',
  '\uD83C\uDFE0': 'bed',
  '\uD83D\uDCCD': 'pin',
  '\uD83C\uDF5C': 'bowl',
  '\uD83D\uDECD': 'bag',
  '\uD83D\uDCCC': 'ring',
  '\uD83C\uDFAB': 'ticket',
  '\u26FD': 'fuel',
  '\uD83C\uDF92': 'pack',
};
{
  // 同一个 emoji 可能带不带变体选择符（U+FE0F）落库，先剥掉再查表，否则会漏掉一半
  const bare = (s) => String(s || '').replace(/[\uFE0E\uFE0F]/g, '');
  const upd = db.prepare('UPDATE vocab SET icon = ? WHERE id = ?');
  let n = 0;
  for (const row of db.prepare('SELECT id, icon FROM vocab').all()) {
    const name = EMOJI_TO_GLYPH[bare(row.icon)];
    if (name) {
      upd.run(name, row.id);
      n++;
    }
  }
  if (n) console.log('词表图标已升级为线性图标：' + n + ' 条');
}

/*
 * sort_order 以前是「每一天各自从 0 开始」排的，拖拽要跨天就分不出先后了。
 * 这里按 (日期, 原顺序) 重排成一条贯穿整趟行程的全局序列，幂等，每次启动跑一遍。
 */
{
  const rows = db.prepare('SELECT id FROM nodes ORDER BY trip_id, date, sort_order, start_time').all();
  const upd = db.prepare('UPDATE nodes SET sort_order = ? WHERE id = ?');
  const tx = db.transaction(() => rows.forEach((r, i) => upd.run(i * 10, r.id)));
  tx();
}

export function nowISO() {
  return new Date().toISOString();
}

export function uid() {
  return crypto.randomUUID();
}
