import { buildGuideRows, calcGuideItem, isEquipmentItem, resolveGuidePrice } from "@@/apis/guide/calc"
import { describe, expect, it } from "vitest"

describe("calcGuideItem", () => {
  it("按税率0.95计算四项指标", () => {
    const r = calcGuideItem(100, 120, 10, 0.95)
    expect(r.profitPP).toBe(120 * 0.95 - 100)
    expect(r.profitRate).toBe((120 * 0.95 - 100) / 100)
    expect(r.profitPH).toBe((120 * 0.95 - 100) * 10)
    expect(r.profitPD).toBe((120 * 0.95 - 100) * 10 * 24)
  })

  it("不计税时税因子为1", () => {
    const r = calcGuideItem(100, 120, 10, 1)
    expect(r.profitPP).toBe(20)
    expect(r.profitRate).toBe(0.2)
    expect(r.profitPH).toBe(200)
    expect(r.profitPD).toBe(4800)
  })

  it("买价或卖价无效时四项全为 null", () => {
    for (const [ask, bid] of [[-1, 120], [100, -1], [0, 120], [100, 0]]) {
      const r = calcGuideItem(ask, bid, 10, 0.95)
      expect(r.profitPP).toBeNull()
      expect(r.profitRate).toBeNull()
      expect(r.profitPH).toBeNull()
      expect(r.profitPD).toBeNull()
    }
  })

  it("成交量为负时只有利润/h和利润/天为 null", () => {
    const r = calcGuideItem(100, 120, -1, 0.95)
    expect(r.profitPP).toBe(120 * 0.95 - 100)
    expect(r.profitRate).toBe((120 * 0.95 - 100) / 100)
    expect(r.profitPH).toBeNull()
    expect(r.profitPD).toBeNull()
  })

  it("成交量为0时利润/h和利润/天为0", () => {
    const r = calcGuideItem(100, 120, 0, 0.95)
    expect(r.profitPH).toBe(0)
    expect(r.profitPD).toBe(0)
  })
})

describe("resolveGuidePrice", () => {
  const market = { ask: 100, bid: 90, vol: 50 }

  it("无手动价时用市场价", () => {
    const r = resolveGuidePrice(null, market)
    expect(r).toEqual({ ask: 100, bid: 90, vol: 50, hasManualPrice: false })
  })

  it("手动买价优先于市场价", () => {
    const r = resolveGuidePrice({ ask: { manual: true, manualPrice: 88 } }, market)
    expect(r.ask).toBe(88)
    expect(r.bid).toBe(90)
    expect(r.hasManualPrice).toBe(true)
  })

  it("手动价 manual=false 时仍用市场价", () => {
    const r = resolveGuidePrice({ ask: { manual: false, manualPrice: 88 } }, market)
    expect(r.ask).toBe(100)
    expect(r.hasManualPrice).toBe(false)
  })
})

describe("isEquipmentItem", () => {
  it("按 categoryHrid 判断装备", () => {
    expect(isEquipmentItem({ categoryHrid: "/item_categories/equipment" })).toBe(true)
    expect(isEquipmentItem({ categoryHrid: "/item_categories/food" })).toBe(false)
    expect(isEquipmentItem({})).toBe(false)
  })
})

describe("buildGuideRows", () => {
  const plainItem: any = { hrid: "/items/apple", name: "Apple", categoryHrid: "/item_categories/food", itemLevel: 1 }
  const equipItem: any = { hrid: "/items/test_sword", name: "Test Sword", categoryHrid: "/item_categories/equipment", itemLevel: 10, equipmentDetail: { type: "/equipment_types/sword" } }
  const priceGetter = (_hrid: string, level: number) => ({ ask: 100, bid: 120, vol: 10 + level })
  const manualGetter = () => null

  it("普通物品只有0级一行", () => {
    const rows = buildGuideRows([plainItem], priceGetter, manualGetter, 0.95)
    expect(rows.length).toBe(1)
    expect(rows[0].level).toBe(0)
    expect(rows[0].name).toBe("苹果")
    expect(rows[0].profitPP).toBe(120 * 0.95 - 100)
  })

  it("装备物品生成0级+8个强化等级共9行", () => {
    const rows = buildGuideRows([equipItem], priceGetter, manualGetter, 0.95)
    expect(rows.map(r => r.level)).toEqual([0, 5, 7, 8, 10, 12, 13, 14, 15])
    // 成交量按 level 传入，验证 getter 收到正确等级
    expect(rows[1].vol).toBe(15)
  })

  it("手动价行标记 hasManualPrice", () => {
    const manualGetter2 = (hrid: string, level: number) =>
      hrid === "/items/apple" && level === 0 ? { ask: { manual: true, manualPrice: 95 } } : null
    const rows = buildGuideRows([plainItem], priceGetter, manualGetter2, 0.95)
    expect(rows[0].hasManualPrice).toBe(true)
    expect(rows[0].ask).toBe(95)
  })

  it("favorite 初始为 false", () => {
    const rows = buildGuideRows([plainItem], priceGetter, manualGetter, 0.95)
    expect(rows[0].favorite).toBe(false)
  })
})
