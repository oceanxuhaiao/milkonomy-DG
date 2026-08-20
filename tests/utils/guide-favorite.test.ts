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
