# MCP 任务排队 + 运行完成通知 修复需求

## 目标
当通过 MCP 发起任务时，如果相同工作目录已有正在运行的窗口，则不再新建窗口，而是把任务加入一个“排队列表”。当该窗口运行结束后，排队任务自动顺序执行。同时，修复“完成后未在笑脸面板看到结果”的问题（参见 `docs/CHATOS_UI_PROMPTS_PROTOCOL.md`）。

## 现状梳理（基于代码）
- MCP server：`plugin/apps/codex_app/mcp-server.mjs`
  - `window_run` 会按 `workingDirectory` 选窗口；找不到就新建。
  - `findWindowByWorkingDirectory()` 默认不包含运行中窗口。
  - 会把请求写入 `codex_app_requests.v1.json`，并轮询状态文件等待完成后发通知。
- Backend：`plugin/backend/index.mjs`
  - `syncRequests()` 处理 `startRuns`：
    - 窗口运行中时，会把请求放回 `pendingRuns`，并写回 requests 文件。
    - 但没有“自动触发下一次 syncRequests”的机制（基本依赖 UI 刷新/调用）。
- UI：`plugin/apps/codex_app/index.mjs`
  - 左侧只有“窗口列表”。
  - 没有展示 MCP 队列，也没有监听/展示 pendingRuns。

## 新需求（功能）
### 1) MCP 同目录排队
- 当 `workingDirectory` 对应的窗口**已存在且正在运行**时：
  - **不创建新窗口**。
  - 任务进入“排队列表”。
- 当 `workingDirectory` 对应窗口空闲：
  - 立即执行。
- 当 `workingDirectory` 对应窗口不存在：
  - 允许新建并执行。

### 2) 左侧新增“任务列表”
- 在左侧窗口列表旁/下方，新增一个与窗口列表一致的竖向列表。
- 展示内容（最少）：
  - 任务摘要（prompt 前 N 字）。
  - 工作目录。
  - 目标窗口（windowId/窗口名）。
  - 状态：排队中 / 将执行 / 等待当前窗口完成。
  - 创建时间（如果可取）。
- 仅显示“因同目录运行而排队”的 MCP 任务。
- 列表应随刷新/状态变化更新。

### 3) 自动串行执行
- 当某个窗口的运行结束（completed/failed/aborted）：
  - 自动触发检查该窗口工作目录的排队任务。
  - **按 FIFO** 依次启动。
  - 不依赖用户手动刷新。

### 4) 笑脸面板完成通知
- 按新的 UI Prompts 协议写入 `ui-prompts.jsonl`：
  - 记录为 `type="ui_prompt" + action="request"`。
  - `prompt.kind="result"`，`title`/`message`/`markdown` 可包含 “😊” 与结果摘要。
  - `source` 使用 `pluginId:appId`（为空时由宿主补齐）。
  - `requestId` 需可追踪（建议与 MCP requestId / runId 关联）。
- 队列任务执行完成也要写入对应的 result prompt。
- 可保留 `codex_app.window_run.completed` 通知作为兼容，但不作为笑脸面板的唯一入口。

## 约束 & 数据来源
- 排队任务数据建议复用现有 `codex_app_requests.v1.json` 的 `startRuns`。
- 工作目录以 `runOptions.workingDirectory` 为准（路径需 resolve 后对比）。
- 队列显示与执行逻辑需考虑：
  - 运行中窗口的匹配（当前实现默认排除 running）。
  - `pendingRuns` 的持久化与自动推进。

## 参考文件
- MCP server：`plugin/apps/codex_app/mcp-server.mjs`
- Backend：`plugin/backend/index.mjs`
- UI：`plugin/apps/codex_app/index.mjs`

## 验收标准
1. 同一工作目录同时触发 2 个 MCP 任务：
   - 两个任务都出现在“任务列表”。
   - 第 1 个状态为“执行中”，第 2 个状态为“排队中/等待当前窗口完成”。
2. 第 1 个运行结束后，第 2 个自动开始运行。
3. “任务列表”能看到排队任务，且状态随运行切换更新（执行中 → 完成）。
4. 每个任务完成后都会在笑脸面板出现 `kind="result"` 的结果通知。

## 非目标
- 不涉及修改 MCP tool schema（仍保持 `prompt` 单参数）。
- 不改变 UI 右侧日志/任务/输入记录结构。
