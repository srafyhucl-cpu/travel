// 注册 tripCheckin 的原子接口。
// 接口名必须与 mcp.json / SKILL.md 完全一致（含大小写）；path 与 app.json 的 agent.skills[].path 一致。
const { bootSkill } = require('../../lib/skill.js');

bootSkill({
  path: 'agent/skills/checkin',
  tag: 'checkin',
  apis: {
    checkIn: require('./apis/checkIn.js'),
  },
});
