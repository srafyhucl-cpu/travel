# tripCheckin · 行程打卡（旅行助手）

> 写 SKILL：记录「到了 / 出发、离开 / 完成」。
> 查询请走 tripItinerary；改行程请走 tripPlan。

## 业务流程图

```
用户说「我们到雪山了 / 要去吃饭了 / 古城逛完了」
  │
  ├─ 上下文里已有该行程项的 nodeId？
  │     没有 → 先查：findItems（知道名字，如「雪山」）
  │            或 getDaySchedule（就是现在/今天这一项）
  │            ← 拿到 nodeId 再继续
  │
  ├─ 动作选择：到达→arrived；出发、离开→departed；完成、搞定→done
  │     拿不准 → 先问一句「是到了、离开还是完成？」再调用
  │
  └─ checkIn（nodeId + action）
        → 文本确认 + 小程序卡片（点击进时间线看当天状态）
```

## 业务约束（跨接口铁律）

### 0. 能力边界（最高优先级）

- 本 SKILL 只有 `checkIn` 一个接口：**只记录打卡**。
- 不支持：撤销打卡、修改/删除行程项、顺延时间、批量打卡。用户要这些 → 如实说明，能转 tripPlan / tripItinerary 的转过去，不能的引导打开小程序操作。
- 只有能对到 `checkIn` 真实语义的请求才调用；对不上就如实回复，不要硬调。

### 1. 先查后打（铁律）

- `nodeId` 必须来自 getDaySchedule / findItems / getTodos 的返回原文。
- 禁止猜 nodeId、禁止用示例值、禁止拿行程项名字当 nodeId 传。
- 用户说的项在当天安排里找不到 → 如实说没找到，建议换个说法或到时间线里看看，**不要**挑一个"差不多的"打卡。

### 2. 动作口径

- 「到了 / 抵达 / 入场了」→ arrived
- 「出发 / 走了 / 离开 / 返程了」→ departed
- 「逛完了 / 搞定了 / 完成了」→ done
- 一句话里有多个动作（"到了，逛完直接去吃饭"）→ 只记录**当前**发生的那个（这里是 arrived）；后续动作等用户说。
- 拿不准 → 先问一句，不要默认成 done。
- **目标项已完成也照打不误**：用户明确说「到了 / 出发了」就正常调用 checkIn——arrived / departed 本来就可以
  多次记录（反复进出、补记都正常），不要因为「该项已完成」「行程已结束」而拒绝打卡或只复述不记录；
  只有「完成」（done）类对已完成项可能去重（接口返回 alreadyDone 时如实转告即可）。

### 3. 结果呈现

- 打卡成功：用一句话确认（项名 + 动作），不展开其它内容；卡片进时间线即可。
- 返回 alreadyDone（重复报完成）：如实告诉用户「这一项早就完成了」，不要重复调用。

## 用户意图分流

- 「到 XX 了」→ 查 nodeId 后 checkIn(arrived)
- 「出发去 XX / 离开 XX」→ 查 nodeId 后 checkIn(departed)
- 「XX 逛完了/搞定了」→ 查 nodeId 后 checkIn(done)
- 「打卡记录给我看看」→ 转 tripItinerary 的 getDaySchedule/getTripOverview 看状态
- 「撤销打卡 / 改打卡时间」→ 暂不支持，引导打开小程序
