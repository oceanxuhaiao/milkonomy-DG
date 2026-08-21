import { defineStore } from "pinia"
import {
  buildHistoryTasks,
  calcHistoryStats,
  fetchHistoryPoints,
  type GuideHistoryStats,
  HISTORY_CACHE_TTL,
  type HistoryCache,
  historyKeyOf,
  type HistoryTask,
  indexedDbHistoryCache,
  runHistoryFetch,
  type RunHistoryFetchOptions
} from "@/common/apis/guide/history"
import { pinia } from "@/pinia"
import { useGameStoreOutside } from "./game"

export const useGuideHistoryStore = defineStore("guideHistory", {
  state: () => ({
    /** key = {hrid}|{level}，值为历史统计或抓取失败标记 */
    data: new Map<string, GuideHistoryStats | "failed" | null>(),
    progress: null as { done: number, total: number } | null,
    ready: false,
    /** 数据版本号：每次抓取完成一条 +1，页面 watch 此值触发重算 */
    version: 0
  }),
  actions: {
    /**
     * 进入页面时调用：读缓存 → 缺失/过期条目抓取。
     * items/cache/opts 可注入（测试用）；默认走游戏数据与 IndexedDB。
     */
    async ensureLoaded(
      items?: { hrid: string, categoryHrid?: string }[],
      cache: HistoryCache = indexedDbHistoryCache,
      opts: RunHistoryFetchOptions = {}
    ) {
      if (this.ready && this.progress) return // 已有抓取在进行
      const itemList = items ?? Object.values(useGameStoreOutside().gameData?.itemDetailMap ?? {})
      if (itemList.length === 0) return

      const tasks = buildHistoryTasks(itemList)
      const pending: HistoryTask[] = []

      // 读缓存：未过期直接进 data，过期/缺失入队
      for (const task of tasks) {
        const key = historyKeyOf(task.hrid, task.level)
        const cached = await cache.get(key)
        if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL) {
          this.data.set(key, calcHistoryStats(cached.points))
        } else {
          pending.push(task)
        }
      }

      if (pending.length === 0) {
        this.ready = true
        this.progress = null
        this.version++
        return
      }

      this.progress = { done: 0, total: pending.length }
      await runHistoryFetch(
        pending,
        async (key, result) => {
          if (result === "failed") {
            this.data.set(key, "failed")
          } else {
            const stats = calcHistoryStats(result)
            await cache.set(key, { points: result, fetchedAt: Date.now() })
            this.data.set(key, stats)
          }
          this.version++
        },
        (done, total) => {
          this.progress = { done, total }
        },
        opts
      )
      this.progress = null
      this.ready = true
      this.version++
    },
    /** 按需单查（详情弹窗用）：先查缓存，无则请求并写缓存 */
    async fetchOne(hrid: string, level: number): Promise<GuideHistoryStats | "failed" | null> {
      const key = historyKeyOf(hrid, level)
      const cached = await indexedDbHistoryCache.get(key)
      if (cached) {
        return calcHistoryStats(cached.points)
      }
      try {
        const points = await fetchHistoryPoints(hrid, level)
        await indexedDbHistoryCache.set(key, { points, fetchedAt: Date.now() })
        return calcHistoryStats(points)
      } catch {
        return "failed"
      }
    }
  }
})

export function useGuideHistoryStoreOutside() {
  return useGuideHistoryStore(pinia)
}
