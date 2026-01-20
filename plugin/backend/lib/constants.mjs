export const MAX_RUN_EVENTS = 5000;
export const MAX_EVENT_TEXT_CHARS = 50000;
export const MAX_WINDOW_INPUTS = 500;
export const MAX_MCP_TASKS = 200;
export const MAX_MCP_RESULT_CHARS = 4000;
export const STATE_VERSION = 1;
export const STATE_FILE_NAME = 'codex_app_state.v1.json';
export const REQUESTS_FILE_NAME = 'codex_app_requests.v1.json';
export const UI_PROMPTS_FILE_NAME = 'ui-prompts.jsonl';

// Keep in-memory runs/windows across backend hot reloads in dev sandbox (and any other dynamic import reloads).
// The dev server resets backendInstance on file changes, which would otherwise make `codexPollRun` return "run not found".
export const GLOBAL_BACKEND_STORE = Symbol.for('chatos_ui_apps.codex_app.backend_store.v1');
