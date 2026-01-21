export const send = (msg) => {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch (e) {
    try {
      process.stderr.write(`[mcp] failed to send: ${e?.message || String(e)}\n`);
    } catch {
      // ignore
    }
  }
};

export const sendNotification = (method, params) => {
  if (!method) return;
  
  // 调试日志：记录发送的通知
  try {
    if (method.includes('stream') || method.includes('codex_app.window_run')) {
      const debugInfo = {
        timestamp: new Date().toISOString(),
        method,
        params: {
          ...params,
          // 隐藏可能的大文本内容
          text: params?.text ? `[text: ${params.text.length} chars]` : undefined,
          finalText: params?.finalText ? `[finalText: ${params.finalText.length} chars]` : undefined,
        },
      };
      // 使用console.error确保在Electron中能看到
      console.error('[MCP DEBUG] Sending notification:', debugInfo);
    }
  } catch (e) {
    // 忽略调试日志错误
  }
  
  send({ jsonrpc: '2.0', method, params });
};

export const jsonRpcError = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id,
  error: {
    code,
    message,
    ...(data !== undefined ? { data } : {}),
  },
});

export const jsonRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

export const toolResultText = (text) => ({
  content: [{ type: 'text', text: String(text ?? '') }],
});
