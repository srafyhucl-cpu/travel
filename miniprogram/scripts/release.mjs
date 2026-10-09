/**
 * 小程序发布助手：提审 → 查状态 → 发布，一步一步来；AppSecret 只从环境变量读。
 *
 * 微信没给 miniprogram-ci 提审 / 发布能力，这两个动作只能走 HTTP 接口，前置条件两个：
 *   1) AppSecret：mp.weixin.qq.com → 开发管理 → 开发设置 → AppSecret（拿到后只放环境变量）
 *   2) 调用机器的公网 IP 在「IP 白名单」里（接口报 40164 就是这一步没做）
 * 代码包上传不在这里做：先在开发者工具里「上传」，再回来提审。
 *
 * 用法（在 miniprogram/ 下）：
 *   $env:WX_APPSECRET = "小程序的 AppSecret"
 *
 *   node scripts/release.mjs token        # 验证 AppID / AppSecret / IP 白名单（只读）
 *   node scripts/release.mjs status       # 看最近一次审核状态（只读）
 *   node scripts/release.mjs submit       # 提交最新开发版审核（默认只提审行程页）
 *   node scripts/release.mjs submit --item "pages/timeline/index|行程时间线|旅行 记录" --desc "首个正式版本"
 *   node scripts/release.mjs release      # 审核通过后发布上线
 *   node scripts/release.mjs undo         # 撤回审核（提审信息写错了用）
 *   node scripts/release.mjs auto --yes   # 给计划任务用：审核通过就直接发布
 *
 * 约定：
 *   - 写操作（submit / release / undo / auto 走到发布那步）在交互终端里会先确认；
 *     非交互环境（计划任务、CI）必须显式加 --yes，防止手滑。
 *   - --item 可重复，最多 5 条，格式：页面路径|标题|标签（标题、标签可省略）。
 *   - --dry-run 只打印将要发送的请求，不联网。
 *   - 环境变量：WX_APPSECRET（必填）；WX_APPID 覆盖 project.config.json 的 appid；
 *     WX_API_BASE 换接口地址（联调测试用，默认 https://api.weixin.qq.com）。
 *
 * 退出码：0 成功 / 1 微信侧拒绝或状态不满足 / 2 用法、网络或脚本自身问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const API_BASE = (process.env.WX_API_BASE || 'https://api.weixin.qq.com').replace(/\/+$/, '');
const SECRET = process.env.WX_APPSECRET || '';

/** 审核状态：官方文档当前取值；没见过的值原样显示，不猜。 */
const STATUS_TEXT = {
  0: '审核成功（可发布）',
  1: '审核被拒绝',
  2: '审核中',
  3: '已撤回',
  4: '审核延后',
};
/** 这几个错误码是「配置问题」而不是「业务状态」，遇到直接按失败退出。 */
const CONFIG_ERRORS = new Set([40001, 40013, 40014, 40125, 40164, 42001, 45009]);

const argv = process.argv.slice(2);
const CMD = argv[0] || '';
const YES = argv.includes('--yes') || argv.includes('-y');
const DRY_RUN = argv.includes('--dry-run');

const hasFlag = (name) => argv.includes(name);
function valuesOf(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  return out;
}
const valueOf = (name) => valuesOf(name)[0];

/** 用法/环境问题：退出码 2；微信拒绝：退出码 1；成功：0。 */
function fail(msg, code = 2) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function hintOf(errcode) {
  switch (errcode) {
    case 40001:
    case 40125:
      return 'AppSecret 不对（或后台重置过）：核对 mp.weixin.qq.com → 开发管理 → 开发设置';
    case 40013:
      return 'AppID 不对：核对 project.config.json 里的 appid';
    case 40164:
      return '本机公网 IP 不在白名单：把 errmsg 里的那个 IP 加到 mp.weixin.qq.com → 开发管理 → 开发设置 → IP 白名单（加完等几分钟生效）';
    case 45009:
      return '接口调用次数超限（access_token 每天 2000 次），明天再试';
    default:
      return '';
  }
}

function appId() {
  if (process.env.WX_APPID) return process.env.WX_APPID;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'project.config.json'), 'utf8'));
    if (cfg.appid) return cfg.appid;
  } catch {
    /* 下面统一报错 */
  }
  fail('读不到 AppID：project.config.json 里没有 appid，也没有设 WX_APPID');
}

async function request(method, pathname, { query, body } = {}) {
  const url = new URL(API_BASE + pathname);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    fail(`请求微信接口失败（${method} ${pathname}）：${e.message}`, 2);
  }
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(`微信接口返回了非 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`, 2);
  }
}

/** 业务错误直接退出 1；返回体保持原样，调用方自己取字段。 */
function assertOk(data, what) {
  if (data.errcode && data.errcode !== 0) {
    const hint = hintOf(data.errcode);
    fail(`${what}失败：${data.errcode} ${data.errmsg}${hint ? `\n  → ${hint}` : ''}`, 1);
  }
  return data;
}

async function getToken() {
  if (!SECRET) {
    fail('缺少 WX_APPSECRET 环境变量。先设置：$env:WX_APPSECRET = "小程序的 AppSecret"', 2);
  }
  const data = await request('GET', '/cgi-bin/token', {
    query: { grant_type: 'client_credential', appid: appId(), secret: SECRET },
  });
  assertOk(data, '获取 access_token');
  return data.access_token;
}

/** 最近一次审核状态：读不到（例如从没提审过）时不硬报错，交给调用方决定。 */
async function readLatest(token) {
  const data = await request('GET', '/wxa/get_latest_auditstatus', { query: { access_token: token } });
  return data.errcode && data.errcode !== 0 ? { ok: false, data } : { ok: true, data };
}

const statusText = (s) => STATUS_TEXT[s] ?? `未知状态（${s}）`;

function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return String(ts);
  return new Date(n > 1e12 ? n : n * 1000).toLocaleString('zh-CN', { hour12: false });
}

function printStatus(s) {
  console.log(`  auditid：${s.auditid ?? '-'}`);
  console.log(`  状态：${statusText(s.status)}`);
  console.log(`  版本：${s.user_version ?? '-'}（${s.user_desc ?? '无版本说明'}）`);
  if (s.submit_audit_time) console.log(`  提交时间：${fmtTime(s.submit_audit_time)}`);
  if (s.status === 1 && s.reason) console.log(`  拒绝原因：${s.reason}`);
}

async function confirm(question) {
  if (YES) return;
  if (!process.stdin.isTTY) {
    fail(`非交互环境，确认后请加 --yes 重跑：${question}`, 2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`? ${question} [y/N] `, resolve));
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log('已取消，没有执行任何写操作。');
    process.exit(0);
  }
}

function parseItems() {
  const raws = valuesOf('--item');
  if (raws.length !== argv.filter((a) => a === '--item').length) fail('--item 后面缺少取值（格式：页面路径|标题|标签）');
  if (!raws.length) raws.push('pages/timeline/index|行程时间线|旅行 记录');
  if (raws.length > 5) fail('item_list 最多 5 条（--item 重复次数超了）');
  return raws.map((raw) => {
    const [address, title, tag] = raw.split('|').map((s) => (s || '').trim());
    if (!address) fail(`--item 缺少页面路径：${raw}`);
    const item = { address };
    if (title) item.title = title;
    if (tag) item.tag = tag;
    return item;
  });
}

/* -------------------------------- 命令 -------------------------------- */

async function cmdToken() {
  if (DRY_RUN) {
    console.log('（--dry-run）将请求：GET /cgi-bin/token（appid + secret 取自环境）');
    return;
  }
  const token = await getToken();
  console.log(`✓ AppID / AppSecret 可用，access_token 已取到（${String(token).length} 字符，有效期 7200 秒）`);
  console.log(`  AppID：${appId()}`);
  console.log('  能走到这一步，说明本机公网 IP 也在白名单里。');
}

async function cmdStatus() {
  const token = await getToken();
  const r = await readLatest(token);
  if (!r.ok) {
    const { errcode, errmsg } = r.data;
    console.error(`✗ 查不到最近审核状态：${errcode} ${errmsg}${hintOf(errcode) ? `\n  → ${hintOf(errcode)}` : ''}`);
    console.error('  （如果这个小程序还没提审过，这条报错属正常状态）');
    process.exit(CONFIG_ERRORS.has(errcode) ? 1 : 0);
  }
  printStatus(r.data);
}

async function cmdSubmit() {
  const items = parseItems();
  const body = { item_list: items };
  const desc = valueOf('--desc');
  if (desc) body.version_desc = desc;

  console.log(`AppID：${appId()}`);
  console.log('即将提交审核：');
  for (const it of items) console.log(`  - ${it.address}  「${it.title || ''}」${it.tag ? ` # ${it.tag}` : ''}`);
  if (desc) console.log(`  版本说明：${desc}`);

  if (DRY_RUN) {
    console.log(`\n（--dry-run）将发送：POST /wxa/submit_audit\n${JSON.stringify(body, null, 2)}`);
    return;
  }

  const token = await getToken();
  const r = await readLatest(token);
  if (r.ok) {
    const s = r.data;
    if (s.status === 2) {
      fail(`已有审核中的版本（auditid=${s.auditid}，${s.user_version ?? ''}），等结果或先 undo 撤回再提`, 1);
    }
    if (s.status === 0) {
      console.log('注意：最近一版已审核通过、还没发布；直接提审新版本可能就发不了这一版了（要先 release 就先 Ctrl+C）。');
    }
  } else {
    console.log(`（读不到最近审核状态：${r.data.errcode} ${r.data.errmsg}，继续提审，微信侧还会再校验）`);
  }

  await confirm('确认提交审核？');
  const res = assertOk(await request('POST', '/wxa/submit_audit', { query: { access_token: token }, body }), '提交审核');
  console.log(`✓ 已提交审核，auditid=${res.auditid}。之后用 status 查进度。`);
}

function guardApproved(s) {
  if (!s) return;
  if (s.status === 2) fail(`还在审核中（auditid=${s.auditid}），先等结果；审核被拒的话看 status 里的原因`, 1);
  if (s.status === 1) fail(`上一次审核被拒，不能发布。原因：${s.reason || '（status 命令可看全文）'}`, 1);
  if (s.status !== 0) fail(`最近一次审核状态是「${statusText(s.status)}」，不是「审核成功」，不能发布`, 1);
}

async function cmdRelease() {
  if (DRY_RUN) {
    console.log('（--dry-run）将发送：POST /wxa/release（空 JSON body）');
    return;
  }
  const token = await getToken();
  const r = await readLatest(token);
  if (!r.ok) {
    fail(`读不到最近审核状态（${r.data.errcode} ${r.data.errmsg}），先跑 status 看看，确认有审核通过的版本再发布`, 1);
  }
  guardApproved(r.data);
  console.log('最近一次审核：');
  printStatus(r.data);
  await confirm(`确认把版本「${r.data.user_version ?? ''}」发布到线上？`);
  assertOk(await request('POST', '/wxa/release', { query: { access_token: token }, body: {} }), '发布');
  console.log('✓ 已发布上线。后台「版本管理」里能看到线上版本，C 端会逐步生效。');
}

async function cmdUndo() {
  if (DRY_RUN) {
    console.log('（--dry-run）将请求：GET /wxa/undocodeaudit');
    return;
  }
  await confirm('确认撤回当前审核？（撤回后要重新提审）');
  const token = await getToken();
  assertOk(await request('GET', '/wxa/undocodeaudit', { query: { access_token: token } }), '撤回审核');
  console.log('✓ 已撤回。改好上传后重新 submit 即可。');
}

async function cmdAuto() {
  if (DRY_RUN) {
    console.log('（--dry-run）流程：查最新审核状态；若为「审核成功」则 POST /wxa/release');
    return;
  }
  const token = await getToken();
  const r = await readLatest(token);
  if (!r.ok) {
    fail(`读不到最近审核状态：${r.data.errcode} ${r.data.errmsg}`, 1);
  }
  const s = r.data;
  printStatus(s);
  if (s.status !== 0) {
    console.log(`✓ 还没到发布时机（${statusText(s.status)}）${s.status === 1 ? `：${s.reason || ''}` : ''}`);
    process.exit(s.status === 1 ? 1 : 0);
  }
  await confirm(`审核已通过，确认发布版本「${s.user_version ?? ''}」？`);
  assertOk(await request('POST', '/wxa/release', { query: { access_token: token }, body: {} }), '发布');
  console.log('✓ 审核通过，已自动发布上线。');
}

function usage() {
  console.log(`小程序发布助手（在 miniprogram/ 下跑）

  $env:WX_APPSECRET = "小程序的 AppSecret"

  node scripts/release.mjs token        验证 AppID / AppSecret / IP 白名单（只读）
  node scripts/release.mjs status       查最近一次审核状态（只读）
  node scripts/release.mjs submit       提交最新开发版审核（--item "路径|标题|标签"，最多 5 条）
  node scripts/release.mjs release      审核通过后发布上线
  node scripts/release.mjs undo         撤回审核
  node scripts/release.mjs auto         查状态：通过就直接发布（计划任务用）

  写操作加 --yes 跳过确认；--dry-run 只打印将发送的请求，不联网。

  上传代码包不在这里做：开发者工具「上传」→ 再回来 submit。`);
}

/* -------------------------------- 入口 -------------------------------- */

switch (CMD) {
  case 'token':
    await cmdToken();
    break;
  case 'status':
    await cmdStatus();
    break;
  case 'submit':
    await cmdSubmit();
    break;
  case 'release':
    await cmdRelease();
    break;
  case 'undo':
    await cmdUndo();
    break;
  case 'auto':
    await cmdAuto();
    break;
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;
  case '':
    usage();
    process.exit(2);
    break;
  default:
    fail(`不认识命令「${CMD}」。可用：token / status / submit / release / undo / auto`, 2);
}
