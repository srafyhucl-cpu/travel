/**
 * 把 web/src 里平台无关的代码同步到小程序工程。
 *
 * 单一事实来源是 web/src/core 和 web/src/store —— 这里只做复制，生成物加
 * 「勿手改」头注释；改完 web 侧跑一遍（在 miniprogram/ 目录下）：
 *   node scripts/sync-shared.mjs
 * 顺手用 web/node_modules 里的 esbuild 做全量语法检查（解析不执行），
 * 有语法错误直接退出码 1，免得在开发者工具里才发现。
 *
 * 另外把 agent/（微信AI 独立分包）要复用的 core 纯逻辑转成 CommonJS 落到
 * agent/lib/core/ —— 独立分包不能 require 主包，只能用「同一来源、双份产物」
 * 来保持单一事实来源；agent/lib 其余文件与各 SKILL 的 apis 都是手写的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB_ROOT = path.resolve(ROOT, '..', 'web');
const WEB_SRC = path.join(WEB_ROOT, 'src');

const HEADER =
  '/* 同步生成，勿手改：来源 web/src/core|store，跑 miniprogram/scripts/sync-shared.mjs 更新 */\n';
const AGENT_HEADER =
  '/* 同步生成，勿手改：来源 web/src/core，由 sync-shared.mjs 转 CommonJS 落到 agent/lib/core */\n';

/* agent 独立分包里被原子接口复用的 core 纯逻辑（均为单文件、无跨文件 import） */
const AGENT_SHARED_CORE = ['format.js', 'budget.js'];

const webRequire = createRequire(path.join(WEB_ROOT, 'package.json'));
let esbuild = null;
try {
  esbuild = webRequire('esbuild');
} catch {
  /* 没有 esbuild：agent/lib/core 生成与语法检查都跳过 */
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, HEADER + fs.readFileSync(src, 'utf8'));
  console.log('  ✓', path.relative(ROOT, dest));
}

/* 1. core 整个目录 + store 的两个平台无关文件 */
for (const name of fs.readdirSync(path.join(WEB_SRC, 'core'))) {
  if (name.endsWith('.js')) {
    copyFile(path.join(WEB_SRC, 'core', name), path.join(ROOT, 'core', name));
  }
}
for (const name of ['store.js', 'api.js']) {
  copyFile(path.join(WEB_SRC, 'store', name), path.join(ROOT, 'store', name));
}

/* 2. agent/lib/core：core 纯逻辑转 CommonJS（独立分包不能 require 主包） */
if (esbuild) {
  for (const name of AGENT_SHARED_CORE) {
    const src = fs.readFileSync(path.join(WEB_SRC, 'core', name), 'utf8');
    const out = esbuild.transformSync(src, { loader: 'js', format: 'cjs' }).code;
    const dest = path.join(ROOT, 'agent', 'lib', 'core', name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, AGENT_HEADER + out);
    console.log('  ✓', path.relative(ROOT, dest));
  }
} else {
  console.log('（没找到 web/node_modules/esbuild，跳过 agent/lib/core 生成）');
}

/* 3. 全量语法检查 */
function allJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allJs(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

if (esbuild) {
  const files = allJs(ROOT);
  let bad = 0;
  for (const file of files) {
    try {
      esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
        loader: 'js',
        format: 'esm',
        sourcefile: file,
      });
    } catch (e) {
      bad += 1;
      console.error('  ✗ 语法错误', path.relative(ROOT, file));
      console.error('    ', e.message.split('\n')[0]);
    }
  }
  console.log(bad ? `语法检查：${bad} 个文件有问题` : `语法检查：${files.length} 个 JS 全部通过（esbuild）`);
  if (bad) process.exit(1);
} else {
  console.log('（没找到 web/node_modules/esbuild，跳过语法检查）');
}

console.log('同步完成：core/ 与 store/ 都不要手改，改 web/src 再跑一遍。');
