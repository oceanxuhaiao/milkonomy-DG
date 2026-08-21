import { getIndexedDbValue, setIndexedDbValue } from "@/common/utils/cache/indexed-db"
import { guideLevelsOf } from "./calc"

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

export function historyKeyOf(hrid: string, level: number) {
  return `${hrid}|${level}`
}

export interface HistoryTask {
  hrid: string
  level: number
}

/** 生成抓取任务清单：与 buildGuideRows 行生成一致（物品 0 级 + 装备强化等级） */
export function buildHistoryTasks(items: { hrid: string, categoryHrid?: string }[]): HistoryTask[] {
  const tasks: HistoryTask[] = []
  for (const item of items) {
    const levels = guideLevelsOf(item)
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
        if (consecutiveFailures >= failLimit && !aborted) {
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
