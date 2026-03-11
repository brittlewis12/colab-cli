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

    expect(resultPromise).rejects.toThrow("WebSocket closed");
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
});
