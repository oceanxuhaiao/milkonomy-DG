import type { GuideRequestData } from "./type"
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

  const taxFactor = params.includeTax === false ? 1 : 0.95
  const items = Object.values(gameData.itemDetailMap)

  let list = buildGuideRows(
    items,
    (hrid, level) => {
      const price = getPriceOf(hrid, level, PriceStatus.ASK, PriceStatus.BID)
      return { ask: price.ask, bid: price.bid, vol: price.vol ?? -1 }
    },
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
