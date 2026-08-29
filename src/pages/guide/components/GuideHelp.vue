<script setup lang="ts">
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits(["update:modelValue"])

const visible = computed({
  get: () => props.modelValue,
  set: value => emit("update:modelValue", value)
})
</script>

<template>
  <el-dialog v-model="visible" title="导购工具使用说明" width="min(900px, 94vw)" append-to-body>
    <div class="guide-help">
      <el-alert type="info" :closable="false" show-icon>
        导购工具用于比较“按挂单价买入、再按挂单价卖出”的潜在收益。结果是行情参考，不保证你的挂单能够按全服成交速度卖出。
      </el-alert>

      <section>
        <h3>1. 数据来源与价格口径</h3>
        <dl>
          <dt>买价</dt>
          <dd>优先使用自定义买价；否则使用最近24小时“卖家主动向 bid 成交”的成交量加权中位价；该侧没有成交时依次回退到24小时 bid 快照中位数、当前 bid。</dd>
          <dt>卖价</dt>
          <dd>优先使用自定义卖价；否则使用最近24小时“买家主动向 ask 成交”的成交量加权中位价；该侧没有成交时依次回退到24小时 ask 快照中位数、当前 ask。</dd>
          <dt>买/卖价偏差</dt>
          <dd><code>（当前快照价－24小时成交参考价）÷ 24小时成交参考价</code>。成交方向根据成交价更接近当时 bid 还是 ask 估算，并非逐笔订单的精确方向。</dd>
          <dt>历史更新</dt>
          <dd>网站首次打开或本地缓存超过12小时后重新下载历史文件。页面没有手动刷新按钮。</dd>
        </dl>
      </section>

      <section>
        <h3>2. 表格指标</h3>
        <dl>
          <dt>利润 / 次</dt>
          <dd><code>卖价 × 税率系数－买价</code>。勾选“计算税率”时税率系数为0.95，不勾选时为1。</dd>
          <dt>利润率</dt>
          <dd><code>利润 / 次 ÷ 买价</code>，表示每投入一单位资金的单次理论回报。</dd>
          <dt>成交量(1h)</dt>
          <dd><code>最近5天成交量总和 ÷ 120</code>。无成交的小时按0计算；5天只成交1件时约为0.008333/h。</dd>
          <dt>利润 / h</dt>
          <dd><code>利润 / 次 × 成交量(1h)</code>，表示按照全服历史成交速度估算的小时利润。</dd>
          <dt>利润 / 天</dt>
          <dd><code>利润 / h × 24</code>，是连续24小时都保持相同行情与成交速度的理论值。</dd>
          <dt>倒货效率</dt>
          <dd>
            <code>利润/h × √有效利润率 × 价格可信度</code>。有效利润率限制在0～100%；价格可信度根据买卖快照与24小时中位价的最大绝对偏差计算：
            <code>0.5 + 0.5 × 2<sup>(-偏差/5%)</sup></code>。两侧偏差都缺失时可信度取0.5。
          </dd>
          <dt>建议最大投入</dt>
          <dd><code>买价 × max(1，⌊成交量(1h) × 24 × 25%⌋)</code>。把单个项目控制在预计日成交量的四分之一左右；它是流动性风控上限，不保证能在一天内卖完。</dd>
        </dl>
        <p class="tip">
          倒货效率是用于横向排序的综合评分，不是金币、利润或实际回本时间。价格越稳定、利润率和利润/h越高，评分越高。
        </p>
      </section>

      <section>
        <h3>3. 筛选与排序</h3>
        <dl>
          <dt>物品</dt>
          <dd>按名称模糊搜索。</dd>
          <dt>利润率 ≥</dt>
          <dd>只显示达到最低利润率的项目；输入10代表10%。</dd>
          <dt>物品等级 ≤</dt>
          <dd>限制物品自身等级，不是强化等级。</dd>
          <dt>成交量范围</dt>
          <dd>按5天平均每小时成交量筛选。可用于排除几乎没有流动性的物品。</dd>
          <dt>排除装备 / 护符</dt>
          <dd>隐藏对应类别。装备会分别展示未强化、+5、+7、+8、+10、+12～+15。</dd>
          <dt>排序</dt>
          <dd>点击支持排序的列标题切换降序和升序；无效数据始终排在最后。</dd>
        </dl>
      </section>

      <section>
        <h3>4. 自定义、详情与收藏</h3>
        <dl>
          <dt>自定义价格</dt>
          <dd>可单独覆盖某个物品及强化等级的买价或卖价。启用后该侧历史偏差不参与倒货效率，蓝色数值表示使用了自定义价格。</dd>
          <dt>详情</dt>
          <dd>展示1天、3天、5天行情、建议最大投入，以及当前挂单、历史采集和本次排行计算的时间。数据超过18小时会出现过期警告。买卖盘属于估算值。</dd>
          <dt>收藏</dt>
          <dd>收藏特定物品与强化等级，便于后续识别；不会改变计算结果。</dd>
        </dl>
      </section>

      <section>
        <h3>5. 使用建议与限制</h3>
        <ul>
          <li>优先按“倒货效率”降序寻找候选，再查看成交量、偏差和详情，不要只看单次利润。</li>
          <li>成交量是全服成交量，不代表你的挂单一定能获得相同销量，也没有计算其他卖家的排队数量。</li>
          <li>极低成交量、极高利润率或价格偏差较大的项目，可能来自稀疏数据或短期异常报价。</li>
          <li>利润/h和利润/天是假设行情持续不变的理论估算，实际交易前仍应查看游戏内挂单深度。</li>
        </ul>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.guide-help {
  line-height: 1.65;
  section {
    margin-top: 20px;
  }
  h3 {
    margin: 0 0 10px;
  }
  dl {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 8px 16px;
    margin: 0;
  }
  dt {
    font-weight: 600;
  }
  dd {
    margin: 0;
  }
  code {
    padding: 2px 5px;
    border-radius: 4px;
    background: var(--el-fill-color-light);
  }
  .tip {
    color: var(--el-text-color-secondary);
  }
  ul {
    margin: 0;
    padding-left: 22px;
  }
}

@media (max-width: 600px) {
  .guide-help dl {
    grid-template-columns: 1fr;
    gap: 3px;
  }
  .guide-help dd {
    margin-bottom: 8px;
  }
}
</style>
