# codex_app

这是一个 **ChatOS UI Apps 插件工程**（UI Apps Plugins）。

## 你应该在哪写什么

- `plugin/plugin.json`：插件清单（应用列表、入口、后端、AI 贡献）
- `plugin/apps/codex_app/index.mjs`：**module 入口**（导出 `mount({ container, host, slots })`）
- `plugin/apps/codex_app/compact.mjs`：**compact 入口**（可选；用于侧边抽屉/分栏场景）
- `plugin/backend/index.mjs`：**插件后端**（导出 `createUiAppsBackend(ctx)`，通过 `host.backend.invoke()` 调用）
- `plugin/apps/codex_app/mcp-server.mjs`：MCP Server 源码（构建产物见 bundle）
- `plugin/apps/codex_app/mcp-server.bundle.mjs`：MCP Server bundle 产物（ChatOS 实际加载）
- `plugin/apps/codex_app/mcp-prompt.zh.md` / `.en.md`：MCP Prompt

## 开发与预览（本地沙箱）

```bash
npm install
npm run dev
```

沙箱会：

- 用 HTTP 运行你的 `module` 入口（模拟 ChatOS 的 `mount()` 调用）
- 提供 `host.*` 的 mock（含 `host.backend.invoke()`、`host.uiPrompts.*`、`host.chat.*`）

## 主题与样式（重要）

- 宿主通过 `document.documentElement.dataset.theme` 下发 `light` / `dark`，用 `host.theme.get()` / `host.theme.onChange()` 读取与监听。
- 推荐使用 CSS Tokens（`--ds-*`）做主题适配，避免硬编码颜色。
- 本地沙箱右上角提供 Theme 切换（light/dark/system）用于测试样式响应。
- 本地沙箱 Inspect 面板可查看 `host.context` 与 `--ds-*` tokens。

## 开发清单（建议）

- `plugin/plugin.json`：`apps[i].entry.type` 必须是 `module`，且 `path` 在插件目录内。
- `plugin/plugin.json`：可选 `apps[i].entry.compact.path`，用于 compact UI。
- `mount()`：返回卸载函数并清理事件/订阅；滚动放在应用内部，固定内容用 `slots.header`。
- 主题：用 `host.theme.*` 与 `--ds-*` tokens；避免硬编码颜色。
- 宿主能力：先判断 `host.bridge.enabled`，非宿主环境要可降级运行。
- Node 能力：前端不直接用 Node API，需要时走 `host.backend.invoke()`。
- 打包：依赖需 bundle 成单文件；不要指望 `node_modules` 随包生效。
- 提交前：`npm run validate`，必要时再 `pack/install`。

## 复用 ChatOS 的 AI 调用（推荐）

本项目演示两种“复用宿主模型/密钥/工具链”的方式：

1) **前端直连 Chat 域**：用 `host.chat.*` 创建 agent/session、`host.chat.send()` 发送消息、`host.chat.events.subscribe()` 订阅流式事件。
2) **后端调用 LLM**：在 `plugin/backend/index.mjs` 里通过 `ctx.llm.complete()` 调用模型；前端用 `host.backend.invoke('llmComplete', { input })` 触发。

说明：本地沙箱只提供 mock（不会真实调用模型）；要验证真实 AI 行为请安装到 ChatOS 后运行。

## 安装到本机 ChatOS

```bash
npm run validate
npm run install:chatos
```

或打包成 zip（用于 ChatOS UI：应用 → 导入应用包）：

```bash
npm run pack
```

## 协议文档

`docs/` 目录包含当前版本的协议快照（建议团队内统一对齐），并包含主题样式指南与排错清单。

## MCP（已启用）

本插件已启用 `ai.mcp`，ChatOS 入口指向 `plugin/apps/codex_app/mcp-server.bundle.mjs`。源码位于 `plugin/apps/codex_app/mcp-server.mjs`，构建命令：

```bash
npm run build:mcp
```

注意：导入插件包时会排除 `node_modules`，所以 MCP server 需要 bundle 成单文件再打包。

## MCP 默认窗口配置

- `model`：`gpt-5.2-codex`
- `modelReasoningEffort`：`xhigh`
- `sandboxMode`：`danger-full-access`
- `skipGitRepoCheck`：`true`

可在 UI 运行设置或 MCP 调用时通过 options 覆盖。
