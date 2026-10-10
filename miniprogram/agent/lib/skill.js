/**
 * 每个 SKILL 的 index.js 共用引导：
 * createSkill → 日志中间件 → requireLogin 包裹 → registerAPI。
 *
 * apis 传 { 接口名: 实现函数 }，键的顺序就是注册顺序；
 * 接口名必须与 mcp.json / SKILL.md 完全一致（含大小写）。
 */
const { requireLogin } = require('./respond.js');

function bootSkill({ path, tag, apis }) {
  const skill = wx.modelContext.createSkill(path);

  skill.use(async (ctx, next) => {
    const started = Date.now();
    try {
      await next();
    } finally {
      // 观测用：接口名与耗时；真正的错误详情由 requireLogin 打
      console.log(`[agent][${tag}] ${ctx.name} ${Date.now() - started}ms`);
    }
  });

  const names = Object.keys(apis);
  for (const name of names) {
    skill.registerAPI(name, requireLogin(apis[name]));
  }
  console.log(`[agent][${tag}] ${names.length} 个原子接口已注册`);
}

module.exports = { bootSkill };
