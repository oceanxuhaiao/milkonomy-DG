import type { ItemDetail } from "~/game"

export interface GuideItem {
  hrid: string
  level: number
  name: string
  item: ItemDetail
  ask: number
  bid: number
  vol: number
  profitPP: number | null
  profitRate: number | null
  profitPH: number | null
  profitPD: number | null
  hasManualPrice: boolean
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
