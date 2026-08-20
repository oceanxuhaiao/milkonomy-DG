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

export function isEquipmentItem(item: { categoryHrid?: string }) {
  return item.categoryHrid === "/item_categories/equipment"
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

/**
 * 挂单倒卖口径的价格解析：买价取市场 bid 侧（挂单买入），卖价取市场 ask 侧（挂单卖出）。
 * 手动价优先，否则市场价；vol 恒取市场值。
 */
export function resolveGuidePrice(manual: GuideManualPrice | null | undefined, market: GuideMarketPrice) {
  const buyPrice = manual?.bid?.manual ? manual.bid.manualPrice! : market.bid
  const sellPrice = manual?.ask?.manual ? manual.ask.manualPrice! : market.ask
  return {
    buyPrice,
    sellPrice,
    vol: market.vol,
    hasManualPrice: !!manual?.ask?.manual || !!manual?.bid?.manual
  }
}

export interface GuidePriceGetter {
  (hrid: string, level: number): GuideMarketPrice
}
export interface GuideManualGetter {
  (hrid: string, level: number): GuideManualPrice | null
}

/** 生成导购行：普通物品 0 级一行；装备额外 +5/+7/+8/+10/+12~+15 */
export function buildGuideRows(
  items: GuideItem["item"][],
  priceGetter: GuidePriceGetter,
  manualGetter: GuideManualGetter,
  taxFactor: number
): GuideItem[] {
  const rows: GuideItem[] = []
  for (const item of items) {
    const levels = isEquipmentItem(item) ? [0, ...GUIDE_ENHANCE_LEVELS] : [0]
    for (const level of levels) {
      const price = resolveGuidePrice(manualGetter(item.hrid, level), priceGetter(item.hrid, level))
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

const SORTABLE_PROPS = ["profitPD", "profitPH", "profitRate", "profitPP", "vol"]

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
