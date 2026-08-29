import type { GuideItem, GuideRequestData } from "./type"
import { getTrans } from "@/locales"
import { getEquipmentTypeOf } from "../../utils/game"

/** 装备类物品额外展示的强化等级 */
export const GUIDE_ENHANCE_LEVELS = [5, 7, 8, 10, 12, 13, 14, 15]

/**
 * 四项利润指标（挂单倒卖口径：买价 = 市场 bid 侧挂单买入价，卖价 = 市场 ask 侧挂单卖出价）。
 * 买价/卖价无效（<=0）时四项全为 null；
 * 成交量无效（<0）时仅 利润/h、利润/天 为 null。
 */
export function calcGuideItem(buyPrice: number, sellPrice: number, vol: number, taxFactor: number) {
  const validPrice = buyPrice > 0 && sellPrice > 0
  const validVol = typeof vol === "number" && vol >= 0
  const profitPP = validPrice ? sellPrice * taxFactor - buyPrice : null
  const profitRate = profitPP !== null ? profitPP / buyPrice : null
  const profitPH = profitPP !== null && validVol ? profitPP * vol : null
  const profitPD = profitPH !== null ? profitPH * 24 : null
  return { profitPP, profitRate, profitPH, profitPD }
}

/**
 * 倒货效率 = 利润/h × √有效利润率 × 价格可信度。
 * 有效利润率限制在 0~100%；价格偏差每增加 5%，可信度奖励部分减半。
 * 两侧偏差都缺失时采用 0.5 的保守系数。
 */
export function calcTradingEfficiency(
  profitPH: number | null,
  profitRate: number | null,
  priceDeviation: { buy: number | null, sell: number | null } | null
) {
  if (profitPH === null || profitRate === null) return null
  const effectiveRate = Math.min(Math.max(profitRate, 0), 1)
  const deviations = [priceDeviation?.buy, priceDeviation?.sell]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map(Math.abs)
  const confidence = deviations.length > 0
    ? 0.5 + 0.5 * 2 ** (-Math.max(...deviations) / 0.05)
    : 0.5
  return profitPH * Math.sqrt(effectiveRate) * confidence
}

/** 保守投入上限：最多占预计24小时成交量的25%，且仅在有正成交量和有效买价时给出。 */
export function calcSuggestedInvestment(buyPrice: number, hourlyVolume: number) {
  if (!(buyPrice > 0) || !(hourlyVolume > 0)) {
    return { suggestedMaxUnits: null, suggestedMaxInvestment: null }
  }
  const suggestedMaxUnits = Math.max(1, Math.floor(hourlyVolume * 24 * 0.25))
  return { suggestedMaxUnits, suggestedMaxInvestment: suggestedMaxUnits * buyPrice }
}

export function isEquipmentItem(item: { categoryHrid?: string }) {
  return item.categoryHrid === "/item_categories/equipment"
}

/** 物品的导购行等级列表：普通物品 [0]，装备 [0, ...GUIDE_ENHANCE_LEVELS] */
function guideLevelsOf(item: { categoryHrid?: string }): number[] {
  return isEquipmentItem(item) ? [0, ...GUIDE_ENHANCE_LEVELS] : [0]
}

export interface GuideMarketPrice {
  ask: number
  bid: number
  vol: number
}

export interface GuideManualPrice {
  ask?: { manual: boolean, manualPrice?: number }
  bid?: { manual: boolean, manualPrice?: number }
}

/** 历史行情注入数据（由 store 提供；值无效时回落快照） */
export interface GuideHistoryData {
  /** 1d 卖家主动成交参考价（无成交时已回退 bid 快照中位数），<=0 无效 */
  medianBuy: number
  /** 1d 买家主动成交参考价（无成交时已回退 ask 快照中位数），<=0 无效 */
  medianSell: number
  /** 5d 平均每小时成交量，<0 无效 */
  avgVol: number
}

/**
 * 挂单倒卖口径的价格解析，三级兜底：
 * 买价 = 手动价 > 1d卖家主动成交中位价 > 1d bid中位价 > 当前bid；卖价对应买家主动成交/ask。
 */
export function resolveGuidePrice(
  manual: GuideManualPrice | null | undefined,
  market: GuideMarketPrice,
  history?: GuideHistoryData | null
) {
  const h = history ?? null
  const validBuy = !!h && h.medianBuy > 0
  const validSell = !!h && h.medianSell > 0
  const validVol = !!h && h.avgVol >= 0
  const hasHistory = validBuy || validSell || validVol
  // 有效性标志已保证对应值可用，提取局部变量消除 h! 非空断言
  const hb = h?.medianBuy ?? 0
  const hs = h?.medianSell ?? 0
  const hv = h?.avgVol ?? -1

  const buyPrice = manual?.bid?.manual
    ? manual.bid.manualPrice!
    : validBuy ? hb : market.bid
  const sellPrice = manual?.ask?.manual
    ? manual.ask.manualPrice!
    : validSell ? hs : market.ask
  const vol = validVol ? hv : market.vol
  const priceDeviation = hasHistory
    ? {
        buy: validBuy && !manual?.bid?.manual && market.bid > 0
          ? (market.bid - hb) / hb
          : null,
        sell: validSell && !manual?.ask?.manual && market.ask > 0
          ? (market.ask - hs) / hs
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

export interface GuidePriceGetter {
  (hrid: string, level: number): GuideMarketPrice
}
export interface GuideManualGetter {
  (hrid: string, level: number): GuideManualPrice | null
}

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
    const levels = guideLevelsOf(item)
    for (const level of levels) {
      const price = resolveGuidePrice(
        manualGetter(item.hrid, level),
        priceGetter(item.hrid, level),
        historyGetter?.(item.hrid, level)
      )
      const profit = calcGuideItem(price.buyPrice, price.sellPrice, price.vol, taxFactor)
      const tradingEfficiency = calcTradingEfficiency(profit.profitPH, profit.profitRate, price.priceDeviation)
      const investment = calcSuggestedInvestment(price.buyPrice, price.vol)
      rows.push({
        hrid: item.hrid,
        level,
        name: getTrans(item.name),
        item,
        ...price,
        ...profit,
        tradingEfficiency,
        ...investment,
        calculatedAt: Date.now(),
        favorite: false
      })
    }
  }
  return rows
}

export function filterGuideList(list: GuideItem[], params: GuideRequestData): GuideItem[] {
  let result = list
  if (params.name) {
    const regex = new RegExp(params.name, "i")
    result = result.filter(row => row.name.match(regex))
  }
  if (params.profitRate) {
    result = result.filter(row => row.profitRate !== null && row.profitRate >= params.profitRate! / 100)
  }
  const hasMaxItemLevel = params.maxItemLevel !== undefined && params.maxItemLevel !== null
  if (hasMaxItemLevel) {
    const maxItemLevel = Number(params.maxItemLevel)
    result = result.filter(row => typeof row.item?.itemLevel === "number" && row.item.itemLevel <= maxItemLevel)
  }
  const hasMinVol = params.minVolume1h !== undefined && params.minVolume1h !== null
  const hasMaxVol = params.maxVolume1h !== undefined && params.maxVolume1h !== null
  if (hasMinVol || hasMaxVol) {
    const minVol = hasMinVol ? Number(params.minVolume1h) : undefined
    const maxVol = hasMaxVol ? Number(params.maxVolume1h) : undefined
    result = result.filter((row) => {
      const vol = row.vol
      if (typeof vol !== "number" || vol < 0) return false
      return (minVol === undefined || vol >= minVol) && (maxVol === undefined || vol <= maxVol)
    })
  }
  if (params.banEquipment) {
    result = result.filter(row => !isEquipmentItem(row.item))
  }
  if (params.banCharm) {
    result = result.filter(row => !row.item || getEquipmentTypeOf(row.item) !== "charm")
  }
  return result
}

const SORTABLE_PROPS = ["profitPD", "profitPH", "profitRate", "profitPP", "vol", "tradingEfficiency"]

function compareGuide(a: GuideItem, b: GuideItem, prop: string, order: string): number {
  const va = (a as any)[prop]
  const vb = (b as any)[prop]
  const invalid = (v: any) => v === null || v === undefined || (prop === "vol" && v < 0)
  const aNull = invalid(va)
  const bNull = invalid(vb)
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  const diff = order === "descending" ? vb - va : va - vb
  if (diff !== 0) return diff
  // 同值兜底：利润/h 降序（null 视为 -Infinity 排最后）
  const pa = a.profitPH ?? -Infinity
  const pb = b.profitPH ?? -Infinity
  return pb - pa
}

/** 排序；无 sort 或 prop 非法时默认按利润/h 降序 */
export function sortGuideList(list: GuideItem[], sort?: { prop: string, order: string }): GuideItem[] {
  const sorted = [...list]
  const prop = sort?.prop && SORTABLE_PROPS.includes(sort.prop) ? sort.prop : "profitPH"
  const order = sort?.order === "ascending" ? "ascending" : "descending"
  sorted.sort((a, b) => compareGuide(a, b, prop, order))
  return sorted
}

export function guidePage(list: GuideItem[], params: GuideRequestData) {
  const start = (params.currentPage - 1) * params.size
  return { list: list.slice(start, start + params.size), total: list.length }
}
