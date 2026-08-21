<script setup lang="ts">
import type { GuideHistoryStats, WindowReport } from "@@/apis/guide/history"
import type { GuideItem } from "@@/apis/guide/type"
import { calcHistoryStats, fetchHistoryPoints } from "@@/apis/guide/history"
import ItemIcon from "@@/components/ItemIcon/index.vue"
import * as Format from "@/common/utils/format"
import { useGuideHistoryStore } from "@/pinia/stores/guide-history"

const props = defineProps<{
  modelValue: boolean
  data?: GuideItem
}>()

const emit = defineEmits(["update:modelValue"])
const visible = computed({
  get: () => props.modelValue,
  set: val => emit("update:modelValue", val)
})

const { t } = useI18n()

function fmt(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : Format.money(value)
}

const historyStore = useGuideHistoryStore()

const historyState = ref<"loading" | "ready" | "none" | "failed">("loading")
const historyStats = ref<GuideHistoryStats | null>(null)

let currentKey = ""
watch(() => props.data, async (row) => {
  historyState.value = "loading"
  historyStats.value = null
  if (!row) return
  currentKey = `${row.hrid}|${row.level}`
  const key = currentKey
  const cached = historyStore.data.get(key)
  if (cached && cached !== "failed") {
    historyStats.value = cached
    historyState.value = "ready"
    return
  }
  if (cached === "failed") {
    historyState.value = "failed"
    return
  }
  try {
    const points = await fetchHistoryPoints(row.hrid, row.level)
    if (currentKey !== key) return // 已切换物品，丢弃过期结果
    const stats = calcHistoryStats(points)
    if (stats) {
      historyStats.value = stats
      historyState.value = "ready"
    } else {
      historyState.value = "none"
    }
  } catch {
    if (currentKey !== key) return
    historyState.value = "failed"
  }
}, { immediate: true })

const WINDOW_KEYS = ["1d", "3d", "5d"] as const

function fmtPrice(v: number) {
  return v > 0 ? Format.price(v) : "-"
}

function fmtNumber(v: number) {
  return v >= 0 ? Format.number(v) : "-"
}

function reportRow(label: string, r: WindowReport) {
  return {
    label,
    avgPrice: r.volume > 0 ? Format.price(r.avgPrice) : "-",
    medianPrice: r.medianPrice > 0 ? Format.price(r.medianPrice) : "-",
    volume: fmtNumber(r.volume),
    buy: fmtNumber(r.buyVolume),
    sell: fmtNumber(r.sellVolume),
    minMax: r.minPrice > 0 && r.maxPrice > 0 ? `${Format.price(r.minPrice)} / ${Format.price(r.maxPrice)}` : "-"
  }
}

const historyRows = computed(() => {
  const s = historyStats.value
  if (!s) return []
  return WINDOW_KEYS.map(k => reportRow(k, s.report[k]))
})
</script>

<template>
  <el-dialog v-model="visible" :title="t('详情')" :show-close="false" width="60%">
    <template v-if="data">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <ItemIcon :hrid="data.hrid" />
        <span style="font-weight:bold">{{ data.name }}</span>
        <span v-if="data.level">{{ `+${data.level}` }}</span>
      </div>
      <el-descriptions :column="2" border>
        <el-descriptions-item :label="t('买价')">
          {{ data.buyPrice > 0 ? Format.price(data.buyPrice) : "-" }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('卖价')">
          {{ data.sellPrice > 0 ? Format.price(data.sellPrice) : "-" }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('成交量(1h)')">
          {{ data.vol >= 0 ? Format.number(data.vol) : "-" }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('利润率')">
          {{ data.profitRate !== null ? Format.percent(data.profitRate) : "-" }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('利润 / 次')">
          {{ fmt(data.profitPP) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('利润 / h')">
          {{ fmt(data.profitPH) }}
        </el-descriptions-item>
        <el-descriptions-item :label="t('利润 / 天')">
          {{ fmt(data.profitPD) }}
        </el-descriptions-item>
      </el-descriptions>

      <div style="font-weight:bold;margin:16px 0 8px">
        {{ t('历史行情') }}
      </div>
      <div v-if="historyState === 'loading'" style="color:#909399;font-size:12px">
        {{ t('加载中...') }}
      </div>
      <div v-else-if="historyState === 'none'" style="color:#909399;font-size:12px">
        {{ t('无交易记录') }}
      </div>
      <div v-else-if="historyState === 'failed'" style="color:#909399;font-size:12px">
        {{ t('历史数据加载失败') }}
      </div>
      <el-table v-else :data="historyRows" size="small" border>
        <el-table-column prop="label" :label="t('窗口')" width="60" />
        <el-table-column prop="avgPrice" :label="t('均价')" align="center" />
        <el-table-column prop="medianPrice" :label="t('中位价')" align="center" />
        <el-table-column prop="volume" :label="t('成交量')" align="center" />
        <el-table-column prop="buy" :label="t('买盘')" align="center" />
        <el-table-column prop="sell" :label="t('卖盘')" align="center" />
        <el-table-column prop="minMax" :label="t('最低/最高')" align="center" />
      </el-table>
      <div v-if="historyRows.length > 0" style="color:#909399;font-size:12px;margin-top:6px">
        {{ t('当前快照') }}：ask {{ fmtPrice(data.sellPrice) }} / bid {{ fmtPrice(data.buyPrice) }} / vol {{ fmtNumber(data.vol) }}
      </div>
    </template>
  </el-dialog>
</template>
