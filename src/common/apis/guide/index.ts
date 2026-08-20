import type { GuideRequestData } from "./type"
import { NO_TAX_FACTOR, SELL_TAX_FACTOR } from "@/common/constants/market"
import { PriceStatus, useGameStoreOutside } from "@/pinia/stores/game"
import { useGuideFavoriteStoreOutside } from "@/pinia/stores/guide-favorite"
import { getGameDataApi, getPriceOf } from "../game"
import { getManualPriceOf } from "../price"
import { buildGuideRows, filterGuideList, guidePage, sortGuideList } from "./calc"

/** 查：导购列表（倒卖视角，价格固定 ask/bid，不随全局买价/卖价状态变化） */
export function getGuideDataApi(params: GuideRequestData) {
  // 数据未就绪时返回空
  const marketData = useGameStoreOutside().marketData
  const gameData = getGameDataApi()
  if (!marketData || !gameData) return { list: [], total: 0 }

  const taxFactor = params.includeTax === false ? NO_TAX_FACTOR : SELL_TAX_FACTOR
  const items = Object.values(gameData.itemDetailMap)

  let list = buildGuideRows(
    items,
    (hrid, level) => {
      const price = getPriceOf(hrid, level, PriceStatus.ASK, PriceStatus.BID)
      // 市场数据可能缺 vol，-1 表示无成交量（calc 层按无效处理）
      return { ask: price.ask, bid: price.bid, vol: price.vol ?? -1 }
    },
    // 归一化为契约要求的 GuideManualPrice | null
    (hrid, level) => getManualPriceOf(hrid, level) ?? null,
    taxFactor
  )
  list = filterGuideList(list, params)
  list = sortGuideList(list, params.sort)

  const favoriteStore = useGuideFavoriteStoreOutside()
  list.forEach((row) => {
    row.favorite = favoriteStore.hasFavorite(row)
  })

  return guidePage(list, params)
}
