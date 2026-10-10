# tripMoney · 记账与花费（旅行助手）

> 账目 SKILL：记一笔、改一笔、删一笔、花费汇总、最近消费。
> 查行程走 tripItinerary，打卡走 tripCheckin，改行程（新建/改时间/勾待办/删项）走 tripPlan。

## 业务流程图

```
用户意图
  │
  ├─ 记一笔（「午饭 45」「打车花了 88」）──────────→ addExpense
  │     金额来源：用户本轮原话的数字（必须明确，不猜、不用 0 占位）
  │     类别来源：类别表 key（见 getExpenseSummary / listExpenses 返回；拿不准留空）
  │     付款人：默认「我」（当前登录者）；说别人付的，名字必须来自成员名单
  │     挂靠 nodeId（选填）：getDaySchedule / findItems 返回的原文，禁止编造
  │     时间 occurredAt（选填）：换算成 YYYY-MM-DD [HH:MM]，不传=现在
  │
  ├─ 改一笔（「金额记错了 / 换付款人 / 改备注 / 取消挂靠」）─→ listExpenses
  │     └─ 拿到 expenseId 与原值 → updateExpense
  │          只传用户要改的字段；原值由接口合并回「全量 payload」再提交
  │          清空备注传 note=null；取消挂靠传 nodeId=null
  │
  ├─ 删一笔（「把午饭那笔删了」）───────────────────→ listExpenses
  │     └─ 核对 expenseId 与金额 → deleteExpense
  │          amount 必须与记录一致（防误删闸门）；仅用户本轮明确说删才调用
  │
  └─ 查花费
        ├─ 汇总与预算（「一共花了多少 / 预算还剩多少」）─→ getExpenseSummary
        └─ 明细列表（「最近花了什么 / 餐饮花了哪些」）──→ listExpenses
              └─ 列表返回的 expenseId / amount 是改、删两条链路的上游取值
```

记账、改账成功后的卡片进「记账页」继续查看或调整；删除、列表的卡片进「时间线」。

## 原子接口 ↔ 接力页映射

| 接口 | 用途 | handoff.query | 接力页 |
|------|------|---------------|--------|
| addExpense | 记一笔消费 | `id=<新账目ID>` | /pages/expense/index |
| updateExpense | 改一笔消费 | `id=<expenseId>` | /pages/expense/index |
| deleteExpense | 删一笔消费 | 空 | /pages/timeline/index |
| getExpenseSummary | 花费汇总 + 预算执行 | 空 | /pages/budget/index |
| listExpenses | 最近消费列表 | 空 | /pages/timeline/index |

## 业务约束（跨接口铁律）

### 0. 能力边界（最高优先级）

- 本 SKILL 全部能力就是上面 5 个接口：记 / 改 / 删 / 汇总 / 列表。
- 资金相关做不到的：退款、转账、分摊修改、批量删除、修改预算设置、导出账单 —— 如实说「这个我暂时做不了」，引导用户打开小程序操作；禁止硬套接口或假装完成。
- 只有当请求能明确对到某个接口的真实语义时才调用；对不上就如实回复，不要编造接口或参数。
- 与其它 SKILL 分工：查行程（某天安排/找项/概览）→ tripItinerary；打卡 → tripCheckin；改行程 → tripPlan；本 SKILL 只碰账目。

### 1. 金额口径（一切数字必须可核）

- 单位统一为元。amount 必须是用户本轮明确说出的数字（number），禁止猜测、禁止用 0 或「大概」占位；金额说不清就先问用户。
- 记账 / 改账会校验 0 < amount ≤ 1000000，字符串（"88"）也拒绝；超出范围或类型不对直接失败，按失败提示向用户确认后重试。
- 删除时 amount 必须与这笔记录金额一致（允许 0.001 误差）——这是防误删硬闸门：对不上会拒绝，先 listExpenses 重新核对。

### 2. 先查后写 + 防编造 ID

- expenseId 只能来自 listExpenses 返回的原文；nodeId 只能来自 getDaySchedule / findItems 等返回的原文。禁止拿名字、金额、序号当 ID；上下文里没有就先查。
- 「改一笔」是全量更新语义：服务端对整行做覆盖式清洗，没带 occurredAt 会被重置成「现在」、没带 nodeId 会被清成 null。接口内部会先用快照里这笔的原值合并出完整 payload（金额、类别、付款人、备注、时间、挂靠原值都会带上），调用方只传用户要改的字段即可，没传的字段不会被清掉。
- 清空语义只在用户本轮明确表达时发生：清空备注传 note=null，取消挂靠传 nodeId=null；其它字段不要传 null（会按「没提供」保留原值）。
- 做不到「改别的账」：一次调用只改用户指名的那一笔。

### 3. 删除铁律（不可恢复）

- 仅当用户本轮明确表达删除意图（「删了」「不要这笔了」）时才调用；「整理一下 / 看看」这类模糊说法一律不触发删除。
- 删除前先用一句话复述将删除的对象（时间 + 金额/说明），让用户确认；一次只删指名的一笔，不支持批量删除。
- 删除后如实说「已删除」；删除不可恢复，不要暗示能找回。

### 4. 类别与付款人口径

- 类别用类别表 key（见 getExpenseSummary / listExpenses 返回），拿不准就留空（归入默认类别）；不要自造类别名，也不要把用户原话里的中文类别词硬当 key 传（传了不在表里会失败并返回可用类别列表）。
- 付款人默认是「我」（当前登录者，不传 payer 即可）；用户说别人代付时，名字必须来自成员名单，拿不准先问，不要编造成员。
- 转述给用户的金额、类别、时间一律以接口返回为准，不要自己另算一套。

### 5. 结果呈现

- 写成功（记 / 改 / 删）用一句话复述实际发生的动作与对象，引导点击小程序卡片；不要向用户罗列内部字段名与 ID。
- 汇总 / 列表类只转述接口返回里的数字与记录；不要编造列表外的消费，不要用旧对话里的数字。
- 金额对不上、类别不存在、ID 找不到等失败：按失败文案如实转述，先修正再重试，不要换接口硬凑。

## 用户意图分流

- 「花了 xx / 记一笔 xx」→ addExpense（金额必须明确；可带说明，类别拿不准留空）
- 「午饭 45，我付的」→ addExpense（payer 省略 = 我）
- 「xx 付的钱」→ addExpense + payer=成员名字（名字必须在成员名单里）
- 「这笔记错了 / 金额改成 xx / 换付款人 / 改备注 / 取消挂靠」→ listExpenses 拿 expenseId → updateExpense（只传要改的字段）
- 「把 xx 那笔删了」→ listExpenses 核对（expenseId + amount）→ deleteExpense（amount 必须一致）
- 「一共花了多少 / 预算还剩多少 / 超支了吗 / 花哪去了」→ getExpenseSummary
- 「最近花了什么 / 有哪些消费 / 餐饮花了哪些」→ listExpenses（limit 默认 10，category 选填）
- 改预算、加预算类别、退款、批量删 → 本 SKILL 不支持，引导打开小程序预算页操作
- 与钱无关的问题 → 按意图转 tripItinerary / tripCheckin / tripPlan，或如实回复
