import { describe, test, expect } from "bun:test";
import { SessionsClient } from "../../src/jupyter/sessions.ts";

function mockFetch(
  handler: (req: Request) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(handler(new Request(input, init)));
  }) as typeof globalThis.fetch;
}

describe("SessionsClient", () => {
  test("listSessions returns sessions", async () => {
    const sessions = [
      {
        id: "sess-1",
        path: "nb.ipynb",
        name: "nb.ipynb",
        type: "notebook",
        kernel: {
          id: "k-1",
          name: "python3",
          last_activity: "2025-01-01T00:00:00Z",
          execution_state: "idle",
          connections: 1,
        },
      },
    ];
    const fetch = mockFetch((req) => {
      expect(new URL(req.url).pathname).toBe("/api/sessions");
      expect(req.headers.get("X-Colab-Runtime-Proxy-Token")).toBe("ptok");
      return new Response(JSON.stringify(sessions));
    });

    const client = new SessionsClient("https://proxy.test", "ptok", { fetch });
    const result = await client.listSessions();
    expect(result).toHaveLength(1);
    expect(result[0]!.kernel.id).toBe("k-1");
  });

  test("createSession sends POST with kernel spec", async () => {
    const session = {
      id: "sess-new",
      path: "nb.ipynb",
      name: "nb.ipynb",
      type: "notebook",
      kernel: {
        id: "k-new",
        name: "python3",
        last_activity: "2025-01-01T00:00:00Z",
        execution_state: "starting",
        connections: 0,
      },
    };
    let capturedBody: any;
    const fetch = mockFetch(async (req) => {
      expect(req.method).toBe("POST");
      capturedBody = await req.json();
      return new Response(JSON.stringify(session));
    });

    const client = new SessionsClient("https://proxy.test", "ptok", { fetch });
    const result = await client.createSession({
      path: "nb.ipynb",
      name: "nb.ipynb",
    });

    expect(result.id).toBe("sess-new");
    expect(capturedBody.kernel.name).toBe("python3");
    expect(capturedBody.type).toBe("notebook");
  });

  test("deleteSession sends DELETE", async () => {
    const fetch = mockFetch((req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/api/sessions/sess-1");
      return new Response("", { status: 204 });
    });

    const client = new SessionsClient("https://proxy.test", "ptok", { fetch });
    await client.deleteSession("sess-1");
  });

  test("deleteSession ignores 404", async () => {
    const fetch = mockFetch(() => new Response("", { status: 404 }));
    const client = new SessionsClient("https://proxy.test", "ptok", { fetch });
    await client.deleteSession("gone"); // should not throw
  });

  test("interruptKernel sends POST", async () => {
    const fetch = mockFetch((req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/api/kernels/k-1/interrupt");
      return new Response("");
    });

    const client = new SessionsClient("https://proxy.test", "ptok", { fetch });
    await client.interruptKernel("k-1");
  });

  test("restartKernel sends POST", async () => {
    const fetch = mockFetch((req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/api/kernels/k-1/restart");
      return new Response("");
    });

    const client = new SessionsClient("https://proxy.test", "ptok", { fetch });
    await client.restartKernel("k-1");
  });
});
