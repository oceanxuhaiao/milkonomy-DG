import { calcGuideItem } from "@@/apis/guide/calc"
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
