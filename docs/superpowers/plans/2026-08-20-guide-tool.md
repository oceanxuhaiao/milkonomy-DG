# 导购工具（Guide Tool）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Milkonomy 网站新增"导购工具"页面：以倒卖视角（买价 ask / 卖价 bid 扣税）对全物品做利润排序，含筛选、排序、收藏、自定义价格、详情弹窗。

**Architecture:** 独立轻量数据层（`src/common/apis/guide/`：纯函数 calc.ts + 胶水层 index.ts + 类型 type.d.ts），新建页面 `src/pages/guide/` 及两个弹窗组件，独立收藏 store（不与首页收藏夹互通）。计算不依赖 Calculator 动作体系。

**Tech Stack:** Vue 3 + TypeScript + Element Plus + Pinia + Vitest（happy-dom）

**设计文档：** `docs/superpowers/specs/2026-08-20-guide-tool-design.md`（已与用户确认）

**重要约束（用户明确要求）：**
- **禁止 push/PR 到 GitHub 源码仓库**（polokikiki/Milkonomy）。所有提交仅限本地。
- 本机未配置 git 身份，**每次 commit 必须**带 `-c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com"`（与仓库历史一致），且**不要**运行任何修改 git config 的命令。

**项目约定：**
- 路径别名：`@` = `src`，`@@` = `src/common`，`~` = `types`
- Vue 自动导入已启用（`ref`/`watch`/`computed` 无需 import）；Element Plus 全量注册（`el-*` 组件可直接用）
- UI 文案以中文为 key，i18n 三个语言文件：`src/locales/lang/zh-cn.ts`、`zh-tw.ts`、`en.ts`
- 测试：`tests/**/*.test.ts`，跑 `pnpm test`（vitest，happy-dom）

---

## 文件结构总览

| 操作 | 文件 | 职责 |
|---|---|---|
| Create | `src/common/apis/guide/type.d.ts` | GuideItem / GuideRequestData 类型 |
| Create | `src/common/apis/guide/calc.ts` | 纯函数：计算、行生成、筛选、排序、分页（可单测，不依赖 pinia） |
| Create | `src/common/apis/guide/index.ts` | `getGuideDataApi`：从 store 取数，注入价格 getter，组合 calc 函数 |
| Create | `src/pinia/stores/guide-favorite.ts` | 导购收藏 store（localStorage 持久化） |
| Create | `src/pages/guide/index.vue` | 页面：筛选表单 + 表格 + 分页 |
| Create | `src/pages/guide/components/GuideDetail.vue` | 详情弹窗 |
| Create | `src/pages/guide/components/GuidePrice.vue` | 自定义价格弹窗 |
| Modify | `src/router/routes/public.ts` | 新增 /guide 路由（dashboard 之后） |
| Modify | `src/locales/lang/zh-cn.ts` `zh-tw.ts` `en.ts` | 新增"导购工具"key |
| Test | `tests/utils/guide.test.ts` | calc.ts 全部纯函数测试 |
| Test | `tests/utils/guide-favorite.test.ts` | 收藏 store 测试 |

---

## Task 0: 环境准备

**Files:** 无

- [ ] **Step 1: 安装 pnpm**

```bash
npm install -g pnpm@9
```

- [ ] **Step 2: 安装依赖**

```bash
cd "E:\项目\niuniu\导购工具" && pnpm install
```

Expected: 安装成功，无 peer 依赖致命错误。

- [ ] **Step 3: 跑基线测试**

```bash
pnpm test
```

Expected: 现有测试（demo/Notify/handleSearch/validate）通过。若有个别失败且与本次改动无关，记录后继续，不要顺手修。

- [ ] **Step 4: 提交**（本次无改动，跳过；如 pnpm-lock 有变动则单独提交）

```bash
git status --short
```

---

## Task 1: 类型定义 + calcGuideItem（核心计算）

**Files:**
- Create: `src/common/apis/guide/type.d.ts`
- Create: `src/common/apis/guide/calc.ts`
- Test: `tests/utils/guide.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/utils/guide.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { calcGuideItem } from "@@/apis/guide/calc"

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/utils/guide.test.ts`
Expected: FAIL，报 "Cannot find module '@@/apis/guide/calc'"

- [ ] **Step 3: 创建类型定义**

Create `src/common/apis/guide/type.d.ts`:

```ts
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
  profitRate?: number
  maxItemLevel?: number
  minVolume1h?: number
  maxVolume1h?: number
  banEquipment?: boolean
  banCharm?: boolean
  sort?: { prop: string; order: string }
}
```

- [ ] **Step 4: 实现 calcGuideItem**

Create `src/common/apis/guide/calc.ts`:

```ts
import { getEquipmentTypeOf } from "../utils/game"
import { getTrans } from "@/locales"
import type { GuideItem, GuideRequestData } from "./type"

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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test tests/utils/guide.test.ts`
Expected: 5 个用例全部 PASS

- [ ] **Step 6: 提交**

```bash
git add tests/utils/guide.test.ts src/common/apis/guide/type.d.ts src/common/apis/guide/calc.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具数据层-核心计算 calcGuideItem（含类型定义与测试）"
```

---

## Task 2: resolveGuidePrice + buildGuideRows（行生成）

**Files:**
- Modify: `src/common/apis/guide/calc.ts`
- Test: `tests/utils/guide.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `tests/utils/guide.test.ts` 末尾追加：

```ts
import { buildGuideRows, isEquipmentItem, resolveGuidePrice } from "@@/apis/guide/calc"

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
    expect(rows[0].name).toBe("Apple")
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
```

注意：`import` 语句要移到文件顶部（与原有 import 合并），`describe` 块追加在文件末尾。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/utils/guide.test.ts`
Expected: FAIL，报 "does not provide an export named 'buildGuideRows'"

- [ ] **Step 3: 实现 resolveGuidePrice / isEquipmentItem / buildGuideRows**

在 `src/common/apis/guide/calc.ts` 的 `calcGuideItem` 之后追加：

```ts
export function isEquipmentItem(item: { categoryHrid?: string }) {
  return item.categoryHrid === "/item_categories/equipment"
}

export interface GuideMarketPrice {
  ask: number
  bid: number
  vol: number
}

export interface GuideManualPrice {
  ask?: { manual: boolean; manualPrice?: number }
  bid?: { manual: boolean; manualPrice?: number }
}

/** 手动价优先，否则市场价；vol 恒取市场值 */
export function resolveGuidePrice(manual: GuideManualPrice | null | undefined, market: GuideMarketPrice) {
  const ask = manual?.ask?.manual ? manual.ask.manualPrice! : market.ask
  const bid = manual?.bid?.manual ? manual.bid.manualPrice! : market.bid
  return {
    ask,
    bid,
    vol: market.vol,
    hasManualPrice: !!manual?.ask?.manual || !!manual?.bid?.manual
  }
}

export interface GuidePriceGetter {
  (hrid: string, level: number): GuideMarketPrice
}
export interface GuideManualGetter {
  (hrid: string, level: number): GuideManualPrice | null
}

/** 生成导购行：普通物品 0 级一行；装备额外 +5/+7/+8/+10/+12~+15 */
export function buildGuideRows(
  items: GuideItem["item"][],
  priceGetter: GuidePriceGetter,
  manualGetter: GuideManualGetter,
  taxFactor: number
): GuideItem[] {
  const rows: GuideItem[] = []
  for (const item of items) {
    const levels = isEquipmentItem(item) ? [0, ...GUIDE_ENHANCE_LEVELS] : [0]
    for (const level of levels) {
      const price = resolveGuidePrice(manualGetter(item.hrid, level), priceGetter(item.hrid, level))
      const profit = calcGuideItem(price.ask, price.bid, price.vol, taxFactor)
      rows.push({
        hrid: item.hrid,
        level,
        name: getTrans(item.name),
        item,
        ...price,
        ...profit,
        favorite: false
      })
    }
  }
  return rows
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/utils/guide.test.ts`
Expected: 全部 PASS（原 5 个 + 新 9 个）

- [ ] **Step 5: 提交**

```bash
git add tests/utils/guide.test.ts src/common/apis/guide/calc.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具数据层-行生成（手动价优先/装备强化等级行）"
```

---

## Task 3: filterGuideList（筛选）

**Files:**
- Modify: `src/common/apis/guide/calc.ts`
- Test: `tests/utils/guide.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `tests/utils/guide.test.ts` 末尾追加：

```ts
import { filterGuideList } from "@@/apis/guide/calc"

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
    expect(filterGuideList(rows, { currentPage: 1, size: 10, maxItemLevel: 50 }).length).toBe(1)
  })

  it("成交量区间：vol<0 不通过", () => {
    const rows = [baseRow({ vol: 10 }), baseRow({ vol: 100 }), baseRow({ vol: -1 })]
    const r = filterGuideList(rows, { currentPage: 1, size: 10, minVolume1h: 20, maxVolume1h: 80 })
    expect(r.map(x => x.vol)).toEqual([50])
  })

  it("排除装备", () => {
    const equipRow = baseRow({ item: { ...baseRow().item, categoryHrid: "/item_categories/equipment" } })
    expect(filterGuideList([baseRow(), equipRow], { currentPage: 1, size: 10, banEquipment: true }).length).toBe(1)
  })

  it("排除护符", () => {
    const charmRow = baseRow({ item: { ...baseRow().item, equipmentDetail: { type: "/equipment_types/charm" } } })
    const ringRow = baseRow({ item: { ...baseRow().item, equipmentDetail: { type: "/equipment_types/ring" } } })
    const r = filterGuideList([baseRow(), charmRow, ringRow], { currentPage: 1, size: 10, banCharm: true })
    expect(r.length).toBe(2)
  })
})
```

注意：`import` 合并到文件顶部。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/utils/guide.test.ts`
Expected: FAIL，报 "does not provide an export named 'filterGuideList'"

- [ ] **Step 3: 实现 filterGuideList**

在 `src/common/apis/guide/calc.ts` 末尾追加：

```ts
export function filterGuideList(list: GuideItem[], params: GuideRequestData): GuideItem[] {
  let result = list
  if (params.name) {
    const regex = new RegExp(params.name, "i")
    result = result.filter(row => row.name.match(regex))
  }
  if (params.profitRate) {
    result = result.filter(row => row.profitRate !== null && row.profitRate >= params.profitRate! / 100)
  }
  const hasMaxItemLevel = params.maxItemLevel !== undefined && params.maxItemLevel !== null
  if (hasMaxItemLevel) {
    const maxItemLevel = Number(params.maxItemLevel)
    result = result.filter(row => typeof row.item?.itemLevel === "number" && row.item.itemLevel <= maxItemLevel)
  }
  const hasMinVol = params.minVolume1h !== undefined && params.minVolume1h !== null
  const hasMaxVol = params.maxVolume1h !== undefined && params.maxVolume1h !== null
  if (hasMinVol || hasMaxVol) {
    const minVol = hasMinVol ? Number(params.minVolume1h) : undefined
    const maxVol = hasMaxVol ? Number(params.maxVolume1h) : undefined
    result = result.filter(row => {
      const vol = row.vol
      if (typeof vol !== "number" || vol < 0) return false
      return (minVol === undefined || vol >= minVol) && (maxVol === undefined || vol <= maxVol)
    })
  }
  if (params.banEquipment) {
    result = result.filter(row => !isEquipmentItem(row.item))
  }
  if (params.banCharm) {
    result = result.filter(row => !row.item || getEquipmentTypeOf(row.item) !== "charm")
  }
  return result
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/utils/guide.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add tests/utils/guide.test.ts src/common/apis/guide/calc.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具数据层-筛选 filterGuideList"
```

---

## Task 4: sortGuideList + guidePage（排序与分页）

**Files:**
- Modify: `src/common/apis/guide/calc.ts`
- Test: `tests/utils/guide.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `tests/utils/guide.test.ts` 末尾追加：

```ts
import { guidePage, sortGuideList } from "@@/apis/guide/calc"

describe("sortGuideList", () => {
  const row = (profitPH: number | null, profitRate: number | null = 0.1): any => ({
    hrid: "/items/x", level: 0, name: "X", item: {} as any, ask: 1, bid: 1, vol: 1,
    profitPP: 1, profitRate, profitPH, profitPD: profitPH === null ? null : profitPH * 24,
    hasManualPrice: false, favorite: false
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
```

注意：`import` 合并到文件顶部。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/utils/guide.test.ts`
Expected: FAIL，报 "does not provide an export named 'sortGuideList'"

- [ ] **Step 3: 实现 sortGuideList / guidePage**

在 `src/common/apis/guide/calc.ts` 末尾追加：

```ts
const SORTABLE_PROPS = ["profitPD", "profitPH", "profitRate", "profitPP", "vol"]

function compareGuide(a: GuideItem, b: GuideItem, prop: string, order: string): number {
  const va = (a as any)[prop]
  const vb = (b as any)[prop]
  const aNull = va === null || va === undefined
  const bNull = vb === null || vb === undefined
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  const diff = order === "descending" ? vb - va : va - vb
  if (diff !== 0) return diff
  // 同值兜底：利润/h 降序（null 视为 -Infinity 排最后）
  const pa = a.profitPH ?? -Infinity
  const pb = b.profitPH ?? -Infinity
  return pb - pa
}

/** 排序；无 sort 或 prop 非法时默认按利润/h 降序 */
export function sortGuideList(list: GuideItem[], sort?: { prop: string; order: string }): GuideItem[] {
  const sorted = [...list]
  const prop = sort?.prop && SORTABLE_PROPS.includes(sort.prop) ? sort.prop : "profitPH"
  const order = sort?.order === "ascending" ? "ascending" : "descending"
  sorted.sort((a, b) => compareGuide(a, b, prop, order))
  return sorted
}

export function guidePage(list: GuideItem[], params: GuideRequestData) {
  const start = (params.currentPage - 1) * params.size
  return { list: list.slice(start, start + params.size), total: list.length }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/utils/guide.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add tests/utils/guide.test.ts src/common/apis/guide/calc.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具数据层-排序与分页（null 排最后）"
```

---

## Task 5: 导购收藏 store

**Files:**
- Create: `src/pinia/stores/guide-favorite.ts`
- Test: `tests/utils/guide-favorite.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/utils/guide-favorite.test.ts`:

```ts
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it } from "vitest"
import { useGuideFavoriteStore } from "@/pinia/stores/guide-favorite"

describe("guide-favorite store", () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it("添加/查询/删除收藏", () => {
    const store = useGuideFavoriteStore()
    const row = { hrid: "/items/apple", level: 0 }
    store.addFavorite(row)
    expect(store.hasFavorite({ hrid: "/items/apple", level: 0 })).toBe(true)
    expect(store.hasFavorite({ hrid: "/items/apple", level: 5 })).toBe(false)
    expect(() => store.addFavorite(row)).toThrow("请勿重复添加")
    store.deleteFavorite(row)
    expect(store.hasFavorite(row)).toBe(false)
    expect(() => store.deleteFavorite(row)).toThrow("未找到该记录")
  })

  it("持久化到 localStorage", () => {
    const store = useGuideFavoriteStore()
    store.addFavorite({ hrid: "/items/apple", level: 0 })
    expect(JSON.parse(localStorage.getItem("guide-favorite-list")!)).toEqual([{ hrid: "/items/apple", level: 0 }])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/utils/guide-favorite.test.ts`
Expected: FAIL，报 "Cannot find module '@/pinia/stores/guide-favorite'"

- [ ] **Step 3: 实现 store**

Create `src/pinia/stores/guide-favorite.ts`（结构参照 `src/pinia/stores/favorite.ts`）：

```ts
import { defineStore } from "pinia"
import { pinia } from "@/pinia"

export interface GuideFavoriteItem {
  hrid: string
  level: number
}

export const useGuideFavoriteStore = defineStore("guideFavorite", {
  state: () => ({
    list: load()
  }),
  actions: {
    setList() {
      save(this.list)
    },
    addFavorite(row: GuideFavoriteItem) {
      if (this.hasFavorite(row)) {
        throw new Error("请勿重复添加")
      }
      this.list.push({ hrid: row.hrid, level: row.level })
      this.setList()
    },
    deleteFavorite(row: GuideFavoriteItem) {
      const index = this.list.findIndex(item => item.hrid === row.hrid && item.level === row.level)
      if (index < 0) {
        throw new Error("未找到该记录")
      }
      this.list.splice(index, 1)
      this.setList()
    },
    hasFavorite(row: GuideFavoriteItem) {
      return this.list.some(item => item.hrid === row.hrid && item.level === row.level)
    }
  }
})

const LIST_KEY = "guide-favorite-list"

function load(): GuideFavoriteItem[] {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY) || "[]")
  } catch {
    return []
  }
}

function save(list: GuideFavoriteItem[]) {
  localStorage.setItem(LIST_KEY, JSON.stringify(list))
}

export function useGuideFavoriteStoreOutside() {
  return useGuideFavoriteStore(pinia)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/utils/guide-favorite.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add tests/utils/guide-favorite.test.ts src/pinia/stores/guide-favorite.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购收藏 store（独立存储，与首页收藏夹不互通）"
```

---

## Task 6: getGuideDataApi 胶水层

**Files:**
- Create: `src/common/apis/guide/index.ts`

- [ ] **Step 1: 实现 API**

Create `src/common/apis/guide/index.ts`：

```ts
import { getManualPriceOf } from "../price"
import { getGameDataApi, getPriceOf } from "../game"
import { PriceStatus, useGameStoreOutside } from "@/pinia/stores/game"
import { useGuideFavoriteStoreOutside } from "@/pinia/stores/guide-favorite"
import { buildGuideRows, filterGuideList, guidePage, sortGuideList } from "./calc"
import type { GuideRequestData } from "./type"

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
    (hrid, level) => getPriceOf(hrid, level, PriceStatus.ASK, PriceStatus.BID),
    (hrid, level) => getManualPriceOf(hrid, level),
    taxFactor
  )
  list = filterGuideList(list, params)
  list = sortGuideList(list, params.sort)

  const favoriteStore = useGuideFavoriteStoreOutside()
  list.forEach(row => {
    row.favorite = favoriteStore.hasFavorite(row)
  })

  return guidePage(list, params)
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 3: 提交**

```bash
git add src/common/apis/guide/index.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具 API getGuideDataApi（固定 ask/bid 口径）"
```

---

## Task 7: GuideDetail 详情弹窗组件

**Files:**
- Create: `src/pages/guide/components/GuideDetail.vue`

- [ ] **Step 1: 实现组件**

Create `src/pages/guide/components/GuideDetail.vue`：

```vue
<script setup lang="ts">
import type { GuideItem } from "@@/apis/guide/type"
import ItemIcon from "@@/components/ItemIcon/index.vue"
import * as Format from "@/common/utils/format"

const props = defineProps<{
  modelValue: boolean
  data?: GuideItem
}>()

const emit = defineEmits(["update:modelValue"])
const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit("update:modelValue", val)
})

const { t } = useI18n()

function fmt(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : Format.money(value)
}
</script>

<template>
  <el-dialog v-model="visible" :title="t('详情')" :show-close="false" width="50%">
    <template v-if="data">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <ItemIcon :hrid="data.hrid" />
        <span style="font-weight:bold">{{ data.name }}</span>
        <span v-if="data.level">{{ `+${data.level}` }}</span>
      </div>
      <el-descriptions :column="2" border>
        <el-descriptions-item :label="t('买价')">{{ data.ask > 0 ? Format.price(data.ask) : "-" }}</el-descriptions-item>
        <el-descriptions-item :label="t('卖价')">{{ data.bid > 0 ? Format.price(data.bid) : "-" }}</el-descriptions-item>
        <el-descriptions-item :label="t('成交量(1h)')">{{ data.vol >= 0 ? Format.number(data.vol) : "-" }}</el-descriptions-item>
        <el-descriptions-item :label="t('利润率')">{{ data.profitRate !== null ? Format.percent(data.profitRate) : "-" }}</el-descriptions-item>
        <el-descriptions-item :label="t('利润 / 次')">{{ fmt(data.profitPP) }}</el-descriptions-item>
        <el-descriptions-item :label="t('利润 / h')">{{ fmt(data.profitPH) }}</el-descriptions-item>
        <el-descriptions-item :label="t('利润 / 天')">{{ fmt(data.profitPD) }}</el-descriptions-item>
      </el-descriptions>
    </template>
  </el-dialog>
</template>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 3: 提交**

```bash
git add src/pages/guide/components/GuideDetail.vue
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具详情弹窗 GuideDetail"
```

---

## Task 8: GuidePrice 自定义价格弹窗组件

**Files:**
- Create: `src/pages/guide/components/GuidePrice.vue`

- [ ] **Step 1: 实现组件**

Create `src/pages/guide/components/GuidePrice.vue`：

```vue
<script setup lang="ts">
import type { GuideItem } from "@@/apis/guide/type"
import ItemIcon from "@@/components/ItemIcon/index.vue"
import * as Format from "@/common/utils/format"
import { getPriceOf } from "@/common/apis/game"
import { getManualPriceOf } from "@/common/apis/price"
import { PriceStatus } from "@/pinia/stores/game"
import { usePriceStore } from "@/pinia/stores/price"

const props = defineProps<{
  modelValue: boolean
  data?: GuideItem
}>()

const emit = defineEmits(["update:modelValue"])
const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit("update:modelValue", val)
})

const { t } = useI18n()

interface PriceRow {
  type: "ask" | "bid"
  label: string
  market: number
  manual: boolean
  manualPrice?: number
}

const rows = ref<PriceRow[]>([])

watch(() => props.data, (row) => {
  rows.value = []
  if (!row) return
  const market = getPriceOf(row.hrid, row.level, PriceStatus.ASK, PriceStatus.BID)
  const manual = getManualPriceOf(row.hrid, row.level)
  rows.value = [
    { type: "ask", label: t("买价"), market: market.ask, manual: manual?.ask?.manual || false, manualPrice: manual?.ask?.manualPrice },
    { type: "bid", label: t("卖价"), market: market.bid, manual: manual?.bid?.manual || false, manualPrice: manual?.bid?.manualPrice }
  ]
}, { immediate: true })

function onConfirm() {
  const row = props.data!
  const ask = rows.value.find(r => r.type === "ask")!
  const bid = rows.value.find(r => r.type === "bid")!
  usePriceStore().setPrice({
    hrid: row.hrid,
    level: row.level,
    ask: { manual: ask.manual, manualPrice: ask.manualPrice },
    bid: { manual: bid.manual, manualPrice: bid.manualPrice }
  })
  usePriceStore().commit()
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" :title="t('自定义价格')" :show-close="false" width="50%">
    <div v-if="data" style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <ItemIcon :hrid="data.hrid" />
      <span style="font-weight:bold">{{ data.name }}</span>
      <span v-if="data.level">{{ `+${data.level}` }}</span>
    </div>
    <el-table :data="rows">
      <el-table-column prop="label" :label="t('价格')" />
      <el-table-column :label="t('市场价格')">
        <template #default="{ row }">
          {{ row.market > 0 ? Format.price(row.market) : "-" }}
        </template>
      </el-table-column>
      <el-table-column :label="t('自定义价格')">
        <template #default="{ row }">
          <el-checkbox style="margin-right: 10px;" v-model="row.manual" />
          <el-input-number v-show="row.manual" v-model="row.manualPrice" :controls="false" :min="0" />
        </template>
      </el-table-column>
    </el-table>
    <template #footer>
      <div style="text-align: center;">
        <el-button type="primary" @click="onConfirm">
          {{ t('保存') }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 3: 提交**

```bash
git add src/pages/guide/components/GuidePrice.vue
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具自定义价格弹窗 GuidePrice"
```

---

## Task 9: 导购工具页面 index.vue

**Files:**
- Create: `src/pages/guide/index.vue`

- [ ] **Step 1: 实现页面**

Create `src/pages/guide/index.vue`（参照 `src/pages/dashboard/index.vue` 的结构精简）：

```vue
<script lang="ts" setup>
import type { GuideItem } from "@@/apis/guide/type"
import { getGuideDataApi } from "@@/apis/guide"
import ItemIcon from "@@/components/ItemIcon/index.vue"
import { usePagination } from "@@/composables/usePagination"
import { Edit, Search, Star, StarFilled } from "@element-plus/icons-vue"
import { ElMessage, ElMessageBox, type FormInstance, type Sort } from "element-plus"
import { cloneDeep, debounce } from "lodash-es"

import { useMemory } from "@/common/composables/useMemory"
import * as Format from "@/common/utils/format"
import { useGameStore } from "@/pinia/stores/game"
import { useGuideFavoriteStore } from "@/pinia/stores/guide-favorite"
import { usePriceStore } from "@/pinia/stores/price"
import GuideDetail from "./components/GuideDetail.vue"
import GuidePrice from "./components/GuidePrice.vue"

// #region 查
const favoriteStore = useGuideFavoriteStore()
const { paginationData: paginationDataGD, handleCurrentChange: handleCurrentChangeGD, handleSizeChange: handleSizeChangeGD } = usePagination({}, "guide-pagination")

const guideData = ref<GuideItem[]>([])
const gdSearchFormRef = ref<FormInstance | null>(null)

const gdSearchData = useMemory("guide-search-data", {
  name: "",
  profitRate: 0,
  maxItemLevel: undefined,
  minVolume1h: undefined,
  maxVolume1h: undefined,
  banEquipment: false,
  banCharm: false
})

const includeTax = useMemory("guide-include-tax", true)

const loadingGD = ref(false)

const sortGD: Ref<Sort | undefined> = ref({ prop: "profitPH", order: "descending" })

const getGuideData = debounce(() => {
  loadingGD.value = true
  getGuideDataApi({
    currentPage: paginationDataGD.currentPage,
    size: paginationDataGD.pageSize,
    includeTax: includeTax.value,
    ...gdSearchData.value,
    sort: sortGD.value
  }).then((data) => {
    paginationDataGD.total = data.total
    guideData.value = data.list
  }).catch((e) => {
    console.error(e)
    guideData.value = []
  }).finally(() => {
    loadingGD.value = false
  })
}, 300)

function handleSearchGD() {
  paginationDataGD.currentPage === 1 ? getGuideData() : (paginationDataGD.currentPage = 1)
}

function handleSortGD(sort: Sort) {
  sortGD.value = sort
  getGuideData()
}

// 监听分页/税率/市场数据/价格变化
watch([
  () => paginationDataGD.currentPage,
  () => paginationDataGD.pageSize,
  () => includeTax.value,
  () => useGameStore().marketData,
  () => usePriceStore()
], () => {
  getGuideData()
}, { immediate: true })

// 收藏变化时刷新标记
watch(() => favoriteStore.list, () => {
  getGuideData()
}, { deep: true })
// #endregion

// #region 收藏
function addFavorite(row: GuideItem) {
  try {
    favoriteStore.addFavorite(row)
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}

function deleteFavorite(row: GuideItem) {
  try {
    favoriteStore.deleteFavorite(row)
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}
// #endregion

// #region 详情 / 自定义价格
const currentRow = ref<GuideItem>()
const detailVisible = ref<boolean>(false)
function showDetail(row: GuideItem) {
  currentRow.value = cloneDeep(row)
  detailVisible.value = true
}

const priceVisible = ref<boolean>(false)
const currentPriceRow = ref<GuideItem>()
function setPrice(row: GuideItem) {
  const activated = usePriceStore().activated
  if (!activated) {
    ElMessageBox.confirm(t("是否确定开启自定义价格？"), t("需先开启自定义价格"), {
      confirmButtonText: t("确定"),
      cancelButtonText: t("取消"),
      closeOnClickModal: true
    }).then(() => {
      usePriceStore().setActivated(true)
    })
    return
  }
  currentPriceRow.value = cloneDeep(row)
  priceVisible.value = true
}
// #endregion

const { t } = useI18n()

function fmt(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : Format.money(value)
}

function formatVolume1h(row: GuideItem) {
  return row.vol < 0 ? "-" : Format.number(row.vol)
}
</script>

<template>
  <div class="app-container">
    <div class="game-info">
      <el-checkbox v-model="includeTax" @change="handleSearchGD">
        {{ t('计算税率') }}
      </el-checkbox>
    </div>
    <el-card>
      <template #header>
        <el-form class="rank-card" ref="gdSearchFormRef" :inline="true" :model="gdSearchData">
          <div class="title">
            {{ t('导购工具') }}
          </div>
          <el-form-item prop="name" :label="t('物品')">
            <el-input style="width:100px" v-model="gdSearchData.name" :placeholder="t('请输入')" clearable @input="handleSearchGD" />
          </el-form-item>
          <el-form-item :label="`${t('利润率')} ≥`">
            <el-input style="width:60px" v-model="gdSearchData.profitRate" :placeholder="t('请输入')" clearable @input="handleSearchGD" />&nbsp;%
          </el-form-item>
          <el-form-item :label="`${t('物品等级')} ≤`">
            <el-input-number
              v-model="gdSearchData.maxItemLevel"
              :controls="false"
              @change="handleSearchGD"
              style="width: 80px;"
            />
          </el-form-item>
          <el-form-item :label="`${t('成交量(1h)')} ≥`">
            <el-input-number
              v-model="gdSearchData.minVolume1h"
              :min="0"
              :controls="false"
              @change="handleSearchGD"
              style="width: 90px;"
            />
          </el-form-item>
          <el-form-item :label="`${t('成交量(1h)')} ≤`">
            <el-input-number
              v-model="gdSearchData.maxVolume1h"
              :min="0"
              :controls="false"
              @change="handleSearchGD"
              style="width: 90px;"
            />
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="gdSearchData.banEquipment" @change="handleSearchGD">
              {{ t('排除装备') }}
            </el-checkbox>
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="gdSearchData.banCharm" @change="handleSearchGD">
              {{ t('排除护符') }}
            </el-checkbox>
          </el-form-item>
        </el-form>
      </template>
      <template #default>
        <el-table
          :data="guideData"
          v-loading="loadingGD"
          @sort-change="handleSortGD"
          :default-sort="{ prop: 'profitPH', order: 'descending' }"
          style="overflow-x:auto"
        >
          <el-table-column width="54" fixed="left">
            <template #default="{ row }">
              <ItemIcon :hrid="row.hrid" />
            </template>
          </el-table-column>
          <el-table-column :label="t('物品')">
            <template #default="{ row }">
              {{ row.name }}<span v-if="row.level"> +{{ row.level }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="profitPD" :label="t('利润 / 天')" align="center" min-width="120" sortable="custom">
            <template #default="{ row }">
              <span :class="row.hasManualPrice ? 'manual' : ''">
                {{ fmt(row.profitPD) }}&nbsp;
              </span>
              <el-link type="primary" :icon="Edit" @click="setPrice(row)">
                {{ t('自定义') }}
              </el-link>
            </template>
          </el-table-column>
          <el-table-column prop="profitPH" :label="t('利润 / h')" align="center" min-width="120" sortable="custom">
            <template #default="{ row }">
              {{ fmt(row.profitPH) }}
            </template>
          </el-table-column>
          <el-table-column prop="profitRate" :label="t('利润率')" min-width="120" align="center" sortable="custom">
            <template #default="{ row }">
              {{ row.profitRate !== null ? Format.percent(row.profitRate) : "-" }}
            </template>
          </el-table-column>
          <el-table-column prop="profitPP" :label="t('利润 / 次')" align="center" min-width="120" sortable="custom">
            <template #default="{ row }">
              <span :class="row.hasManualPrice ? 'manual' : ''">{{ fmt(row.profitPP) }}&nbsp;</span>
            </template>
          </el-table-column>
          <el-table-column prop="vol" :label="t('成交量(1h)')" align="center" min-width="120" sortable="custom">
            <template #default="{ row }">
              {{ formatVolume1h(row) }}
            </template>
          </el-table-column>
          <el-table-column :label="t('详情')" align="center">
            <template #default="{ row }">
              <el-link type="primary" :icon="Search" @click="showDetail(row)">
                {{ t('查看') }}
              </el-link>
            </template>
          </el-table-column>
          <el-table-column :label="t('收藏')" align="center">
            <template #default="{ row }">
              <el-link v-if="!row.favorite" :underline="false" type="warning" :icon="Star" @click="addFavorite(row)" style="font-size:24px" />
              <el-link v-else :underline="false" :icon="StarFilled" type="warning" @click="deleteFavorite(row)" style="font-size:28px" />
            </template>
          </el-table-column>
        </el-table>
      </template>
      <template #footer>
        <div class="pager-wrapper">
          <el-pagination
            background
            :layout="paginationDataGD.layout"
            :page-sizes="paginationDataGD.pageSizes"
            :total="paginationDataGD.total"
            :page-size="paginationDataGD.pageSize"
            :current-page="paginationDataGD.currentPage"
            @size-change="handleSizeChangeGD"
            @current-change="handleCurrentChangeGD"
          />
        </div>
      </template>
    </el-card>
    <GuideDetail v-model="detailVisible" :data="currentRow" />
    <GuidePrice v-model="priceVisible" :data="currentPriceRow" />
  </div>
</template>

<style lang="scss" scoped>
.rank-card {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  .title {
    width: 160px;
    margin-bottom: 12px;
  }
}
.pager-wrapper {
  display: flex;
  justify-content: center;
}
.manual {
  color: #409eff;
}
</style>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 3: 提交**

```bash
git add src/pages/guide/index.vue
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具页面（筛选/排序/收藏/自定义价格/详情）"
```

---

## Task 10: 路由与 i18n

**Files:**
- Modify: `src/router/routes/public.ts`
- Modify: `src/locales/lang/zh-cn.ts`
- Modify: `src/locales/lang/zh-tw.ts`
- Modify: `src/locales/lang/en.ts`

- [ ] **Step 1: 新增路由（dashboard 路由之后）**

修改 `src/router/routes/public.ts`，在 dashboard 路由对象结束后插入新路由对象。用 Edit 精确替换：

old_string:

```ts
      {
        path: "dashboard",
        component: () => import("@/pages/dashboard/index.vue"),
        name: "Dashboard",
        meta: {
          title: t("首页"),
          svgIcon: "dashboard",
          affix: true
        }
      }
    ]
  },
```

new_string:

```ts
      {
        path: "dashboard",
        component: () => import("@/pages/dashboard/index.vue"),
        name: "Dashboard",
        meta: {
          title: t("首页"),
          svgIcon: "dashboard",
          affix: true
        }
      }
    ]
  },
  {
    path: "/",
    component: Layouts,
    redirect: "/guide",
    children: [
      {
        path: "guide",
        component: () => import("@/pages/guide/index.vue"),
        name: "Guide",
        meta: {
          title: t("导购工具"),
          svgIcon: "dashboard",
          affix: false
        }
      }
    ]
  },
```

- [ ] **Step 2: i18n 三个语言文件加 key**

`src/locales/lang/zh-cn.ts`（在 `"计算税率": "计算税率",` 行后插入）：

```ts
  "计算税率": "计算税率",

  "导购工具": "导购工具",
```

`src/locales/lang/zh-tw.ts`（在 `"计算税率": "計算稅率",` 行后插入）：

```ts
  "计算税率": "計算稅率",

  "导购工具": "導購工具",
```

`src/locales/lang/en.ts`（在 `"计算税率": "Include Tax",` 行后插入）：

```ts
  "计算税率": "Include Tax",

  "导购工具": "Guide Tool",
```

- [ ] **Step 3: 类型检查**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
git add src/router/routes/public.ts src/locales/lang/zh-cn.ts src/locales/lang/zh-tw.ts src/locales/lang/en.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购工具路由与三语言菜单文案"
```

---

## Task 11: 全量验证

**Files:** 无

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全部测试 PASS（含原有测试 + guide.test.ts + guide-favorite.test.ts）

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm exec vue-tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 启动开发服务器手动验收**

Run: `pnpm dev:public`（或 `pnpm dev`），浏览器打开输出地址，逐项核对：

1. 侧边栏出现"导购工具"菜单（首页下方），点击进入 `/guide`
2. 表格默认按 利润/h 降序；数值列为 "-" 的行排在最后
3. 点各数值列表头可升/降序切换
4. 装备类物品存在 +5/+7/+8/+10/+12/+13/+14/+15 行（如搜索某件装备名）
5. 筛选逐个验证：物品名、利润率≥、物品等级≤、成交量上下限、排除装备、排除护符
6. 勾选/取消"计算税率"，利润数值随之变化（0.95/1 两档）
7. 收藏：点星标收藏后刷新页面仍保持；再次点击取消
8. 自定义价格：未开启时点"自定义"弹确认框；开启后弹窗可改买/卖价，保存后该行数值变蓝（manual 样式）并重算
9. 详情弹窗显示买价/卖价/成交量/四项利润，无效项显示 "-"
10. 与首页对比：导购工具数值 = 卖价×税率-买价 口径（不随首页买价/卖价下拉状态变化）

- [ ] **Step 4: 最终提交**（如有手动验收后的修复）

```bash
git add -A
git status --short
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "fix: 导购工具验收问题修复"
```

若无修复则跳过本步。

- [ ] **Step 5: 完成确认**

Run: `git log --oneline -8`
Expected: 本次功能相关提交齐全，**未执行任何 push 操作**。

---

## 计划自审记录

- **Spec 覆盖**：数据层（§3）→ Task 1/2/3/4/6；收藏（§4）→ Task 5；页面与组件（§5）→ Task 7/8/9；路由与 i18n（§5.3/5.4）→ Task 10；测试（§7）→ Task 1-5 的测试步骤 + Task 11。赚钱速度列按设计文档 §2.2 暂缓，不在本计划内。✓
- **占位符扫描**：无 TBD/TODO；所有代码步骤包含完整代码。✓
- **类型一致性**：`GuideItem` 字段（hrid/level/name/item/ask/bid/vol/profitPP/profitRate/profitPH/profitPD/hasManualPrice/favorite）在 calc.ts、index.vue、GuideDetail.vue、GuidePrice.vue 中一致；`GuideRequestData` 参数名（name/profitRate/maxItemLevel/minVolume1h/maxVolume1h/banEquipment/banCharm/sort/includeTax/currentPage/size）在页面与 API 间一致。✓
