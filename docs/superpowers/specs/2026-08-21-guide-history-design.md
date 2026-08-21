# 导购工具·历史行情数据集成 设计文档

日期：2026-08-21
状态：已与用户逐节确认

## 1. 背景与目标

导购工具当前基于官方 `marketplace.json` 快照（ask/bid/vol）计算利润，存在两个问题：

1. **成交量不稳定**：快照 `vol` 是瞬时 1 小时成交量，波动大、大量物品为 -1
2. **价格可能有极端值**：快照 ask/bid 是单一挂单价，可能出现卖价虚高/买价虚低，不符合实际成交情况

通过集成第三方历史行情 API（q7：`https://q7.nainai.eu.org/api/market/history`，来源"交易量显示"插件，返回逐小时 `{time, a, b, p, v}`），实现：

- 利润计算改用**1d 中位买/卖价**（贴近当前行情、抗极端挂单）与 **5d 平均每小时成交量**（平滑）
- 表格展示"当前快照 vs 中位价"偏差提示，无历史数据的行回落快照并标记
- 详情弹窗展示 1d/3d/5d 历史行情报表（均价/中位价/成交量/买盘/卖盘/min-max）

## 2. 范围

### 2.1 本次实现

- 历史数据抓取服务（限速并发队列）+ IndexedDB 缓存（12 小时过期）
- 历史统计纯函数（中位价/均量/买卖盘估算/窗口报表）
- 表格计算三级兜底（手动价 > 历史 > 快照）与偏差提示、无历史标记
- 详情弹窗历史行情区块（含按需单查）
- 页面顶部抓取进度展示

### 2.2 不在本次范围

- **自建数据源**（GitHub Actions 定时采集官方 marketplace.json + 静态 JSON 托管）：已确认方案，作为后续工作单独实施；本次把 API 地址做成可配置常量，未来只改一行即可切换
- **赚钱速度/回本时间**：维持搁置（无订单簿数据，无法估算排队数）
- 手动刷新按钮：设计过程中取消（进页面自动增量抓取即可）

## 3. 数据层设计

### 3.1 新文件

- `src/common/apis/guide/history.ts`：API 常量、抓取服务、统计纯函数、缓存读写接口
- `src/pinia/stores/guide-history.ts`：状态管理

### 3.2 API 约定

```
GET https://q7.nainai.eu.org/api/market/history?item_id={hrid}&variant={level}&days=5
```

- 返回：`[{time, a, b, p, v}]`（小时级，time 为秒级时间戳），无交易记录返回 `[]`
- `days=5` 一次拉 120 条，覆盖 1d/3d/5d 全部窗口
- **API 地址集中为常量** `HISTORY_API_URL`（history.ts 顶部），未来切换自建数据源只改此一处
- CORS：`access-control-allow-origin: *`，网页可直接 fetch

### 3.3 统计纯函数

```ts
export interface HistoryPoint { time: number; a: number; b: number; p: number; v: number }

export interface GuideHistoryStats {
  medianBuy1d: number   // 最近24h b(买价)中位数，仅 b>0 参与；无数据 -1
  medianSell1d: number  // 最近24h a(卖价)中位数，仅 a>0 参与；无数据 -1
  avgVol5d: number      // 最近120h v 逐小时平均；无数据 -1
  report: {
    "1d" | "3d" | "5d": {
      volume: number      // 窗口总成交量
      avgPrice: number    // 成交量加权均价
      medianPrice: number // 成交量加权中位价
      buyVolume: number   // 主动买入量（挂卖单消化速度）
      sellVolume: number  // 主动卖出量（挂买单消化速度）
      minPrice: number    // 最低成交价（价格档位修正）
      maxPrice: number    // 最高成交价（价格档位修正）
    }
  }
}

export function calcHistoryStats(points: HistoryPoint[]): GuideHistoryStats | null
// 空数组/无有效数据返回 null
```

**买/卖盘估算算法**（沿用"交易量显示"插件）：
- 按小时分组，逐小时取 a/b 均价；成交价 `p >= 当时ask` → 计入买盘；`p <= 当时bid` → 计入卖盘；居中按与买卖价的距离比例分配；无法判断时平分
- min/max 用价格档位函数修正（与插件 getPriceTier 一致）

### 3.4 抓取服务

- `fetchHistory(hrid, level)`：5 秒超时（AbortController），失败重试 1 次，仍失败抛错
- `runHistoryFetch(taskList, { onProgress, onDone })`：
  - **10 并发 + 每请求 100ms 间隔**（限速，不冲击第三方服务器）
  - 空数组 `[]` 视为合法结果（无交易记录），请求失败单独标记
  - 连续 50 个请求失败 → 中止本轮，判定服务不可用
- 任务清单生成函数 `buildHistoryTasks(items)`：与 `buildGuideRows` 行生成一致（所有物品 0 级 + 装备类 +5/+7/+8/+10/+12/+13/+14/+15），可单测

### 3.5 IndexedDB 缓存

- 复用项目现有 IndexedDB 工具（与 market-data 同款），独立库名 `guide-history`
- key：`{hrid}|{level}`；value：`{ points: HistoryPoint[], fetchedAt: number }`
- **过期：12 小时**（用户指定：保守频率，减轻第三方服务器负担）
- 进入页面只抓缺失/过期条目（增量）

## 4. 状态层

`src/pinia/stores/guide-history.ts`：

```
state:
  data: Map<string, GuideHistoryStats | "failed">   // key = {hrid}|{level}
  progress: { done: number; total: number } | null
  ready: boolean   // 是否完成过一轮全量抓取

actions:
  ensureLoaded()   // 页面进入调用：读缓存入 data → 缺失/过期入队 → 启动抓取
```

- 抓取完成（成功/失败）实时更新 `data` 并写缓存；全部完成后 `ready=true`
- 页面离开不中断抓取（后台继续，结果进缓存）
- 无手动刷新（已取消）

## 5. 计算集成（三级兜底）

改造 `calc.ts` 注入链，`resolveGuidePrice` 接受可选第三参 history：

```
buyPrice  = 手动价.bid   ?? 历史中位买价(1d)  ?? 快照 bid
sellPrice = 手动价.ask   ?? 历史中位卖价(1d)  ?? 快照 ask
vol       =                历史均量(5d)        ?? 快照 vol
```

- 手动价最高优先；历史缺失（null）或 failed → 回落快照
- `GuideItem` 增加 `hasHistory: boolean`（false 时 UI 显示"无历史"）与 `priceDeviation: { buy, sell } | null`（快照相对中位价的偏差百分比，手动价行为 null）
- `getGuideDataApi` 通过参数接收 history 数据（保持 calc.ts 纯函数可单测）
- 抓取完成后 store 变化 → 页面 watch → 重拉表格 → 历史口径重算排序（排序逻辑不变）

## 6. UI

### 6.1 页面顶部（计算税率旁）

- 抓取中：小进度条 + "历史数据 1234/5204" 文字；表格仍按快照正常操作
- 完成：进度条消失，表格自动切换历史口径并重算

### 6.2 表格"物品"列

名称下方第二行灰色小字：
- 有历史：`买 +5% · 卖 -3%`（快照价相对 1d 中位价的偏差，正 = 快照偏高）
- 无历史：`无历史`
- 手动价行不显示偏差

### 6.3 详情弹窗（GuideDetail.vue）

新增"历史行情"区块：

| 窗口 | 均价 | 中位价 | 成交量 | 买盘 | 卖盘 | 最低/最高 |
|---|---|---|---|---|---|---|
| 1d | … | … | … | … | … | … |
| 3d | … | … | … | … | … | … |
| 5d | … | … | … | … | … | … |
| 当前快照 | — | ask/bid | vol | — | — | — |

- 打开时：缓存有数据直接渲染；无数据 → "加载中…" → 按需单查（1 个请求）；查无 → "无交易记录"
- 数值格式复用 Format.price/Format.number

## 7. 数据流与错误处理

### 7.1 数据流

```
页面进入
  ├─ 表格立即按快照渲染（秒开）
  └─ ensureLoaded()：
       ├─ 读 IndexedDB：未过期条目直接进 store.data
       └─ 缺失/过期条目入队 → 限速抓取
            ├─ 每完成一条：写缓存 + store.data + 进度+1
            └─ 全部完成：ready=true → watch 触发表格重拉 → 历史口径重算排序
```

### 7.2 错误处理

- 单请求超时/失败：重试 1 次 → 标记 `failed` → 该行回落快照（显示"无历史"）
- 连续 50 个请求失败：中止本轮，ElMessage 提示"历史数据服务暂不可用，已使用快照数据"
- 空数组 `[]`：合法结果，写缓存（避免重复请求），显示"无历史"
- 抓取中用户操作表格：不受影响（快照数据响应）

## 8. 测试

### 8.1 单元测试（vitest）

`tests/utils/guide-history.test.ts`：
- `calcHistoryStats`：1d 中位价（b/a≤0 过滤）、5d 均量、窗口边界（time 过滤）、空数组/全无效返回 null、买/卖盘估算三分支、min/max 档位修正
- 三级兜底：手动 > 历史 > 快照（resolveGuidePrice 扩展后）
- `buildHistoryTasks`：普通物品仅 0 级、装备含 +5/+7/+8/+10/+12/+13/+14/+15（与行生成一致）

### 8.2 E2E 验收（Playwright，沿用现有测试基建）

- 进入页面：进度条出现 → 完成消失 → 物品列出现偏差小字/无历史标记
- 详情弹窗：历史行情三行窗口 + 快照对比行渲染；按需单查路径（清缓存后打开）
- 模拟服务不可用（拦截请求）：行回落快照、提示不阻塞页面
- 真实数据抽查：某物品历史中位价与"交易量显示"插件游戏内数据量级一致
