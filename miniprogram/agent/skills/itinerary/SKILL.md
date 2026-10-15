# tripItinerary · 行程查询（旅行助手）

> 只读 SKILL：回答「去哪玩、安排了什么、玩到哪了、还有什么待办」。
> 修改行程请走 tripPlan，打卡请走 tripCheckin，记账请走 tripMoney。

## 业务流程图

```
用户意图
  │
  ├─ 总览类（"这次安排是啥/玩到哪天了/还剩多少"）─→ getTripOverview
  │
  ├─ 某天类（"今天/明天/第 3 天有什么安排"）─────→ getDaySchedule（date 缺省=今天）
  │
  ├─ 找具体安排（"雪山是哪天/有没有看表演"）──────→ findItems（keyword 取自用户原话）
  │      └─ 拿到结果的 nodeId 后，可继续：打卡(checkIn) / 挂账(addExpense) / 改行程(updateItem)
  │
  └─ 待办类（"还有什么没准备的/充电宝带了没"）────→ getTodos（默认今天+出行准备）
```

所有接口都返回「文本 + 小程序卡片」：卡片点击后 handoff 进入小程序时间线（或按日期定位到当天）。

## 原子接口 ↔ 接力页映射

| 接口 | 用途 | handoff.query | 接力页 |
|------|------|---------------|--------|
| getTripOverview | 旅行全貌、进度、下一项 | 空 | /pages/timeline/index |
| getDaySchedule | 某天行程列表 | `date=YYYY-MM-DD` | /pages/timeline/index |
| findItems | 按关键词找行程项 | 单项命中时带 `date=` | /pages/timeline/index |
| getTodos | 未完成待办 | 空 | /pages/timeline/index |

## 业务约束（跨接口铁律）

### 0. 能力边界（最高优先级）

- 本 SKILL 全部能力就是上面 4 个接口。**只读**，不能修改、删除、新建任何数据。
- 用户要求改/删/加行程或打卡时：直接告诉他「可以帮你改/打卡」，并按 `SKILL.md` 映射转到对应 SKILL（tripPlan / tripCheckin）的能力去办；没有对应能力时如实说暂不支持，禁止硬套接口。
- 判断依据：只有当用户意图能明确对到某个接口的真实语义时才调用；对不上就如实回复，不要编造接口或参数。

### 1. 输出形态

- 检索/列表类结果以**简短口述 + 小程序卡片**呈现：按时间顺序转述关键字段（日期、时间、标题、状态），不要长篇铺陈备注、待办明细等细节。
- 解释性、知识性问答（如"第 3 天是几号"）正常用文本回复。

### 2. 数据口径（防编造）

- **nodeId 只能用接口返回的原文**（getDaySchedule / findItems / getTodos 的 `items[].nodeId`），禁止从用户语言推断、禁止使用示例值；上下文里没有 nodeId 就先查。
- 「今天/明天」按对话发生的当前日期换算；「第 N 天」按旅行开始日期推算；**换算结果要以接口返回的 `dayText` 为准**，不要自己另算一套。
- 接口已经给出 `timeText`（如「待定」）、`statusText`（未开始/进行中/已完成/已跳过）、`checklistText`，直接转述，不要改写含义。

### 3. 空结果与错误

- 某天没有安排：如实说「这天没有安排」，不要造内容；用户想看别的日期再查一次，或用卡片引导去添加。
- findItems 零命中：如实告知没找到；可以建议换关键词；**禁止用相同关键词重复调用**。
- 接口返回 isError 时：按 content 里的事实和出口处理，不要绕路重试别的接口硬凑。

## 用户意图分流

- 「这次旅行/玩到哪了/还剩多少/下一项」→ getTripOverview
- 「今天/明天/后天有什么安排」→ getDaySchedule（不传 date）
- 「第 N 天/10 月 X 日」→ getDaySchedule（换算成具体日期再传）
- 「XX 是哪天/安排在哪/有没有 XX」→ findItems
- 「还没去的还有哪些」→ findItems + onlyRemaining=true
- 「待办/还有什么没准备」→ getTodos
- 「整趟还有哪些待办没勾」→ getTodos + scope=all
- 要改行程 / 打卡 / 记账 → 分别交给 tripPlan / tripCheckin / tripMoney 的能力（本 SKILL 只负责查）
- 与行程无关的问题（天气、订票等）→ 如实说不属于本小程序的能力，不要编
