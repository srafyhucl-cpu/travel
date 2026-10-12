/**
 * 一键体检：一条命令看清「这个仓库 + 线上服务」还健不健康。
 *
 *   node tools/checkup.mjs
 *
 * 覆盖：
 *   1. 仓库状态（当前分支、未提交改动提示）
 *   2. 生成物同步核对（跑 sync-shared.mjs，再看 miniprogram/core|store 有没有 diff）
 *   3. platform/wx 只读检查（check-platform.mjs；需要 PASS=口令，没设就跳过）
 *   4. 微信AI agent 只读检查（check-agent.mjs 存在时；需要 PASS，没设就跳过）
 *   5. 线上冒烟：/api/health、/api/trip/rev 部署状态、快照接口鉴权是否正常
 *
 * 只读：不会改线上数据，也不会写除生成物以外的文件。退出码 0=通过（含跳过），1=有失败。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const PROD = process.env.CHECKUP_BASE || 'https://travel.hclstudio.cn';

const results = []; // { name, status: 'ok'|'fail'|'skip'|'warn', detail }

function record(name, status, detail = '') {
  results.push({ name, status, detail });
  const icon = { ok: '✓', fail: '✗', skip: '—', warn: '!' }[status] || '?';
  console.log(`${icon} ${name}${detail ? '  —— ' + detail : ''}`);
}

function runNode(args, { cwd = ROOT, env = {} } = {}) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function countChecks(out) {
  const okCount = (out.match(/[✓✔]/g) || []).length;
  const failLines = out
    .split(/\r?\n/)
    .filter((l) => /[✗✘]/.test(l) || /\bFAIL\b/.test(l));
  return { okCount, failLines };
}

/* -------- 1. 仓库状态 -------- */
console.log('\n== 仓库 ==');
{
  const branch = spawnSync('git', ['-C', ROOT, 'branch', '--show-current'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
  record('当前分支', 'ok', branch || '(未知)');
  if (dirty) {
    const lines = dirty.split(/\r?\n/);
    record('工作区', 'warn', `有 ${lines.length} 处未提交改动（体检本身不受影响）`);
  } else {
    record('工作区', 'ok', '干净');
  }
}

/* -------- 2. 生成物同步 -------- */
console.log('\n== 生成物同步（miniprogram/core|store ← web/src） ==');
{
  const r = runNode([path.join('scripts', 'sync-shared.mjs')], { cwd: MP });
  if (r.status !== 0) {
    record('sync-shared 执行', 'fail', (r.stderr || '').split(/\r?\n/).slice(-3).join(' ').slice(0, 200));
  } else {
    record('sync-shared 执行', 'ok', '语法检查通过');
    const diff = spawnSync('git', ['-C', ROOT, 'diff', '--stat', '--', 'miniprogram/core', 'miniprogram/store'], {
      encoding: 'utf8',
    }).stdout.trim();
    if (diff) {
      record('生成物与 web/src 一致', 'fail', '跑完 sync 仍有 diff —— 把生成物一起提交：' + diff.split(/\r?\n/).slice(-1)[0]);
    } else {
      record('生成物与 web/src 一致', 'ok');
    }
  }
}

/* -------- 3. 平台只读检查 -------- */
console.log('\n== platform/wx 只读检查（打真站） ==');
const PASS = process.env.PASS;
if (!PASS) {
  record('check-platform', 'skip', '未设置 PASS 口令（PASS=你的口令 node tools/checkup.mjs）');
} else {
  const r = runNode([path.join('scripts', 'check-platform.mjs')], { cwd: MP });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const { okCount, failLines } = countChecks(out);
  if (r.status === 0) record('check-platform', 'ok', `${okCount} 项通过`);
  else record('check-platform', 'fail', failLines.slice(0, 3).join(' | ').slice(0, 300));
}

/* -------- 4. agent 只读检查（存在才跑） -------- */
const agentCheck = path.join(MP, 'scripts', 'check-agent.mjs');
if (fs.existsSync(agentCheck)) {
  console.log('\n== 微信AI agent 只读检查 ==');
  if (!PASS) {
    record('check-agent', 'skip', '未设置 PASS 口令');
  } else {
    const r = runNode([path.join('scripts', 'check-agent.mjs')], { cwd: MP });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const { okCount, failLines } = countChecks(out);
    if (r.status === 0) record('check-agent', 'ok', `${okCount} 项通过`);
    else record('check-agent', 'fail', failLines.slice(0, 3).join(' | ').slice(0, 300));
  }
}

/* -------- 5. 线上冒烟 -------- */
console.log('\n== 线上冒烟 ==');
{
  const t0 = Date.now();
  try {
    const r = await fetch(`${PROD}/api/health`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (r.ok && j.ok) record('服务健康 /api/health', 'ok', `${ms}ms · node ${j.node || '?'} · uptime ${j.uptime ?? '?'}s`);
    else record('服务健康 /api/health', 'fail', `status=${r.status}`);
  } catch (e) {
    record('服务健康 /api/health', 'fail', String(e.message).slice(0, 120));
  }

  // rev 端点的部署状态要靠「带令牌」才能区分：未部署=404，已部署=200
  //（不能只看未带令牌的 401 —— /api/trip/* 整组都有鉴权中间件，旧版也返回 401）
  try {
    let token = null;
    if (PASS) {
      const lr = await fetch(`${PROD}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: PASS, name: process.env.NAME || '龙哥' }),
        signal: AbortSignal.timeout(8000),
      });
      if (lr.ok) {
        token = (await lr.json()).token || null;
        record('口令登录', 'ok');
      } else {
        record('口令登录', 'fail', `status=${lr.status}（PASS 不对或服务异常）`);
      }
    }
    if (!token) {
      record('版本号端点 /api/trip/rev', 'skip', '需要 PASS 登录后才能确认部署状态');
    } else {
      const r = await fetch(`${PROD}/api/trip/rev`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        record('版本号端点 /api/trip/rev', 'ok', `已部署（rev=${j.rev}）`);
      } else if (r.status === 404) {
        record('版本号端点 /api/trip/rev', 'warn', '服务端还是旧版（未部署 rev）——客户端会自动退回全量轮询');
      } else {
        record('版本号端点 /api/trip/rev', 'warn', `非预期状态 ${r.status}`);
      }
    }
  } catch (e) {
    record('版本号端点 /api/trip/rev', 'fail', String(e.message).slice(0, 120));
  }

  try {
    const r = await fetch(`${PROD}/api/trip/snapshot`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 401) record('快照接口鉴权', 'ok', '未带令牌返回 401');
    else record('快照接口鉴权', 'warn', `未带令牌返回 ${r.status}（预期 401）`);
  } catch (e) {
    record('快照接口鉴权', 'fail', String(e.message).slice(0, 120));
  }
}

/* -------- 汇总 -------- */
const fails = results.filter((r) => r.status === 'fail').length;
const warns = results.filter((r) => r.status === 'warn').length;
const skips = results.filter((r) => r.status === 'skip').length;
console.log(`\n========== 体检结果：${results.length - fails - warns - skips} 通过 / ${warns} 提醒 / ${fails} 失败 / ${skips} 跳过 ==========`);
if (fails) {
  console.log('失败项：');
  for (const f of results.filter((r) => r.status === 'fail')) console.log(`  ✗ ${f.name}  ${f.detail}`);
}
process.exit(fails ? 1 : 0);
