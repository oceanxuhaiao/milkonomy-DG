import type { GuideRequestData } from "./type"
import { NO_TAX_FACTOR, SELL_TAX_FACTOR } from "@/common/constants/market"
import { PriceStatus, useGameStoreOutside } from "@/pinia/stores/game"
import { useGuideFavoriteStoreOutside } from "@/pinia/stores/guide-favorite"
import { getGameDataApi, getPriceOf } from "../game"
import { getManualPriceOf } from "../price"
import { buildGuideRows, filterGuideList, guidePage, sortGuideList } from "./calc"
import { type GuideHistoryEntry, historyKeyOf, toGuideHistoryData } from "./history"

export interface GuideApiParams extends GuideRequestData {
  /**
   * 历史行情数据（key = {hrid}|{level}），可选。
   * 值两态：GuideHistoryStats 统计值（参与三级兜底）/ null 无有效记录。
   */
  historyData?: Map<string, GuideHistoryEntry>
  /** 整份历史文件是否已加载完成；完成后缺失条目表示5天零成交 */
  historyReady?: boolean
}

export function getGuideHistoryData(params: Pick<GuideApiParams, "historyData" | "historyReady">, hrid: string, level: number) {
  const stats = params.historyData?.get(historyKeyOf(hrid, level))
  if (stats) return toGuideHistoryData(stats)
  if (params.historyReady) return { medianBuy: -1, medianSell: -1, avgVol: 0 }
  return null
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
    return getGuideHistoryData(params, hrid, level)
  }

  let list = buildGuideRows(
    items,
    (hrid, level) => {
      const price = getPriceOf(hrid, level, PriceStatus.ASK, PriceStatus.BID)
      // 市场数据可能缺 vol，-1 表示无成交量（calc 层按无效处理）
      return { ask: price.ask, bid: price.bid, vol: price.vol ?? -1 }
    },
    // 归一化为契约要求的 GuideManualPrice | null
    (hrid, level) => getManualPriceOf(hrid, level) ?? null,
    taxFactor,
    historyGetter
  )
  list = filterGuideList(list, params)
  list = sortGuideList(list, params.sort)

  const favoriteStore = useGuideFavoriteStoreOutside()
  list.forEach((row) => {
    row.favorite = favoriteStore.hasFavorite(row)
  })

  return guidePage(list, params)
}
