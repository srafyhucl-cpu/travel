// 注册 tripItinerary 的原子接口。
// 接口名必须与 mcp.json / SKILL.md 完全一致（含大小写）；path 与 app.json 的 agent.skills[].path 一致。
const { bootSkill } = require('../../lib/skill.js');

bootSkill({
  path: 'agent/skills/itinerary',
  tag: 'itinerary',
  apis: {
    getTripOverview: require('./apis/getTripOverview.js'),
    getDaySchedule: require('./apis/getDaySchedule.js'),
    findItems: require('./apis/findItems.js'),
    getTodos: require('./apis/getTodos.js'),
  },
});
