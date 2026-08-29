import { defineStore } from "pinia"
import {
  type CachedHistory,
  calcHistoryStats,
  fetchHistoryFile,
  getLastHistorySourceUpdatedAt,
  type GuideHistoryEntry,
  HISTORY_CACHE_TTL,
  type HistoryCache,
  type HistoryPoint,
  indexedDbHistoryCache
} from "@/common/apis/guide/history"
import { pinia } from "@/pinia"

const CACHE_KEY = "__history_file__"

/** 整文件缓存条目：数据与时间戳合一（IndexedDB kv 无法枚举，单条目存全部） */
interface HistoryFileCache {
  fetchedAt: number
  sourceUpdatedAt?: number
  history: Record<string, HistoryPoint[]>
}

export const useGuideHistoryStore = defineStore("guideHistory", {
  state: () => ({
    /** key = {hrid}|{level}，两态：统计值 / null(无有效记录) */
    data: new Map<string, GuideHistoryEntry>(),
    progress: null as { done: number, total: number } | null,
    ready: false,
    sourceUpdatedAt: 0,
    fetchedAt: 0,
    usingStaleCache: false,
    loadError: "",
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
      // 占位进度：在首个 await 前设置，防止下载窗口内（页面 setup 调用 + watch 二次调用）重入重复下载
      this.progress = { done: 0, total: 1 }
      try {
        let file: HistoryFileCache | null = null
        const cached = await cache.get(CACHE_KEY) as HistoryFileCache | null
        if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL) {
          file = cached
        } else {
          try {
            const map = await fetchHistoryFile()
            const history: Record<string, HistoryPoint[]> = {}
            for (const [key, points] of map) history[key] = points
            file = { fetchedAt: Date.now(), sourceUpdatedAt: getLastHistorySourceUpdatedAt(), history }
            try {
              await cache.set(CACHE_KEY, file as unknown as CachedHistory)
            } catch (e) {
              console.error("历史数据缓存写入失败:", e)
            }
          } catch (e) {
            if (!cached?.history || Object.keys(cached.history).length === 0) throw e
            file = cached
            this.usingStaleCache = true
            this.loadError = e instanceof Error ? e.message : "历史数据下载失败"
          }
        }

        this.sourceUpdatedAt = file.sourceUpdatedAt ?? 0
        this.fetchedAt = file.fetchedAt
        const keys = Object.keys(file.history)
        this.progress = { done: 0, total: keys.length }
        for (const key of keys) {
          this.data.set(key, calcHistoryStats(file.history[key]))
          this.progress = { done: this.progress.done + 1, total: keys.length }
        }
        this.progress = null
        this.ready = true
        this.version++
      } catch (e) {
        console.error("历史数据加载失败:", e)
        this.loadError = e instanceof Error ? e.message : "历史数据加载失败"
        this.progress = null
        this.version++ // 触发弹窗等消费者重读（失败态 → 无交易记录）
      }
    }
  }
})

export function useGuideHistoryStoreOutside() {
  return useGuideHistoryStore(pinia)
}
