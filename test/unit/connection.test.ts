import { describe, test, expect } from "bun:test";
import { KernelConnection } from "../../src/jupyter/connection.ts";

// --- Mock WebSocket ---

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(
    public url: string,
    public opts?: unknown,
  ) {
    MockWebSocket.instances.push(this);
    // Auto-open on next tick
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  // Test helper: simulate receiving a message
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function resetMocks(): void {
  MockWebSocket.instances = [];
}

describe("KernelConnection", () => {
  test("connect opens WebSocket with correct URL and headers", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "kernel-abc",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );

    await conn.connect();

    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toStartWith("wss://proxy.test/api/kernels/kernel-abc/channels?session_id=");
    const opts = ws.opts as { headers: Record<string, string> };
    expect(opts.headers["X-Colab-Runtime-Proxy-Token"]).toBe("ptok");
  });

  test("execute sends execute_request and collects stdout", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    const resultPromise = conn.execute('print("hello")');

    // Parse the sent message to get msg_id
    expect(ws.sent).toHaveLength(1);
    const sent = JSON.parse(ws.sent[0]!);
    expect(sent.header.msg_type).toBe("execute_request");
    expect(sent.content.code).toBe('print("hello")');
    const msgId = sent.header.msg_id;

    // Simulate kernel response sequence
    ws.receive({
      header: { msg_type: "stream" },
      parent_header: { msg_id: msgId },
      content: { name: "stdout", text: "hello\n" },
      metadata: {},
      channel: "iopub",
    });

    ws.receive({
      header: { msg_type: "execute_reply" },
      parent_header: { msg_id: msgId },
      content: { status: "ok", execution_count: 1 },
      metadata: {},
      channel: "shell",
    });

    ws.receive({
      header: { msg_type: "status" },
      parent_header: { msg_id: msgId },
      content: { execution_state: "idle" },
      metadata: {},
      channel: "iopub",
    });

    const result = await resultPromise;
    expect(result.status).toBe("ok");
    expect(result.stdout).toBe("hello\n");
    expect(result.executionCount).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.outputs).toEqual([]);

    conn.close();
  });

  test("execute collects stderr and error info", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    const resultPromise = conn.execute("1/0");
    const msgId = JSON.parse(ws.sent[0]!).header.msg_id;

    ws.receive({
      header: { msg_type: "error" },
      parent_header: { msg_id: msgId },
      content: {
        ename: "ZeroDivisionError",
        evalue: "division by zero",
        traceback: ["Traceback...", "ZeroDivisionError: division by zero"],
      },
      metadata: {},
      channel: "iopub",
    });

    ws.receive({
      header: { msg_type: "execute_reply" },
      parent_header: { msg_id: msgId },
      content: {
        status: "error",
        execution_count: 2,
        ename: "ZeroDivisionError",
        evalue: "division by zero",
        traceback: ["Traceback..."],
      },
      metadata: {},
      channel: "shell",
    });

    ws.receive({
      header: { msg_type: "status" },
      parent_header: { msg_id: msgId },
      content: { execution_state: "idle" },
      metadata: {},
      channel: "iopub",
    });

    const result = await resultPromise;
    expect(result.status).toBe("error");
    expect(result.error?.ename).toBe("ZeroDivisionError");
    expect(result.error?.evalue).toBe("division by zero");
    expect(result.executionCount).toBe(2);

    conn.close();
  });

  test("execute collects display_data and execute_result", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    const resultPromise = conn.execute("display(42)");
    const msgId = JSON.parse(ws.sent[0]!).header.msg_id;

    ws.receive({
      header: { msg_type: "display_data" },
      parent_header: { msg_id: msgId },
      content: {
        data: { "text/plain": "42", "text/html": "<b>42</b>" },
        metadata: {},
      },
      metadata: {},
      channel: "iopub",
    });

    ws.receive({
      header: { msg_type: "execute_result" },
      parent_header: { msg_id: msgId },
      content: {
        data: { "text/plain": "42" },
        metadata: {},
        execution_count: 3,
      },
      metadata: {},
      channel: "iopub",
    });

    ws.receive({
      header: { msg_type: "execute_reply" },
      parent_header: { msg_id: msgId },
      content: { status: "ok", execution_count: 3 },
      metadata: {},
      channel: "shell",
    });

    ws.receive({
      header: { msg_type: "status" },
      parent_header: { msg_id: msgId },
      content: { execution_state: "idle" },
      metadata: {},
      channel: "iopub",
    });

    const result = await resultPromise;
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[0]!.type).toBe("display_data");
    expect(result.outputs[0]!.data["text/html"]).toBe("<b>42</b>");
    expect(result.outputs[1]!.type).toBe("execute_result");
    expect(result.executionCount).toBe(3);

    conn.close();
  });

  test("WebSocket close rejects pending executions", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    const resultPromise = conn.execute("time.sleep(100)");

    // Close the WebSocket before reply arrives
    ws.close();

    await expect(resultPromise).rejects.toThrow("WebSocket closed");
  });

  test("input_request gets auto-replied so kernel unblocks", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    const resultPromise = conn.execute('x = input("name: ")');
    const msgId = JSON.parse(ws.sent[0]!).header.msg_id;

    // Kernel sends input_request
    ws.receive({
      header: { msg_type: "input_request" },
      parent_header: { msg_id: msgId },
      content: { prompt: "name: ", password: false },
      metadata: {},
      channel: "stdin",
    });

    // Verify an input_reply was sent back
    expect(ws.sent).toHaveLength(2);
    const reply = JSON.parse(ws.sent[1]!);
    expect(reply.header.msg_type).toBe("input_reply");
    expect(reply.content.value).toBe("\x04"); // EOF triggers EOFError in Python
    expect(reply.channel).toBe("stdin");

    // Complete the execution normally
    ws.receive({
      header: { msg_type: "execute_reply" },
      parent_header: { msg_id: msgId },
      content: { status: "ok", execution_count: 1 },
      metadata: {},
      channel: "shell",
    });
    ws.receive({
      header: { msg_type: "status" },
      parent_header: { msg_id: msgId },
      content: { execution_state: "idle" },
      metadata: {},
      channel: "iopub",
    });

    const result = await resultPromise;
    expect(result.status).toBe("ok");

    conn.close();
  });

  test("execute times out when timeoutMs is set", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );
    await conn.connect();

    // Execute with a very short timeout — never send reply
    const promise = conn.execute("time.sleep(999)", 50);

    await expect(promise).rejects.toThrow("timed out");

    conn.close();
  });

  test("timeout timer is cleared after successful execution (bug 6 fix)", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    // Execute with a long timeout
    const resultPromise = conn.execute('print("ok")', 5000);
    const msgId = JSON.parse(ws.sent[0]!).header.msg_id;

    // Complete immediately
    ws.receive({
      header: { msg_type: "execute_reply" },
      parent_header: { msg_id: msgId },
      content: { status: "ok", execution_count: 1 },
      metadata: {},
      channel: "shell",
    });
    ws.receive({
      header: { msg_type: "status" },
      parent_header: { msg_id: msgId },
      content: { execution_state: "idle" },
      metadata: {},
      channel: "iopub",
    });

    const result = await resultPromise;
    expect(result.status).toBe("ok");

    // Wait longer than the timeout would have been — if timer wasn't
    // cleared, this would cause issues (stale timer fire, pending.delete
    // on already-resolved msgId, etc.)
    await new Promise((r) => setTimeout(r, 50));

    // No error thrown — timer was properly cleared
    conn.close();
  });

  test("messages for unknown parent_id are ignored", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      { WebSocket: MockWebSocket as any },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    // Send a stray message — should not throw
    ws.receive({
      header: { msg_type: "stream" },
      parent_header: { msg_id: "unknown-id" },
      content: { name: "stdout", text: "stray" },
      metadata: {},
      channel: "iopub",
    });

    conn.close();
  });

  // ── GetSecret handler ───────────────────────────────────────────────

  test("GetSecret resolves from env var first", async () => {
    resetMocks();
    process.env.__TEST_SECRET = "env-value";
    try {
      const conn = new KernelConnection(
        "https://proxy.test",
        "k-1",
        "ptok",
        {
          WebSocket: MockWebSocket as any,
          secretResolver: async () => ({ exists: true as const, payload: "api-value" }),
        },
      );
      await conn.connect();
      const ws = MockWebSocket.instances[0]!;

      // Kernel sends GetSecret
      ws.receive({
        header: { msg_type: "colab_request" },
        parent_header: {},
        metadata: { colab_request_type: "GetSecret", colab_msg_id: 42 },
        content: { request: { key: "__TEST_SECRET" } },
        channel: "stdin",
      });

      // handleGetSecret is async — wait for it to complete
      await new Promise((r) => setTimeout(r, 10));

      // Should have sent a reply
      expect(ws.sent).toHaveLength(1);
      const reply = JSON.parse(ws.sent[0]!);
      expect(reply.content.value.data.exists).toBe(true);
      expect(reply.content.value.data.payload).toBe("env-value");
      expect(reply.content.value.colab_msg_id).toBe(42);

      conn.close();
    } finally {
      delete process.env.__TEST_SECRET;
    }
  });

  test("GetSecret falls back to secretResolver when no env var", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      {
        WebSocket: MockWebSocket as any,
        secretResolver: async (key) =>
          key === "__COLAB_TEST_SECRET_XYZ"
            ? { exists: true as const, payload: "api_value" }
            : { exists: false as const },
      },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    ws.receive({
      header: { msg_type: "colab_request" },
      parent_header: {},
      metadata: { colab_request_type: "GetSecret", colab_msg_id: 7 },
      content: { request: { key: "__COLAB_TEST_SECRET_XYZ" } },
      channel: "stdin",
    });

    // handleGetSecret is async — wait for it to complete
    await new Promise((r) => setTimeout(r, 10));

    const reply = JSON.parse(ws.sent[0]!);
    expect(reply.content.value.data.exists).toBe(true);
    expect(reply.content.value.data.payload).toBe("api_value");

    conn.close();
  });

  test("GetSecret returns exists:false for unknown key", async () => {
    resetMocks();
    const conn = new KernelConnection(
      "https://proxy.test",
      "k-1",
      "ptok",
      {
        WebSocket: MockWebSocket as any,
        secretResolver: async () => ({ exists: false as const }),
      },
    );
    await conn.connect();
    const ws = MockWebSocket.instances[0]!;

    ws.receive({
      header: { msg_type: "colab_request" },
      parent_header: {},
      metadata: { colab_request_type: "GetSecret", colab_msg_id: 99 },
      content: { request: { key: "__COLAB_NONEXISTENT_XYZ" } },
      channel: "stdin",
    });

    // handleGetSecret is async — wait for it to complete
    await new Promise((r) => setTimeout(r, 10));

    const reply = JSON.parse(ws.sent[0]!);
    expect(reply.content.value.data.exists).toBe(false);

    conn.close();
  });
});
