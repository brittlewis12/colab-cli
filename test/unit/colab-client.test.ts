import { describe, test, expect } from "bun:test";
import { ColabClient, ColabApiError } from "../../src/colab/client.ts";
import { Variant, Outcome, notebookHash } from "../../src/colab/types.ts";

// --- Mock fetch helper ---

function mockFetch(
  responses: Array<{
    status?: number;
    body: unknown;
    xssi?: boolean;
  }>,
): { fetch: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  let idx = 0;

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input instanceof Request ? input.url : input.toString(), init);
    calls.push(req);
    const resp = responses[idx++];
    if (!resp) throw new Error(`No mock response for call ${idx}`);
    const body =
      typeof resp.body === "string"
        ? resp.body
        : (resp.xssi ? ")]}'\n" : "") + JSON.stringify(resp.body);
    return new Response(body, {
      status: resp.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}

// --- Tests ---

describe("ColabClient", () => {
  test("getUserInfo calls GAPI with correct URL and headers", async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          subscriptionTier: "SUBSCRIPTION_TIER_PRO",
          paidComputeUnitsBalance: 300,
          eligibleAccelerators: [
            { variant: "VARIANT_GPU", models: ["T4", "A100"] },
          ],
        },
      },
    ]);
    const client = new ColabClient({
      gapiDomain: "https://gapi.test",
      fetch,
    });

    const info = await client.getUserInfo("tok-123");
    expect(info.subscriptionTier).toBe("SUBSCRIPTION_TIER_PRO");
    expect(info.paidComputeUnitsBalance).toBe(300);
    expect(info.eligibleAccelerators?.[0]?.models).toEqual(["T4", "A100"]);

    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://gapi.test");
    expect(url.pathname).toBe("/v1/user-info");
    expect(url.searchParams.get("get_ccu_consumption_info")).toBe("true");
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer tok-123");
  });

  test("listAssignments returns empty array when no assignments", async () => {
    const { fetch } = mockFetch([{ body: {} }]);
    const client = new ColabClient({
      gapiDomain: "https://gapi.test",
      fetch,
    });

    const result = await client.listAssignments("tok");
    expect(result).toEqual([]);
  });

  test("listAssignments returns assignment list", async () => {
    const { fetch } = mockFetch([
      {
        body: {
          assignments: [
            {
              endpoint: "ep-1",
              variant: "VARIANT_GPU",
              machineShape: "SHAPE_DEFAULT",
              accelerator: "T4",
              runtimeProxyInfo: {
                token: "proxy-tok",
                tokenTtl: "3600s",
                url: "https://proxy.test",
              },
            },
          ],
        },
      },
    ]);
    const client = new ColabClient({
      gapiDomain: "https://gapi.test",
      fetch,
    });

    const result = await client.listAssignments("tok");
    expect(result).toHaveLength(1);
    expect(result[0]!.endpoint).toBe("ep-1");
    expect(result[0]!.runtimeProxyInfo?.token).toBe("proxy-tok");
  });

  test("getAssignment sends correct tunnel URL with authuser=0", async () => {
    const { fetch, calls } = mockFetch([
      {
        body: { acc: "T4", nbh: "hash", p: false, token: "xsrf", variant: "GPU" },
        xssi: true,
      },
    ]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    const resp = await client.getAssignment("tok", {
      notebookHash: "hash",
      variant: Variant.GPU,
      accelerator: "T4",
    });

    expect(resp).toHaveProperty("token", "xsrf");

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/tun/m/assign");
    expect(url.searchParams.get("authuser")).toBe("0");
    expect(url.searchParams.get("nbh")).toBe("hash");
    expect(url.searchParams.get("variant")).toBe("GPU");
    expect(url.searchParams.get("accelerator")).toBe("T4");
  });

  test("assign: already assigned returns existing assignment", async () => {
    const assignment = {
      accelerator: "T4",
      endpoint: "ep-existing",
      fit: 3600,
      allowedCredentials: true,
      sub: 2,
      subTier: 1,
      outcome: Outcome.SUCCESS,
      variant: 1,
      machineShape: 0,
      runtimeProxyInfo: {
        token: "proxy-tok",
        tokenExpiresInSeconds: 3600,
        url: "https://proxy.test",
      },
    };
    const { fetch, calls } = mockFetch([{ body: assignment, xssi: true }]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    const result = await client.assign("tok", {
      notebookHash: "hash",
      variant: Variant.GPU,
      accelerator: "T4",
    });

    expect(result.endpoint).toBe("ep-existing");
    expect(result.runtimeProxyInfo.token).toBe("proxy-tok");
    // Only 1 call — no POST needed
    expect(calls).toHaveLength(1);
  });

  test("assign: not yet assigned does GET then POST", async () => {
    const getResp = {
      acc: "T4",
      nbh: "hash",
      p: false,
      token: "xsrf-tok",
      variant: "GPU",
    };
    const postResp = {
      accelerator: "T4",
      endpoint: "ep-new",
      fit: 3600,
      allowedCredentials: true,
      sub: 2,
      subTier: 1,
      outcome: Outcome.SUCCESS,
      variant: 1,
      machineShape: 0,
      runtimeProxyInfo: {
        token: "proxy-new",
        tokenExpiresInSeconds: 3600,
        url: "https://proxy-new.test",
      },
    };
    const { fetch, calls } = mockFetch([
      { body: getResp, xssi: true },
      { body: postResp, xssi: true },
    ]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    const result = await client.assign("tok", {
      notebookHash: "hash",
      variant: Variant.GPU,
      accelerator: "T4",
    });

    expect(result.endpoint).toBe("ep-new");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers.get("X-Goog-Colab-Token")).toBe("xsrf-tok");
  });

  test("unassign does GET+POST with XSRF", async () => {
    const { fetch, calls } = mockFetch([
      { body: { token: "xsrf-unsign" }, xssi: true },
      { body: "", status: 200 },
    ]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    await client.unassign("tok", "ep-123");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("GET");
    expect(new URL(calls[0]!.url).pathname).toBe("/tun/m/unassign/ep-123");
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers.get("X-Goog-Colab-Token")).toBe("xsrf-unsign");
  });

  test("keepAlive sends tunnel header", async () => {
    const { fetch, calls } = mockFetch([{ body: "" }]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    await client.keepAlive("tok", "ep-123");

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/tun/m/ep-123/keep-alive/");
    expect(calls[0]!.headers.get("X-Colab-Tunnel")).toBe("Google");
  });

  test("refreshProxyToken calls GAPI", async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          token: "refreshed-tok",
          tokenTtl: "3600s",
          url: "https://proxy.refreshed",
        },
      },
    ]);
    const client = new ColabClient({
      gapiDomain: "https://gapi.test",
      fetch,
    });

    const result = await client.refreshProxyToken("tok", "ep-123");
    expect(result.token).toBe("refreshed-tok");

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/runtime-proxy-token");
    expect(url.searchParams.get("endpoint")).toBe("ep-123");
    expect(url.searchParams.get("port")).toBe("8080");
  });

  test("propagateCredentials does GET+POST with XSRF (non-dry-run)", async () => {
    const { fetch, calls } = mockFetch([
      { body: { token: "xsrf-prop" }, xssi: true },
      { body: { success: true }, xssi: true },
    ]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    const result = await client.propagateCredentials(
      "tok",
      "ep-123",
      "dfs_ephemeral",
      false,
    );

    expect(result).toEqual({ success: true });
    expect(calls).toHaveLength(2);

    // GET
    const getUrl = new URL(calls[0]!.url);
    expect(getUrl.pathname).toBe("/tun/m/credentials-propagation/ep-123");
    expect(getUrl.searchParams.get("authtype")).toBe("dfs_ephemeral");
    expect(getUrl.searchParams.get("dryrun")).toBe("false");
    expect(getUrl.searchParams.get("propagate")).toBe("true");

    // POST with XSRF
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers.get("X-Goog-Colab-Token")).toBe("xsrf-prop");
  });

  test("propagateCredentials dry-run only does GET, no POST (bug 3 fix)", async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          token: "xsrf-prop",
          success: false,
          unauthorized_redirect_uri: "https://accounts.google.com/consent",
        },
        xssi: true,
      },
    ]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    const result = await client.propagateCredentials(
      "tok",
      "ep-123",
      "dfs_ephemeral",
      true,
    );

    // Should return the GET response directly
    expect(result.unauthorized_redirect_uri).toBe("https://accounts.google.com/consent");
    expect(result.success).toBe(false);

    // Only 1 call — GET only, no POST
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    const getUrl = new URL(calls[0]!.url);
    expect(getUrl.searchParams.get("dryrun")).toBe("true");
  });

  test("propagateCredentials dry-run returns success:true when already consented", async () => {
    const { fetch, calls } = mockFetch([
      { body: { token: "xsrf", success: true }, xssi: true },
    ]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    const result = await client.propagateCredentials(
      "tok", "ep-123", "dfs_ephemeral", true,
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("API error throws ColabApiError", async () => {
    const { fetch } = mockFetch([
      { body: "quota exceeded", status: 429 },
    ]);
    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    try {
      await client.keepAlive("tok", "ep-123");
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(ColabApiError);
      expect((e as ColabApiError).status).toBe(429);
      expect((e as ColabApiError).path).toContain("keep-alive");
    }
  });
});

// ── listSecrets ──────────────────────────────────────────────────────────

describe("listSecrets", () => {
  test("returns secrets from /userdata/list", async () => {
    const { fetch } = mockFetch([
      {
        body: [
          { key: "HF_TOKEN", payload: "hf_xxx", access: true },
          { key: "WANDB", payload: "wb_yyy", access: false },
        ],
      },
    ]);

    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    const secrets = await client.listSecrets("tok-123");
    expect(secrets).toHaveLength(2);
    expect(secrets[0]!.key).toBe("HF_TOKEN");
    expect(secrets[1]!.key).toBe("WANDB");
  });

  test("handles XSSI prefix in response (bug 9 fix)", async () => {
    const { fetch } = mockFetch([
      {
        body: [
          { key: "SECRET_A", payload: "val_a", access: true },
        ],
        xssi: true,
      },
    ]);

    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    const secrets = await client.listSecrets("tok-123");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.key).toBe("SECRET_A");
    expect(secrets[0]!.payload).toBe("val_a");
  });

  test("throws on auth failure", async () => {
    const { fetch } = mockFetch([{ status: 401, body: "Unauthorized" }]);

    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch,
    });

    await expect(client.listSecrets("bad-tok")).rejects.toThrow(ColabApiError);
  });
});

// ── createSecretResolver ─────────────────────────────────────────────────

import { createSecretResolver } from "../../src/colab/secrets.ts";

describe("createSecretResolver", () => {
  test("caches API call — only one fetch for multiple lookups", async () => {
    let fetchCount = 0;
    const { fetch } = mockFetch([
      {
        body: [
          { key: "A", payload: "val_a", access: true },
          { key: "B", payload: "val_b", access: true },
        ],
      },
    ]);

    const wrappedFetch = (async (...args: any[]) => {
      fetchCount++;
      return (fetch as any)(...args);
    }) as typeof globalThis.fetch;

    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch: wrappedFetch,
    });

    const resolve = createSecretResolver(client, "tok");

    const a = await resolve("A");
    expect(a).toEqual({ exists: true, payload: "val_a" });

    const b = await resolve("B");
    expect(b).toEqual({ exists: true, payload: "val_b" });

    const c = await resolve("C");
    expect(c).toEqual({ exists: false });

    // Only one API call despite three lookups
    expect(fetchCount).toBe(1);
  });

  test("concurrent calls share one fetch — no double-fetch race (bug 11 fix)", async () => {
    let fetchCount = 0;
    let resolveGate: (() => void) | null = null;

    // Create a fetch that blocks until we release a gate
    const slowFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCount++;
      // Wait for gate to be released — simulates slow network
      await new Promise<void>((r) => { resolveGate = r; });
      const body = JSON.stringify([
        { key: "X", payload: "val_x", access: true },
        { key: "Y", payload: "val_y", access: true },
      ]);
      return new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;

    const client = new ColabClient({
      colabDomain: "https://colab.test",
      fetch: slowFetch,
    });

    const resolve = createSecretResolver(client, "tok");

    // Launch two concurrent lookups before the first can complete
    const p1 = resolve("X");
    const p2 = resolve("Y");

    // Release the gate — both should resolve from the same API call
    resolveGate!();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ exists: true, payload: "val_x" });
    expect(r2).toEqual({ exists: true, payload: "val_y" });

    // Only ONE fetch call despite two concurrent resolves
    expect(fetchCount).toBe(1);
  });
});

// ── notebookHash ─────────────────────────────────────────────────────────

describe("notebookHash", () => {
  test("produces 44-char string with underscores and dot padding", () => {
    const hash = notebookHash();
    expect(hash).toHaveLength(44);
    // UUID dashes replaced with underscores
    expect(hash).not.toContain("-");
    expect(hash).toContain("_");
    // Padded with dots
    expect(hash).toMatch(/\.+$/);
  });

  test("produces unique values", () => {
    const a = notebookHash();
    const b = notebookHash();
    expect(a).not.toBe(b);
  });
});
