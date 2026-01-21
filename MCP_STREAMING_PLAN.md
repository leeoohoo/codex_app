# MCP Streaming Plan (stdio)

## 现状速览
- `plugin/apps/codex_app/mcp-server.mjs` 仅在 `tools/call` 返回一次性 ack，并在运行完成后发送 `codex_app.window_run.completed` 通知。
- Codex 运行过程事件会被写入 `codex_app_state.v1.json` 的 `windowLogs`（来自 `plugin/backend/index.mjs` 的 `pushRunEvent`）。

## 目标
- 继续使用 stdio MCP。
- 在运行过程中把 Codex 的事件/输出流式回传给 MCP 调用方。

## 可行性结论
可行。MCP 允许 server 通过 stdio 发送 JSON-RPC notification。可以在 `tools/call` 返回后，持续发送流式通知；完成后发送 completed 通知，客户端如果支持即可实时展示/转发。

## 方案概述
### 1) 追加“流式事件通知”
在 `plugin/apps/codex_app/mcp-server.mjs` 中增加一个流式 watcher：
- 在 `tools/call` 进入后，除现有 `scheduleCompletionNotification` 外，再启动 `scheduleStreamNotification`。
- 通过轮询 `codex_app_state.v1.json`（或 `fs.watch` + fallback 轮询）读取 `windowLogs`。
- 复用现有“定位 runId”的逻辑（根据 `requestedAt` 找到该 window 的目标 run）。
- 记录 `lastIndex` 或 `lastSeq`，只发送新增事件。
- 事件格式用 notification 输出，例如：

```json
{ "jsonrpc": "2.0", "method": "codex_app.window_run.stream", "params": {
  "requestId": "...",
  "rpcId": "...",
  "windowId": "...",
  "runId": "...",
  "event": { "seq": 12, "ts": "...", "source": "codex", "event": { "type": "item.completed", "item": { ... } } },
  "text": "[2025-01-20T10:12:13Z] item.completed ..."
}}
```

> `text` 可以在 MCP server 内用一个轻量 formatter 生成（可复制 `plugin/backend/lib/codex.mjs` 中的 `formatRunEvent` 逻辑，避免直接依赖 backend 代码）。

### 2) 结束信号
- 当检测到 run 结束（`status` 不是 running/aborting）时：
  - 发送最后一个 `codex_app.window_run.stream`（可加 `done: true` 或单独发送 `codex_app.window_run.done`）。
  - 保持原有 `codex_app.window_run.completed` 通知不变。

### 3) 兼容策略
- **不修改 tool schema**（仍仅 `prompt`），避免 prompt 文档变更。
- 若需要可选开关：支持读取 `params._meta.stream === true` 时才启用 streaming（默认 true 或默认 false 由你决定）。

### 4) 流控与容错
- 轮询间隔建议 200~500ms；可新增常量 `STREAM_POLL_MS`。
- 若 `windowLogs.events` 长度回退（日志被清理或重置），重置 `lastIndex`。
- 若 `state` 读取异常，跳过本轮并保留 watcher（避免崩溃）。

## 需要改动的文件
- `plugin/apps/codex_app/mcp-server.mjs`
  - 新增 stream watcher
  - 通知发送与清理
- `plugin/apps/codex_app/mcp/constants.mjs`
  - 增加 `STREAM_POLL_MS` / `STREAM_TIMEOUT_MS`（可选）
- （可选）`plugin/apps/codex_app/mcp/stream.mjs`
  - 抽出流式逻辑，保持主文件干净
- 构建：`npm run build:mcp` 更新 `plugin/apps/codex_app/mcp-server.bundle.mjs`

## 与 Host/客户端对接
- 若 ChatOS MCP 客户端当前**不转发 notification**给模型或 UI，需要在 Host 层增加对应转发逻辑。
- 最小可行路径：Host 收到 `codex_app.window_run.stream` 后，将 `params.text` 追加为 tool output 的增量展示（或挂到 UI 侧日志面板）。

## 风险与注意事项
- `windowLogs` 可能越来越大；若担心文件体积，可在 Host 侧增加截断策略（或 MCP server 仅取末尾增量）。
- 需要确保 stdout 只输出 JSON-RPC（日志继续写 stderr）。
- 轮询/文件监听要避免阻塞；watcher 超时需释放。

## 验证步骤（建议）
1. 用 MCP 调用 `codex_app_window_run`。
2. 观察 MCP stdio 是否持续输出 `codex_app.window_run.stream` 通知。
3. 运行完成后收到 `codex_app.window_run.completed`。
4. 若 Host 支持转发，确认 UI/Agent 可见流式内容。
