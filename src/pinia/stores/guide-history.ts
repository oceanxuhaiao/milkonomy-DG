import { defineStore } from "pinia"
import {
  buildHistoryTasks,
  calcHistoryStats,
  type GuideHistoryEntry,
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
    /** key = {hrid}|{level}，值三态：统计值 / 无有效记录 null / 抓取失败 "failed" */
    data: new Map<string, GuideHistoryEntry>(),
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
      // 抓取进行中防重入；完成后 progress=null，再次调用可增量刷新
      if (this.progress) return
      const itemList = items ?? Object.values(useGameStoreOutside().gameData?.itemDetailMap ?? {})
      if (itemList.length === 0) return

      const tasks = buildHistoryTasks(itemList)
      const pending: HistoryTask[] = []

      try {
        // 占位进度：防背靠背调用穿透守卫（第二次调用同步段先于首次 await 恢复）
        this.progress = { done: 0, total: tasks.length }

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
          this.progress = null
          this.ready = true
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
              try {
                await cache.set(key, { points: result, fetchedAt: Date.now() })
              } catch (e) {
                console.error("历史数据缓存写入失败:", e)
              }
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
      } catch (e) {
        // 缓存读取异常：恢复 progress 允许下次重试，历史数据失败不影响页面
        console.error("历史数据加载失败:", e)
        this.progress = null
      }
    }
  }
})

export function useGuideHistoryStoreOutside() {
  return useGuideHistoryStore(pinia)
}
