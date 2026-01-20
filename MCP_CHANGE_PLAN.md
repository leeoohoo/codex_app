# MCP Change Plan

## Goals
- Keep a single MCP tool: `codex_app.window_run`.
- Make `window_run` asynchronous: validate prompt, enqueue, immediately acknowledge success.
- Send a completion smiley (`😊`) after the run finishes.
- Use default working directory from MCP meta; no caller-selected window or extra params.
- Auto-pick a non-running window by working directory; create if none exists.
- Update prompts to explain the ack + completion notification behavior.

## Steps
1. Update `plugin/apps/codex_app/mcp-server.mjs`:
   - Return `调用成功` immediately from `window_run`.
   - Add a completion tracker that watches the state file and emits a notification with `😊` when the run finishes.
   - Keep only `window_run` in the tool list and schema.
2. Update `plugin/apps/codex_app/mcp-prompt.zh.md` and `plugin/apps/codex_app/mcp-prompt.en.md`:
   - Document the immediate ack and the completion smiley notification.
   - Keep the simplified `prompt`-only usage and default workdir behavior.
3. Rebuild the MCP bundle:
   - Run `npm run build:mcp` to regenerate `plugin/apps/codex_app/mcp-server.bundle.mjs`.
