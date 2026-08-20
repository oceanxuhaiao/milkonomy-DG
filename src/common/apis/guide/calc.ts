import type { GuideItem } from "./type"
import { getTrans } from "@/locales"

/** 装备类物品额外展示的强化等级 */
export const GUIDE_ENHANCE_LEVELS = [5, 7, 8, 10, 12, 13, 14, 15]

/**
 * 四项利润指标。
 * 买价/卖价无效（<=0）时四项全为 null；
 * 成交量无效（<0）时仅 利润/h、利润/天 为 null。
 */
export function calcGuideItem(ask: number, bid: number, vol: number, taxFactor: number) {
  const validPrice = ask > 0 && bid > 0
  const validVol = typeof vol === "number" && vol >= 0
  const profitPP = validPrice ? bid * taxFactor - ask : null
  const profitRate = profitPP !== null ? profitPP / ask : null
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

/** 手动价优先，否则市场价；vol 恒取市场值 */
export function resolveGuidePrice(manual: GuideManualPrice | null | undefined, market: GuideMarketPrice) {
  const ask = manual?.ask?.manual ? manual.ask.manualPrice! : market.ask
  const bid = manual?.bid?.manual ? manual.bid.manualPrice! : market.bid
  return {
    ask,
    bid,
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
      const profit = calcGuideItem(price.ask, price.bid, price.vol, taxFactor)
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
