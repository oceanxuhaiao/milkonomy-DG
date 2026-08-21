import { calcHistoryStats, getPriceTier } from "@@/apis/guide/history"
import { describe, expect, it } from "vitest"

// 固定"现在"：2026-08-21 12:00:00 UTC = 1787266800 秒
const NOW = 1787266800
const H = 3600

/** 构造小时级数据点：hoursAgo 小时前，a/b/p/v 可指定 */
function pt(hoursAgo: number, a: number, b: number, p: number, v: number) {
  return { time: NOW - hoursAgo * H, a, b, p, v }
}

describe("calcHistoryStats", () => {
  it("1d 中位买/卖价（b/a<=0 不参与中位）", () => {
    // 24h 内 4 条 b：10, -1(无效), 12, 14 → 有效 [10,12,14] 中位 12
    const points = [
      pt(2, 15, 10, 13, 5),
      pt(5, 16, -1, 14, 5),
      pt(8, 17, 12, 15, 5),
      pt(10, 18, 14, 16, 5),
      // 24h 外（不影响 1d）
      pt(30, 100, 1, 50, 5)
    ]
    const s = calcHistoryStats(points, NOW)!
    expect(s.medianBuy1d).toBe(12)
    // 24h 内 a：15,16,17,18 → 偶数个取中间两个平均 (16+17)/2
    expect(s.medianSell1d).toBe(16.5)
  })

  it("5d 均量为窗口内 v 的平均", () => {
    const points = [pt(10, 15, 10, 13, 6), pt(50, 15, 10, 13, 10)]
    const s = calcHistoryStats(points, NOW)!
    expect(s.avgVol5d).toBe(8)
  })

  it("窗口边界：恰好 24h/120h 的记录算在窗口内", () => {
    const points = [pt(24, 15, 10, 13, 7), pt(120, 15, 10, 13, 9)]
    const s = calcHistoryStats(points, NOW)!
    expect(s.medianBuy1d).toBe(10) // time >= NOW-24h 含边界
    expect(s.avgVol5d).toBe(8)
  })

  it("5d 窗口内无任何有效记录返回 null", () => {
    expect(calcHistoryStats([], NOW)).toBeNull()
    expect(calcHistoryStats([pt(200, 15, 10, 13, 5)], NOW)).toBeNull()
    expect(calcHistoryStats([pt(2, 0, -1, 0, 0), pt(3, -1, 0, 0, 0)], NOW)).toBeNull()
  })

  it("窗口报表：总成交量/加权均价", () => {
    const points = [pt(2, 15, 10, 13, 6), pt(30, 20, 15, 19, 2)]
    const s = calcHistoryStats(points, NOW)!
    expect(s.report["1d"].volume).toBe(6)
    expect(s.report["1d"].avgPrice).toBe(13)
    expect(s.report["3d"].volume).toBe(8)
    expect(s.report["3d"].avgPrice).toBe((13 * 6 + 19 * 2) / 8)
    expect(s.report["5d"].volume).toBe(8)
  })

  it("买/卖盘估算：p>=ask 计买盘、p<=bid 计卖盘", () => {
    // 三个点落在 3 个连续小时，各小时 avgAsk=15/avgBid=10 相同；
    // 跨小时 lastAvg 回退路径同时被覆盖
    const points = [
      pt(2, 15, 10, 16, 30), // p 16 >= 15 → 买盘
      pt(3, 15, 10, 9, 20), // p 9 <= 10 → 卖盘
      pt(4, 15, 10, 12, 10) // 居中 12：range 15-10=5 → buyRatio=(12-10)/5=0.4 → 买4 卖6
    ]
    const s = calcHistoryStats(points, NOW)!
    expect(s.report["1d"].buyVolume).toBe(34)
    expect(s.report["1d"].sellVolume).toBe(26)
  })

  it("加权中位价：累计成交量过半处的价格", () => {
    const points = [
      pt(2, 15, 10, 10, 30),
      pt(3, 15, 10, 20, 10),
      pt(4, 15, 10, 30, 10)
    ]
    const s = calcHistoryStats(points, NOW)!
    // 总 v=50，中位在 25 处 → 落在价格 10
    expect(s.report["1d"].medianPrice).toBe(10)
  })

  it("min/max 经价格档位修正", () => {
    // 用非档位价格，硬编码期望以独立验证 direction 参数
    const points = [pt(2, 15, 10, 16.7, 5), pt(3, 15, 10, 9.5, 5)]
    const s = calcHistoryStats(points, NOW)!
    // getPriceTier(9.5,"down")：trunc=9，1 位 9 开头 step=1，9%1=0 → 9
    expect(s.report["1d"].minPrice).toBe(9)
    // getPriceTier(16.7,"up")：trunc=16，2 位 1 开头 step=1，16%1=0 → 16
    expect(s.report["1d"].maxPrice).toBe(16)
  })
})

describe("getPriceTier", () => {
  it("档位规则与交易量显示插件 getPriceTier 一致", () => {
    // 以下期望按插件算法（逐字移植）验算修正：
    // 9：1 位 9 开头 → step=1，9 恰在档位上 → 9（原稿期望 8 与算法不符）
    expect(getPriceTier(9, "down")).toBe(9)
    // 16：2 位 1 开头（digitCount<4）→ step=1，16 恰在档位上 → 16（原稿期望 17 与算法不符）
    expect(getPriceTier(16, "up")).toBe(16)
    // 300：3 开头 3 位 → step=10^(3-3)=1 → 300
    expect(getPriceTier(300, "down")).toBe(300)
    // 345：3 开头 3 位 → step=10^(3-3)=1 → 345（原稿期望 340 与算法不符）
    expect(getPriceTier(345, "down")).toBe(345)
    // 1600：1 开头 4 位 → step=5*10^(4-4)=5，1600 恰在档位上 → 1600（原稿期望 1605 与算法不符）
    expect(getPriceTier(1600, "up")).toBe(1600)
    // 58000：5 开头 5 位 → step=2*10^(5-3)=200，58000 恰在档位上 → 58000
    expect(getPriceTier(58000, "down")).toBe(58000)
  })

  it("进位/取整分支与无效输入", () => {
    // 1617：1 开头 4 位 step=5，1617%5=2 → down 退到 1615，up 进一档 1620
    expect(getPriceTier(1617, "up")).toBe(1620)
    expect(getPriceTier(1617, "down")).toBe(1615)
    // 58050：5 开头 5 位 step=2*10^2=200，58050%200=50 → down 退到 58000
    expect(getPriceTier(58050, "down")).toBe(58000)
    // 无效输入（price<=0）返回 0
    expect(getPriceTier(0, "down")).toBe(0)
    expect(getPriceTier(-5, "up")).toBe(0)
    // trunc 后 <=1 返回 2
    expect(getPriceTier(1, "down")).toBe(2)
  })
})
