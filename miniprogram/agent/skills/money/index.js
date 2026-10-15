// 注册 tripMoney 的原子接口。
// 接口名必须与 mcp.json / SKILL.md 完全一致（含大小写）；path 与 app.json 的 agent.skills[].path 一致。
const { bootSkill } = require('../../lib/skill.js');

bootSkill({
  path: 'agent/skills/money',
  tag: 'money',
  apis: {
    addExpense: require('./apis/addExpense.js'),
    updateExpense: require('./apis/updateExpense.js'),
    deleteExpense: require('./apis/deleteExpense.js'),
    getExpenseSummary: require('./apis/getExpenseSummary.js'),
    listExpenses: require('./apis/listExpenses.js'),
  },
});
