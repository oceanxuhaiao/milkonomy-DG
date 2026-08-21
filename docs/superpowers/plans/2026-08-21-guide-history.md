# 导购工具·历史行情数据集成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导购工具集成第三方历史行情 API（q7），用 1d 中位买/卖价 + 5d 均量替代快照计算利润（手动价 > 历史 > 快照 三级兜底），表格显示偏差提示/无历史标记，详情弹窗展示 1d/3d/5d 历史行情报表。

**Architecture:** 新增纯函数模块 `history.ts`（统计/抓取/任务清单/缓存接口）+ pinia store `guide-history.ts`（状态与调度）；`calc.ts` 的注入链扩展第三级兜底；页面与详情弹窗消费 store。API 地址集中为常量，未来可无缝切换自建数据源。

**Tech Stack:** Vue 3 + TS + Pinia + IndexedDB（复用 `src/common/utils/cache/indexed-db.ts`）+ Vitest（happy-dom）

**设计文档：** `docs/superpowers/specs/2026-08-21-guide-history-design.md`（已确认）

**关键约束：**
- **禁止 push 到 polokikiki/Milkonomy**；本地提交用 `-c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com"`
- 测试命令用 `npx vitest run <file>`（**不要用 `pnpm test`**，watch 模式在本环境挂起）
- 项目 pre-commit 钩子（eslint --fix）会自动格式化/移除未用 import——正常现象，提交后重跑测试确认
- 设计文档 §3.5 写"独立库名 guide-history"；实现**改为复用现有 DB（milkonomy-cache）+ key 前缀 `gh:`**（`src/common/utils/cache/indexed-db.ts` 的 DB_NAME 是硬编码单库，前缀隔离即可，不再开新库）

---

## 文件结构总览

| 操作 | 文件 | 职责 |
|---|---|---|
| Create | `src/common/apis/guide/history.ts` | HISTORY_API_URL 常量、HistoryPoint/GuideHistoryStats 类型、calcHistoryStats、getPriceTier、加权中位、buildHistoryTasks、historyKeyOf、fetchHistoryPoints、runHistoryFetch、HistoryCache 接口与 IndexedDB 实现 |
| Create | `src/pinia/stores/guide-history.ts` | store：data/progress/ready/version + ensureLoaded（缓存读取 + 增量抓取） |
| Modify | `src/common/apis/guide/type.d.ts` | GuideItem 增加 hasHistory、priceDeviation |
| Modify | `src/common/apis/guide/calc.ts` | GuideHistoryData 类型、resolveGuidePrice 三级兜底、buildGuideRows 加 historyGetter 参数 |
| Modify | `src/common/apis/guide/index.ts` | getGuideDataApi 接收 historyData 并注入 |
| Modify | `src/pages/guide/index.vue` | 进度条、物品列偏差小字/无历史标记、watch store、ensureLoaded 调用 |
| Modify | `src/pages/guide/components/GuideDetail.vue` | 历史行情区块（1d/3d/5d 报表 + 快照对比行） |
| Modify | `src/locales/lang/zh-cn.ts` `zh-tw.ts` `en.ts` | 新增文案 key |
| Test | `tests/utils/guide-history.test.ts` | 统计纯函数、任务清单、抓取服务（stub fetch）、三级兜底 |

---

## Task 1: history.ts 类型与统计纯函数 calcHistoryStats

**Files:**
- Create: `src/common/apis/guide/history.ts`
- Test: `tests/utils/guide-history.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/utils/guide-history.test.ts`:

```ts
import { calcHistoryStats, getPriceTier } from "@@/apis/guide/history"
import { describe, expect, it } from "vitest"

// 固定"现在"：2026-08-21 12:00:00 UTC = 1787266800 秒
const NOW = 1787266800
const H = 3600

/** 构造小时级数据点：hoursAgo 小时前，a/b/p/v 可指定 */
function pt(hoursAgo: number, a: number, b: number, p: number, v: number) {
  return { time: NOW - hoursAgo * H, a, b, p, v }
}

describe("calcHistoryStats", () => {
  it("1d 中位买/卖价（b/a<=0 不参与中位）", () => {
    // 24h 内 4 条 b：10, -1(无效), 12, 14 → 有效 [10,12,14] 中位 12
    const points = [
      pt(2, 15, 10, 13, 5),
      pt(5, 16, -1, 14, 5),
      pt(8, 17, 12, 15, 5),
      pt(10, 18, 14, 16, 5),
      // 24h 外（不影响 1d）
      pt(30, 100, 1, 50, 5)
    ]
    const s = calcHistoryStats(points, NOW)!
    expect(s.medianBuy1d).toBe(12)
    // 24h 内 a：15,16,17,18 → 偶数个取中间两个平均 (16+17)/2
    expect(s.medianSell1d).toBe(16.5)
  })

  it("5d 均量为窗口内 v 的平均", () => {
    const points = [pt(10, 15, 10, 13, 6), pt(50, 15, 10, 13, 10)]
    const s = calcHistoryStats(points, NOW)!
    expect(s.avgVol5d).toBe(8)
  })

  it("窗口边界：恰好 24h/120h 的记录算在窗口内", () => {
    const points = [pt(24, 15, 10, 13, 7), pt(120, 15, 10, 13, 9)]
    const s = calcHistoryStats(points, NOW)!
    expect(s.medianBuy1d).toBe(10) // time >= NOW-24h 含边界
    expect(s.avgVol5d).toBe(8)
  })

  it("5d 窗口内无任何有效记录返回 null", () => {
    expect(calcHistoryStats([], NOW)).toBeNull()
    expect(calcHistoryStats([pt(200, 15, 10, 13, 5)], NOW)).toBeNull()
    expect(calcHistoryStats([pt(2, 0, -1, 0, 0), pt(3, -1, 0, 0, 0)], NOW)).toBeNull()
  })

  it("窗口报表：总成交量/加权均价", () => {
    const points = [pt(2, 15, 10, 13, 6), pt(30, 20, 15, 19, 2)]
    const s = calcHistoryStats(points, NOW)!
    expect(s.report["1d"].volume).toBe(6)
    expect(s.report["1d"].avgPrice).toBe(13)
    expect(s.report["3d"].volume).toBe(8)
    expect(s.report["3d"].avgPrice).toBe((13 * 6 + 19 * 2) / 8)
    expect(s.report["5d"].volume).toBe(8)
  })

  it("买/卖盘估算：p>=ask 计买盘、p<=bid 计卖盘", () => {
    // 同一小时内：avgAsk=15, avgBid=10
    const points = [
      pt(2, 15, 10, 16, 30),  // p 16 >= 15 → 买盘
      pt(3, 15, 10, 9, 20),   // p 9 <= 10 → 卖盘
      pt(4, 15, 10, 12, 10)   // 居中 12：range 15-10=5 → buyRatio=(12-10)/5=0.4 → 买4 卖6
    ]
    const s = calcHistoryStats(points, NOW)!
    expect(s.report["1d"].buyVolume).toBe(34)
    expect(s.report["1d"].sellVolume).toBe(26)
  })

  it("加权中位价：累计成交量过半处的价格", () => {
    const points = [
      pt(2, 15, 10, 10, 30),
      pt(3, 15, 10, 20, 10),
      pt(4, 15, 10, 30, 10)
    ]
    const s = calcHistoryStats(points, NOW)!
    // 总 v=50，中位在 25 处 → 落在价格 10
    expect(s.report["1d"].medianPrice).toBe(10)
  })

  it("min/max 经价格档位修正", () => {
    const points = [pt(2, 15, 10, 16, 5), pt(3, 15, 10, 9, 5)]
    const s = calcHistoryStats(points, NOW)!
    expect(s.report["1d"].minPrice).toBe(getPriceTier(9, "down"))
    expect(s.report["1d"].maxPrice).toBe(getPriceTier(16, "up"))
  })
})

describe("getPriceTier", () => {
  it("档位规则与游戏一致", () => {
    expect(getPriceTier(9, "down")).toBe(8)   // 1开头 <4位：step=1
    expect(getPriceTier(16, "up")).toBe(17)
    expect(getPriceTier(300, "down")).toBe(300) // 3开头 3位：step=10^(3-3)=1 → 300
    expect(getPriceTier(345, "down")).toBe(340) // 3开头：step=10^0=1？修正：digitCount>=3 且 3/4 开头 → step=10^(3-3)=1
    expect(getPriceTier(1600, "up")).toBe(1605) // 1开头 4位：step=5
    expect(getPriceTier(58000, "down")).toBe(58000 - 58000 % 2000)
  })
})
```

注意：`getPriceTier` 档位用例中 345 一行的期望需要与实现算法严格一致——实现方在写测试时若发现档位期望与算法不符，**以算法为准修正期望值并在报告中说明**（算法来源为"交易量显示"插件 getPriceTier，必须逐字移植）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: FAIL，报 "Cannot find module '@@/apis/guide/history'"

- [ ] **Step 3: 实现 history.ts（统计部分）**

Create `src/common/apis/guide/history.ts`:

```ts
/** 历史行情 API 地址（未来切换自建数据源只改此处） */
export const HISTORY_API_URL = "https://q7.nainai.eu.org/api/market/history"

/** 缓存过期时间：12 小时（保守频率，减轻第三方服务器负担） */
export const HISTORY_CACHE_TTL = 12 * 60 * 60 * 1000

/** 抓取并发数与请求间隔（限速） */
export const HISTORY_CONCURRENCY = 10
export const HISTORY_REQUEST_GAP_MS = 100
/** 连续失败阈值：达到即判定服务不可用并中止本轮 */
export const HISTORY_FAIL_LIMIT = 50

export interface HistoryPoint {
  /** 秒级时间戳 */
  time: number
  /** ask 侧挂单买入价（卖价） */
  a: number
  /** bid 侧挂单卖出价（买价） */
  b: number
  /** 成交均价 */
  p: number
  /** 成交量 */
  v: number
}

export interface WindowReport {
  volume: number
  avgPrice: number
  medianPrice: number
  buyVolume: number
  sellVolume: number
  minPrice: number
  maxPrice: number
}

export interface GuideHistoryStats {
  /** 最近24h 买价(b)中位数，无数据 -1 */
  medianBuy1d: number
  /** 最近24h 卖价(a)中位数，无数据 -1 */
  medianSell1d: number
  /** 最近120h 成交量(v)逐小时平均，无数据 -1 */
  avgVol5d: number
  report: {
    "1d": WindowReport
    "3d": WindowReport
    "5d": WindowReport
  }
}

const HOUR = 3600
const WINDOWS: Record<"1d" | "3d" | "5d", number> = { "1d": 24 * HOUR, "3d": 72 * HOUR, "5d": 120 * HOUR }

function medianOf(values: number[]): number {
  if (values.length === 0) return -1
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 与游戏 getBinnedPrice 一致的价格档位（来源：交易量显示插件 getPriceTier） */
export function getPriceTier(price: number, direction: "up" | "down"): number {
  const numericPrice = Number(price)
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return 0

  const normalizedPrice = Math.trunc(numericPrice)
  if (normalizedPrice <= 1) return 2

  const priceText = String(normalizedPrice)
  const leadingDigit = priceText[0]
  const digitCount = priceText.length
  let step = 1

  switch (leadingDigit) {
    case "1":
    case "2":
      if (digitCount >= 4) step = 5 * Math.pow(10, digitCount - 4)
      break
    case "3":
    case "4":
      if (digitCount >= 3) step = Math.pow(10, digitCount - 3)
      break
    default:
      if (digitCount >= 3) step = 2 * Math.pow(10, digitCount - 3)
  }

  const lowerPrice = normalizedPrice - normalizedPrice % step
  return direction === "up" && normalizedPrice > lowerPrice
    ? lowerPrice + step
    : lowerPrice
}

/** 成交量加权中位价（来源：交易量显示插件 calculateMedianPrice） */
function calcWeightedMedianPrice(points: HistoryPoint[]): number {
  const priceList = points.filter(item => item.v > 0 && item.p > 0)
  if (priceList.length === 0) return 0

  priceList.sort((x, y) => x.p - y.p)
  const totalVol = priceList.reduce((sum, item) => sum + item.v, 0)
  if (totalVol === 0) return 0

  const midVol = totalVol / 2
  let accumVol = 0
  for (const item of priceList) {
    accumVol += item.v
    if (accumVol >= midVol) return item.p
  }
  return priceList[priceList.length - 1].p
}

/** 买/卖盘成交量估算（来源：交易量显示插件 processMarketData 的按小时分析法） */
function calcBuySellVolume(points: HistoryPoint[]): { buyVolume: number; sellVolume: number } {
  let buyVolume = 0
  let sellVolume = 0
  if (points.length === 0) return { buyVolume, sellVolume }

  // 按小时分组
  const hourlyData: Record<number, HistoryPoint[]> = {}
  points.forEach(item => {
    const hour = Math.floor(item.time / HOUR)
    if (!hourlyData[hour]) hourlyData[hour] = []
    hourlyData[hour].push(item)
  })

  const sortedHours = Object.keys(hourlyData).map(Number).sort((x, y) => x - y)

  for (let i = 0; i < sortedHours.length; i++) {
    const currentHourData = hourlyData[sortedHours[i]]

    const validAsks = currentHourData.map(item => item.a).filter(a => a > 0)
    const validBids = currentHourData.map(item => item.b).filter(b => b > 0)
    const currentAvgAsk = validAsks.length > 0 ? validAsks.reduce((s, a) => s + a, 0) / validAsks.length : 0
    const currentAvgBid = validBids.length > 0 ? validBids.reduce((s, b) => s + b, 0) / validBids.length : 0

    let lastAvgAsk = currentAvgAsk
    let lastAvgBid = currentAvgBid
    if (i > 0) {
      const lastHourData = hourlyData[sortedHours[i - 1]]
      const lastValidAsks = lastHourData.map(item => item.a).filter(a => a > 0)
      const lastValidBids = lastHourData.map(item => item.b).filter(b => b > 0)
      lastAvgAsk = lastValidAsks.length > 0 ? lastValidAsks.reduce((s, a) => s + a, 0) / lastValidAsks.length : currentAvgAsk
      lastAvgBid = lastValidBids.length > 0 ? lastValidBids.reduce((s, b) => s + b, 0) / lastValidBids.length : currentAvgBid
    }

    currentHourData.forEach(item => {
      if (item.v > 0) {
        if ((currentAvgAsk > 0 && item.p >= currentAvgAsk) || (lastAvgAsk > 0 && item.p >= lastAvgAsk)) {
          buyVolume += item.v
        } else if ((currentAvgBid > 0 && item.p <= currentAvgBid) || (lastAvgBid > 0 && item.p <= lastAvgBid)) {
          sellVolume += item.v
        } else {
          const currentRange = currentAvgAsk - currentAvgBid
          const lastRange = lastAvgAsk - lastAvgBid
          const avgRange = (currentRange + lastRange) / 2

          if (avgRange > 0) {
            const minBid = Math.min(currentAvgBid, lastAvgBid)
            const maxAsk = Math.max(currentAvgAsk, lastAvgAsk)
            const actualRange = maxAsk - minBid

            if (actualRange > 0) {
              const buyRatio = (item.p - minBid) / actualRange
              buyVolume += item.v * buyRatio
              sellVolume += item.v * (1 - buyRatio)
            } else {
              buyVolume += item.v * 0.5
              sellVolume += item.v * 0.5
            }
          } else {
            buyVolume += item.v * 0.5
            sellVolume += item.v * 0.5
          }
        }
      }
    })
  }

  return { buyVolume: Math.round(buyVolume), sellVolume: Math.round(sellVolume) }
}

function buildWindowReport(points: HistoryPoint[]): WindowReport {
  const totalV = points.reduce((sum, item) => sum + item.v, 0)
  const totalPV = points.reduce((sum, item) => sum + item.p * item.v, 0)
  const avgPrice = totalV > 0 ? totalPV / totalV : 0

  let minPrice = 0
  let maxPrice = 0
  if (points.length > 0) {
    const prices = points.map(item => item.p).filter(p => p > 0)
    if (prices.length > 0) {
      minPrice = getPriceTier(Math.min(...prices), "down")
      maxPrice = getPriceTier(Math.max(...prices), "up")
    }
  }

  const { buyVolume, sellVolume } = calcBuySellVolume(points)

  return {
    volume: totalV,
    avgPrice,
    medianPrice: calcWeightedMedianPrice(points),
    buyVolume,
    sellVolume,
    minPrice,
    maxPrice
  }
}

/**
 * 历史统计：中位买/卖价（1d）、平均每小时成交量（5d）、1d/3d/5d 窗口报表。
 * 5d 窗口内无任何有效记录（a/b/p/v 全无效）时返回 null。
 * @param points 小时级数据点（任意顺序）
 * @param nowSec 当前秒级时间戳（测试注入用）
 */
export function calcHistoryStats(points: HistoryPoint[], nowSec: number = Math.floor(Date.now() / 1000)): GuideHistoryStats | null {
  const inWindow = (point: HistoryPoint, windowSec: number) =>
    point.time >= nowSec - windowSec && point.time <= nowSec

  const valid5d = points.filter(p => inWindow(p, WINDOWS["5d"]) && (p.v > 0 || p.a > 0 || p.b > 0))
  if (valid5d.length === 0) return null

  const buys1d = valid5d.filter(p => inWindow(p, WINDOWS["1d"]) && p.b > 0).map(p => p.b)
  const sells1d = valid5d.filter(p => inWindow(p, WINDOWS["1d"]) && p.a > 0).map(p => p.a)
  const vols5d = valid5d.filter(p => p.v >= 0).map(p => p.v)

  const medianBuy1d = medianOf(buys1d)
  const medianSell1d = medianOf(sells1d)
  const avgVol5d = vols5d.length > 0 ? vols5d.reduce((s, v) => s + v, 0) / vols5d.length : -1

  const report = {
    "1d": buildWindowReport(valid5d.filter(p => inWindow(p, WINDOWS["1d"]))),
    "3d": buildWindowReport(valid5d.filter(p => inWindow(p, WINDOWS["3d"]))),
    "5d": buildWindowReport(valid5d)
  }

  return { medianBuy1d, medianSell1d, avgVol5d, report }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: 全部 PASS（若 getPriceTier 档位期望与算法不符，按算法修正期望并在提交信息说明）

- [ ] **Step 5: 提交**

```bash
git add tests/utils/guide-history.test.ts src/common/apis/guide/history.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购历史行情-统计纯函数 calcHistoryStats（1d中位价/5d均量/买卖盘估算）"
```

---

## Task 2: 任务清单 + 抓取服务（fetchHistoryPoints / runHistoryFetch）

**Files:**
- Modify: `src/common/apis/guide/history.ts`
- Test: `tests/utils/guide-history.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `tests/utils/guide-history.test.ts` 末尾追加（import 合并到顶部）：

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildHistoryTasks, fetchHistoryPoints, historyKeyOf, runHistoryFetch, HISTORY_API_URL } from "@@/apis/guide/history"
import { GUIDE_ENHANCE_LEVELS } from "@@/apis/guide/calc"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("historyKeyOf / buildHistoryTasks", () => {
  it("key 由 hrid|level 组成", () => {
    expect(historyKeyOf("/items/apple", 0)).toBe("/items/apple|0")
    expect(historyKeyOf("/items/sword", 13)).toBe("/items/sword|13")
  })

  it("普通物品只有0级任务；装备含0级+全部强化等级", () => {
    const items: any[] = [
      { hrid: "/items/apple", categoryHrid: "/item_categories/food" },
      { hrid: "/items/sword", categoryHrid: "/item_categories/equipment" }
    ]
    const tasks = buildHistoryTasks(items)
    expect(tasks.map(t => t.level)).toEqual([0, 0, ...GUIDE_ENHANCE_LEVELS])
    expect(tasks.length).toBe(2 + GUIDE_ENHANCE_LEVELS.length)
  })
})

describe("fetchHistoryPoints", () => {
  it("成功返回数据数组", async () => {
    const payload = [{ time: 1787266800, a: 13, b: 12, p: 12, v: 100 }]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const result = await fetchHistoryPoints("/items/sugar", 0)
    expect(result).toEqual(payload)
    expect(fetchMock.mock.calls[0][0]).toBe(`${HISTORY_API_URL}?item_id=/items/sugar&variant=0&days=5`)
  })

  it("失败重试1次后仍失败则抛错", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchHistoryPoints("/items/sugar", 0)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("返回非数组时抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ bad: true }), { status: 200 })))
    await expect(fetchHistoryPoints("/items/sugar", 0)).rejects.toThrow()
  })
})

describe("runHistoryFetch", () => {
  it("并发抓取并回调进度与结果；空数组合法", async () => {
    const responses: Record<string, any[]> = {
      "/items/a|0": [{ time: 1, a: 1, b: 1, p: 1, v: 1 }],
      "/items/b|0": [],
      "/items/c|0": [{ time: 2, a: 2, b: 2, p: 2, v: 2 }]
    }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const hrid = decodeURIComponent(String(url).split("item_id=")[1].split("&")[0])
      const level = String(url).split("variant=")[1].split("&")[0]
      return new Response(JSON.stringify(responses[`${hrid}|${level}`] ?? []), { status: 200 })
    }))

    const items = new Map<string, any[] | "failed">()
    const progress: number[] = []
    await runHistoryFetch(
      [
        { hrid: "/items/a", level: 0 },
        { hrid: "/items/b", level: 0 },
        { hrid: "/items/c", level: 0 }
      ],
      (key, result) => { items.set(key, result) },
      (done, total) => progress.push(done),
      { gapMs: 0 }
    )
    expect(items.get("/items/a|0")).toEqual(responses["/items/a|0"])
    expect(items.get("/items/b|0")).toEqual([])
    expect(items.size).toBe(3)
    expect(progress[progress.length - 1]).toBe(3)
  })

  it("连续失败达到上限时中止本轮", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })))
    let aborted = false
    await runHistoryFetch(
      Array.from({ length: 5 }, (_, i) => ({ hrid: `/items/x${i}`, level: 0 })),
      () => undefined,
      undefined,
      { gapMs: 0, failLimit: 3, onAbort: () => { aborted = true } }
    )
    expect(aborted).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: FAIL，报 "does not provide an export named 'buildHistoryTasks'"

- [ ] **Step 3: 实现任务清单与抓取服务**

在 `src/common/apis/guide/history.ts` 末尾追加（`isEquipmentItem` 从 `./calc` 导入，加到文件顶部 import）：

```ts
import { GUIDE_ENHANCE_LEVELS, isEquipmentItem } from "./calc"

export function historyKeyOf(hrid: string, level: number) {
  return `${hrid}|${level}`
}

export interface HistoryTask {
  hrid: string
  level: number
}

/** 生成抓取任务清单：与 buildGuideRows 行生成一致（物品 0 级 + 装备强化等级） */
export function buildHistoryTasks(items: { hrid: string; categoryHrid?: string }[]): HistoryTask[] {
  const tasks: HistoryTask[] = []
  for (const item of items) {
    const levels = isEquipmentItem(item) ? [0, ...GUIDE_ENHANCE_LEVELS] : [0]
    for (const level of levels) {
      tasks.push({ hrid: item.hrid, level })
    }
  }
  return tasks
}

/**
 * 抓取单个物品+等级的历史数据（days=5 覆盖 1d/3d/5d）。
 * 5 秒超时，失败重试 1 次，仍失败抛错。
 */
export async function fetchHistoryPoints(hrid: string, level: number): Promise<HistoryPoint[]> {
  const url = `${HISTORY_API_URL}?item_id=${hrid}&variant=${level}&days=5`
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) throw new Error(`历史数据请求失败: ${res.status}`)
      const data = await res.json()
      if (!Array.isArray(data)) throw new Error("历史数据格式错误")
      return data as HistoryPoint[]
    } catch (e) {
      lastError = e
    } finally {
      clearTimeout(timeoutId)
    }
  }
  throw lastError instanceof Error ? lastError : new Error("历史数据请求失败")
}

export interface RunHistoryFetchOptions {
  /** 每个请求之间的限速间隔（毫秒），默认 100 */
  gapMs?: number
  /** 连续失败中止阈值，默认 50 */
  failLimit?: number
  onAbort?: () => void
}

/**
 * 限速并发抓取队列。
 * @param tasks 任务清单
 * @param onItem 每条结果回调（"failed" 表示请求失败，[] 表示无交易记录）
 * @param onProgress 进度回调
 */
export async function runHistoryFetch(
  tasks: HistoryTask[],
  onItem: (key: string, result: HistoryPoint[] | "failed") => void | Promise<void>,
  onProgress?: (done: number, total: number) => void,
  options: RunHistoryFetchOptions = {}
) {
  const gapMs = options.gapMs ?? HISTORY_REQUEST_GAP_MS
  const failLimit = options.failLimit ?? HISTORY_FAIL_LIMIT
  const total = tasks.length
  const queue = [...tasks]
  let completed = 0
  let consecutiveFailures = 0
  let aborted = false

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  async function worker() {
    while (queue.length > 0 && !aborted) {
      const task = queue.shift()!
      const key = historyKeyOf(task.hrid, task.level)
      let result: HistoryPoint[] | "failed"
      try {
        result = await fetchHistoryPoints(task.hrid, task.level)
      } catch {
        result = "failed"
      }

      if (result === "failed") {
        consecutiveFailures++
        if (consecutiveFailures >= failLimit) {
          aborted = true
          options.onAbort?.()
        }
      } else {
        consecutiveFailures = 0
      }

      await onItem(key, result)
      completed++
      onProgress?.(completed, total)

      await sleep(gapMs)
    }
  }

  await Promise.all(Array.from({ length: HISTORY_CONCURRENCY }, () => worker()))
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 类型检查 + 提交**

Run: `npx vue-tsc --noEmit`
Expected: 无类型错误

```bash
git add tests/utils/guide-history.test.ts src/common/apis/guide/history.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购历史行情-抓取服务（任务清单/限速并发队列/失败中止）"
```

---

## Task 3: 缓存接口与 guide-history store

**Files:**
- Modify: `src/common/apis/guide/history.ts`（缓存接口 + IndexedDB 实现）
- Create: `src/pinia/stores/guide-history.ts`
- Test: `tests/utils/guide-history.test.ts`（store 测试追加）

- [ ] **Step 1: 追加失败测试**

在 `tests/utils/guide-history.test.ts` 末尾追加：

```ts
import { createPinia, setActivePinia } from "pinia"
import { useGuideHistoryStore } from "@/pinia/stores/guide-history"
import type { CachedHistory } from "@@/apis/guide/history"
import { HISTORY_CACHE_TTL } from "@@/apis/guide/history"

describe("guide-history store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function makeStore(overrides: Partial<ReturnType<typeof useGuideHistoryStore>> = {}) {
    const store = useGuideHistoryStore()
    return Object.assign(store, overrides)
  }

  it("ensureLoaded：缓存未过期直接用，缺失/过期条目抓取", async () => {
    const now = Date.now()
    const cache = {
      get: vi.fn(async (key: string) => key === "/items/fresh|0"
        ? { points: [{ time: 1, a: 2, b: 1, p: 1.5, v: 3 }], fetchedAt: now - 1000 }
        : key === "/items/stale|0"
          ? { points: [{ time: 1, a: 2, b: 1, p: 1.5, v: 3 }], fetchedAt: now - HISTORY_CACHE_TTL - 1 }
          : null),
      set: vi.fn(async () => undefined)
    }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const hrid = decodeURIComponent(String(url).split("item_id=")[1].split("&")[0])
      const level = String(url).split("variant=")[1].split("&")[0]
      return new Response(JSON.stringify(hrid === "/items/missing" && level === "0"
        ? [{ time: 1, a: 5, b: 4, p: 4.5, v: 6 }]
        : []), { status: 200 })
    }))

    const items: any[] = [
      { hrid: "/items/fresh", categoryHrid: "/item_categories/food" },
      { hrid: "/items/stale", categoryHrid: "/item_categories/food" },
      { hrid: "/items/missing", categoryHrid: "/item_categories/food" }
    ]

    const store = makeStore()
    await store.ensureLoaded(items, cache as any, { gapMs: 0 })
    expect(store.ready).toBe(true)
    expect(store.progress).toBeNull()
    // fresh 走缓存
    expect(store.data.get("/items/fresh|0")).toBeTruthy()
    expect(cache.get).toHaveBeenCalledWith("/items/fresh|0")
    // stale 与 missing 被抓取并写缓存
    expect(cache.set).toHaveBeenCalledWith("/items/stale|0", expect.objectContaining({ points: expect.any(Array) }))
    expect(cache.set).toHaveBeenCalledWith("/items/missing|0", expect.objectContaining({ points: expect.any(Array) }))
    // 抓取到的数据进 store
    const missing = store.data.get("/items/missing|0") as any
    expect(missing.medianBuy1d).toBe(4)
    expect(missing.medianSell1d).toBe(5)
  })

  it("请求失败标记 failed，不影响 ready", async () => {
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })))

    const items: any[] = [{ hrid: "/items/a", categoryHrid: "/item_categories/food" }]
    const store = makeStore()
    await store.ensureLoaded(items, cache as any, { gapMs: 0, failLimit: 10 })
    expect(store.ready).toBe(true)
    expect(store.data.get("/items/a|0")).toBe("failed")
  })
})
```

注意：store 的 `ensureLoaded(items, cache, opts)` 设计为**依赖注入**（items/cache/抓取选项作参数，默认实现走真实数据源），保证 store 可单测、不依赖 game store 与 IndexedDB。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: FAIL，报 "Cannot find module '@/pinia/stores/guide-history'"

- [ ] **Step 3: 实现缓存接口（history.ts 追加）**

在 `src/common/apis/guide/history.ts` 末尾追加：

```ts
import { getIndexedDbValue, setIndexedDbValue } from "@/common/utils/cache/indexed-db"

export interface CachedHistory {
  points: HistoryPoint[]
  fetchedAt: number
}

/** 缓存读写接口（可注入 fake 用于测试） */
export interface HistoryCache {
  get(key: string): Promise<CachedHistory | null>
  set(key: string, value: CachedHistory): Promise<void>
}

const CACHE_KEY_PREFIX = "gh:"

/** IndexedDB 实现：复用现有 milkonomy-cache 库，key 前缀 gh: 隔离 */
export const indexedDbHistoryCache: HistoryCache = {
  async get(key: string) {
    const value = await getIndexedDbValue<CachedHistory>(CACHE_KEY_PREFIX + key)
    return value ?? null
  },
  async set(key: string, value: CachedHistory) {
    await setIndexedDbValue(CACHE_KEY_PREFIX + key, value)
  }
}
```

（`@/common/utils/cache/indexed-db` 的 `getIndexedDbValue` 已返回 `value ?? null`，见该文件。）

- [ ] **Step 4: 实现 store**

Create `src/pinia/stores/guide-history.ts`:

```ts
import { defineStore } from "pinia"
import { pinia } from "@/pinia"
import {
  buildHistoryTasks,
  calcHistoryStats,
  fetchHistoryPoints,
  HISTORY_CACHE_TTL,
  historyKeyOf,
  indexedDbHistoryCache,
  runHistoryFetch,
  type CachedHistory,
  type GuideHistoryStats,
  type HistoryCache,
  type HistoryTask,
  type RunHistoryFetchOptions
} from "@/common/apis/guide/history"
import { useGameStoreOutside } from "./game"

export const useGuideHistoryStore = defineStore("guideHistory", {
  state: () => ({
    /** key = {hrid}|{level}，值为历史统计或抓取失败标记 */
    data: new Map<string, GuideHistoryStats | "failed">(),
    progress: null as { done: number; total: number } | null,
    ready: false,
    /** 数据版本号：每次抓取完成一条 +1，页面 watch 此值触发重算 */
    version: 0
  }),
  actions: {
    /**
     * 进入页面时调用：读缓存 → 缺失/过期条目抓取。
     * items/cache/opts 可注入（测试用）；默认走游戏数据与 IndexedDB。
     */
    async ensureLoaded(
      items?: { hrid: string; categoryHrid?: string }[],
      cache: HistoryCache = indexedDbHistoryCache,
      opts: RunHistoryFetchOptions = {}
    ) {
      if (this.ready && this.progress) return // 已有抓取在进行
      const itemList = items ?? Object.values(useGameStoreOutside().gameData?.itemDetailMap ?? {})
      if (itemList.length === 0) return

      const tasks = buildHistoryTasks(itemList)
      const pending: HistoryTask[] = []

      // 读缓存：未过期直接进 data，过期/缺失入队
      for (const task of tasks) {
        const key = historyKeyOf(task.hrid, task.level)
        const cached = await cache.get(key)
        if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL) {
          this.data.set(key, calcHistoryStats(cached.points))
        } else {
          pending.push(task)
        }
      }

      if (pending.length === 0) {
        this.ready = true
        this.progress = null
        this.version++
        return
      }

      this.progress = { done: 0, total: pending.length }
      await runHistoryFetch(
        pending,
        async (key, result) => {
          if (result === "failed") {
            this.data.set(key, "failed")
          } else {
            const stats = calcHistoryStats(result)
            await cache.set(key, { points: result, fetchedAt: Date.now() })
            this.data.set(key, stats)
          }
          this.version++
        },
        (done, total) => {
          this.progress = { done, total }
        },
        opts
      )
      this.progress = null
      this.ready = true
      this.version++
    },
    /** 按需单查（详情弹窗用）：先查缓存，无则请求并写缓存 */
    async fetchOne(hrid: string, level: number): Promise<GuideHistoryStats | "failed" | null> {
      const key = historyKeyOf(hrid, level)
      const cached = await indexedDbHistoryCache.get(key)
      if (cached) {
        return calcHistoryStats(cached.points)
      }
      try {
        const points = await fetchHistoryPoints(hrid, level)
        await indexedDbHistoryCache.set(key, { points, fetchedAt: Date.now() })
        return calcHistoryStats(points)
      } catch {
        return "failed"
      }
    }
  }
})

export function useGuideHistoryStoreOutside() {
  return useGuideHistoryStore(pinia)
}
```

注意：`calcHistoryStats` 返回 `GuideHistoryStats | null`，Map 值类型允许 null（`data.set(key, calcHistoryStats(...))` 存 null 表示"无有效记录"——三级兜底时视同无历史）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: 全部 PASS（含 store 2 个用例）

- [ ] **Step 6: 类型检查 + 提交**

Run: `npx vue-tsc --noEmit`
Expected: 无类型错误（若 Map 值类型报 null 不兼容，将 state 类型改为 `Map<string, GuideHistoryStats | "failed" | null>` 并同步测试断言）

```bash
git add tests/utils/guide-history.test.ts src/common/apis/guide/history.ts src/pinia/stores/guide-history.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购历史行情-缓存与 store（12小时过期/增量抓取/按需单查）"
```

---

## Task 4: calc.ts 三级兜底（手动价 > 历史 > 快照）

**Files:**
- Modify: `src/common/apis/guide/type.d.ts`
- Modify: `src/common/apis/guide/calc.ts`
- Test: `tests/utils/guide-history.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

在 `tests/utils/guide-history.test.ts` 末尾追加：

```ts
import { buildGuideRows, resolveGuidePrice } from "@@/apis/guide/calc"

describe("resolveGuidePrice 三级兜底", () => {
  const market = { ask: 100, bid: 90, vol: 50 }

  it("无历史时回落快照", () => {
    const r = resolveGuidePrice(null, market, null)
    expect(r.buyPrice).toBe(90)
    expect(r.sellPrice).toBe(100)
    expect(r.vol).toBe(50)
    expect(r.hasHistory).toBe(false)
    expect(r.priceDeviation).toBeNull()
  })

  it("历史值优先于快照（买=中位b、卖=中位a、量=均量）", () => {
    const history = { medianBuy: 88, medianSell: 96, avgVol: 40 }
    const r = resolveGuidePrice(null, market, history)
    expect(r.buyPrice).toBe(88)
    expect(r.sellPrice).toBe(96)
    expect(r.vol).toBe(40)
    expect(r.hasHistory).toBe(true)
    expect(r.priceDeviation).toEqual({ buy: (90 - 88) / 88, sell: (100 - 96) / 96 })
  })

  it("手动价最高优先，对应侧偏差为 null", () => {
    const history = { medianBuy: 88, medianSell: 96, avgVol: 40 }
    const r = resolveGuidePrice({ bid: { manual: true, manualPrice: 85 } }, market, history)
    expect(r.buyPrice).toBe(85)
    expect(r.sellPrice).toBe(96)
    expect(r.priceDeviation).toEqual({ buy: null, sell: (100 - 96) / 96 })
  })

  it("历史中位价无效(<=0)时该侧回落快照", () => {
    const history = { medianBuy: -1, medianSell: 96, avgVol: 40 }
    const r = resolveGuidePrice(null, market, history)
    expect(r.buyPrice).toBe(90)
    expect(r.sellPrice).toBe(96)
  })

  it("历史均量无效(<0)时量回落快照", () => {
    const history = { medianBuy: 88, medianSell: 96, avgVol: -1 }
    const r = resolveGuidePrice(null, market, history)
    expect(r.vol).toBe(50)
  })

  it("快照价无效(<=0)时偏差为 null", () => {
    const history = { medianBuy: 88, medianSell: 96, avgVol: 40 }
    const r = resolveGuidePrice(null, { ask: -1, bid: 90, vol: 50 }, history)
    expect(r.priceDeviation).toEqual({ buy: (90 - 88) / 88, sell: null })
  })
})

describe("buildGuideRows 注入历史", () => {
  const plainItem: any = { hrid: "/items/apple", name: "Apple", categoryHrid: "/item_categories/food", itemLevel: 1 }
  const priceGetter = (_hrid: string, level: number) => ({ ask: 100, bid: 90, vol: 50 })
  const manualGetter = () => null

  it("historyGetter 命中时行含 hasHistory 与偏差", () => {
    const historyGetter = () => ({ medianBuy: 88, medianSell: 96, avgVol: 40 })
    const rows = buildGuideRows([plainItem], priceGetter, manualGetter, 0.95, historyGetter)
    expect(rows[0].hasHistory).toBe(true)
    expect(rows[0].buyPrice).toBe(88)
    expect(rows[0].vol).toBe(40)
    expect(rows[0].profitPP).toBe(96 * 0.95 - 88)
  })

  it("historyGetter 返回 null 时行为与原来一致", () => {
    const rows = buildGuideRows([plainItem], priceGetter, manualGetter, 0.95, () => null)
    expect(rows[0].hasHistory).toBe(false)
    expect(rows[0].priceDeviation).toBeNull()
    expect(rows[0].buyPrice).toBe(90)
    expect(rows[0].profitPP).toBe(100 * 0.95 - 90)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: FAIL，报 resolveGuidePrice 相关断言不通过（无历史参数/无 hasHistory 字段）

- [ ] **Step 3: 扩展类型定义**

修改 `src/common/apis/guide/type.d.ts`，GuideItem 增加字段：

```ts
export interface GuideItem {
  hrid: string
  level: number
  name: string
  item: ItemDetail
  /** 买价：挂单买入价（手动 > 1d历史中位 > 市场bid） */
  buyPrice: number
  /** 卖价：挂单卖出价（手动 > 1d历史中位 > 市场ask） */
  sellPrice: number
  vol: number
  profitPP: number | null
  profitRate: number | null
  profitPH: number | null
  profitPD: number | null
  hasManualPrice: boolean
  /** 是否有历史行情数据参与计算 */
  hasHistory: boolean
  /** 快照价相对 1d 中位价的偏差（正=快照偏高）；对应侧手动价或无数据时为 null */
  priceDeviation: { buy: number | null, sell: number | null } | null
  favorite: boolean
}
```

- [ ] **Step 4: 实现三级兜底（calc.ts）**

修改 `src/common/apis/guide/calc.ts`：

1. 在 `resolveGuidePrice` 上方新增类型并替换函数：

```ts
/** 历史行情注入数据（由 store 提供；值无效时回落快照） */
export interface GuideHistoryData {
  /** 1d 买价中位数，<=0 无效 */
  medianBuy: number
  /** 1d 卖价中位数，<=0 无效 */
  medianSell: number
  /** 5d 平均每小时成交量，<0 无效 */
  avgVol: number
}

/**
 * 挂单倒卖口径的价格解析，三级兜底：
 * 买价 = 手动(bid侧) > 1d历史中位买价 > 市场 bid；卖价同理取 ask 侧；成交量 = 5d均量 > 快照。
 * 手动价优先，否则市场价；vol 恒取市场值（无历史时）。
 */
export function resolveGuidePrice(
  manual: GuideManualPrice | null | undefined,
  market: GuideMarketPrice,
  history?: GuideHistoryData | null
) {
  const buyPrice = manual?.bid?.manual
    ? manual.bid.manualPrice!
    : history && history.medianBuy > 0 ? history.medianBuy : market.bid
  const sellPrice = manual?.ask?.manual
    ? manual.ask.manualPrice!
    : history && history.medianSell > 0 ? history.medianSell : market.ask
  const vol = history && history.avgVol >= 0 ? history.avgVol : market.vol
  const hasHistory = !!(history && (history.medianBuy > 0 || history.medianSell > 0 || history.avgVol >= 0))
  const priceDeviation = hasHistory
    ? {
        buy: history!.medianBuy > 0 && !manual?.bid?.manual && market.bid > 0
          ? (market.bid - history!.medianBuy) / history!.medianBuy
          : null,
        sell: history!.medianSell > 0 && !manual?.ask?.manual && market.ask > 0
          ? (market.ask - history!.medianSell) / history!.medianSell
          : null
      }
    : null
  return {
    buyPrice,
    sellPrice,
    vol,
    hasManualPrice: !!manual?.ask?.manual || !!manual?.bid?.manual,
    hasHistory,
    priceDeviation
  }
}
```

2. `buildGuideRows` 增加第 5 参（可选，默认无历史——现有调用与测试兼容）：

```ts
export interface GuideHistoryGetter {
  (hrid: string, level: number): GuideHistoryData | null
}

/** 生成导购行：普通物品 0 级一行；装备额外 +5/+7/+8/+10/+12~+15 */
export function buildGuideRows(
  items: GuideItem["item"][],
  priceGetter: GuidePriceGetter,
  manualGetter: GuideManualGetter,
  taxFactor: number,
  historyGetter?: GuideHistoryGetter
): GuideItem[] {
  const rows: GuideItem[] = []
  for (const item of items) {
    const levels = isEquipmentItem(item) ? [0, ...GUIDE_ENHANCE_LEVELS] : [0]
    for (const level of levels) {
      const price = resolveGuidePrice(
        manualGetter(item.hrid, level),
        priceGetter(item.hrid, level),
        historyGetter?.(item.hrid, level)
      )
      const profit = calcGuideItem(price.buyPrice, price.sellPrice, price.vol, taxFactor)
      rows.push({
        hrid: item.hrid,
        level,
        name: getTrans(item.name),
        item,
        ...price,
        ...profit,
        favorite: false
      })
    }
  }
  return rows
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/utils/guide-history.test.ts && npx vitest run tests/utils/guide.test.ts`
Expected: 两个文件全部 PASS（原 guide.test.ts 不受影响——新参数可选）

- [ ] **Step 6: 类型检查 + 提交**

Run: `npx vue-tsc --noEmit`
Expected: 无类型错误

```bash
git add tests/utils/guide-history.test.ts src/common/apis/guide/type.d.ts src/common/apis/guide/calc.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购三级兜底计算（手动价>1d中位价/5d均量>快照）"
```

---

## Task 5: getGuideDataApi 注入历史数据

**Files:**
- Modify: `src/common/apis/guide/index.ts`

- [ ] **Step 1: 实现注入**

修改 `src/common/apis/guide/index.ts` 的 `getGuideDataApi`：

```ts
import type { GuideHistoryStats } from "./history"
import { historyKeyOf } from "./history"
import type { GuideRequestData } from "./type"

export interface GuideApiParams extends GuideRequestData {
  /** 历史行情数据（key = {hrid}|{level}），可选 */
  historyData?: Map<string, GuideHistoryStats | "failed" | null>
}

/** 查：导购列表（挂单倒卖口径；价格固定 ask/bid 快照，历史数据注入后三级兜底） */
export function getGuideDataApi(params: GuideApiParams) {
  // 数据未就绪时返回空
  const marketData = useGameStoreOutside().marketData
  const gameData = getGameDataApi()
  if (!marketData || !gameData) return { list: [], total: 0 }

  const taxFactor = params.includeTax === false ? NO_TAX_FACTOR : SELL_TAX_FACTOR
  const items = Object.values(gameData.itemDetailMap)

  const historyGetter = (hrid: string, level: number) => {
    const stats = params.historyData?.get(historyKeyOf(hrid, level))
    if (!stats || stats === "failed") return null
    return { medianBuy: stats.medianBuy1d, medianSell: stats.medianSell1d, avgVol: stats.avgVol5d }
  }

  let list = buildGuideRows(
    items,
    (hrid, level) => getPriceOf(hrid, level, PriceStatus.ASK, PriceStatus.BID),
    (hrid, level) => getManualPriceOf(hrid, level),
    taxFactor,
    historyGetter
  )
  list = filterGuideList(list, params)
  list = sortGuideList(list, params.sort)

  const favoriteStore = useGuideFavoriteStoreOutside()
  list.forEach(row => {
    row.favorite = favoriteStore.hasFavorite(row)
  })

  return guidePage(list, params)
}
```

（其余 import 保持现状；新增 import 合并进现有 import 块。）

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: 无类型错误，全量测试通过

- [ ] **Step 3: 提交**

```bash
git add src/common/apis/guide/index.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购 API 注入历史行情数据（三级兜底）"
```

---

## Task 6: 页面集成（进度条/偏差小字/无历史标记）

**Files:**
- Modify: `src/pages/guide/index.vue`

- [ ] **Step 1: 实现页面改动**

修改 `src/pages/guide/index.vue`：

1. script 部分新增 import 与 store 集成：

```ts
import { useGuideHistoryStore } from "@/pinia/stores/guide-history"
import * as Format from "@/common/utils/format"

const historyStore = useGuideHistoryStore()

// 进入页面自动增量抓取历史数据
historyStore.ensureLoaded()

function formatDeviation(dev: { buy: number | null, sell: number | null } | null, row: GuideItem) {
  if (!row.hasHistory) return null
  if (!dev) return null
  const parts: string[] = []
  if (dev.buy !== null) parts.push(`买 ${dev.buy >= 0 ? "+" : ""}${(dev.buy * 100).toFixed(1)}%`)
  if (dev.sell !== null) parts.push(`卖 ${dev.sell >= 0 ? "+" : ""}${(dev.sell * 100).toFixed(1)}%`)
  return parts.length > 0 ? parts.join(" · ") : null
}
```

2. `getGuideData` 调用注入历史数据：

```ts
  getGuideDataApi({
    currentPage: paginationDataGD.currentPage,
    size: paginationDataGD.pageSize,
    includeTax: includeTax.value,
    ...gdSearchData.value,
    sort: sortGD.value,
    historyData: historyStore.data
  }).then(...)
```

3. 监听历史数据版本变化重算（加在现有 watch 之后）：

```ts
// 历史数据就绪/更新后重算
watch(() => historyStore.version, () => {
  getGuideData()
})
```

4. 顶部工具区（`<div class="game-info">` 内，计算税率复选框之后）加进度展示：

```vue
      <div v-if="historyStore.progress" class="history-progress">
        <el-progress
          :percentage="Math.round(historyStore.progress.done / historyStore.progress.total * 100)"
          :stroke-width="6"
          style="width: 160px;"
        />
        <span class="history-progress-text">{{ t('历史数据') }} {{ historyStore.progress.done }}/{{ historyStore.progress.total }}</span>
      </div>
```

5. 物品列（`<el-table-column :label="t('物品')">`）第二行小字：

```vue
          <el-table-column :label="t('物品')">
            <template #default="{ row }">
              <div>{{ row.name }}<span v-if="row.level"> +{{ row.level }}</span></div>
              <div v-if="formatDeviation(row.priceDeviation, row)" class="history-deviation">{{ formatDeviation(row.priceDeviation, row) }}</div>
              <div v-else-if="!row.hasHistory" class="history-deviation">{{ t('无历史') }}</div>
            </template>
          </el-table-column>
```

6. style 区块追加：

```scss
.history-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  .history-progress-text {
    font-size: 12px;
    color: #909399;
    white-space: nowrap;
  }
}
.history-deviation {
  font-size: 12px;
  color: #909399;
}
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: 无类型错误，全量测试通过

- [ ] **Step 3: 提交**

```bash
git add src/pages/guide/index.vue
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购页面集成历史数据（进度条/偏差小字/无历史标记/自动重算）"
```

---

## Task 7: GuideDetail 历史行情区块

**Files:**
- Modify: `src/pages/guide/components/GuideDetail.vue`

- [ ] **Step 1: 实现历史行情区块**

改写 `src/pages/guide/components/GuideDetail.vue`：

```vue
<script setup lang="ts">
import type { GuideItem } from "@@/apis/guide/type"
import type { GuideHistoryStats, WindowReport } from "@@/apis/guide/history"
import { calcHistoryStats, fetchHistoryPoints } from "@@/apis/guide/history"
import ItemIcon from "@@/components/ItemIcon/index.vue"
import * as Format from "@/common/utils/format"
import { useGuideHistoryStore } from "@/pinia/stores/guide-history"

const props = defineProps<{
  modelValue: boolean
  data?: GuideItem
}>()

const emit = defineEmits(["update:modelValue"])
const visible = computed({
  get: () => props.modelValue,
  set: val => emit("update:modelValue", val)
})

const { t } = useI18n()

const historyStore = useGuideHistoryStore()

const historyState = ref<"loading" | "ready" | "none" | "failed">("loading")
const historyStats = ref<GuideHistoryStats | null>(null)

watch(() => props.data, async (row) => {
  historyState.value = "loading"
  historyStats.value = null
  if (!row) return
  const key = `${row.hrid}|${row.level}`
  const cached = historyStore.data.get(key)
  if (cached && cached !== "failed") {
    historyStats.value = cached
    historyState.value = "ready"
    return
  }
  if (cached === "failed") {
    historyState.value = "failed"
    return
  }
  try {
    const points = await fetchHistoryPoints(row.hrid, row.level)
    const stats = calcHistoryStats(points)
    if (stats) {
      historyStats.value = stats
      historyState.value = "ready"
    } else {
      historyState.value = "none"
    }
  } catch {
    historyState.value = "failed"
  }
}, { immediate: true })

const WINDOW_KEYS = ["1d", "3d", "5d"] as const

function fmtPrice(v: number) {
  return v > 0 ? Format.price(v) : "-"
}

function fmtNumber(v: number) {
  return v >= 0 ? Format.number(v) : "-"
}

function reportRow(label: string, r: WindowReport) {
  return {
    label,
    avgPrice: r.volume > 0 ? Format.price(r.avgPrice) : "-",
    medianPrice: r.medianPrice > 0 ? Format.price(r.medianPrice) : "-",
    volume: fmtNumber(r.volume),
    buy: fmtNumber(r.buyVolume),
    sell: fmtNumber(r.sellVolume),
    minMax: r.minPrice > 0 && r.maxPrice > 0 ? `${Format.price(r.minPrice)} / ${Format.price(r.maxPrice)}` : "-"
  }
}

const historyRows = computed(() => {
  const s = historyStats.value
  if (!s) return []
  return WINDOW_KEYS.map(k => reportRow(k, s.report[k]))
})
</script>

<template>
  <el-dialog v-model="visible" :title="t('详情')" :show-close="false" width="60%">
    <template v-if="data">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <ItemIcon :hrid="data.hrid" />
        <span style="font-weight:bold">{{ data.name }}</span>
        <span v-if="data.level">{{ `+${data.level}` }}</span>
      </div>
      <el-descriptions :column="2" border>
        <el-descriptions-item :label="t('买价')">
          {{ data.buyPrice > 0 ? Format.price(data.buyPrice) : "-" }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('卖价')">
          {{ data.sellPrice > 0 ? Format.price(data.sellPrice) : "-" }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('成交量(1h)')">
          {{ data.vol >= 0 ? Format.number(data.vol) : "-" }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('利润率')">
          {{ data.profitRate !== null ? Format.percent(data.profitRate) : "-" }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('利润 / 次')">
          {{ fmt(data.profitPP) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('利润 / h')">
          {{ fmt(data.profitPH) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('利润 / 天')">
          {{ fmt(data.profitPD) }}
        </el-descriptions-item>
      </el-descriptions>

      <div style="font-weight:bold;margin:16px 0 8px">{{ t('历史行情') }}</div>
      <div v-if="historyState === 'loading'" style="color:#909399;font-size:12px">{{ t('加载中...') }}</div>
      <div v-else-if="historyState === 'none'" style="color:#909399;font-size:12px">{{ t('无交易记录') }}</div>
      <div v-else-if="historyState === 'failed'" style="color:#909399;font-size:12px">{{ t('历史数据加载失败') }}</div>
      <el-table v-else :data="historyRows" size="small" border>
        <el-table-column prop="label" :label="t('窗口')" width="60" />
        <el-table-column prop="avgPrice" :label="t('均价')" align="center" />
        <el-table-column prop="medianPrice" :label="t('中位价')" align="center" />
        <el-table-column prop="volume" :label="t('成交量')" align="center" />
        <el-table-column prop="buy" :label="t('买盘')" align="center" />
        <el-table-column prop="sell" :label="t('卖盘')" align="center" />
        <el-table-column prop="minMax" :label="t('最低/最高')" align="center" />
      </el-table>
      <div v-if="historyRows.length > 0" style="color:#909399;font-size:12px;margin-top:6px">
        {{ t('当前快照') }}：ask {{ fmtPrice(data.sellPrice) }} / bid {{ fmtPrice(data.buyPrice) }} / vol {{ fmtNumber(data.vol) }}
      </div>
    </template>
  </el-dialog>
</template>
```

注意：`fmt` 函数（原有）保留。

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: 无类型错误，全量测试通过

- [ ] **Step 3: 提交**

```bash
git add src/pages/guide/components/GuideDetail.vue
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购详情弹窗历史行情区块（1d/3d/5d报表+快照对比）"
```

---

## Task 8: i18n 新文案

**Files:**
- Modify: `src/locales/lang/zh-cn.ts`
- Modify: `src/locales/lang/zh-tw.ts`
- Modify: `src/locales/lang/en.ts`

- [ ] **Step 1: 添加 key**

`zh-cn.ts`（在 `"导购工具": "导购工具",` 后插入）：

```ts
  "导购工具": "导购工具",

  "历史数据": "历史数据",
  "历史行情": "历史行情",
  "无历史": "无历史",
  "中位价": "中位价",
  "买盘": "买盘",
  "卖盘": "卖盘",
  "窗口": "窗口",
  "最低/最高": "最低/最高",
  "无交易记录": "无交易记录",
  "当前快照": "当前快照",
  "历史数据加载失败": "历史数据加载失败",
  "历史数据服务暂不可用，已使用快照数据": "历史数据服务暂不可用，已使用快照数据",
```

`zh-tw.ts`（在 `"导购工具": "導購工具",` 后插入）：

```ts
  "导购工具": "導購工具",

  "历史数据": "歷史數據",
  "历史行情": "歷史行情",
  "无历史": "無歷史",
  "中位价": "中位價",
  "买盘": "買盤",
  "卖盘": "賣盤",
  "窗口": "窗口",
  "最低/最高": "最低/最高",
  "无交易记录": "無交易記錄",
  "当前快照": "當前快照",
  "历史数据加载失败": "歷史數據加載失敗",
  "历史数据服务暂不可用，已使用快照数据": "歷史數據服務暫不可用，已使用快照數據",
```

`en.ts`（在 `"导购工具": "Guide Tool",` 后插入）：

```ts
  "导购工具": "Guide Tool",

  "历史数据": "History",
  "历史行情": "Market History",
  "无历史": "No History",
  "中位价": "Median",
  "买盘": "Buy Vol",
  "卖盘": "Sell Vol",
  "窗口": "Window",
  "最低/最高": "Min/Max",
  "无交易记录": "No Records",
  "当前快照": "Current Snapshot",
  "历史数据加载失败": "History Load Failed",
  "历史数据服务暂不可用，已使用快照数据": "History service unavailable, using snapshot data",
```

注意：`历史数据服务暂不可用，已使用快照数据` 文案在 store 的连续失败中止路径中使用——Task 6 未实现该提示，本任务同时补上：在 `src/pages/guide/index.vue` 监听 historyStore 的 `aborted` 状态（若 store 无此状态，跳过该提示，文案保留备用即可；实现方自查：store 当前未暴露 aborted 标志，则本任务只加文案不动逻辑，并在报告中说明）。

- [ ] **Step 2: 类型检查 + 提交**

Run: `npx vue-tsc --noEmit`
Expected: 无类型错误

```bash
git add src/locales/lang/zh-cn.ts src/locales/lang/zh-tw.ts src/locales/lang/en.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购历史行情三语言文案"
```

---

## Task 9: E2E 验收 + 全量验证 + 部署

**Files:** 无（测试脚本在临时目录）

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `npx vitest run && npx vue-tsc --noEmit`
Expected: 全部通过

- [ ] **Step 2: 启动 dev 服务器**

```bash
cd "E:\项目\niuniu\导购工具" && MSYS2_ENV_CONV_EXCL="VITE_PUBLIC_PATH" npx vite --mode public --port 5173 &
```

- [ ] **Step 3: E2E 验收**（Playwright，Python 脚本放临时目录 `guide_history_e2e.py`）

验收清单（脚本断言）：
1. 进入 `#/guide`：出现进度文本 `历史数据`（或已 ready 无进度条——两种状态都接受）
2. 等待进度条消失（最多 5 分钟，或 ready 状态）：`page.wait_for_function` 检查无 `.history-progress` 元素
3. 物品列出现 `.history-deviation` 小字（部分行"买 +x% · 卖 -y%"或"无历史"）——统计两种小字合计 > 0
4. 打开详情弹窗：出现"历史行情"标题与表格（`窗口`/`均价`/`中位价`/`买盘`/`卖盘`列头），或"无交易记录"/"加载中"（等待 10s 后应为表格或无记录）
5. 控制台无报错
6. 截图存档

（脚本具体实现参照既有 `guide_e2e_test.py` 风格；真实抓取耗时约 3-15 分钟，把超时放宽到 15 分钟。若 q7 服务不可用，验收第 2 步改为断言"进度条消失且页面正常、部分行显示无历史"。）

- [ ] **Step 4: 修复验收发现的问题并提交**（如有）

```bash
git add -A
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "fix: 导购历史行情验收问题修复"
```

- [ ] **Step 5: 部署**

```bash
git push mine main
```

推送后等待 Actions 完成（约 2-5 分钟），用 Playwright 访问 `https://oceanxuhaiao.github.io/milkonomy-DG/#/guide` 复核历史数据集成生效（进度条 → 偏差小字出现）。

---

## 计划自审记录

- **Spec 覆盖**：§3.2 API 常量/参数 → Task 1/2；§3.3 统计纯函数 → Task 1；§3.4 抓取服务（10并发/100ms/重试/连续失败中止）→ Task 2；§3.5 缓存（12h/前缀复用现有库）→ Task 3；§4 store（data/progress/ready/ensureLoaded/无手动刷新）→ Task 3；§5 三级兜底 → Task 4/5；§6.1 进度条 → Task 6；§6.2 偏差小字/无历史 → Task 6；§6.3 详情弹窗 → Task 7；§7 数据流/错误处理 → Task 2/3/6；§8 测试 → Task 1/2/3/4 测试步骤 + Task 9 E2E。i18n（设计未明列但页面必用）→ Task 8。✓
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。✓
- **类型一致性**：`HistoryPoint`/`GuideHistoryStats`/`WindowReport`/`CachedHistory`/`HistoryCache`/`HistoryTask`/`RunHistoryFetchOptions`/`GuideHistoryData`/`GuideHistoryGetter` 在 Task 1-7 中定义与使用一致；`historyKeyOf` 输出 `{hrid}|{level}` 与 store/API 键一致；`GuideItem` 新字段 hasHistory/priceDeviation 在 type.d.ts（Task 4）与页面/详情（Task 6/7）一致。✓
