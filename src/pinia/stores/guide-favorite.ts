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
    const value = JSON.parse(localStorage.getItem(LIST_KEY) || "[]")
    return Array.isArray(value) ? value : []
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
