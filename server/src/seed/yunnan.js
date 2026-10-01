/**
 * 预填行程数据 —— 全部来自出发前那轮反复核对的结果。
 * 时间、航班号、价格、坑点提示都按最终确认的版本写死。
 */

export const TRIP = {
  name: '云南四日 · 丽江大理',
  destination: '丽江 · 大理',
  startDate: '2026-10-01',
  endDate: '2026-10-04',
  theme: 'plain',
};

export const NODES = [
  /* ===================== 10/1 周三 · 北京 → 丽江 ===================== */
  {
    date: '2026-10-01',
    type: 'flight',
    title: '首都航空 JD5181 · 北京大兴 → 丽江三义',
    startTime: '16:30',
    endTime: '19:50',
    location: '北京大兴国际机场',
    navKeyword: '北京大兴国际机场',
    transportMinutes: 70,
    notes:
      '去程已出票。\n\n【起飞前】\n· 16:30 到大兴，值机柜台一般提前 2 小时开，40 分钟足够\n· JD5181 是廉航（首都航空/海航系），0 件免费托运，你只带随身\n· 充电宝必须随身，不能托运\n\n【落地】\n· 23:10 落地丽江三义机场\n· 机场到丽江古城约 30–40 分钟车程，打车 ¥60–80\n\n【重要】\n· 落地已经 23:10，到酒店大概 23:40，一定提前跟映象酒店确认 late check-in，否则可能在门口干等',
    checklist: ['充电宝放随身（不能托运）', '确认映象酒店 late check-in', '落地打车钱备好，约 ¥60–80'],
  },
  {
    date: '2026-10-01',
    type: 'hotel',
    title: '入住 映象酒店（丽江古水木华店）',
    startTime: '23:40',
    endTime: '23:59',
    location: '映象酒店（丽江古水木华店）',
    navKeyword: '映象酒店 丽江古水木华店',
    notes: '全景观大床房，含双早。国庆价位 ¥274/晚，连住 2 晚。\n\n住的是丽江古城里的民宿，不是连锁商务房，晚上出门吃饭走路就到。',
    checklist: ['确认能否 late check-in（23:40 到店）'],
  },

  /* ===================== 10/2 周四 · 丽江 ===================== */
  {
    date: '2026-10-02',
    type: 'spot',
    title: '玉龙雪山 · 云杉坪索道 + 蓝月谷',
    startTime: '07:00',
    endTime: '13:00',
    location: '玉龙雪山景区',
    navKeyword: '玉龙雪山景区 云杉坪',
    transportMinutes: 30,
    notes:
      '门票 ¥290/人 × 2 = ¥580。\n\n【好消息】这份票不含大索道（冰川公园索道），是「古维费 + 云杉坪索道 + 蓝月谷」，所以不需要抢国庆限流票，已经稳了。\n\n【现场另付】\n· 环保车票\n· 羽绒服租赁费（山上冷）\n\n【注意】\n· 海拔 4506m，基础旅游意外险通常不保高原反应\n· 提前吃点东西再上山，别空着\n· 索道排队时间可能很长，穿舒服的鞋',
    checklist: ['带厚外套/羽绒服', '防晒', '充电宝随身', '现场买环保车票 + 羽绒服租赁'],
  },
  {
    date: '2026-10-02',
    type: 'spot',
    title: '丽江古城 · 闲逛',
    startTime: '14:00',
    endTime: '18:00',
    location: '丽江古城',
    navKeyword: '丽江古城',
    transportMinutes: 25,
    notes: '雪山下来回酒店休息完，下午逛古城。古城住宿步行可达，不用打车。',
  },
  {
    date: '2026-10-02',
    type: 'meal',
    title: '晚餐 宋河鱼火',
    startTime: '18:30',
    endTime: '20:00',
    location: '宋河鱼火（丽江）',
    navKeyword: '宋河鱼火 丽江',
    notes: '丽江本地鱼火锅，Trip 行程单里推荐的那家。',
  },

  /* ===================== 10/3 周五 · 丽江 → 大理 ===================== */
  {
    date: '2026-10-03',
    type: 'car',
    title: '包车：丽江 → 大理',
    startTime: '09:00',
    endTime: '12:00',
    location: '映象酒店 → 大理',
    transportMinutes: 0,
    notes:
      '包车 ¥1,400 / 4 天，丽江到大理这段含在里面，高速约 2.5–3 小时。\n\n【建议】上午退房出发后直接去双廊，别先回大理酒店放行李——双廊/小普陀/理想邦都是下午看日落的地方，先去龙龛放行李再折返会白白浪费一下午。\n\n司机在大理古城门口等，不用去火车站。',
    checklist: ['退房前检查充电器、身份证', '行李放后备箱'],
  },
  {
    date: '2026-10-03',
    type: 'spot',
    title: '双廊古镇',
    startTime: '13:00',
    endTime: '17:00',
    location: '双廊古镇',
    navKeyword: '双廊古镇',
    notes: '洱海东北岸。下午到正好，人少一点，光线斜下来很好看。',
  },
  {
    date: '2026-10-03',
    type: 'spot',
    title: '小普陀 · 洱海日落',
    startTime: '17:00',
    endTime: '19:00',
    location: '小普陀（洱海中的小岛）',
    navKeyword: '小普陀 大理',
    transportMinutes: 15,
    notes: '小普陀在洱海中间的一个小岛上，日落是重点。看完日落再回龙龛。',
  },
  {
    date: '2026-10-03',
    type: 'spot',
    title: '理想邦',
    startTime: '19:30',
    endTime: '20:30',
    location: '理想邦',
    navKeyword: '大理 理想邦',
    transportMinutes: 20,
    notes: '洱海东岸的网红拍照点，晚上有灯。Day 3 最后一个点，之后开回龙龛。',
  },
  {
    date: '2026-10-03',
    type: 'hotel',
    title: '入住 大理寻忆庭院民宿（龙龛码头店）',
    startTime: '21:00',
    location: '大理寻忆庭院民宿（龙龛码头店）',
    navKeyword: '大理寻忆庭院民宿 龙龛码头店',
    notes: '洱海观景房，含双早，国庆 ¥241/晚。\n\n位置在古城南边龙龛码头。10/4 退房后行李可以寄存在前台（要跟民宿确认），因为晚上 21:25 的飞机，白天退房没地方放。',
    checklist: ['问民宿退房后能否寄存行李'],
  },

  /* ===================== 10/4 周日 · 大理 → 北京 ===================== */
  {
    date: '2026-10-04',
    type: 'spot',
    title: '喜洲稻田 · 天空之镜',
    startTime: '08:30',
    endTime: '11:00',
    location: '喜洲古镇 稻田',
    navKeyword: '喜洲古镇',
    transportMinutes: 35,
    notes: '喜洲在洱海西岸，离龙龛有点远，所以放上午。稻田 8–9 点光线最好（侧逆光拍水面反射）。',
  },
  {
    date: '2026-10-04',
    type: 'spot',
    title: '大理古城',
    startTime: '12:00',
    endTime: '14:30',
    location: '大理古城',
    navKeyword: '大理古城',
    transportMinutes: 40,
    notes: '中午回古城吃饭，顺着逛一下。',
  },
  {
    date: '2026-10-04',
    type: 'spot',
    title: '崇圣寺三塔',
    startTime: '15:00',
    endTime: '16:30',
    location: '崇圣寺三塔文化旅游区',
    navKeyword: '崇圣寺三塔',
    transportMinutes: 20,
    notes: '大理标志性打卡点，离古城不远。1.5 小时够了。',
  },
  {
    date: '2026-10-04',
    type: 'spot',
    title: '洱海生态廊道',
    startTime: '16:45',
    endTime: '17:30',
    location: '洱海生态廊道',
    navKeyword: '洱海生态廊道',
    transportMinutes: 15,
    notes: '回龙龛路上顺路走一段，不用专门绕。',
  },
  {
    date: '2026-10-04',
    type: 'car',
    title: '退房 · 出发去大理凤仪机场',
    startTime: '18:30',
    endTime: '19:20',
    location: '龙龛码头 → 大理凤仪机场 DLU',
    navKeyword: '大理凤仪机场',
    transportMinutes: 50,
    notes:
      '【这是全程最容易踩坑的一步】\n\n· 大理凤仪机场（DLU）不在大理市区，在下关凤仪镇，离古城 40–50 分钟\n· 21:25 起飞，18:30 必须出发，别按「晚上」从容安排\n· 机场小，20:00 到登机口就行\n\n【取行李】\n· 白天已经退房，行李要么寄存在民宿，要么直接放包车上跟着走',
    checklist: ['退房并寄存行李', '18:30 准时出发', '确认包车能送到凤仪机场（不是市区）'],
  },
  {
    date: '2026-10-04',
    type: 'flight',
    title: 'MU9723 · 大理凤仪 → 北京大兴',
    startTime: '21:25',
    endTime: '23:59',
    location: '大理凤仪机场 → 北京大兴国际机场',
    navKeyword: '北京大兴国际机场',
    notes:
      '直飞，¥1,520/人 + 机建燃油 ¥120 = ¥1,640/人，2 人 ¥3,280。\n\n【落地】\n· 次日 00:50 落地北京大兴\n· 地铁已经停，出机场打车回家约 ¥100\n\n【注意】\n· MU9723 是代码共享（东航/联航/厦航同班），行李规则要按实际承运航司看\n· 这是当天大理飞北京的末班直飞，座位少',
    checklist: ['值机前确认行李额度（0 件免费托运规则）', '落地后叫车，地铁已停'],
  },
];

export const BUDGETS = [
  // vocabKey 把这条预算映射到消费类别，消费才会自动冲抵到正确的行
  { category: '机票·去程', vocabKey: 'flightfee', amount: 2040, note: 'JD5181 2 人，含机建燃油 ¥120/人，已出票' },
  { category: '机票·返程', vocabKey: 'flightfee', amount: 3280, note: 'MU9723 2 人，¥1,520/人 + 税 ¥120/人' },
  { category: '酒店', vocabKey: 'stay', amount: 789, note: '丽江 2 晚 ¥274 + 大理 1 晚 ¥241，均含双早' },
  { category: '包车', vocabKey: 'transit', amount: 1400, note: '4 天全程包车，含机场接送与丽江→大理' },
  { category: '门票', vocabKey: 'ticket', amount: 580, note: '玉龙雪山 ¥290 × 2（不含大索道）' },
  { category: '保险+服务费', vocabKey: 'misc', amount: 141, note: '意外险 ¥21 + 服务费 ¥120' },
];

export const EXPENSES = [
  {
category: 'flightfee',
    amount: 2040,
    payer: '我',
    occurredAt: '2026-09-30T10:00:00+08:00',
    note: 'JD5181 去程，已支付',
    nodeTitle: '首都航空 JD5181',
  },
];

export const OVERVIEW = `这趟行程的账已经反复核过几轮，几件最要紧的事记在这里：

【已出票】
· 去程 JD5181 10/1 19:50 大兴 → 23:10 丽江三义
· 返程还没订（或已订）MU9723 10/4 21:25 凤仪 → 00:50 大兴

【全程 0 行李】
两段都是 0 件免费托运，你和同伴都只带随身箱。这是有意的——提前买托运 2 人 4 段要 ¥400–1,200，带随身反而省。

【三个最容易踩的坑】
1. 大理凤仪机场（DLU）不在大理市区，离古城 40–50 分钟。10/4 要 18:30 出发，不是「晚上从容走」。
2. 10/1 落地 23:10，到酒店 23:40，必须确认 late check-in。
3. 玉龙雪山这份票不含大索道（是古维费 + 云杉坪索道 + 蓝月谷），所以不用抢限流票，已稳。

【总预算】
机票 ¥5,320 + 酒店 ¥789 + 包车 ¥1,400 + 门票 ¥580 + 保险服务费 ¥141 ≈ ¥8,230。`;
