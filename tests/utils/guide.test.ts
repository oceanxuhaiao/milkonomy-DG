import { buildGuideRows, calcGuideItem, filterGuideList, guidePage, isEquipmentItem, resolveGuidePrice, sortGuideList } from "@@/apis/guide/calc"
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

  it("手动卖价优先于市场价", () => {
    const r = resolveGuidePrice({ bid: { manual: true, manualPrice: 95 } }, market)
    expect(r.bid).toBe(95)
    expect(r.ask).toBe(100)
    expect(r.hasManualPrice).toBe(true)
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

describe("filterGuideList", () => {
  const baseRow = (over: Partial<any> = {}): any => ({
    hrid: "/items/apple",
    level: 0,
    name: "Apple",
    item: { hrid: "/items/apple", name: "Apple", categoryHrid: "/item_categories/food", itemLevel: 10, equipmentDetail: undefined },
    ask: 100,
    bid: 120,
    vol: 50,
    profitPP: 14,
    profitRate: 0.14,
    profitPH: 700,
    profitPD: 16800,
    hasManualPrice: false,
    favorite: false,
    ...over
  })

  it("名称搜索（不区分大小写）", () => {
    const rows = [baseRow(), baseRow({ name: "Milk" })]
    expect(filterGuideList(rows, { currentPage: 1, size: 10, name: "app" }).map(r => r.name)).toEqual(["Apple"])
  })

  it("利润率下限：null 不通过", () => {
    const rows = [baseRow({ profitRate: 0.05 }), baseRow({ profitRate: 0.2 }), baseRow({ profitRate: null })]
    expect(filterGuideList(rows, { currentPage: 1, size: 10, profitRate: 10 }).map(r => r.profitRate)).toEqual([0.2])
  })

  it("物品等级上限", () => {
    const rows = [baseRow(), baseRow({ item: { ...baseRow().item, itemLevel: 100 } })]
    const r = filterGuideList(rows, { currentPage: 1, size: 10, maxItemLevel: 50 })
    expect(r[0].item.itemLevel).toBe(10)
  })

  it("成交量区间：vol<0 不通过", () => {
    const rows = [baseRow({ vol: 10 }), baseRow(), baseRow({ vol: 100 }), baseRow({ vol: -1 })]
    const r = filterGuideList(rows, { currentPage: 1, size: 10, minVolume1h: 20, maxVolume1h: 80 })
    expect(r.map(x => x.vol)).toEqual([50])
  })

  it("排除装备", () => {
    const equipRow = baseRow({ item: { ...baseRow().item, categoryHrid: "/item_categories/equipment" } })
    const r = filterGuideList([baseRow(), equipRow], { currentPage: 1, size: 10, banEquipment: true })
    expect(r[0].item.categoryHrid).toBe("/item_categories/food")
  })

  it("排除护符", () => {
    const charmRow = baseRow({ item: { ...baseRow().item, equipmentDetail: { type: "/equipment_types/charm" } } })
    const ringRow = baseRow({ item: { ...baseRow().item, equipmentDetail: { type: "/equipment_types/ring" } } })
    const r = filterGuideList([baseRow(), charmRow, ringRow], { currentPage: 1, size: 10, banCharm: true })
    expect(r.length).toBe(2)
  })
})

describe("sortGuideList", () => {
  const row = (profitPH: number | null, profitRate: number | null = 0.1): any => ({
    hrid: "/items/x",
    level: 0,
    name: "X",
    item: {} as any,
    ask: 1,
    bid: 1,
    vol: 1,
    profitPP: 1,
    profitRate,
    profitPH,
    profitPD: profitPH === null ? null : profitPH * 24,
    hasManualPrice: false,
    favorite: false
  })

  it("默认按利润/h降序", () => {
    const rows = [row(100), row(300), row(200)]
    expect(sortGuideList(rows).map(r => r.profitPH)).toEqual([300, 200, 100])
  })

  it("升序", () => {
    const rows = [row(300), row(100)]
    expect(sortGuideList(rows, { prop: "profitPH", order: "ascending" }).map(r => r.profitPH)).toEqual([100, 300])
  })

  it("利润率列排序", () => {
    const rows = [row(100, 0.05), row(100, 0.3), row(100, 0.1)]
    expect(sortGuideList(rows, { prop: "profitRate", order: "descending" }).map(r => r.profitRate)).toEqual([0.3, 0.1, 0.05])
  })

  it("排序列同值时兜底按利润/h降序", () => {
    const rows = [row(100, 0.1), row(300, 0.1)]
    // profitRate 相同 → 触发兜底：profitPH 高的 300 排前面
    expect(sortGuideList(rows, { prop: "profitRate", order: "descending" }).map(r => r.profitPH)).toEqual([300, 100])
  })

  it("null 恒排最后（无论升降序）", () => {
    const rows = [row(null), row(300), row(null), row(100)]
    const desc = sortGuideList(rows, { prop: "profitPH", order: "descending" })
    expect(desc.map(r => r.profitPH)).toEqual([300, 100, null, null])
    const asc = sortGuideList(rows, { prop: "profitPH", order: "ascending" })
    expect(asc.map(r => r.profitPH)).toEqual([100, 300, null, null])
  })

  it("非法 prop 回退为利润/h降序", () => {
    const rows = [row(100), row(300)]
    expect(sortGuideList(rows, { prop: "hack", order: "descending" }).map(r => r.profitPH)).toEqual([300, 100])
  })

  it("vol 为 -1 的行按成交量排序时恒排最后", () => {
    const rows = [
      { hrid: "/items/a", level: 0, name: "A", item: {} as any, ask: 1, bid: 1, vol: 50, profitPP: 1, profitRate: 0.1, profitPH: 100, profitPD: 2400, hasManualPrice: false, favorite: false },
      { hrid: "/items/b", level: 0, name: "B", item: {} as any, ask: 1, bid: 1, vol: -1, profitPP: 1, profitRate: 0.1, profitPH: 100, profitPD: 2400, hasManualPrice: false, favorite: false },
      { hrid: "/items/c", level: 0, name: "C", item: {} as any, ask: 1, bid: 1, vol: 10, profitPP: 1, profitRate: 0.1, profitPH: 100, profitPD: 2400, hasManualPrice: false, favorite: false }
    ]
    const asc = sortGuideList(rows, { prop: "vol", order: "ascending" })
    expect(asc.map(r => r.hrid)).toEqual(["/items/c", "/items/a", "/items/b"])
    const desc = sortGuideList(rows, { prop: "vol", order: "descending" })
    expect(desc.map(r => r.hrid)).toEqual(["/items/a", "/items/c", "/items/b"])
  })
})

describe("guidePage", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ hrid: `/items/${i}` })) as any[]

  it("按 currentPage/size 切片并返回 total", () => {
    const r = guidePage(rows, { currentPage: 2, size: 10 })
    expect(r.total).toBe(25)
    expect(r.list.length).toBe(10)
    expect(r.list[0].hrid).toBe("/items/10")
  })
})
