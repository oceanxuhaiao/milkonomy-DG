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
