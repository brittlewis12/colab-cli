/**
 * KernelConnection: WebSocket client for Jupyter kernel communication.
 *
 * Connects to a Colab runtime's kernel via WebSocket, sends execute
 * requests, and collects output messages. All messages are JSON text
 * (no binary framing on Colab).
 */

import { PROXY_TOKEN, CLIENT_AGENT, CLIENT_AGENT_VALUE } from "../colab/headers.ts";
import type { ColabClient } from "../colab/client.ts";
import type { JupyterMessage, ExecuteReplyContent } from "./messages.ts";
import { makeExecuteRequest, makeHeader } from "./messages.ts";

/** Auth types the kernel may request that we can propagate. */
const EPHEMERAL_AUTH_TYPES = new Set(["dfs_ephemeral", "auth_user_ephemeral"]);

export interface ExecutionResult {
  status: "ok" | "error" | "abort";
  executionCount: number;
  stdout: string;
  stderr: string;
  outputs: Array<{
    type: "display_data" | "execute_result";
    data: Record<string, unknown>;
  }>;
  error?: {
    ename: string;
    evalue: string;
    traceback: string[];
  };
}

/** Resolves a secret key to its value. Injected by the CLI layer. */
export type SecretResolver = (key: string) => Promise<{ exists: true; payload: string } | { exists: false }>;

export interface KernelConnectionOptions {
  /** WebSocket constructor override for testing. */
  WebSocket?: typeof WebSocket;
  /** ColabClient for credential propagation (required for execution). */
  colabClient?: ColabClient;
  /** OAuth access token (required for credential propagation). */
  accessToken?: string;
  /** Runtime endpoint (required for credential propagation). */
  endpoint?: string;
  /** Secret resolver for GetSecret colab_requests. */
  secretResolver?: SecretResolver;
}

export class KernelConnection {
  private readonly wsUrl: string;
  private readonly proxyToken: string;
  private readonly sessionId: string;
  private ws: WebSocket | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: ExecutionResult) => void;
      reject: (error: Error) => void;
      result: ExecutionResult;
      gotReply: boolean;
      gotIdle: boolean;
    }
  >();
  private readonly wsConstructor: typeof WebSocket;
  private readonly colabClient?: ColabClient;
  private readonly accessToken?: string;
  private readonly endpoint?: string;
  private readonly secretResolver?: SecretResolver;

  constructor(
    proxyUrl: string,
    kernelId: string,
    proxyToken: string,
    opts: KernelConnectionOptions = {},
  ) {
    const base = proxyUrl.replace(/^http/, "ws");
    this.sessionId = crypto.randomUUID().replace(/-/g, "");
    this.wsUrl = `${base}/api/kernels/${kernelId}/channels?session_id=${this.sessionId}`;
    this.proxyToken = proxyToken;
    this.wsConstructor = opts.WebSocket ?? WebSocket;
    this.colabClient = opts.colabClient;
    this.accessToken = opts.accessToken;
    this.endpoint = opts.endpoint;
    this.secretResolver = opts.secretResolver;
  }

  /** Open the WebSocket connection. */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new this.wsConstructor(this.wsUrl, {
        headers: {
          [PROXY_TOKEN]: this.proxyToken,
          [CLIENT_AGENT]: CLIENT_AGENT_VALUE,
        },
      } as any);

      ws.onopen = () => {
        this.ws = ws;
        resolve();
      };

      ws.onerror = (e: Event) => {
        const msg = e instanceof ErrorEvent ? e.message : "connection failed";
        reject(new Error(`WebSocket error: ${msg}`));
      };

      ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      };

      ws.onclose = () => {
        this.ws = null;
        // Reject all pending executions
        for (const [, entry] of this.pending) {
          entry.reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      };
    });
  }

  /** Execute code and collect all outputs. */
  async execute(code: string, timeoutMs?: number): Promise<ExecutionResult> {
    if (!this.ws) throw new Error("Not connected");

    const msg = makeExecuteRequest(code, this.sessionId);
    const msgId = msg.header.msg_id;

    const executionPromise = new Promise<ExecutionResult>((resolve, reject) => {
      this.pending.set(msgId, {
        resolve,
        reject,
        result: {
          status: "ok",
          executionCount: 0,
          stdout: "",
          stderr: "",
          outputs: [],
        },
        gotReply: false,
        gotIdle: false,
      });

      this.ws!.send(JSON.stringify(msg));
    });

    if (!timeoutMs) return executionPromise;

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(msgId);
        reject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([executionPromise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  }

  /** Close the connection. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  /** Resolve a pending execution when both execute_reply and status:idle have arrived. */
  private tryResolve(
    parentId: string,
    entry: {
      resolve: (result: ExecutionResult) => void;
      result: ExecutionResult;
      gotReply: boolean;
      gotIdle: boolean;
    },
  ): void {
    if (entry.gotReply && entry.gotIdle) {
      this.pending.delete(parentId);
      entry.resolve(entry.result);
    }
  }

  private handleMessage(data: string): void {
    let msg: JupyterMessage;
    try {
      msg = JSON.parse(data) as JupyterMessage;
    } catch {
      return;
    }

    const msgType =
      msg.header?.msg_type ??
      (msg as unknown as Record<string, string>).msg_type;

    // --- Handle colab_request (credential propagation) ---
    // These arrive without a parent_header matching any pending execution.
    // Must be handled or the kernel blocks indefinitely.
    if (msgType === "colab_request") {
      this.handleColabRequest(msg);
      return;
    }

    // --- Handle input_request (Python's input()) ---
    // Reply with EOFError-triggering empty + raise so the kernel doesn't block forever.
    // CLI execution is non-interactive; input() cannot be satisfied.
    // Sending EOFError via the kernel's stdin channel causes Python to raise EOFError,
    // which is the correct behavior for non-interactive contexts.
    if (msgType === "input_request") {
      this.sendInputReply("\x04", msg); // Ctrl-D (EOF) triggers EOFError in Python
      return;
    }

    // Find the pending execution this message belongs to
    const parentId =
      "msg_id" in msg.parent_header
        ? (msg.parent_header as { msg_id: string }).msg_id
        : undefined;
    if (!parentId) return;

    const entry = this.pending.get(parentId);
    if (!entry) return;

    const { header, content } = msg;

    switch (header.msg_type) {
      case "stream": {
        const c = content as { name: string; text: string };
        if (c.name === "stdout") entry.result.stdout += c.text;
        else if (c.name === "stderr") entry.result.stderr += c.text;
        break;
      }

      case "display_data":
      case "execute_result": {
        const c = content as {
          data: Record<string, unknown>;
          execution_count?: number;
        };
        entry.result.outputs.push({
          type: header.msg_type as "display_data" | "execute_result",
          data: c.data,
        });
        if (c.execution_count !== undefined) {
          entry.result.executionCount = c.execution_count;
        }
        break;
      }

      case "error": {
        const c = content as {
          ename: string;
          evalue: string;
          traceback: string[];
        };
        entry.result.error = {
          ename: c.ename,
          evalue: c.evalue,
          traceback: c.traceback,
        };
        break;
      }

      case "execute_reply": {
        const c = content as ExecuteReplyContent;
        entry.result.status = c.status;
        entry.result.executionCount = c.execution_count;
        if (c.status === "error" && !entry.result.error) {
          entry.result.error = {
            ename: c.ename ?? "UnknownError",
            evalue: c.evalue ?? "",
            traceback: c.traceback ?? [],
          };
        }
        entry.gotReply = true;
        this.tryResolve(parentId, entry);
        break;
      }

      case "status": {
        const c = content as { execution_state: string };
        if (c.execution_state === "idle") {
          entry.gotIdle = true;
          this.tryResolve(parentId, entry);
        }
        break;
      }
    }
  }

  /**
   * Handle a colab_request message from the kernel.
   *
   * The kernel sends these to request credential propagation (Drive,
   * user auth). We must reply or the kernel blocks indefinitely.
   */
  private handleColabRequest(msg: JupyterMessage): void {
    const metadata = msg.metadata as Record<string, unknown>;
    const requestType = metadata.colab_request_type as string | undefined;
    const colabMsgId = metadata.colab_msg_id as string | number | undefined;

    if (colabMsgId == null) {
      return; // Malformed — no way to reply
    }

    // GetSecret: google.colab.userdata.get('KEY')
    if (requestType === "GetSecret") {
      this.handleGetSecret(msg, colabMsgId);
      return;
    }

    if (requestType !== "request_auth") {
      // Unknown request type — send error reply so kernel unblocks
      this.sendColabReply(colabMsgId, `unsupported colab_request type: ${requestType}`);
      return;
    }

    const content = msg.content as Record<string, unknown>;
    const request = content.request as Record<string, unknown> | undefined;
    const authType = String(request?.authType ?? "").toLowerCase();

    if (!this.colabClient || !this.accessToken || !this.endpoint) {
      this.sendColabReply(colabMsgId, "no auth context for credential propagation");
      return;
    }

    if (!EPHEMERAL_AUTH_TYPES.has(authType)) {
      this.sendColabReply(colabMsgId, `unsupported auth type: ${authType}`);
      return;
    }

    // Propagate credentials asynchronously
    this.propagateAndReply(authType, colabMsgId);
  }

  /**
   * Handle GetSecret colab_request.
   *
   * Precedence: env var > Colab API (via secretResolver) > not found.
   * Reply format: {exists: bool, access: bool, payload: string}
   */
  private async handleGetSecret(
    msg: JupyterMessage,
    colabMsgId: string | number,
  ): Promise<void> {
    const content = msg.content as Record<string, unknown>;
    const request = content.request as Record<string, unknown> | undefined;
    const key = String(request?.key ?? "");

    if (!key) {
      this.sendGetSecretReply(colabMsgId, false);
      return;
    }

    // 1. Check environment variables first
    const envValue = process.env[key];
    if (envValue !== undefined) {
      this.sendGetSecretReply(colabMsgId, true, envValue);
      return;
    }

    // 2. Try secretResolver (Colab API)
    if (this.secretResolver) {
      try {
        const result = await this.secretResolver(key);
        if (result.exists) {
          this.sendGetSecretReply(colabMsgId, true, result.payload);
          return;
        }
      } catch {
        // Fall through to not found
      }
    }

    // 3. Not found
    this.sendGetSecretReply(colabMsgId, false);
  }

  /** Send a GetSecret reply on the WebSocket. */
  private sendGetSecretReply(
    colabMsgId: string | number,
    exists: boolean,
    payload?: string,
  ): void {
    if (!this.ws) return;

    const value: Record<string, unknown> = {
      type: "colab_reply",
      colab_msg_id: colabMsgId,
      ...(exists
        ? { exists: true, access: true, payload: payload ?? "" }
        : { exists: false }),
    };

    const reply: JupyterMessage = {
      header: makeHeader("input_reply", this.sessionId),
      parent_header: {},
      metadata: {},
      content: { value },
      channel: "stdin",
    };

    this.ws.send(JSON.stringify(reply));
  }

  private async propagateAndReply(
    authType: string,
    colabMsgId: string | number | undefined,
  ): Promise<void> {
    try {
      // Dry run first
      const dry = await this.colabClient!.propagateCredentials(
        this.accessToken!,
        this.endpoint!,
        authType,
        true,
      );

      const dryResult = dry as Record<string, unknown>;
      if (dryResult.unauthorized_redirect_uri || dryResult.unauthorizedRedirectUri) {
        this.sendColabReply(
          colabMsgId,
          `${authType} requires interactive browser consent`,
        );
        return;
      }

      if (dryResult.success === false) {
        this.sendColabReply(
          colabMsgId,
          `${authType} propagation denied`,
        );
        return;
      }

      // Real propagation
      await this.colabClient!.propagateCredentials(
        this.accessToken!,
        this.endpoint!,
        authType,
        false,
      );

      // Success — no error
      this.sendColabReply(colabMsgId);
    } catch (err) {
      this.sendColabReply(
        colabMsgId,
        `${authType} propagation failed: ${err}`,
      );
    }
  }

  /**
   * Send an input_reply for Python's input().
   * We send Ctrl-D (EOF, \x04) to trigger EOFError in the kernel.
   * CLI execution is non-interactive; input() cannot be satisfied.
   */
  private sendInputReply(value: string, parentMsg: JupyterMessage): void {
    if (!this.ws) return;

    const reply: JupyterMessage = {
      header: makeHeader("input_reply", this.sessionId),
      parent_header: parentMsg.header,
      metadata: {},
      content: { value },
      channel: "stdin",
    };

    this.ws.send(JSON.stringify(reply));
  }

  /** Send a colab_reply input_reply message on the WebSocket. */
  private sendColabReply(
    colabMsgId: string | number | undefined,
    error?: string,
  ): void {
    if (!this.ws) return;

    const value: Record<string, unknown> = {
      type: "colab_reply",
      colab_msg_id: colabMsgId,
    };
    if (error) value.error = error;

    const reply: JupyterMessage = {
      header: makeHeader("input_reply", this.sessionId),
      parent_header: {},
      metadata: {},
      content: { value },
      channel: "stdin",
    };

    this.ws.send(JSON.stringify(reply));
  }
}
