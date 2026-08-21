import { buildGuideRows, GUIDE_ENHANCE_LEVELS, resolveGuidePrice } from "@@/apis/guide/calc"
import { buildHistoryTasks, type CachedHistory, calcHistoryStats, fetchHistoryPoints, getPriceTier, HISTORY_API_URL, HISTORY_CACHE_TTL, historyKeyOf, runHistoryFetch, toGuideHistoryData } from "@@/apis/guide/history"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useGuideHistoryStore } from "@/pinia/stores/guide-history"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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
    // 三个点落在 3 个连续小时，各小时 avgAsk=15/avgBid=10 相同；
    // 跨小时 lastAvg 回退路径同时被覆盖
    const points = [
      pt(2, 15, 10, 16, 30), // p 16 >= 15 → 买盘
      pt(3, 15, 10, 9, 20), // p 9 <= 10 → 卖盘
      pt(4, 15, 10, 12, 10) // 居中 12：range 15-10=5 → buyRatio=(12-10)/5=0.4 → 买4 卖6
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
    // 用非档位价格，硬编码期望以独立验证 direction 参数
    const points = [pt(2, 15, 10, 16.7, 5), pt(3, 15, 10, 9.5, 5)]
    const s = calcHistoryStats(points, NOW)!
    // getPriceTier(9.5,"down")：trunc=9，1 位 9 开头 step=1，9%1=0 → 9
    expect(s.report["1d"].minPrice).toBe(9)
    // getPriceTier(16.7,"up")：trunc=16，2 位 1 开头 step=1，16%1=0 → 16
    expect(s.report["1d"].maxPrice).toBe(16)
  })
})

describe("getPriceTier", () => {
  it("档位规则与交易量显示插件 getPriceTier 一致", () => {
    // 以下期望按插件算法（逐字移植）验算修正：
    // 9：1 位 9 开头 → step=1，9 恰在档位上 → 9（原稿期望 8 与算法不符）
    expect(getPriceTier(9, "down")).toBe(9)
    // 16：2 位 1 开头（digitCount<4）→ step=1，16 恰在档位上 → 16（原稿期望 17 与算法不符）
    expect(getPriceTier(16, "up")).toBe(16)
    // 300：3 开头 3 位 → step=10^(3-3)=1 → 300
    expect(getPriceTier(300, "down")).toBe(300)
    // 345：3 开头 3 位 → step=10^(3-3)=1 → 345（原稿期望 340 与算法不符）
    expect(getPriceTier(345, "down")).toBe(345)
    // 1600：1 开头 4 位 → step=5*10^(4-4)=5，1600 恰在档位上 → 1600（原稿期望 1605 与算法不符）
    expect(getPriceTier(1600, "up")).toBe(1600)
    // 58000：5 开头 5 位 → step=2*10^(5-3)=200，58000 恰在档位上 → 58000
    expect(getPriceTier(58000, "down")).toBe(58000)
  })

  it("进位/取整分支与无效输入", () => {
    // 1617：1 开头 4 位 step=5，1617%5=2 → down 退到 1615，up 进一档 1620
    expect(getPriceTier(1617, "up")).toBe(1620)
    expect(getPriceTier(1617, "down")).toBe(1615)
    // 58050：5 开头 5 位 step=2*10^2=200，58050%200=50 → down 退到 58000
    expect(getPriceTier(58050, "down")).toBe(58000)
    // 无效输入（price<=0）返回 0
    expect(getPriceTier(0, "down")).toBe(0)
    expect(getPriceTier(-5, "up")).toBe(0)
    // trunc 后 <=1 返回 2
    expect(getPriceTier(1, "down")).toBe(2)
  })
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

describe("toGuideHistoryData", () => {
  it("字段名映射正确", () => {
    const stats: any = { medianBuy1d: 88, medianSell1d: 96, avgVol5d: 40, report: {} }
    expect(toGuideHistoryData(stats)).toEqual({ medianBuy: 88, medianSell: 96, avgVol: 40 })
  })
})

describe("fetchHistoryPoints", () => {
  it("成功返回数据数组", async () => {
    const payload = [{ time: 1787266800, a: 13, b: 12, p: 12, v: 100 }]
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(payload), { status: 200 }))
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
      (key, result) => {
        items.set(key, result)
      },
      (done, _total) => progress.push(done),
      { gapMs: 0 }
    )
    expect(items.get("/items/a|0")).toEqual(responses["/items/a|0"])
    expect(items.get("/items/b|0")).toEqual([])
    expect(items.size).toBe(3)
    expect(progress[progress.length - 1]).toBe(3)
  })

  it("连续失败达到上限时中止本轮，onAbort 仅调用一次", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })))
    let aborted = false
    const onAbort = vi.fn(() => {
      aborted = true
    })
    await runHistoryFetch(
      Array.from({ length: 5 }, (_, i) => ({ hrid: `/items/x${i}`, level: 0 })),
      () => undefined,
      undefined,
      { gapMs: 0, failLimit: 3, onAbort }
    )
    expect(aborted).toBe(true)
    expect(onAbort).toHaveBeenCalledTimes(1)
  })
})

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
    // 数据点时间取 1 小时前，保证落在 calcHistoryStats 的 5d 统计窗口内
    const t = Math.floor(now / 1000) - 3600
    const cache = {
      get: vi.fn(async (key: string): Promise<CachedHistory | null> => key === "/items/fresh|0"
        ? { points: [{ time: t, a: 2, b: 1, p: 1.5, v: 3 }], fetchedAt: now - 1000 }
        : key === "/items/stale|0"
          ? { points: [{ time: t, a: 2, b: 1, p: 1.5, v: 3 }], fetchedAt: now - HISTORY_CACHE_TTL - 1 }
          : null),
      set: vi.fn(async () => undefined)
    }
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const hrid = decodeURIComponent(String(url).split("item_id=")[1].split("&")[0])
      const level = String(url).split("variant=")[1].split("&")[0]
      return new Response(JSON.stringify(hrid === "/items/missing" && level === "0"
        ? [{ time: t, a: 5, b: 4, p: 4.5, v: 6 }]
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

  it("抓取中重复调用 ensureLoaded 不重复抓取", async () => {
    let resolveFetch!: (r: Response) => void
    const gate = new Promise<Response>((r) => {
      resolveFetch = r
    })
    const fetchMock = vi.fn(async () => gate)
    vi.stubGlobal("fetch", fetchMock)
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
    const items: any[] = [{ hrid: "/items/a", categoryHrid: "/item_categories/food" }]
    const store = makeStore()
    const p1 = store.ensureLoaded(items, cache as any, { gapMs: 0 })
    const p2 = store.ensureLoaded(items, cache as any, { gapMs: 0 })
    await Promise.resolve()
    resolveFetch(new Response(JSON.stringify([]), { status: 200 }))
    await Promise.all([p1, p2])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.ready).toBe(true)
  })

  it("缓存读取抛错时恢复 progress 且 ready 保持 false（可重试）", async () => {
    const cache = {
      get: vi.fn(async () => {
        throw new Error("db fail")
      }),
      set: vi.fn(async () => undefined)
    }
    const items: any[] = [{ hrid: "/items/a", categoryHrid: "/item_categories/food" }]
    const store = makeStore()
    await store.ensureLoaded(items, cache as any, { gapMs: 0 })
    expect(store.progress).toBeNull()
    expect(store.ready).toBe(false)
    // 可重试：第二次调用不再抛错
    const cache2 = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined)
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    await store.ensureLoaded(items, cache2 as any, { gapMs: 0 })
    expect(store.ready).toBe(true)
  })

  it("缓存写入抛错时单条兜底仍写入 data", async () => {
    const cache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error("db fail")
      })
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ time: Math.floor(Date.now() / 1000) - 3600, a: 5, b: 4, p: 4.5, v: 6 }]), { status: 200 })))
    const items: any[] = [{ hrid: "/items/a", categoryHrid: "/item_categories/food" }]
    const store = makeStore()
    await store.ensureLoaded(items, cache as any, { gapMs: 0 })
    expect(store.ready).toBe(true)
    expect(store.data.get("/items/a|0")).toBeTruthy()
  })
})

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
    expect(r.hasHistory).toBe(true)
  })

  it("历史均量无效(<0)时量回落快照", () => {
    const history = { medianBuy: 88, medianSell: 96, avgVol: -1 }
    const r = resolveGuidePrice(null, market, history)
    expect(r.vol).toBe(50)
  })

  it("历史均量为0时视为有效（vol=0 而非回落快照）", () => {
    const history = { medianBuy: 88, medianSell: 96, avgVol: 0 }
    const r = resolveGuidePrice(null, market, history)
    expect(r.vol).toBe(0)
    expect(r.hasHistory).toBe(true)
  })

  it("历史三值全无效时 hasHistory 为 false", () => {
    const r = resolveGuidePrice(null, market, { medianBuy: -1, medianSell: -1, avgVol: -1 })
    expect(r.hasHistory).toBe(false)
    expect(r.priceDeviation).toBeNull()
  })

  it("快照价无效(<=0)时偏差为 null", () => {
    const history = { medianBuy: 88, medianSell: 96, avgVol: 40 }
    const r = resolveGuidePrice(null, { ask: -1, bid: 90, vol: 50 }, history)
    expect(r.priceDeviation).toEqual({ buy: (90 - 88) / 88, sell: null })
  })
})

describe("buildGuideRows 注入历史", () => {
  const plainItem: any = { hrid: "/items/apple", name: "Apple", categoryHrid: "/item_categories/food", itemLevel: 1 }
  const priceGetter = (_hrid: string, _level: number) => ({ ask: 100, bid: 90, vol: 50 })
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
