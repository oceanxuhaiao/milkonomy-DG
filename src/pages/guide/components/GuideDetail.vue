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
  set: val => emit("update:modelValue", val)
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
    </template>
  </el-dialog>
</template>
