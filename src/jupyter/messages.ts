/**
 * Jupyter messaging protocol types.
 *
 * Covers the subset of the Jupyter message spec needed for
 * code execution and output collection. All messages are JSON
 * text over WebSocket (no binary framing on Colab).
 */

export interface JupyterMessageHeader {
  msg_id: string;
  msg_type: string;
  session: string;
  date: string;
  username: string;
  version: string;
}

export interface JupyterMessage<C = unknown> {
  header: JupyterMessageHeader;
  parent_header: JupyterMessageHeader | Record<string, never>;
  metadata: Record<string, unknown>;
  content: C;
  channel: string;
  buffers?: unknown[];
}

// --- Execute ---

export interface ExecuteRequestContent {
  code: string;
  silent: boolean;
  store_history: boolean;
  user_expressions: Record<string, unknown>;
  allow_stdin: boolean;
  stop_on_error: boolean;
}

export interface ExecuteReplyContent {
  status: "ok" | "error" | "abort";
  execution_count: number;
  // error fields (when status === "error")
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

// --- Output messages ---

export interface StreamContent {
  name: "stdout" | "stderr";
  text: string;
}

export interface DisplayDataContent {
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  transient?: Record<string, unknown>;
}

export interface ExecuteResultContent {
  execution_count: number;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface ErrorContent {
  ename: string;
  evalue: string;
  traceback: string[];
}

// --- Helpers ---

export function makeHeader(
  msgType: string,
  sessionId: string,
): JupyterMessageHeader {
  return {
    msg_id: crypto.randomUUID(),
    msg_type: msgType,
    session: sessionId,
    date: new Date().toISOString(),
    username: "colab-cli",
    version: "5.3",
  };
}

export function makeExecuteRequest(
  code: string,
  sessionId: string,
): JupyterMessage<ExecuteRequestContent> {
  return {
    header: makeHeader("execute_request", sessionId),
    parent_header: {},
    metadata: {},
    content: {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: true,
      stop_on_error: true,
    },
    channel: "shell",
  };
}
