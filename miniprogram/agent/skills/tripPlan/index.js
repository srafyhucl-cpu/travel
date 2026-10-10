// 注册 tripPlan 的原子接口。
// 接口名必须与 mcp.json / SKILL.md 完全一致（含大小写）；path 与 app.json 的 agent.skills[].path 一致。
const { bootSkill } = require('../../lib/skill.js');

bootSkill({
  path: 'agent/skills/tripPlan',
  tag: 'tripPlan',
  apis: {
    createItem: require('./apis/createItem.js'),
    updateItem: require('./apis/updateItem.js'),
    setTodo: require('./apis/setTodo.js'),
    deleteItem: require('./apis/deleteItem.js'),
  },
});
