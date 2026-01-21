# MCP 流式返回使用示例（stdio / JSON-RPC）

本文示例展示从初始化到完成的完整调用链，适用于 `com.leeoohoo.codex_app.codex_app` MCP Server。

## 1) 初始化握手

**请求**
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"host","version":"1.0.0"}}}
```

**响应**
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"com.leeoohoo.codex_app.codex_app","version":"0.1.0"},"capabilities":{"tools":{}}}}
```

## 2) 获取工具列表

**请求**
```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

**响应**
```json
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"codex_app_window_run","description":"Queue a run in a UI window (async). Returns immediate ack; emits a smiley on completion.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"}}}}]}}
```

## 3) 发起执行（tools/call）

**请求（默认开启流式）**
```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"codex_app_window_run","arguments":{"prompt":"请分析项目结构"},"_meta":{"stream":true}}}
```

**响应（立即 ack）**
```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"调用成功"}]}}
```

## 4) 流式事件（通知，持续多帧）

**通知示例（每帧 JSON）**
```json
{"jsonrpc":"2.0","method":"codex_app.window_run.stream","params":{"requestId":"REQ_ID","rpcId":3,"windowId":"WIN_ID","runId":"RUN_ID","event":{"seq":1,"ts":"2026-01-21T02:56:42.675Z","source":"codex","event":{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc \"...\"","status":"in_progress","exit_code":null}}},"text":"[2026-01-21T02:56:42.675Z] item.started command \"/bin/zsh -lc \\\"...\\\"\" status=in_progress exit=null"}}
```

> 提示：`params.event` 是结构化事件，`params.text` 仅为可读文本（客户端可直接忽略 text）。

## 5) 最终总结分段（通知，多帧拼接）

**通知示例（按 chunkIndex 拼接）**
```json
{"jsonrpc":"2.0","method":"codex_app.window_run.stream","params":{"requestId":"REQ_ID","rpcId":3,"windowId":"WIN_ID","runId":"RUN_ID","final":true,"finalTextChunk":true,"chunkId":"CHUNK_ID","chunkIndex":0,"chunkCount":3,"finalText":"已按 `codex_plan.md` 完成分析并保留文件...（第 1 段）","text":"已按 `codex_plan.md` 完成分析并保留文件...（第 1 段）"}}
{"jsonrpc":"2.0","method":"codex_app.window_run.stream","params":{"requestId":"REQ_ID","rpcId":3,"windowId":"WIN_ID","runId":"RUN_ID","final":true,"finalTextChunk":true,"chunkId":"CHUNK_ID","chunkIndex":1,"chunkCount":3,"finalText":"...（第 2 段）","text":"...（第 2 段）"}}
{"jsonrpc":"2.0","method":"codex_app.window_run.stream","params":{"requestId":"REQ_ID","rpcId":3,"windowId":"WIN_ID","runId":"RUN_ID","final":true,"finalTextChunk":true,"chunkId":"CHUNK_ID","chunkIndex":2,"chunkCount":3,"finalText":"...（第 3 段）","text":"...（第 3 段）"}}
```

## 6) 结束标记（stream done）

**通知**
```json
{"jsonrpc":"2.0","method":"codex_app.window_run.stream","params":{"requestId":"REQ_ID","rpcId":3,"windowId":"WIN_ID","runId":"RUN_ID","done":true,"status":"completed","finishedAt":"2026-01-21T02:58:17.487Z"}}
```

## 7) 完成通知（原有完成事件）

**通知**
```json
{"jsonrpc":"2.0","method":"codex_app.window_run.completed","params":{"requestId":"REQ_ID","rpcId":3,"windowId":"WIN_ID","runId":"RUN_ID","status":"completed","finishedAt":"2026-01-21T02:58:17.487Z","result":"😊"}}
```

## 说明
- 所有流式数据均通过 stdio 输出 **JSON-RPC notification**。
- 客户端建议优先解析 `params.event` 进行结构化处理；`params.text` 仅为辅助展示文本。
- 最终总结为分段输出，按 `chunkId + chunkIndex` 拼接即可。
