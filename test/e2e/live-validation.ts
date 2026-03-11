#!/usr/bin/env bun
/**
 * Live E2E validation script for Colab API.
 *
 * Tests the full pipeline: auth → allocate → GAPI queries →
 * session → execute → Contents API → out-of-band exec → cleanup.
 *
 * Requires a valid access token at /tmp/colab-vscode-access-token.txt
 * (obtained via VS Code extension client ID OAuth flow).
 *
 * ALWAYS unassigns the runtime in a finally block.
 */

import { ColabClient } from "../../src/colab/client.ts";
import { SessionsClient } from "../../src/jupyter/sessions.ts";
import { ContentsClient } from "../../src/jupyter/contents.ts";
import { KernelConnection } from "../../src/jupyter/connection.ts";
import { notebookHash } from "../../src/colab/types.ts";
import { readFileSync } from "fs";

// ── Helpers ──────────────────────────────────────────────────────────────

function log(section: string, msg: string) {
  console.log(`[${section}] ${msg}`);
}

function fail(section: string, msg: string): never {
  console.error(`[${section}] FAIL: ${msg}`);
  process.exit(1);
}

function assert(section: string, condition: boolean, msg: string) {
  if (!condition) fail(section, msg);
  log(section, `✓ ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Load token ───────────────────────────────────────────────────────────

const TOKEN_PATH = "/tmp/colab-vscode-access-token.txt";
let token: string;
try {
  token = readFileSync(TOKEN_PATH, "utf-8").trim();
} catch {
  fail("auth", `No token at ${TOKEN_PATH}. Run OAuth flow first.`);
}

// ── Clients ──────────────────────────────────────────────────────────────

const client = new ColabClient();
const nbh = notebookHash();
let endpoint: string | undefined;
let proxyUrl: string | undefined;
let proxyToken: string | undefined;

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. GAPI: getUserInfo ─────────────────────────────────────────────
  log("gapi", "getUserInfo...");
  const userInfo = await client.getUserInfo(token);
  assert("gapi", typeof userInfo.subscriptionTier === "string", `tier=${userInfo.subscriptionTier}`);
  assert("gapi", typeof userInfo.paidComputeUnitsBalance === "number", `units=${userInfo.paidComputeUnitsBalance}`);
  log("gapi", `Eligible GPUs: ${userInfo.eligibleAccelerators?.find(a => a.variant === "VARIANT_GPU")?.models.join(", ")}`);

  // ── 2. GAPI: listAssignments (before allocating) ─────────────────────
  log("gapi", "listAssignments (pre-allocate)...");
  const preAssignments = await client.listAssignments(token);
  log("gapi", `${preAssignments.length} existing assignment(s)`);

  // If there are existing assignments, note them so we don't accidentally
  // unassign something we didn't create
  const preEndpoints = new Set(preAssignments.map((a) => a.endpoint));

  // ── 3. Tunnel: allocate T4 runtime ───────────────────────────────────
  log("assign", `Allocating T4 runtime (nbh=${nbh.slice(0, 20)}...)...`);
  const assignment = await client.assign(token, {
    notebookHash: nbh,
    variant: "GPU" as any,
    accelerator: "T4",
  });

  endpoint = assignment.endpoint;
  proxyUrl = assignment.runtimeProxyInfo.url;
  proxyToken = assignment.runtimeProxyInfo.token;

  assert("assign", !!endpoint, `endpoint=${endpoint}`);
  assert("assign", !!proxyUrl, `proxyUrl=${proxyUrl}`);
  assert("assign", !!proxyToken, `proxyToken=${proxyToken!.slice(0, 20)}...`);

  // ── 4. GAPI: listAssignments (after allocating) ──────────────────────
  log("gapi", "listAssignments (post-allocate)...");
  const postAssignments = await client.listAssignments(token);
  const ours = postAssignments.find((a) => a.endpoint === endpoint);
  assert("gapi", !!ours, `listAssignments sees our runtime`);
  assert("gapi", ours!.accelerator === "T4", `accelerator=T4`);

  // ── 5. GAPI: refreshProxyToken ───────────────────────────────────────
  log("gapi", "refreshProxyToken...");
  const refreshed = await client.refreshProxyToken(token, endpoint!);
  assert("gapi", !!refreshed.token, `refreshed token=${refreshed.token.slice(0, 20)}...`);
  assert("gapi", !!refreshed.url, `refreshed url=${refreshed.url}`);
  // Use the refreshed token from here on
  proxyToken = refreshed.token;
  proxyUrl = refreshed.url;

  // ── 6. Session: create with retry ────────────────────────────────────
  log("session", "Creating session (with retry for runtime startup)...");
  const sessions = new SessionsClient(proxyUrl!, proxyToken!);
  let session;
  const deadline = Date.now() + 180_000; // 3 min
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      session = await sessions.createSession({
        path: "colab-e2e-test",
        name: "colab-e2e-test",
      });
      break;
    } catch (e) {
      const remaining = Math.round((deadline - Date.now()) / 1000);
      log("session", `Attempt ${attempt} failed, ${remaining}s left...`);
      await sleep(3000);
    }
  }
  if (!session) fail("session", "Timed out creating session");

  const kernelId = session.kernel.id;
  assert("session", !!kernelId, `kernelId=${kernelId}`);

  // ── 7. Session: list sessions ────────────────────────────────────────
  log("session", "Listing sessions...");
  const sessionList = await sessions.listSessions();
  assert("session", sessionList.length > 0, `${sessionList.length} session(s)`);
  assert("session", sessionList.some((s) => s.kernel.id === kernelId), "our session in list");

  // ── 8. Execute: print("hello") ───────────────────────────────────────
  log("exec", "Connecting WebSocket...");
  const conn = new KernelConnection(proxyUrl!, kernelId, proxyToken!, {
    colabClient: client,
    accessToken: token,
    endpoint: endpoint!,
  });
  await conn.connect();

  log("exec", 'Executing: print("hello world")');
  const result1 = await conn.execute('print("hello world")');
  assert("exec", result1.stdout.includes("hello world"), `stdout="${result1.stdout.trim()}"`);
  assert("exec", result1.status === "ok", `status=${result1.status}`);

  // ── 9. Execute: multi-line, variables persist ────────────────────────
  log("exec", "Executing: x = 42");
  await conn.execute("x = 42");

  log("exec", "Executing: print(x * 2)");
  const result2 = await conn.execute("print(x * 2)");
  assert("exec", result2.stdout.includes("84"), `stdout="${result2.stdout.trim()}"`);

  // ── 10. Execute: GPU check ───────────────────────────────────────────
  log("exec", "Executing: GPU check...");
  const gpuResult = await conn.execute(
    'import torch; print(f"cuda={torch.cuda.is_available()}, device={torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}")',
  );
  log("exec", `GPU: ${gpuResult.stdout.trim()}`);
  assert("exec", gpuResult.stdout.includes("cuda=True"), "CUDA available");

  // ── 11. Execute: error handling ──────────────────────────────────────
  log("exec", "Executing: 1/0 (expect error)...");
  const errResult = await conn.execute("1/0");
  assert("exec", errResult.status === "error", `status=${errResult.status}`);
  assert("exec", errResult.error?.ename === "ZeroDivisionError", `ename=${errResult.error?.ename}`);

  conn.close();

  // ── 12. Out-of-band: new connection to same kernel ───────────────────
  log("oob", "Opening second connection to same kernel...");
  const conn2 = new KernelConnection(proxyUrl!, kernelId, proxyToken!, {
    colabClient: client,
    accessToken: token,
    endpoint: endpoint!,
  });
  await conn2.connect();

  log("oob", "Executing: print(x) — variable from first connection");
  const oobResult = await conn2.execute("print(x)");
  assert("oob", oobResult.stdout.includes("42"), `x persists across connections: stdout="${oobResult.stdout.trim()}"`);

  conn2.close();

  // ── 13. Contents API: list /content ──────────────────────────────────
  log("contents", "Listing /content directory...");
  const contents = new ContentsClient(proxyUrl!, proxyToken!);
  const dirList = await contents.listDir("");
  assert("contents", Array.isArray(dirList), `got directory listing`);
  log("contents", `${dirList.length} entries: ${dirList.map((e) => e.name).join(", ")}`);

  // ── 14. Contents API: write file ─────────────────────────────────────
  log("contents", "Writing test file...");
  await contents.writeText("test-upload.txt", "hello from colab-cli\n");

  // ── 15. Contents API: read file back ─────────────────────────────────
  log("contents", "Reading test file back...");
  const readBack = await contents.readText("test-upload.txt");
  assert("contents", readBack === "hello from colab-cli\n", `round-trip match`);

  // ── 16. Contents API: stat file ──────────────────────────────────────
  log("contents", "Stat test file...");
  const stat = await contents.stat("test-upload.txt");
  assert("contents", stat.name === "test-upload.txt", `name=${stat.name}`);
  assert("contents", stat.type === "file", `type=${stat.type}`);
  assert("contents", !!stat.last_modified, `last_modified=${stat.last_modified}`);

  // ── 17. Contents API: write .ipynb, read back ────────────────────────
  log("contents", "Writing test notebook...");
  const testNotebook = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
    cells: [
      { cell_type: "code", source: "print('from notebook')", metadata: {}, outputs: [], execution_count: null },
    ],
  });
  await contents.writeText("test-notebook.ipynb", testNotebook);

  const nbBack = await contents.readText("test-notebook.ipynb");
  const parsed = JSON.parse(nbBack);
  assert("contents", parsed.nbformat === 4, `nbformat=${parsed.nbformat}`);
  assert("contents", parsed.cells.length === 1, `cells=${parsed.cells.length}`);

  // ── 18. Contents API: delete file ────────────────────────────────────
  log("contents", "Deleting test files...");
  await contents.delete("test-upload.txt");
  await contents.delete("test-notebook.ipynb");

  // Verify deletion
  const dirAfter = await contents.listDir("");
  const testFileStillExists = dirAfter.some((e) => e.name === "test-upload.txt");
  assert("contents", !testFileStillExists, "test file deleted");

  // ── 19. Keep-alive ───────────────────────────────────────────────────
  log("keepalive", "Sending keep-alive...");
  await client.keepAlive(token, endpoint!);
  assert("keepalive", true, "keep-alive succeeded");

  // ── Done ─────────────────────────────────────────────────────────────
  console.log("\n========================================");
  console.log("ALL TESTS PASSED");
  console.log("========================================\n");
}

// ── Run with cleanup ─────────────────────────────────────────────────────

main()
  .catch((err) => {
    console.error("\n[FATAL]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (endpoint) {
      log("cleanup", `Unassigning ${endpoint}...`);
      try {
        await client.unassign(token, endpoint);
        log("cleanup", "Runtime released.");
      } catch (e) {
        console.error("[cleanup] Failed to unassign:", e);
      }
    }
  });
