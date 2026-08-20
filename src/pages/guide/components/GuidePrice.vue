<script setup lang="ts">
import type { GuideItem } from "@@/apis/guide/type"
import ItemIcon from "@@/components/ItemIcon/index.vue"
import { getPriceOf } from "@/common/apis/game"
import { getManualPriceOf } from "@/common/apis/price"
import * as Format from "@/common/utils/format"
import { PriceStatus } from "@/pinia/stores/game"
import { usePriceStore } from "@/pinia/stores/price"

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
  // 挂单倒卖口径：买价 = 市场 bid 侧（挂单买入），卖价 = 市场 ask 侧（挂单卖出）
  rows.value = [
    { type: "bid", label: t("买价"), market: market.bid, manual: manual?.bid?.manual || false, manualPrice: manual?.bid?.manualPrice },
    { type: "ask", label: t("卖价"), market: market.ask, manual: manual?.ask?.manual || false, manualPrice: manual?.ask?.manualPrice }
  ]
}, { immediate: true })

function onConfirm() {
  const row = props.data!
  const sell = rows.value.find(r => r.type === "ask")!
  const buy = rows.value.find(r => r.type === "bid")!
  usePriceStore().setPrice({
    hrid: row.hrid,
    level: row.level,
    ask: { manual: sell.manual, manualPrice: sell.manualPrice },
    bid: { manual: buy.manual, manualPrice: buy.manualPrice }
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
