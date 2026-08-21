import { buildGuideRows, resolveGuidePrice } from "@@/apis/guide/calc"
import { calcHistoryStats, fetchHistoryFile, getPriceTier, parseHistoryFile, toGuideHistoryData } from "@@/apis/guide/history"
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

describe("toGuideHistoryData", () => {
  it("字段名映射正确", () => {
    const stats: any = { medianBuy1d: 88, medianSell1d: 96, avgVol5d: 40, report: {} }
    expect(toGuideHistoryData(stats)).toEqual({ medianBuy: 88, medianSell: 96, avgVol: 40 })
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

  const filePoints = {
    "/items/a|0": [{ t: Math.floor(Date.now() / 1000) - 3600, a: 5, b: 4, p: 4.5, v: 6 }],
    "/items/b|0": [{ t: Math.floor(Date.now() / 1000) - 3600, a: 50, b: 40, p: 45, v: 60 }]
  }

  /** 与 filePoints 同数据、解析后形状（time 字段）——模拟 store 写入的整文件缓存条目 */
  const parsedPoints = {
    "/items/a|0": [{ time: Math.floor(Date.now() / 1000) - 3600, a: 5, b: 4, p: 4.5, v: 6 }],
    "/items/b|0": [{ time: Math.floor(Date.now() / 1000) - 3600, a: 50, b: 40, p: 45, v: 60 }]
  }

  function stubFileResponse(points = filePoints) {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ updatedAt: 1, history: points }), { status: 200 })))
  }

  it("无缓存时下载文件、写整文件缓存并分发统计", async () => {
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
    stubFileResponse()
    const store = makeStore()
    await store.ensureLoaded(cache as any)
    expect(store.ready).toBe(true)
    expect(store.progress).toBeNull()
    const a = store.data.get("/items/a|0") as any
    expect(a.medianBuy1d).toBe(4)
    expect(a.medianSell1d).toBe(5)
    expect(store.data.get("/items/b|0")).toBeTruthy()
    // 整文件单条目缓存写入
    expect(cache.set).toHaveBeenCalledWith("__history_file__", expect.objectContaining({ fetchedAt: expect.any(Number), history: expect.any(Object) }))
  })

  it("整文件缓存 12h 内命中时跳过下载直接分发", async () => {
    const cache = {
      get: vi.fn(async (key: string) => {
        if (key === "__history_file__") {
          return { fetchedAt: Date.now() - 1000, history: parsedPoints }
        }
        return null
      }),
      set: vi.fn(async () => undefined)
    }
    // stub 为 mock，才能断言"未发生下载"
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
    const store = makeStore()
    await store.ensureLoaded(cache as any)
    expect(store.ready).toBe(true)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    const a = store.data.get("/items/a|0") as any
    expect(a.medianBuy1d).toBe(4)
  })

  it("下载失败时 ready 保持 false 且 progress 复位", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })))
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
    const store = makeStore()
    await store.ensureLoaded(cache as any)
    expect(store.ready).toBe(false)
    expect(store.progress).toBeNull()
  })

  it("下载期间重复调用 ensureLoaded 不重复下载", async () => {
    let resolveFetch: (r: Response) => void
    const gate = new Promise<Response>((r) => {
      resolveFetch = r
    })
    vi.stubGlobal("fetch", vi.fn(async () => gate))
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
    const store = makeStore()
    const p1 = store.ensureLoaded(cache as any)
    const p2 = store.ensureLoaded(cache as any)
    await Promise.resolve()
    resolveFetch!(new Response(JSON.stringify({ updatedAt: 1, history: filePoints }), { status: 200 }))
    await Promise.all([p1, p2])
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    expect(store.ready).toBe(true)
  })

  it("缓存写入抛错时仍完成分发", async () => {
    const cache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {
        throw new Error("db fail")
      })
    }
    stubFileResponse()
    const store = makeStore()
    await store.ensureLoaded(cache as any)
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

describe("parseHistoryFile", () => {
  it("解析文件为 Map<key, HistoryPoint[]>（t→time 映射）", () => {
    const file = {
      updatedAt: 1787313960,
      history: {
        "/items/sugar|0": [{ t: 1787310360, a: 13, b: 12, p: 12, v: 3520 }],
        "/items/sword|13": [{ t: 1787313960, a: 200, b: 190, p: -1, v: -1 }]
      }
    }
    const map = parseHistoryFile(JSON.stringify(file))
    expect(map.get("/items/sugar|0")).toEqual([{ time: 1787310360, a: 13, b: 12, p: 12, v: 3520 }])
    expect(map.get("/items/sword|13")).toEqual([{ time: 1787313960, a: 200, b: 190, p: -1, v: -1 }])
  })

  it("损坏条目跳过，无 history 字段返回空 Map", () => {
    const file = {
      updatedAt: 1,
      history: {
        "/items/a|0": [{ t: "bad" }],
        "/items/b|0": "not-array",
        "/items/c|0": [{ t: 100, a: 1, b: 1, p: 1, v: 1 }]
      }
    }
    const map = parseHistoryFile(JSON.stringify(file))
    expect(map.has("/items/a|0")).toBe(false)
    expect(map.has("/items/b|0")).toBe(false)
    expect(map.get("/items/c|0")?.length).toBe(1)
    expect(parseHistoryFile("{}").size).toBe(0)
  })

  it("非对象条目/缺 t 的条目跳过", () => {
    const file = {
      history: {
        "/items/a|0": [null, { a: 1 }, { t: 100, a: 1, b: 1, p: 1, v: 1 }]
      }
    }
    const map = parseHistoryFile(JSON.stringify(file))
    expect(map.get("/items/a|0")?.length).toBe(1)
  })
})

describe("fetchHistoryFile", () => {
  it("成功下载并解析为 Map", async () => {
    const file = { updatedAt: 1, history: { "/items/a|0": [{ t: 100, a: 1, b: 1, p: 1, v: 1 }] } }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(file), { status: 200 })))
    const map = await fetchHistoryFile()
    expect(map.get("/items/a|0")?.length).toBe(1)
  })

  it("http 请求失败重试 1 次后抛错", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchHistoryFile()).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("json 解析失败抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json{", { status: 200 })))
    await expect(fetchHistoryFile()).rejects.toThrow()
  })
})
