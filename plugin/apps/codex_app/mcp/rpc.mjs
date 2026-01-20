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
