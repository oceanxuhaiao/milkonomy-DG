# 导购工具·自建历史数据源 设计文档

日期：2026-08-21
状态：已与用户逐节确认

## 1. 背景与目标

导购工具的历史行情数据目前依赖第三方 API（q7，`q7.nainai.eu.org`），存在依赖风险（私人服务器、限流、CORS 防护）。官方公开接口 `https://www.milkywayidle.com/game_data/marketplace.json` 提供与 q7 相同字段的数据（a/b/p/v），且实测**约每小时更新一次**（253KB、872 物品、3061 组合）。

目标：**自建历史数据源**——用 GitHub Actions 定时采集官方数据，积累 5 天历史，以静态 JSON 形式托管在 GitHub Pages，Milkonomy 直接替换 q7，实现数据自主。

## 2. 范围

### 2.1 本次实现

- 新数据仓库 `milkonomy-history`：`collect.js` 采集脚本 + 定时 workflow + gh-pages 静态发布
- Milkonomy 端数据源替换：下载全量文件 → 分发 → 统计（复用现有 calcHistoryStats），删除逐物品抓取服务
- 部署与线上验证

### 2.2 明确不做

- 双数据源切换模式（直接替换，git 历史保留 q7 版本可回退）
- 数据仓库之外的部署方式（Release 资产、站点仓库混布）
- 超过 5 天的历史保留

## 3. 数据仓库设计（milkonomy-history）

### 3.1 文件结构

```
.github/workflows/collect.yml    # 定时采集工作流
collect.js                        # 采集脚本（Node 原生，无依赖）
history.json                      # 产物，仅存在于 gh-pages 分支
```

### 3.2 数据文件格式

```json
{
  "updatedAt": 1787313960,
  "history": {
    "/items/sugar|0":  [{ "t": 1787313960, "a": 13, "b": 12, "p": 12, "v": 3520 }, ...],
    "/items/azure_sword|13": [...]
  }
}
```

- key = `{hrid}|{level}`（与 Milkonomy 现有 historyKeyOf 一致）
- 短键 `t/a/b/p/v` 节省体积；客户端解析时映射为 `HistoryPoint`（t → time）
- 点数据来源为官方 marketplace.json 的同名字段

### 3.3 collect.js 逻辑

1. fetch 官方 `marketplace.json`（失败或无 marketData → 退出，跳过本轮，不产生坏数据）
2. 读仓库现有 `history.json`（不存在 → 空对象）
3. 逐组合 append 新点 `{t, a, b, p, v}`，按 `t` 去重（同时间戳覆盖）
4. 滚动剔除 `t < now - 5*24*3600` 的点
5. 写回 `history.json`（`updatedAt` = 官方 timestamp）

### 3.4 工作流

- `schedule`：每小时 `:23` 分（官方约整点后几分钟更新，留余量）；`workflow_dispatch` 手动触发
- checkout gh-pages 分支 → 跑 collect.js → commit → `push --force`（仓库只保留最新版文件，避免 git 历史膨胀）
- `concurrency: cancel-in-progress` 防并发竞态
- `GITHUB_TOKEN` 推本仓库，无需额外密钥

### 3.5 静态托管

- GitHub Pages：gh-pages 分支 root 发布 → `https://oceanxuhaiao.github.io/milkonomy-history/history.json`
- GitHub Pages 自动带 `access-control-allow-origin: *`，网页可直接 fetch
- 文件大小：5 天 × 24 点 × 3061 组合 ≈ 14.7MB 原始，gzip 传输约 2-4MB

## 4. Milkonomy 端改造

### 4.1 history.ts

- 新增常量：`HISTORY_FILE_URL`（默认 `https://oceanxuhaiao.github.io/milkonomy-history/history.json`，可配置）
- 新增：
  - `parseHistoryFile(json)`：解析文件 → `Map<key, HistoryPoint[]>`（t→time 映射；异常数据跳过）
  - `fetchHistoryFile()`：下载 + 解析（5 秒超时 + 重试 1 次，失败抛错）
- **删除**（不再需要逐物品请求）：`fetchHistoryPoints`、`runHistoryFetch`、`buildHistoryTasks`、`HISTORY_CONCURRENCY`、`HISTORY_REQUEST_GAP_MS`、`HISTORY_FAIL_LIMIT`
- 保留：统计纯函数（`calcHistoryStats`/`getPriceTier`/`toGuideHistoryData`/`GuideHistoryEntry`）、缓存接口（`HistoryCache`/`indexedDbHistoryCache`/`CachedHistory`）、`historyKeyOf`

### 4.2 guide-history store

`ensureLoaded` 重写：

```
1. 12h 内的 IndexedDB 缓存存在 → 直接分发（与现在一致）
   缓存命中判断：写一个元数据条目（key "__meta__"，value {fetchedAt}），
   ensureLoaded 先读元数据；12h 内 → 跳过下载，直接读各 key 分发
2. 否则：fetchHistoryFile() → 按 key 拆开存 IndexedDB（复用 CachedHistory 结构，
   元数据条目同步更新 fetchedAt）
   → 逐 key 计算统计进 data Map（progress = 分发进度 x/总数）→ ready=true
3. 下载失败 → console.error + ElMessage 提示"历史数据服务暂不可用，已使用快照数据"
   （页面按快照正常渲染，所有行显示"无历史"）
```

- `progress` 语义从"抓取进度"改为"分发进度"
- 依赖注入的 items 参数移除（文件自带全部组合）；cache 注入保留（测试用）
- `data` 三态（GuideHistoryStats | "failed" | null）不变

### 4.3 GuideDetail 弹窗

- 删除按需单查分支（fetchHistoryPoints 已删除）：store.data 无该 key → 直接"无交易记录"
- 其余四态逻辑不变

### 4.4 页面

- 不变（store 接口稳定：data/progress/ready/version）

## 5. 数据流与错误处理

### 5.1 数据流

```
官方每小时更新 → Actions :23 采集 → history.json（滚动 5 天）
                                        │ 浏览器首次访问
页面进入 → IndexedDB 12h 缓存命中？ → 是：直接分发统计
              │ 否
              ▼
下载 history.json（~2-4MB gzip）→ 拆开存缓存 → 分发统计 → ready → 表格重算
```

### 5.2 错误处理

- 采集端：官方接口失败 → 跳过本轮（history.json 保持上次状态）
- 客户端：下载失败/解析异常 → 提示 + 快照兜底（利润仍可算，"无历史"标记）
- 过渡期：数据从 0 积累，统计窗口不满 5 天（有几小时算几小时），满 5 天后完全等同 q7 效果

## 6. 部署流程（一次性）

1. 用户新建空仓库 `milkonomy-history`（Public）
2. 推送 `collect.yml` + `collect.js`（首次 push 触发 + 手动 dispatch 立即采集）
3. 开 Pages（Deploy from branch → gh-pages）
4. 验证 history.json 可访问且含当日数据
5. Milkonomy 改 `HISTORY_FILE_URL` → 本地测试 + E2E → push mine → 线上验证

## 7. 测试

- Milkonomy 端（vitest）：
  - `parseHistoryFile`：字段映射（t→time）、空文件、异常条目跳过
  - `ensureLoaded` 重写后测试：fake 文件下载 + fake cache（缓存命中/下载失败/分发完成）
  - 删除旧抓取服务测试（fetchHistoryPoints/runHistoryFetch）
- 数据仓库（本地 node 验证，不强制自动化）：
  - collect.js：追加、t 去重、5 天滚动、官方接口失败跳过
