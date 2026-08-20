# 导购工具（Guide Tool）设计文档

日期：2026-08-20
状态：已与用户逐节确认

## 1. 背景与目标

在 Milkonomy 网站新增"导购工具"页面：以**倒卖视角**对全物品做利润排序。与首页"利润排行"的区别在于不涉及任何动作/配方计算，只比较单个物品的市场买价（ask）与卖价（bid，扣 5% 市场税），帮助玩家判断哪些物品值得在市场中低买高卖。

## 2. 范围

### 2.1 本次实现

- 新页面 + 侧边栏菜单 + 路由 `/guide`
- 利润排序表格：利润/天、利润/h、利润率、利润/次、成交量(1h)
- 筛选：物品名、利润率下限、物品等级上限、成交量上下限、排除装备、排除护符、计算税率开关
- 排序：所有数值列可升/降序，默认利润/h 降序
- 无效数据（无价格/无成交量）显示 "-"，排序时恒排最后
- 辅助功能：自定义价格（手动覆盖买价/卖价）、收藏、详情弹窗

### 2.2 暂缓（本次不做）

- **"赚钱速度"列**：曾计划为回本时间（投入资金按当前行情翻倍所需时间），但精确计算需要个人挂单/卖出时间数据，该数据无公开 API 可用（调研了 AlphB Way Idle 插件：其排队时间 = 挂单簿排队数量 ÷ 众包交易历史成交量，挂单簿仅游戏内 WebSocket 可获取）。暂缓，未来若获得数据来源再议。

### 2.3 明确不做

- 动作、要求等级、经验三列（导购无动作概念）
- 买价/卖价状态选择器（价格固定用市场 ask/bid 原始口径，不随全局 buyStatus/sellStatus 变化）
- 逐级制作/起始材质/纯净火车等配方相关筛选

## 3. 数据层设计

### 3.1 新文件

- `src/common/apis/guide/type.d.ts`：行类型定义
- `src/common/apis/guide/index.ts`：`getGuideDataApi(params)`

### 3.2 行类型 GuideItem

```ts
export interface GuideItem {
  hrid: string          // 物品 hrid
  level: number         // 强化等级，0 表示无强化
  name: string          // 本地化物品名
  item: ItemDetail      // 物品详情（用于图标/等级/装备判断）
  ask: number           // 买价（手动价优先，否则市场 ask）
  bid: number           // 卖价（手动价优先，否则市场 bid）
  vol: number           // 成交量(1h)，可能为 -1
  profitPP: number | null    // 利润/次
  profitRate: number | null  // 利润率
  profitPH: number | null    // 利润/h
  profitPD: number | null    // 利润/天
  hasManualPrice: boolean    // 是否有手动价格
  favorite: boolean          // 是否收藏
}
```

### 3.3 行生成

遍历 `getGameDataApi().itemDetailMap` 的所有物品：

- 每件物品生成 0 级行
- 物品为装备类时，额外生成强化等级行：+5、+7、+8、+10、+12、+13、+14、+15
- 装备判断复用 `getEquipmentTypeOf`（src/common/utils/game.ts）

### 3.4 价格口径（关键）

- 买价 = 该物品 ask；卖价 = 该物品 bid
- **手动价优先**：`getManualPriceOf(hrid, level)` 存在且 manual 时使用手动值（与全站一致）
- 市场价必须**显式固定** `PriceStatus.ASK` / `PriceStatus.BID` 调用 `getPriceOf(hrid, level, PriceStatus.ASK, PriceStatus.BID)`。不能使用 `getUsedPriceOf`（内部调 `getPriceOf` 未传状态参数，会跟随全局 buyStatus/sellStatus，被首页选择器影响）

### 3.5 计算公式

```
taxFactor = includeTax ? 0.95 : 1        // 计算税率开关
利润/次   = bid × taxFactor - ask
利润率    = 利润/次 ÷ ask
利润/h    = 利润/次 × vol
利润/天   = 利润/h × 24
```

### 3.6 无效数据处理

- `ask <= 0` 或 `bid <= 0`（无市场价且无手动价）→ 四项利润指标全部为 `null`
- `vol < 0`（无成交记录）→ 利润/h、利润/天 为 `null`；利润/次、利润率正常
- 前端显示：`null` 渲染为 "-"
- 排序：`null` 恒排最后（无论升降序）

### 3.7 筛选（在 API 内完成）

| 参数 | 规则 |
|---|---|
| name | 物品名正则匹配（不区分大小写） |
| profitRate | 利润率 >= 输入值/100，null 不通过 |
| maxItemLevel | `item.itemLevel <= 输入值` |
| minVolume1h / maxVolume1h | vol 在区间内，vol < 0 不通过 |
| banEquipment | 装备类物品整件排除（0 级行与强化行都去掉） |
| banCharm | 护符（getEquipmentTypeOf === "charm"）排除 |

### 3.8 排序与分页

- 轻量排序实现（参考 `handleSort` 但适配 GuideItem）：null 排最后；同值或无排序时兜底按利润/h 降序
- 默认排序：利润/h 降序
- 分页：复用 `handlePage`（src/common/apis/utils.ts，仅依赖 currentPage/size，通用）

## 4. 收藏（独立存储）

- 现有收藏夹与 Calculator 强耦合（`getStorageCalculatorItem` 需 className，收藏夹页用 `calculatorConstructable` 重构实例），导购行无法复用
- 新建 `src/pinia/stores/guide-favorite.ts`：
  - state：`{hrid, level}[]`，localStorage 持久化（key 如 `guide-favorite-list`）
  - actions：`hasFavorite(row)` / `addFavorite(row)` / `deleteFavorite(row)`
- **不互通**：首页收藏夹列表不会出现导购收藏，反之亦然（设计取舍，向用户明示）

## 5. 页面与组件

### 5.1 新页面 `src/pages/guide/index.vue`

顶部工具区（无 ActionConfig、无 PriceStatusSelect）：
- "计算税率"复选框（`useMemory("guide-include-tax", true)`）

筛选表单：
- 物品名（输入框，防抖）
- 利润率 ≥（输入框 + %）
- 物品等级 ≤（input-number）
- 成交量(1h) ≥ / ≤（两个 input-number）
- 排除装备（checkbox）、排除护符（checkbox）

表格列（依次）：
1. 图标（复用 `ItemIcon`）
2. 物品：名称 + 强化等级（level > 0 时显示 "+N"）
3. 利润 / 天：含"自定义"链接（点击开价格弹窗）；手动价生效时数值加 `manual` 样式（蓝色，同首页）
4. 利润 / h：sortable="custom"
5. 利润率：sortable="custom"
6. 利润 / 次：sortable="custom"
7. 成交量(1h)：sortable="custom"
8. 详情：查看按钮
9. 收藏：星标按钮（读写 guide-favorite store）

分页：`usePagination({}, "guide-pagination")`，memeory key 独立。

### 5.2 新组件

- `src/pages/guide/components/GuideDetail.vue`：详情弹窗（简化版 ActionDetail，不依赖配方数据）——物品图标、名称、等级、买价/卖价/成交量、四项利润指标
- `src/pages/guide/components/GuidePrice.vue`：自定义价格弹窗——买价、卖价两行：市场价展示 + 手动覆盖输入；保存调 `usePriceStore().setPrice({hrid, level, ask, bid})` + `commit()`；未开启自定义价格时先弹 `ElMessageBox.confirm`（同首页 `setPrice` 逻辑）

### 5.3 路由与菜单

`src/router/routes/public.ts`，在 dashboard 路由之后新增：

```ts
{
  path: "guide",
  component: () => import("@/pages/guide/index.vue"),
  name: "Guide",
  meta: { title: t("导购工具"), svgIcon: "dashboard", affix: false }
}
```

图标暂复用 `dashboard.svg`，后续可替换。

### 5.4 i18n

`src/locales/lang/{zh-cn,zh-tw,en}.ts` 新增 key（参照现有 key 命名风格）：
- 菜单：导购工具 / 導購工具 / Guide Tool
- 页面内所有新文案：列头、筛选标签、弹窗文案、"-" 无需翻译

## 6. 数据流与错误处理

### 6.1 数据流

- 页面挂载后调用 `getGuideDataApi()`，返回分页结果
- `watch`（防抖 300ms，同首页）监听：`marketData`、`includeTax`、筛选/分页/排序参数、`priceStore` 变化 → 重新拉取
- 收藏点击：即时写 store，仅刷新当前行 favorite 标记，不整表重算
- 手动价格保存：`commit()` 清计算缓存 → 监听 price store 变化重拉

### 6.2 错误处理

- `marketData` / `gameData` 未就绪 → 返回空列表，页面空表格
- 计算异常 → console.error + 空列表，不阻塞页面
- 无效价格行：数值列显示 "-"，排序恒排最后
- 计算轻量（无配方遍历），不需要 leaderboard 那样的缓存机制

## 7. 测试

vitest（项目已有），新增 `tests/utils/guide.test.ts`（参照 `tests/utils/handleSearch.test.ts` 风格）：

- 四项公式正确性（税率 0.95 / 1 两档）
- 无效值 → null 映射规则（ask/bid 缺失全 null；仅 vol 缺失只影响利润/h、利润/天）
- 排序：null 排最后、升降序正确、默认利润/h 降序
- 筛选：名称/利润率/物品等级/成交量上下限/排除装备/排除护符
- 行生成：普通物品仅 0 级行；装备含 +5/+7/+8/+10/+12/+13/+14/+15 行
