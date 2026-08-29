import type { GuideHistoryData } from "./calc"
import { getIndexedDbValue, setIndexedDbValue } from "@/common/utils/cache/indexed-db"

/** 自建历史数据文件地址（GitHub Pages 静态托管，可配置） */
export const HISTORY_FILE_URL = "https://oceanxuhaiao.github.io/milkonomy-history/history.json"

/** 缓存过期时间：12 小时（保守频率，减轻第三方服务器负担） */
export const HISTORY_CACHE_TTL = 12 * 60 * 60 * 1000
export const HISTORY_STALE_AFTER = 18 * 60 * 60 * 1000

let lastHistorySourceUpdatedAt = 0
export function getLastHistorySourceUpdatedAt() {
  return lastHistorySourceUpdatedAt
}

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
  /** 最近24h 卖家主动成交价加权中位数；无该侧成交时回退 bid 快照中位数 */
  medianBuy1d: number
  /** 最近24h 买家主动成交价加权中位数；无该侧成交时回退 ask 快照中位数 */
  medianSell1d: number
  buyPriceSource: "trade" | "bid-snapshot" | "none"
  sellPriceSource: "trade" | "ask-snapshot" | "none"
  /** 最近120h 成交量(v)总和 / 120；仅有报价但无成交记录时为0 */
  avgVol5d: number
  report: {
    "1d": WindowReport
    "3d": WindowReport
    "5d": WindowReport
  }
}

/** 历史条目两态：统计值 / null(无有效记录) */
export type GuideHistoryEntry = GuideHistoryStats | null

/** 把历史统计收窄为 calc 层需要的三级兜底数据（字段名映射集中于此） */
export function toGuideHistoryData(stats: GuideHistoryStats): GuideHistoryData {
  return {
    medianBuy: stats.medianBuy1d,
    medianSell: stats.medianSell1d,
    avgVol: stats.avgVol5d
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
      if (digitCount >= 4) step = 5 * 10 ** (digitCount - 4)
      break
    case "3":
    case "4":
      if (digitCount >= 3) step = 10 ** (digitCount - 3)
      break
    default:
      if (digitCount >= 3) step = 2 * 10 ** (digitCount - 3)
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

/** 按成交价更接近当时 bid 还是 ask，估算主动成交方向。 */
export function splitTradeSides(points: HistoryPoint[]) {
  const buySide: HistoryPoint[] = []
  const sellSide: HistoryPoint[] = []
  for (const point of points) {
    if (!(point.v > 0) || !(point.p > 0)) continue
    const hasAsk = point.a > 0
    const hasBid = point.b > 0
    if (hasAsk && point.p >= point.a) {
      buySide.push(point)
    } else if (hasBid && point.p <= point.b) {
      sellSide.push(point)
    } else if (hasAsk && hasBid) {
      const distanceToAsk = Math.abs(point.a - point.p)
      const distanceToBid = Math.abs(point.p - point.b)
      ;(distanceToAsk < distanceToBid ? buySide : sellSide).push(point)
    }
  }
  return { buySide, sellSide }
}

/** 买/卖盘成交量估算（来源：交易量显示插件 processMarketData 的按小时分析法） */
function calcBuySellVolume(points: HistoryPoint[]): { buyVolume: number, sellVolume: number } {
  let buyVolume = 0
  let sellVolume = 0
  if (points.length === 0) return { buyVolume, sellVolume }

  // 按小时分组
  const hourlyData: Record<number, HistoryPoint[]> = {}
  points.forEach((item) => {
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

    currentHourData.forEach((item) => {
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
  const tradedPoints = points.filter(item => item.v > 0)
  const totalV = tradedPoints.reduce((sum, item) => sum + item.v, 0)
  const totalPV = tradedPoints.reduce((sum, item) => sum + item.p * item.v, 0)
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

  const points1d = valid5d.filter(p => inWindow(p, WINDOWS["1d"]))
  const bids1d = points1d.filter(p => p.b > 0).map(p => p.b)
  const asks1d = points1d.filter(p => p.a > 0).map(p => p.a)
  const vols5d = valid5d.filter(p => p.v >= 0).map(p => p.v)

  const { buySide, sellSide } = splitTradeSides(points1d)
  const buyTradeMedian = calcWeightedMedianPrice(sellSide)
  const sellTradeMedian = calcWeightedMedianPrice(buySide)
  const medianBuy1d = buyTradeMedian > 0 ? buyTradeMedian : medianOf(bids1d)
  const medianSell1d = sellTradeMedian > 0 ? sellTradeMedian : medianOf(asks1d)
  const buyPriceSource = buyTradeMedian > 0 ? "trade" : medianBuy1d > 0 ? "bid-snapshot" : "none"
  const sellPriceSource = sellTradeMedian > 0 ? "trade" : medianSell1d > 0 ? "ask-snapshot" : "none"
  // 历史文件只记录有行情的小时。未出现的小时应视为 0 成交，
  // 否则低流通物品（例如 5 天仅成交 1 件）会被错误计算成 1 件/h。
  const avgVol5d = vols5d.reduce((s, v) => s + v, 0) / 120

  const report = {
    "1d": buildWindowReport(valid5d.filter(p => inWindow(p, WINDOWS["1d"]))),
    "3d": buildWindowReport(valid5d.filter(p => inWindow(p, WINDOWS["3d"]))),
    "5d": buildWindowReport(valid5d)
  }

  return { medianBuy1d, medianSell1d, buyPriceSource, sellPriceSource, avgVol5d, report }
}

export function historyKeyOf(hrid: string, level: number) {
  return `${hrid}|${level}`
}

export interface CachedHistory {
  points: HistoryPoint[]
  fetchedAt: number
}

/** 缓存读写接口（可注入 fake 用于测试） */
export interface HistoryCache {
  get: (key: string) => Promise<CachedHistory | null>
  set: (key: string, value: CachedHistory) => Promise<void>
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

/** 解析自建历史数据文件：t→time 字段映射；损坏条目跳过 */
export function parseHistoryFile(json: string): Map<string, HistoryPoint[]> {
  const map = new Map<string, HistoryPoint[]>()
  let data: { history?: Record<string, unknown> }
  try {
    data = JSON.parse(json)
  } catch {
    return map
  }
  const history = data?.history
  if (!history || typeof history !== "object") return map
  for (const [key, value] of Object.entries(history)) {
    if (!Array.isArray(value)) continue
    const points: HistoryPoint[] = []
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue
      const pt = raw as Record<string, unknown>
      const t = pt.t
      if (typeof t !== "number" || !Number.isFinite(t)) continue
      const a = pt.a
      const b = pt.b
      const p = pt.p
      const v = pt.v
      points.push({
        time: t,
        a: typeof a === "number" && Number.isFinite(a) ? a : -1,
        b: typeof b === "number" && Number.isFinite(b) ? b : -1,
        p: typeof p === "number" && Number.isFinite(p) ? p : -1,
        v: typeof v === "number" && Number.isFinite(v) ? v : -1
      })
    }
    if (points.length > 0) map.set(key, points)
  }
  return map
}

export function parseHistoryUpdatedAt(json: string): number {
  try {
    const value = JSON.parse(json)?.updatedAt
    return typeof value === "number" && Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

/** 下载自建历史数据文件（5 秒超时，失败重试 1 次，仍失败抛错） */
export async function fetchHistoryFile(): Promise<Map<string, HistoryPoint[]>> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(HISTORY_FILE_URL, { signal: controller.signal })
      if (!res.ok) throw new Error(`历史数据文件请求失败: ${res.status}`)
      const text = await res.text()
      const map = parseHistoryFile(text)
      if (map.size === 0) throw new Error("历史数据文件为空或格式错误")
      lastHistorySourceUpdatedAt = parseHistoryUpdatedAt(text)
      return map
    } catch (e) {
      lastError = e
    } finally {
      clearTimeout(timeoutId)
    }
  }
  throw lastError instanceof Error ? lastError : new Error("历史数据文件请求失败")
}
