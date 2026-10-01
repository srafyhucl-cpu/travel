/**
 * 静态自查：把 web/src 里所有具名 import 跟目标模块的实际 export 对一遍。
 * 抓的是「import 了但没导出」这类问题——它不会让打包失败，却会在运行时
 * 变成 undefined，报错点还常常在别的文件里，很难查。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    fs.statSync(p).isDirectory() ? walk(p) : /\.(js|jsx)$/.test(f) && files.push(p);
  }
})(SRC);

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(src)) names.add('default');
  if (/export\s*\*/.test(src)) names.add('*');
  return names;
}

let problems = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s+'(\.[^']+)'/g)) {
    const target = path.resolve(path.dirname(file), m[3]);
    const resolved = ['', '.js', '.jsx'].map((e) => target + e).find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!resolved) {
      console.log(`✗ ${path.relative(SRC, file)}  找不到模块 ${m[3]}`);
      problems++;
      continue;
    }
    const available = exportsOf(resolved);
    for (const raw of m[2].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!available.has(name) && !available.has('*')) {
        console.log(`✗ ${path.relative(SRC, file)}  从 ${m[3]} 导入了 { ${name} }，但它没有导出`);
        problems++;
      }
    }
  }
}

console.log(problems ? `\n发现 ${problems} 个问题` : `✓ 全部具名 import 都能对上（共检查 ${files.length} 个文件）`);
process.exit(problems ? 1 : 0);
