/**
 * CLI command tests: kill, pull, push, exec, run.
 *
 * All tests in one file to avoid parallel races on the shared
 * credentials file. Uses real credentials on disk + process.chdir()
 * for project root + globalThis.fetch mock for API calls.
 *
 * No mock.module() — avoids leaking mocks across test files.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile as fsWriteFile, readFile as fsReadFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { writeJson, readJson } from "../../src/state/store.ts";
import type { NotebookState } from "../../src/state/notebooks.ts";

// Commands under test
import { killCommand } from "../../src/cli/kill.ts";
import { pullCommand } from "../../src/cli/pull.ts";
import { pushCommand } from "../../src/cli/push.ts";
import { execCommand } from "../../src/cli/exec.ts";
import { runNotebookCommand } from "../../src/cli/run.ts";
import { secretsCommand } from "../../src/cli/secrets.ts";
import { lsCommand } from "../../src/cli/ls.ts";
import { statusCommand } from "../../src/cli/status.ts";

// ── Shared Setup ─────────────────────────────────────────────────────────

const CREDS_DIR = join(homedir(), ".config", "colab-cli");
const CREDS_PATH = join(CREDS_DIR, "credentials.json");

let tmpDir: string;
let origCwd: string;
let origFetch: typeof globalThis.fetch;
let hadCreds: boolean;
let savedCreds: string;

function makeCreds() {
  return {
    access_token: "test-token-cli",
    refresh_token: "test-refresh-cli",
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: "test-client",
    client_secret: "test-secret",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
}

function makeState(overrides?: Partial<NotebookState>): NotebookState {
  return {
    notebookHash: "abc_def_123..........",
    endpoint: "gpu-t4-s-test123",
    gpu: "t4",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function writeState(name: string, state: NotebookState) {
  await writeJson(join(tmpDir, ".colab", "notebooks", `${name}.json`), state);
}

function minimalIpynb(source = 'print("hello")', id?: string) {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    },
    cells: [
      {
        cell_type: "code",
        source: [source],
        metadata: {},
        outputs: [{ output_type: "stream", name: "stdout", text: ["hello\n"] }],
        execution_count: 1,
        ...(id ? { id } : {}),
      },
    ],
  });
}

function minimalPy(source = 'print("hello")') {
  return `# %%\n${source}\n`;
}

/** Mock fetch for proxy token refresh + Contents API. */
function mockFetchFor(opts: {
  remoteIpynb?: string | null;
  acceptWrite?: boolean;
}) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";

    // GAPI: refreshProxyToken
    if (url.includes("/v1/runtime-proxy-token")) {
      return new Response(
        JSON.stringify({ token: "proxy-tok", tokenTtl: "3600s", url: "https://proxy.test" }),
        { status: 200 },
      );
    }

    // Contents API: read
    if (url.includes("/api/contents/") && method === "GET") {
      if (opts.remoteIpynb != null) {
        const b64 = Buffer.from(opts.remoteIpynb).toString("base64");
        return new Response(JSON.stringify({ content: b64 }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }

    // Contents API: write
    if (url.includes("/api/contents/") && method === "PUT") {
      if (opts.acceptWrite !== false) {
        return new Response(JSON.stringify({ name: "test.ipynb" }), { status: 200 });
      }
      return new Response("Error", { status: 500 });
    }

    // Keep-alive
    if (url.includes("/keep-alive/")) {
      return new Response("", { status: 200 });
    }

    // Unassign GET (xsrf token)
    if (url.includes("/unassign/") && method !== "POST") {
      return new Response(')]}\'\n{"token":"xsrf-tok"}', { status: 200 });
    }

    // Unassign POST
    if (url.includes("/unassign/") && method === "POST") {
      return new Response("", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }) as any;
}

beforeEach(async () => {
  // Temp dir with .colab/
  tmpDir = await mkdtemp(join(tmpdir(), "colab-cmd-test-"));
  await mkdir(join(tmpDir, ".colab", "notebooks"), { recursive: true });

  // Save existing creds
  try {
    savedCreds = await fsReadFile(CREDS_PATH, "utf-8");
    hadCreds = true;
  } catch {
    hadCreds = false;
  }

  // Write mock creds
  await mkdir(CREDS_DIR, { recursive: true });
  await fsWriteFile(CREDS_PATH, JSON.stringify(makeCreds()));

  // chdir to temp dir
  origCwd = process.cwd();
  process.chdir(tmpDir);

  // Save fetch
  origFetch = globalThis.fetch;
});

afterEach(async () => {
  process.chdir(origCwd);
  globalThis.fetch = origFetch;

  // Restore creds
  if (hadCreds) {
    await fsWriteFile(CREDS_PATH, savedCreds);
  } else {
    try { await unlink(CREDS_PATH); } catch {}
  }

  await rm(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Auth ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

import { authCommand } from "../../src/cli/auth.ts";

describe("auth status", () => {
  test("email field is not corrupted by subscription tier", async () => {
    // Write creds with a real email
    await fsWriteFile(
      CREDS_PATH,
      JSON.stringify({
        ...makeCreds(),
        email: "user@example.com",
      }),
    );

    // Mock: getUserInfo returns tier, userinfo endpoint fails
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/v1/user-info")) {
        return new Response(
          JSON.stringify({
            subscriptionTier: "SUBSCRIPTION_TIER_PRO",
            eligibleAccelerators: [],
          }),
          { status: 200 },
        );
      }
      return new Response("Error", { status: 500 });
    }) as any;

    const r = await authCommand(["status"]);
    expect(r.ok).toBe(true);
    const data = r.data as { email?: string; tier?: string };
    // Email should be from stored creds, NOT the tier string
    expect(data.email).toBe("user@example.com");
    expect(data.tier).toBe("SUBSCRIPTION_TIER_PRO");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Kill ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("kill command", () => {
  test("returns NOT_FOUND when no state exists", async () => {
    const r = await killCommand(["nonexistent"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
  });

  test("unassigns and deletes state on success", async () => {
    await writeState("nb", makeState());
    globalThis.fetch = mockFetchFor({});

    const r = await killCommand(["nb"]);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: "nb", unassigned: true, stateDeleted: true });

    // State file gone
    const s = await readJson(join(tmpDir, ".colab", "notebooks", "nb.json"));
    expect(s).toBeNull();
  });

  test("succeeds even if unassign API fails", async () => {
    await writeState("nb", makeState());
    globalThis.fetch = (async () =>
      new Response("Error", { status: 500 })) as any;

    const r = await killCommand(["nb"]);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: "nb", unassigned: false, stateDeleted: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Pull ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("pull command", () => {
  test("returns NOT_FOUND when no notebook state", async () => {
    const r = await pullCommand(["nonexistent"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
  });

  test("returns DIRTY when local .py has unpushed changes", async () => {
    await writeState("train", makeState());
    await fsWriteFile(join(tmpDir, "train.py"), "# edited\n");

    globalThis.fetch = mockFetchFor({ remoteIpynb: minimalIpynb() });

    const r = await pullCommand(["train"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("DIRTY");
  });

  test("--force overrides dirty check", async () => {
    await writeState("train", makeState());
    await fsWriteFile(join(tmpDir, "train.py"), "# edited\n");

    globalThis.fetch = mockFetchFor({ remoteIpynb: minimalIpynb() });

    const r = await pullCommand(["train", "--force"]);
    expect(r.ok).toBe(true);
    expect(r.data!.cells).toBe(1);
  });

  test("happy path: fetches .ipynb, writes .py and cache", async () => {
    await writeState("train", makeState());

    globalThis.fetch = mockFetchFor({
      remoteIpynb: minimalIpynb('print("hello world")'),
    });

    const r = await pullCommand(["train"]);
    expect(r.ok).toBe(true);
    expect(r.data!.name).toBe("train");
    expect(r.data!.cells).toBe(1);

    // .py was written with percent format
    const py = await fsReadFile(join(tmpDir, "train.py"), "utf-8");
    expect(py).toContain('print("hello world")');
    expect(py).toContain("# %%");

    // cache was written
    const cached = JSON.parse(
      await fsReadFile(join(tmpDir, ".colab", "notebooks", "train.ipynb"), "utf-8"),
    );
    expect(cached.cells).toHaveLength(1);

    // pushedHash set with sha256: prefix (clean)
    const state = JSON.parse(
      await fsReadFile(join(tmpDir, ".colab", "notebooks", "train.json"), "utf-8"),
    );
    expect(state.pushedHash).toStartWith("sha256:");
  });

  test("returns NOT_FOUND when runtime is gone", async () => {
    await writeState("train", makeState());

    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as any;

    const r = await pullCommand(["train"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
    expect(r.error!.message).toContain("no longer available");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Push ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("push command", () => {
  test("returns NOT_FOUND when no notebook state", async () => {
    const r = await pushCommand(["nonexistent"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
  });

  test("returns NOT_FOUND when no local .py", async () => {
    await writeState("train", makeState());
    globalThis.fetch = mockFetchFor({ remoteIpynb: null });

    const r = await pushCommand(["train"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
    expect(r.error!.message).toContain("train.py");
  });

  test("happy path: fresh notebook (no remote, no cache)", async () => {
    await writeState("train", makeState());
    await fsWriteFile(join(tmpDir, "train.py"), minimalPy('print("fresh")'));
    globalThis.fetch = mockFetchFor({ remoteIpynb: null });

    const r = await pushCommand(["train"]);
    expect(r.ok).toBe(true);
    expect(r.data!.name).toBe("train");
    expect(r.data!.cells).toBe(1);
    expect(r.data!.merged).toBe(false);

    // cache written
    const cached = JSON.parse(
      await fsReadFile(join(tmpDir, ".colab", "notebooks", "train.ipynb"), "utf-8"),
    );
    expect(cached.cells).toHaveLength(1);
  });

  test("happy path: merge with remote (preserves outputs + cell ID)", async () => {
    const remote = minimalIpynb('print("hello")', "cell-abc");
    await writeState("train", makeState());
    await fsWriteFile(join(tmpDir, "train.py"), minimalPy('print("hello")'));
    globalThis.fetch = mockFetchFor({ remoteIpynb: remote });

    const r = await pushCommand(["train"]);
    expect(r.ok).toBe(true);
    expect(r.data!.merged).toBe(true);

    const cached = JSON.parse(
      await fsReadFile(join(tmpDir, ".colab", "notebooks", "train.ipynb"), "utf-8"),
    );
    expect(cached.cells[0].id).toBe("cell-abc");
    expect(cached.cells[0].outputs).toHaveLength(1);
    expect(cached.cells[0].execution_count).toBe(1);
  });

  test("falls back to cache when remote unavailable", async () => {
    await writeState("train", makeState());
    await fsWriteFile(join(tmpDir, "train.py"), minimalPy('print("edited")'));
    // Write a cache file
    await fsWriteFile(
      join(tmpDir, ".colab", "notebooks", "train.ipynb"),
      minimalIpynb('print("old")', "cached-id"),
    );

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/v1/runtime-proxy-token")) {
        return new Response(
          JSON.stringify({ token: "tok", tokenTtl: "3600s", url: "https://proxy.test" }),
          { status: 200 },
        );
      }
      if (url.includes("/api/contents/") && method === "GET") {
        return new Response("Not found", { status: 404 });
      }
      if (url.includes("/api/contents/") && method === "PUT") {
        return new Response(JSON.stringify({ name: "test.ipynb" }), { status: 200 });
      }
      if (url.includes("/keep-alive/")) return new Response("", { status: 200 });
      return new Response("Not found", { status: 404 });
    }) as any;

    const r = await pushCommand(["train"]);
    expect(r.ok).toBe(true);
    expect(r.data!.merged).toBe(true);
  });

  test("returns NOT_FOUND when runtime is gone", async () => {
    await writeState("train", makeState());
    await fsWriteFile(join(tmpDir, "train.py"), minimalPy());

    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as any;

    const r = await pushCommand(["train"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
    expect(r.error!.message).toContain("no longer available");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Exec ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("exec command", () => {
  test("returns NOT_FOUND when no notebook state", async () => {
    const r = await execCommand(["nonexistent", "print(42)"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
  });

  test("returns NOT_FOUND when runtime is gone", async () => {
    await writeState("nb", makeState());
    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as any;

    const r = await execCommand(["nb", "print(42)"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
    expect(r.error!.message).toContain("no longer available");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Run ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("run command", () => {
  test("returns NOT_FOUND when no notebook state", async () => {
    const r = await runNotebookCommand(["nonexistent"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
  });

  test("returns NOT_FOUND when runtime is gone", async () => {
    await writeState("nb", makeState());
    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as any;

    const r = await runNotebookCommand(["nb"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
  });

  test("--push delegates to push (fails if no .py)", async () => {
    await writeState("train", makeState());
    globalThis.fetch = mockFetchFor({ remoteIpynb: null });

    const r = await runNotebookCommand(["train", "--push"]);
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain("Push failed");
  });

  test("dirty warning is non-blocking", async () => {
    await writeState("train", makeState());
    await fsWriteFile(join(tmpDir, "train.py"), "# dirty\n");

    // Proxy succeeds, contents 404 → fails AFTER dirty warning, not ON it
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/v1/runtime-proxy-token")) {
        return new Response(
          JSON.stringify({ token: "tok", tokenTtl: "3600s", url: "https://proxy.test" }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const r = await runNotebookCommand(["train"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
    expect(r.error!.message).toContain("Could not fetch notebook");
  });

  test("0 cells when notebook has only markdown", async () => {
    await writeState("train", makeState());

    const mdOnly = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      cells: [{ cell_type: "markdown", source: ["# Just markdown"], metadata: {} }],
    });

    globalThis.fetch = mockFetchFor({ remoteIpynb: mdOnly });

    const r = await runNotebookCommand(["train"]);
    expect(r.ok).toBe(true);
    expect(r.data!.cellsExecuted).toBe(0);
    expect(r.data!.cellsTotal).toBe(1);
  });

  test("--cell with invalid ref returns NOT_FOUND", async () => {
    await writeState("train", makeState());
    globalThis.fetch = mockFetchFor({ remoteIpynb: minimalIpynb() });

    const r = await runNotebookCommand(["train", "--cell", "999"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
    expect(r.error!.message).toContain("999");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Secrets ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("secrets command", () => {
  test("secrets list returns key names only (no payloads)", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      // userdata/list API
      if (url.includes("/userdata/list")) {
        return new Response(
          JSON.stringify([
            { key: "HF_TOKEN", payload: "hf_secret123", access: true },
            { key: "WANDB_KEY", payload: "wandb_secret456", access: false },
          ]),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const r = await secretsCommand(["list"]);
    expect(r.ok).toBe(true);
    expect(r.command).toBe("secrets.list");
    const data = r.data as { keys: string[] };
    expect(data.keys).toEqual(["HF_TOKEN", "WANDB_KEY"]);
    // Verify payloads are NOT in the response
    expect(JSON.stringify(r)).not.toContain("hf_secret123");
    expect(JSON.stringify(r)).not.toContain("wandb_secret456");
  });

  test("secrets list returns empty array when no secrets", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/userdata/list")) {
        return new Response("[]", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const r = await secretsCommand(["list"]);
    expect(r.ok).toBe(true);
    expect((r.data as { keys: string[] }).keys).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Ls ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("ls command", () => {
  test("returns empty when no notebooks exist", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/v1/assignments")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const r = await lsCommand([]);
    expect(r.ok).toBe(true);
    const data = r.data as { notebooks: unknown[]; unmanaged: unknown[] };
    expect(data.notebooks).toEqual([]);
    expect(data.unmanaged).toEqual([]);
  });

  test("merges local state with live assignments", async () => {
    await writeState("train", makeState());
    await writeState("eval", makeState({ endpoint: "gpu-t4-s-other", gpu: "a100" }));

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/v1/assignments")) {
        return new Response(
          JSON.stringify({
            assignments: [
              { endpoint: "gpu-t4-s-test123", accelerator: "T4" },
              { endpoint: "gpu-unmanaged-xyz", accelerator: "L4" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const r = await lsCommand([]);
    expect(r.ok).toBe(true);
    const data = r.data as { notebooks: any[]; unmanaged: any[] };

    // train is running (endpoint matches), eval is stopped
    const train = data.notebooks.find((n: any) => n.name === "train");
    const evalNb = data.notebooks.find((n: any) => n.name === "eval");
    expect(train.status).toBe("running");
    expect(evalNb.status).toBe("stopped");

    // Unmanaged runtime detected
    expect(data.unmanaged).toEqual([
      { endpoint: "gpu-unmanaged-xyz", accelerator: "L4" },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Status ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

describe("status command", () => {
  test("dashboard (no args) returns auth + notebooks", async () => {
    await writeState("train", makeState());

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/v1/user-info")) {
        return new Response(
          JSON.stringify({
            subscriptionTier: "SUBSCRIPTION_TIER_PRO",
            paidComputeUnitsBalance: 85.5,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/assignments")) {
        return new Response(
          JSON.stringify({
            assignments: [{ endpoint: "gpu-t4-s-test123", accelerator: "T4" }],
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const r = await statusCommand([]);
    expect(r.ok).toBe(true);
    const data = r.data as any;
    expect(data.auth.loggedIn).toBe(true);
    expect(data.auth.tier).toBe("SUBSCRIPTION_TIER_PRO");
    expect(data.auth.computeUnits).toBe(85.5);
    expect(data.notebooks).toHaveLength(1);
    expect(data.notebooks[0].status).toBe("running");
  });

  test("notebook status returns NOT_FOUND for unknown notebook", async () => {
    const r = await statusCommand(["nonexistent"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("NOT_FOUND");
  });

  test("notebook status returns dirty state and runtime status", async () => {
    await writeState("train", makeState());
    await fsWriteFile(join(tmpDir, "train.py"), "# unpushed\n");

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/v1/assignments")) {
        return new Response(
          JSON.stringify({
            assignments: [{ endpoint: "gpu-t4-s-test123", accelerator: "T4" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/keep-alive/")) {
        return new Response("", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const r = await statusCommand(["train"]);
    expect(r.ok).toBe(true);
    const data = r.data as any;
    expect(data.name).toBe("train");
    expect(data.status).toBe("running");
    expect(data.dirty).toBe(true);
    expect(data.gpu).toBe("t4");
  });
});
