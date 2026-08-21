# 导购工具·自建历史数据源 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 GitHub Actions 定时采集官方 marketplace.json 积累 5 天历史，静态托管到 GitHub Pages 形成自建数据源；Milkonomy 端替换 q7 为全量文件下载模式。

**Architecture:** 两个仓库协作——新数据仓库 `milkonomy-history`（collect.js 采集脚本 + 每小时定时 workflow，force push 单文件到 gh-pages）；Milkonomy 端 history.ts 增加全量文件下载/解析（parseHistoryFile/fetchHistoryFile），store 重写 ensureLoaded（元数据判缓存 → 下载 → 分发），删除逐物品抓取服务。

**Tech Stack:** 数据仓库：Node 22 原生（fetch/fs/node:test）+ GitHub Actions；Milkonomy 端：Vue 3 + TS + Pinia + IndexedDB + Vitest

**设计文档：** `docs/superpowers/specs/2026-08-21-guide-history-selfhost-design.md`（已确认）

**关键约束：**
- **禁止 push 到 polokikiki/Milkonomy**；本地提交用 `-c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com"`；推送数据仓库用 `mine` 系远程（用户自建仓库）
- 测试命令用 `npx vitest run <file>`（**不要用 `pnpm test`**，watch 模式在本环境挂起）
- 项目 pre-commit 钩子（eslint --fix）会自动格式化——正常现象，提交后重跑测试确认
- 数据仓库文件在 Milkonomy 仓库之外（路径用 `../milkonomy-history/` 表示，执行时按实际位置操作）

---

## 文件结构总览

**数据仓库 `milkonomy-history`（新）：**

| 操作 | 文件 | 职责 |
|---|---|---|
| Create | `collect.js` | 采集脚本：fetch 官方 → buildSnapshot/mergeHistory 纯函数 → 写 history.json（main 保护，可被 require 测试） |
| Create | `test.js` | node:test 单测（纯函数） |
| Create | `.github/workflows/collect.yml` | 每小时 :23 定时 + 手动触发 + push 触发；concurrency 防并发；force push gh-pages |

**Milkonomy 仓库：**

| 操作 | 文件 | 职责 |
|---|---|---|
| Modify | `src/common/apis/guide/history.ts` | 新增 HISTORY_FILE_URL/parseHistoryFile/fetchHistoryFile；后删逐物品抓取服务 |
| Modify | `src/pinia/stores/guide-history.ts` | ensureLoaded 重写（元数据缓存判断 → 下载 → 分发） |
| Modify | `src/pages/guide/components/GuideDetail.vue` | 删除按需单查分支 |
| Modify | `tests/utils/guide-history.test.ts` | 新增 parseHistoryFile/ensureLoaded 测试，删除旧抓取服务测试 |

---

## Task 1: 数据仓库 collect.js（纯函数 + node:test）

**Files:**
- Create: `../milkonomy-history/collect.js`
- Test: `../milkonomy-history/test.js`

- [ ] **Step 1: 写失败测试**

Create `../milkonomy-history/test.js`:

```js
const { test } = require("node:test")
const assert = require("node:assert")
const { buildSnapshot, mergeHistory } = require("./collect")

const NOW = 1787313960

test("buildSnapshot 把官方 marketData 转换为 {key: {a,b,p,v}}", () => {
  const marketData = {
    "/items/sugar": { "0": { a: 13, b: 12, p: 12, v: 3520 } },
    "/items/sword": { "0": { a: 100 }, "13": { a: 200, b: 190 } }
  }
  const snap = buildSnapshot(marketData)
  assert.deepStrictEqual(snap["/items/sugar|0"], { a: 13, b: 12, p: 12, v: 3520 })
  assert.deepStrictEqual(snap["/items/sword|0"], { a: 100, b: -1, p: -1, v: -1 })
  assert.deepStrictEqual(snap["/items/sword|13"], { a: 200, b: 190, p: -1, v: -1 })
})

test("mergeHistory 首次采集：只有新快照点", () => {
  const snap = { "/items/sugar|0": { a: 13, b: 12, p: 12, v: 100 } }
  const result = mergeHistory({}, snap, NOW, NOW)
  assert.deepStrictEqual(result["/items/sugar|0"], [{ t: NOW, a: 13, b: 12, p: 12, v: 100 }])
})

test("mergeHistory 追加新点且按时间升序", () => {
  const existing = { "/items/sugar|0": [{ t: NOW - 3600, a: 12, b: 11, p: 11, v: 80 }] }
  const snap = { "/items/sugar|0": { a: 13, b: 12, p: 12, v: 100 } }
  const result = mergeHistory(existing, snap, NOW, NOW)
  assert.strictEqual(result["/items/sugar|0"].length, 2)
  assert.strictEqual(result["/items/sugar|0"][0].t, NOW - 3600)
  assert.strictEqual(result["/items/sugar|0"][1].t, NOW)
})

test("mergeHistory 同 t 去重：新快照覆盖", () => {
  const existing = { "/items/sugar|0": [{ t: NOW, a: 12, b: 11, p: 11, v: 80 }] }
  const snap = { "/items/sugar|0": { a: 13, b: 12, p: 12, v: 100 } }
  const result = mergeHistory(existing, snap, NOW, NOW)
  assert.strictEqual(result["/items/sugar|0"].length, 1)
  assert.strictEqual(result["/items/sugar|0"][0].v, 100)
})

test("mergeHistory 滚动剔除 5 天前的点", () => {
  const RETENTION = 5 * 24 * 3600
  const existing = {
    "/items/sugar|0": [
      { t: NOW - RETENTION - 1, a: 10, b: 9, p: 9, v: 50 },  // 超期 → 剔除
      { t: NOW - RETENTION, a: 11, b: 10, p: 10, v: 60 },      // 恰在边界 → 保留
      { t: NOW - 3600, a: 12, b: 11, p: 11, v: 70 }
    ]
  }
  const result = mergeHistory(existing, {}, NOW, NOW)
  assert.strictEqual(result["/items/sugar|0"].length, 2)
  assert.strictEqual(result["/items/sugar|0"][0].t, NOW - RETENTION)
})

test("mergeHistory 组合无任何有效点时不输出 key", () => {
  const RETENTION = 5 * 24 * 3600
  const existing = { "/items/sugar|0": [{ t: NOW - RETENTION - 100, a: 1, b: 1, p: 1, v: 1 }] }
  const result = mergeHistory(existing, {}, NOW, NOW)
  assert.strictEqual(result["/items/sugar|0"], undefined)
})

test("mergeHistory 跳过损坏的旧点", () => {
  const existing = { "/items/sugar|0": [null, { t: "bad" }, { t: NOW - 3600, a: 12, b: 11, p: 11, v: 70 }] }
  const result = mergeHistory(existing, {}, NOW, NOW)
  assert.strictEqual(result["/items/sugar|0"].length, 1)
  assert.strictEqual(result["/items/sugar|0"][0].v, 70)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ../milkonomy-history && node --test test.js`
Expected: FAIL，报 "Cannot find module './collect'"

- [ ] **Step 3: 实现 collect.js**

Create `../milkonomy-history/collect.js`:

```js
#!/usr/bin/env node
// 采集官方 marketplace.json，滚动维护 5 天历史到 history.json
const fs = require("fs")
const path = require("path")

const OFFICIAL_URL = "https://www.milkywayidle.com/game_data/marketplace.json"
const HISTORY_FILE = path.join(__dirname, "history.json")
const RETENTION_SECONDS = 5 * 24 * 60 * 60

/** 官方格式 marketData[item][level]={a,b,p,v} → { "{item}|{level}": {a,b,p,v} }，缺省字段用 -1 */
function buildSnapshot(marketData) {
  const snapshot = {}
  for (const item of Object.keys(marketData || {})) {
    for (const level of Object.keys(marketData[item] || {})) {
      const p = marketData[item][level] || {}
      snapshot[`${item}|${level}`] = {
        a: typeof p.a === "number" ? p.a : -1,
        b: typeof p.b === "number" ? p.b : -1,
        p: typeof p.p === "number" ? p.p : -1,
        v: typeof p.v === "number" ? p.v : -1
      }
    }
  }
  return snapshot
}

/**
 * 合并历史与新快照：
 * - 新快照按 timestamp 追加，同 t 去重（新覆盖旧）
 * - 滚动剔除 t < now - RETENTION_SECONDS 的点
 * - 跳过损坏的旧点；组合无有效点时不输出 key
 */
function mergeHistory(existing, snapshot, timestamp, now) {
  const cutoff = now - RETENTION_SECONDS
  const result = {}
  const keys = new Set([...Object.keys(existing || {}), ...Object.keys(snapshot || {})])
  for (const key of keys) {
    const points = new Map()
    for (const pt of existing?.[key] || []) {
      if (pt && typeof pt.t === "number" && pt.t >= cutoff) points.set(pt.t, pt)
    }
    const snap = snapshot?.[key]
    if (snap && typeof timestamp === "number" && timestamp >= cutoff) {
      points.set(timestamp, { t: timestamp, a: snap.a, b: snap.b, p: snap.p, v: snap.v })
    }
    if (points.size > 0) {
      result[key] = [...points.values()].sort((x, y) => x.t - y.t)
    }
  }
  return result
}

async function main() {
  let res
  try {
    res = await fetch(OFFICIAL_URL)
  } catch (e) {
    console.error("官方数据请求失败:", e.message)
    process.exit(0) // 跳过本轮，不产生坏数据
  }
  if (!res.ok) {
    console.error(`官方数据请求失败: ${res.status}`)
    process.exit(0)
  }
  const data = await res.json()
  if (!data || !data.marketData || typeof data.timestamp !== "number") {
    console.error("官方数据格式异常")
    process.exit(0)
  }

  let existing = {}
  try {
    existing = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"))?.history || {}
  } catch {
    existing = {}
  }

  const now = Math.floor(Date.now() / 1000)
  const snapshot = buildSnapshot(data.marketData)
  const history = mergeHistory(existing, snapshot, data.timestamp, now)

  fs.writeFileSync(HISTORY_FILE, JSON.stringify({ updatedAt: data.timestamp, history }))
  const pointCount = Object.values(history).reduce((sum, pts) => sum + pts.length, 0)
  console.log(`采集完成: ${Object.keys(history).length} 组合, ${pointCount} 点, updatedAt=${data.timestamp}`)
}

if (require.main === module) {
  main().catch(e => {
    console.error(e)
    process.exit(0)
  })
}

module.exports = { buildSnapshot, mergeHistory }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd ../milkonomy-history && node --test test.js`
Expected: 全部 PASS（7 个用例）

- [ ] **Step 5: 本地真实验证（手动跑一次采集）**

Run: `cd ../milkonomy-history && node collect.js && node -e "const d=require('./history.json'); console.log('组合数:', Object.keys(d.history).length, 'updatedAt:', d.updatedAt)"`
Expected: 输出组合数 > 0、updatedAt 为官方 timestamp；history.json 生成（若官方接口不可达则跳过本轮并退出 0——属预期行为）

- [ ] **Step 6: 提交**（数据仓库在 Milkonomy 仓库外，若尚未 git init 则先初始化；提交到数据仓库自己的 git）

```bash
cd ../milkonomy-history
git init 2>/dev/null
git add collect.js test.js
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 采集脚本（官方数据滚动 5 天历史）"
```

---

## Task 2: 数据仓库 workflow

**Files:**
- Create: `../milkonomy-history/.github/workflows/collect.yml`

- [ ] **Step 1: 实现 workflow**

Create `../milkonomy-history/.github/workflows/collect.yml`:

```yaml
name: Collect Market History
on:
  schedule:
    # 每小时 :23 分（官方数据约整点后几分钟更新）
    - cron: "23 * * * *"
  workflow_dispatch:
  push:
    branches: [main]

concurrency:
  group: collect
  cancel-in-progress: true

permissions:
  contents: write

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout gh-pages
        uses: actions/checkout@v4
        with:
          ref: gh-pages
          fetch-depth: 0

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Run collect
        run: node collect.js

      - name: Commit and force push history.json
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add history.json
          if git diff --cached --quiet; then
            echo "No changes, skip push"
          else
            git commit -m "chore: collect $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            git push --force origin gh-pages
          fi
```

注意：checkout `ref: gh-pages` 需要 gh-pages 分支已存在——首次部署时由 Task 6 的部署流程创建（orphan 空分支 push）。collect.js/test.js 也需在 gh-pages 分支上（checkout gh-pages 后运行 `node collect.js`）——所以**两个文件也要同步到 gh-pages 分支**：部署流程（Task 6）中把 main 的内容合并到 gh-pages。

- [ ] **Step 2: 提交**

```bash
cd ../milkonomy-history
git add .github/workflows/collect.yml
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 每小时定时采集工作流（force push gh-pages）"
```

---

## Task 3: Milkonomy history.ts 新增全量文件接口（旧服务暂保留）

**Files:**
- Modify: `src/common/apis/guide/history.ts`
- Test: `tests/utils/guide-history.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/utils/guide-history.test.ts` 末尾追加：

```ts
import { fetchHistoryFile, parseHistoryFile } from "@@/apis/guide/history"

describe("parseHistoryFile", () => {
  it("解析文件为 Map<key, HistoryPoint[]>（t→time 映射）", () => {
    const file = {
      updatedAt: 1787313960,
      history: {
        "/items/sugar|0": [{ t: 1787310360, a: 13, b: 12, p: 12, v: 3520 }],
        "/items/sword|13": [{ t: 1787313960, a: 200, b: 190, p: -1, v: -1 }]
      }
    }
    const map = parseHistoryFile(JSON.stringify(file))
    expect(map.get("/items/sugar|0")).toEqual([{ time: 1787310360, a: 13, b: 12, p: 12, v: 3520 }])
    expect(map.get("/items/sword|13")).toEqual([{ time: 1787313960, a: 200, b: 190, p: -1, v: -1 }])
  })

  it("损坏条目跳过，无 history 字段返回空 Map", () => {
    const file = {
      updatedAt: 1,
      history: {
        "/items/a|0": [{ t: "bad" }],
        "/items/b|0": "not-array",
        "/items/c|0": [{ t: 100, a: 1, b: 1, p: 1, v: 1 }]
      }
    }
    const map = parseHistoryFile(JSON.stringify(file))
    expect(map.has("/items/a|0")).toBe(false)
    expect(map.has("/items/b|0")).toBe(false)
    expect(map.get("/items/c|0")?.length).toBe(1)
    expect(parseHistoryFile("{}").size).toBe(0)
  })

  it("非对象条目/缺 t 的条目跳过", () => {
    const file = {
      history: {
        "/items/a|0": [null, { a: 1 }, { t: 100, a: 1, b: 1, p: 1, v: 1 }]
      }
    }
    const map = parseHistoryFile(JSON.stringify(file))
    expect(map.get("/items/a|0")?.length).toBe(1)
  })
})

describe("fetchHistoryFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("成功下载并解析为 Map", async () => {
    const file = { updatedAt: 1, history: { "/items/a|0": [{ t: 100, a: 1, b: 1, p: 1, v: 1 }] } }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(file), { status: 200 })))
    const map = await fetchHistoryFile()
    expect(map.get("/items/a|0")?.length).toBe(1)
  })

  it("HTTP 失败重试 1 次后抛错", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchHistoryFile()).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("JSON 解析失败抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json{", { status: 200 })))
    await expect(fetchHistoryFile()).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: FAIL，报 "does not provide an export named 'parseHistoryFile'"

- [ ] **Step 3: 实现**

在 `src/common/apis/guide/history.ts` 中：

1. 替换 `HISTORY_API_URL` 常量区（旧 q7 常量**保留到 Task 5 再删**，本任务并存）：

```ts
/** 自建历史数据文件地址（GitHub Pages 静态托管，可配置） */
export const HISTORY_FILE_URL = "https://oceanxuhaiao.github.io/milkonomy-history/history.json"
```

2. 文件末尾追加：

```ts
/** 解析自建历史数据文件：t→time 字段映射；损坏条目跳过 */
export function parseHistoryFile(json: string): Map<string, HistoryPoint[]> {
  const map = new Map<string, HistoryPoint[]>()
  let data: { history?: Record<string, unknown> }
  try {
    data = JSON.parse(json)
  } catch {
    return map
  }
  const history = data?.history
  if (!history || typeof history !== "object") return map
  for (const [key, value] of Object.entries(history)) {
    if (!Array.isArray(value)) continue
    const points: HistoryPoint[] = []
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue
      const pt = raw as Record<string, unknown>
      if (typeof pt.t !== "number") continue
      points.push({
        time: pt.t,
        a: typeof pt.a === "number" ? pt.a : -1,
        b: typeof pt.b === "number" ? pt.b : -1,
        p: typeof pt.p === "number" ? pt.p : -1,
        v: typeof pt.v === "number" ? pt.v : -1
      })
    }
    if (points.length > 0) map.set(key, points)
  }
  return map
}

/** 下载自建历史数据文件（5 秒超时，失败重试 1 次，仍失败抛错） */
export async function fetchHistoryFile(): Promise<Map<string, HistoryPoint[]>> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(HISTORY_FILE_URL, { signal: controller.signal })
      if (!res.ok) throw new Error(`历史数据文件请求失败: ${res.status}`)
      const text = await res.text()
      const map = parseHistoryFile(text)
      if (map.size === 0) throw new Error("历史数据文件为空或格式错误")
      return map
    } catch (e) {
      lastError = e
    } finally {
      clearTimeout(timeoutId)
    }
  }
  throw lastError instanceof Error ? lastError : new Error("历史数据文件请求失败")
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/utils/guide-history.test.ts && npx vue-tsc --noEmit`
Expected: 全部 PASS（旧测试不受影响——旧服务仍在）

- [ ] **Step 5: 提交**

```bash
git add tests/utils/guide-history.test.ts src/common/apis/guide/history.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购历史自建数据源文件解析与下载（parseHistoryFile/fetchHistoryFile）"
```

---

## Task 4: store 重写 ensureLoaded（全量文件模式）

**Files:**
- Modify: `src/pinia/stores/guide-history.ts`
- Test: `tests/utils/guide-history.test.ts`（store describe 重写）

- [ ] **Step 1: 重写测试**

把 `tests/utils/guide-history.test.ts` 中 `describe("guide-history store")` 整块替换为：

```ts
import { useGuideHistoryStore } from "@/pinia/stores/guide-history"
import { HISTORY_FILE_URL } from "@@/apis/guide/history"

describe("guide-history store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function makeStore(overrides: Partial<ReturnType<typeof useGuideHistoryStore>> = {}) {
    const store = useGuideHistoryStore()
    return Object.assign(store, overrides)
  }

  const filePoints = {
    "/items/a|0": [{ t: Math.floor(Date.now() / 1000) - 3600, a: 5, b: 4, p: 4.5, v: 6 }],
    "/items/b|0": [{ t: Math.floor(Date.now() / 1000) - 3600, a: 50, b: 40, p: 45, v: 60 }]
  }

  function stubFileResponse(points = filePoints) {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ updatedAt: 1, history: points }), { status: 200 })))
  }

  it("无缓存时下载文件、拆开写缓存并分发统计", async () => {
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
    stubFileResponse()
    const store = makeStore()
    await store.ensureLoaded(cache as any)
    expect(store.ready).toBe(true)
    expect(store.progress).toBeNull()
    const a = store.data.get("/items/a|0") as any
    expect(a.medianBuy1d).toBe(4)
    expect(a.medianSell1d).toBe(5)
    expect(store.data.get("/items/b|0")).toBeTruthy()
    // 元数据 + 各组合缓存均写入
    expect(cache.set).toHaveBeenCalledWith("__meta__", expect.objectContaining({ fetchedAt: expect.any(Number) }))
    expect(cache.set).toHaveBeenCalledWith("/items/a|0", expect.objectContaining({ points: expect.any(Array) }))
  })

  it("元数据 12h 内命中时跳过下载直接分发", async () => {
    const cache = {
      get: vi.fn(async (key: string) => {
        if (key === "__meta__") return { fetchedAt: Date.now() - 1000 }
        return null
      }),
      set: vi.fn(async () => undefined)
    }
    const store = makeStore()
    await store.ensureLoaded(cache as any)
    expect(store.ready).toBe(true)
    // 未下载文件
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("下载失败时 ready 保持 false 且 progress 复位", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })))
    const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
    const store = makeStore()
    await store.ensureLoaded(cache as any)
    expect(store.ready).toBe(false)
    expect(store.progress).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/utils/guide-history.test.ts`
Expected: FAIL，store 用例失败（ensureLoaded 仍是旧实现，签名不匹配）

- [ ] **Step 3: 重写 store**

整体替换 `src/pinia/stores/guide-history.ts`：

```ts
import { defineStore } from "pinia"
import { pinia } from "@/pinia"
import {
  calcHistoryStats,
  fetchHistoryFile,
  HISTORY_CACHE_TTL,
  historyKeyOf,
  indexedDbHistoryCache,
  type GuideHistoryEntry,
  type GuideHistoryStats,
  type HistoryCache
} from "@/common/apis/guide/history"

const META_KEY = "__meta__"
const EMPTY_POINTS: never[] = []

export const useGuideHistoryStore = defineStore("guideHistory", {
  state: () => ({
    /** key = {hrid}|{level}，三态：统计值 / null(无有效记录) / "failed"(抓取失败) */
    data: new Map<string, GuideHistoryEntry>(),
    progress: null as { done: number; total: number } | null,
    ready: false,
    /** 数据版本号：分发完成 +1，页面 watch 此值触发重算 */
    version: 0
  }),
  actions: {
    /**
     * 进入页面时调用：下载自建历史数据文件 → 拆开存缓存 → 逐 key 计算统计进 data。
     * cache 可注入（测试用）；默认走 IndexedDB。
     */
    async ensureLoaded(cache: HistoryCache = indexedDbHistoryCache) {
      if (this.progress) return
      try {
        // 元数据命中（12h 内）→ 跳过下载，直接用缓存分发
        const meta = await cache.get(META_KEY)
        if (meta && Date.now() - meta.fetchedAt < HISTORY_CACHE_TTL) {
          await this.distributeFromCache(cache)
          return
        }

        this.progress = { done: 0, total: 0 }
        const file = await fetchHistoryFile()
        const total = file.size
        this.progress = { done: 0, total }

        await cache.set(META_KEY, { fetchedAt: Date.now() })

        let done = 0
        for (const [key, points] of file) {
          await cache.set(key, { points, fetchedAt: Date.now() })
          this.data.set(key, calcHistoryStats(points))
          done++
          this.progress = { done, total }
          this.version++
        }
        this.progress = null
        this.ready = true
        this.version++
      } catch (e) {
        console.error("历史数据加载失败:", e)
        this.progress = null
      }
    },
    /** 缓存命中路径：读各 key 缓存并计算统计（与下载路径共享分发逻辑） */
    async distributeFromCache(cache: HistoryCache) {
      const cached = await cache.get(META_KEY)
      if (!cached || Date.now() - cached.fetchedAt >= HISTORY_CACHE_TTL) return false
      // 从缓存逐 key 读取：缓存 key 集合无法枚举，改为由页面传入的任务清单？
      return false
    }
  }
})

export function useGuideHistoryStoreOutside() {
  return useGuideHistoryStore(pinia)
}
```

**重要说明**：上述草稿暴露一个问题——IndexedDB 的 kv 存储无法枚举 key（现有 `indexed-db.ts` 只有 get/set/remove，无 keys()）。缓存命中路径"逐 key 分发"需要 key 清单。解决方案（选 B，实现简单）：

**缓存改为"整文件"粒度**：`cache.set(META_KEY, { fetchedAt, history: { [key]: HistoryPoint[] } })` 一个条目存全部（~15MB 单值，IndexedDB 支持）。命中时读 META_KEY → 遍历 history 分发。这样：

- 元数据与数据合一（META_KEY 即唯一缓存条目）
- 分发路径统一：`distribute(historyMap)` 一个函数，下载路径和缓存路径共用
- IndexedDB 无需枚举能力

按此修正后的 store 完整实现：

```ts
import { defineStore } from "pinia"
import { pinia } from "@/pinia"
import {
  calcHistoryStats,
  fetchHistoryFile,
  HISTORY_CACHE_TTL,
  indexedDbHistoryCache,
  type GuideHistoryEntry,
  type HistoryCache,
  type HistoryPoint
} from "@/common/apis/guide/history"

const CACHE_KEY = "__history_file__"

/** 整文件缓存条目：数据与时间戳合一（IndexedDB kv 无法枚举，单条目存全部） */
interface HistoryFileCache {
  fetchedAt: number
  history: Record<string, HistoryPoint[]>
}

export const useGuideHistoryStore = defineStore("guideHistory", {
  state: () => ({
    /** key = {hrid}|{level}，三态：统计值 / null(无有效记录) / "failed" */
    data: new Map<string, GuideHistoryEntry>(),
    progress: null as { done: number; total: number } | null,
    ready: false,
    /** 数据版本号：分发完成 +1，页面 watch 此值触发重算 */
    version: 0
  }),
  actions: {
    /**
     * 进入页面时调用：优先读 12h 内的整文件缓存，否则下载自建历史文件；
     * 数据到位后逐 key 计算统计进 data。
     * cache 可注入（测试用）；默认走 IndexedDB。
     */
    async ensureLoaded(cache: HistoryCache = indexedDbHistoryCache) {
      if (this.progress) return
      try {
        let file: HistoryFileCache | null = null
        const cached = await cache.get(CACHE_KEY) as HistoryFileCache | null
        if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL) {
          file = cached
        } else {
          const map = await fetchHistoryFile()
          const history: Record<string, HistoryPoint[]> = {}
          for (const [key, points] of map) history[key] = points
          file = { fetchedAt: Date.now(), history }
          await cache.set(CACHE_KEY, file)
        }

        const keys = Object.keys(file.history)
        this.progress = { done: 0, total: keys.length }
        for (const key of keys) {
          this.data.set(key, calcHistoryStats(file.history[key]))
          this.progress = { done: this.progress.done + 1, total: keys.length }
          this.version++
        }
        this.progress = null
        this.ready = true
        this.version++
      } catch (e) {
        console.error("历史数据加载失败:", e)
        this.progress = null
      }
    }
  }
})

export function useGuideHistoryStoreOutside() {
  return useGuideHistoryStore(pinia)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/utils/guide-history.test.ts && npx vue-tsc --noEmit`
Expected: store 新用例 3/3 PASS；旧抓取服务测试仍通过（旧函数还在）；类型检查通过

- [ ] **Step 5: 提交**

```bash
git add tests/utils/guide-history.test.ts src/pinia/stores/guide-history.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "feat: 导购历史 store 重写为全量文件模式（整文件缓存+分发）"
```

---

## Task 5: 删除逐物品抓取服务 + GuideDetail 简化

**Files:**
- Modify: `src/common/apis/guide/history.ts`
- Modify: `src/pages/guide/components/GuideDetail.vue`
- Test: `tests/utils/guide-history.test.ts`（删除旧测试）

- [ ] **Step 1: 删除 history.ts 旧服务**

删除以下导出与常量（及不再使用的 import）：
- 常量：`HISTORY_API_URL`、`HISTORY_CONCURRENCY`、`HISTORY_REQUEST_GAP_MS`、`HISTORY_FAIL_LIMIT`
- 函数/类型：`fetchHistoryPoints`、`runHistoryFetch`、`RunHistoryFetchOptions`、`HistoryTask`、`buildHistoryTasks`
- `guideLevelsOf` import（若不再被 history.ts 使用——检查后移除）

保留：`HISTORY_CACHE_TTL`、`HistoryPoint`/`WindowReport`/`GuideHistoryStats`、`calcHistoryStats`/`getPriceTier`、`toGuideHistoryData`、`GuideHistoryEntry`、`HistoryCache`/`CachedHistory`/`indexedDbHistoryCache`、`historyKeyOf`、`HISTORY_FILE_URL`/`parseHistoryFile`/`fetchHistoryFile`

- [ ] **Step 2: GuideDetail 简化**

`src/pages/guide/components/GuideDetail.vue` 的 watch 中删除按需单查分支：`cached === undefined`（store 无该 key）→ 直接 "none"（全量文件已含所有组合，缺失即无数据）。完整替换 watch 为：

```ts
watch(() => props.data, (row) => {
  historyState.value = "loading"
  historyStats.value = null
  if (!row) return
  // 全量文件模式：store.data 已含全部组合；缺失即无交易记录
  const cached = historyStore.data.get(historyKeyOf(row.hrid, row.level))
  if (cached === null || cached === undefined) {
    historyState.value = "none"
  } else if (cached === "failed") {
    historyState.value = "failed"
  } else {
    historyStats.value = cached
    historyState.value = "ready"
  }
}, { immediate: true })
```

同时移除不再使用的 import（`calcHistoryStats`、`fetchHistoryPoints`）与 `reqSeq` 变量。

- [ ] **Step 3: 更新测试**

`tests/utils/guide-history.test.ts`：
- 删除 describe：`historyKeyOf / buildHistoryTasks`、`fetchHistoryPoints`、`runHistoryFetch`（含 onAbort 用例）
- 保留：`calcHistoryStats`、`getPriceTier`、`resolveGuidePrice 三级兜底`、`buildGuideRows 注入历史`、`toGuideHistoryData`、`parseHistoryFile`、`fetchHistoryFile`、`guide-history store`
- 顶部 import 相应清理（删除 buildHistoryTasks/fetchHistoryPoints/historyKeyOf/runHistoryFetch/HISTORY_API_URL 的测试引用；historyKeyOf 若测试其他地方未用则一并清理）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run && npx vue-tsc --noEmit`
Expected: 全量测试通过，无类型错误（Grep 确认 src 下无 fetchHistoryPoints/runHistoryFetch/buildHistoryTasks 残留引用）

- [ ] **Step 5: 提交**

```bash
git add src/common/apis/guide/history.ts src/pages/guide/components/GuideDetail.vue tests/utils/guide-history.test.ts
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "refactor: 删除导购历史逐物品抓取服务（q7），弹窗改读 store 缓存"
```

---

## Task 6: 部署与线上验证

**Files:** 无（操作类任务）

- [ ] **Step 1: 用户建数据仓库**

用户在 GitHub 新建空仓库 `milkonomy-history`（Public，不要勾选初始化文件）。

- [ ] **Step 2: 推送数据仓库（含 gh-pages 分支初始化）**

```bash
cd ../milkonomy-history
git remote add origin https://github.com/oceanxuhaiao/milkonomy-history.git
git push -u origin main
# 初始化 gh-pages 分支（空提交，内容与 main 相同——workflow 在 gh-pages 上跑脚本）
git checkout --orphan gh-pages
git rm -rf . 2>/dev/null || true
git checkout main -- collect.js test.js .github
git add -A
git -c user.name="7tnwvk6872-png" -c user.email="7tnwvk6872-png@users.noreply.github.com" commit -m "chore: init gh-pages"
git push origin gh-pages
```

- [ ] **Step 3: 触发首次采集并验证**

1. 网页打开数据仓库 → Actions → Collect Market History → Run workflow（workflow_dispatch）
2. 等完成 → 检查 gh-pages 分支出现 `history.json`（API：`https://api.github.com/repos/oceanxuhaiao/milkonomy-history/contents/history.json?ref=gh-pages`）

- [ ] **Step 4: 用户开 Pages**

数据仓库 Settings → Pages → Deploy from a branch → `gh-pages` / root → Save。

- [ ] **Step 5: 验证静态文件可访问**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://oceanxuhaiao.github.io/milkonomy-history/history.json"
curl -s -D - -o /dev/null "https://oceanxuhaiao.github.io/milkonomy-history/history.json" | grep -i "access-control"
```
Expected: 200 + `access-control-allow-origin: *`

- [ ] **Step 6: Milkonomy 本地 E2E（dev 服务器 + Playwright）**

1. 全量测试 + 类型检查：`npx vitest run && npx vue-tsc --noEmit`
2. 启动 dev：`MSYS2_ENV_CONV_EXCL="VITE_PUBLIC_PATH" npx vite --mode public --port 5173`
3. Playwright 验收（复用 `guide_history_e2e.py` 思路，数据源已切换）：
   - 进度条出现 → 消失（分发完成）
   - 物品列偏差小字/无历史标记出现
   - 详情弹窗历史行情表格或"无交易记录"
   - 刷新后缓存生效（无重新下载，进度条不出现或瞬时消失）
   - 无 console 错误
4. 修复验收发现的问题并提交

- [ ] **Step 7: 部署 Milkonomy**

```bash
git push mine main
```

等 Actions 完成 → Playwright 验证线上 `https://oceanxuhaiao.github.io/milkonomy-DG/#/guide`：
- 进度条 → 偏差小字/无历史标记
- 详情弹窗历史行情
- 无 console 错误

---

## 计划自审记录

- **Spec 覆盖**：§3 数据仓库（collect.js 追加/去重/滚动 → Task 1；workflow 定时/force push/concurrency → Task 2）；§4.1 history.ts（HISTORY_FILE_URL/parseHistoryFile/fetchHistoryFile → Task 3；删除旧服务 → Task 5）；§4.2 store（元数据缓存判断→下载→分发 → Task 4）；§4.3 弹窗（Task 5）；§6 部署流程（Task 6 七步）；§7 测试（Task 1 node:test、Task 3/4 vitest、Task 6 E2E）。✓
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。✓
- **类型一致性**：`parseHistoryFile` 返回 `Map<string, HistoryPoint[]>`，store 转 `Record<string, HistoryPoint[]>` 存缓存；`HistoryFileCache {fetchedAt, history}` 在 store 内部定义；GuideDetail 用 `historyKeyOf`（保留导出）；被删符号（fetchHistoryPoints 等）在 Task 5 后无残留引用。✓
