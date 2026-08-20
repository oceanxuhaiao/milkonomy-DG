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
  try {
    const data = getGuideDataApi({
      currentPage: paginationDataGD.currentPage,
      size: paginationDataGD.pageSize,
      includeTax: includeTax.value,
      ...gdSearchData.value,
      sort: sortGD.value
    })
    paginationDataGD.total = data.total
    guideData.value = data.list
  } catch (e) {
    console.error(e)
    guideData.value = []
  } finally {
    loadingGD.value = false
  }
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

// 自定义价格变化时刷新
watch(() => usePriceStore(), () => {
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
