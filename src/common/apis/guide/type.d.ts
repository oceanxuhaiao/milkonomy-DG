import type { ItemDetail } from "~/game"

export interface GuideItem {
  hrid: string
  level: number
  name: string
  item: ItemDetail
  /** 买价：挂单买入价（市场 bid 侧，手动价优先） */
  buyPrice: number
  /** 卖价：挂单卖出价（市场 ask 侧，手动价优先） */
  sellPrice: number
  vol: number
  profitPP: number | null
  profitRate: number | null
  profitPH: number | null
  profitPD: number | null
  /** 利润/h × √有效利润率 × 价格可信度 */
  tradingEfficiency: number | null
  /** 建议最大投入：按预计日成交量的25%计算，至少1件；不代表一定能成交 */
  suggestedMaxUnits?: number | null
  suggestedMaxInvestment?: number | null
  calculatedAt?: number
  hasManualPrice: boolean
  /** 是否有历史行情数据参与计算 */
  hasHistory: boolean
  /** 快照价相对 1d 成交参考价的偏差（正=快照偏高）；对应侧手动价或无数据时为 null */
  priceDeviation: { buy: number | null, sell: number | null } | null
  favorite: boolean
}

export interface GuideRequestData {
  currentPage: number
  size: number
  includeTax?: boolean
  name?: string
  /** 利润率下限（百分数，10 表示 10%） */
  profitRate?: number
  maxItemLevel?: number
  minVolume1h?: number
  maxVolume1h?: number
  banEquipment?: boolean
  banCharm?: boolean
  sort?: { prop: string, order: string }
}
