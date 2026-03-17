import { describe, test, expect } from "bun:test";
import { getOrCreateKernel } from "../../src/jupyter/lifecycle.ts";

// ── Mock fetch for SessionsClient ────────────────────────────────────────

function mockSessionsFetch(scenario: "existing" | "create" | "retry") {
  let attempt = 0;

  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";

    if (url.includes("/api/sessions") && method === "GET") {
      if (scenario === "existing") {
        return new Response(
          JSON.stringify([
            {
              id: "sess-1",
              path: "test",
              name: "test",
              type: "notebook",
              kernel: {
                id: "kernel-existing",
                name: "python3",
                last_activity: new Date().toISOString(),
                execution_state: "idle",
                connections: 0,
              },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    }

    if (url.includes("/api/sessions") && method === "POST") {
      attempt++;
      if (scenario === "retry" && attempt < 3) {
        return new Response("Not ready", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          id: "sess-new",
          path: "test",
          name: "test",
          type: "notebook",
          kernel: {
            id: "kernel-new",
            name: "python3",
            last_activity: new Date().toISOString(),
            execution_state: "starting",
            connections: 0,
          },
        }),
        { status: 201 },
      );
    }

    return new Response("Not found", { status: 404 });
  };
}

// Patch SessionsClient to use our mock fetch. The SessionsClient
// constructor accepts opts.fetch, but getOrCreateKernel creates it
// internally. We need to patch globalThis.fetch for these tests.

describe("getOrCreateKernel", () => {
  test("returns existing kernel when session exists", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockSessionsFetch("existing") as any;
    try {
      const result = await getOrCreateKernel("https://proxy.test", "tok");
      expect(result.kernelId).toBe("kernel-existing");
      expect(result.sessionId).toBe("sess-1");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("creates new session when none exist", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockSessionsFetch("create") as any;
    try {
      const result = await getOrCreateKernel("https://proxy.test", "tok");
      expect(result.kernelId).toBe("kernel-new");
      expect(result.sessionId).toBe("sess-new");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("retries session creation on failure", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockSessionsFetch("retry") as any;
    const retries: number[] = [];
    try {
      const result = await getOrCreateKernel("https://proxy.test", "tok", {
        timeout: 30_000,
        interval: 10, // fast retries for test
        onRetry: (attempt) => retries.push(attempt),
      });
      expect(result.kernelId).toBe("kernel-new");
      expect(retries.length).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("throws on timeout", async () => {
    const origFetch = globalThis.fetch;
    // Always fail
    globalThis.fetch = (async () =>
      new Response("Not ready", { status: 503 })) as any;
    try {
      await expect(
        getOrCreateKernel("https://proxy.test", "tok", {
          timeout: 30,
          interval: 5,
        }),
      ).rejects.toThrow("not ready");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
