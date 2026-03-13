/**
 * CLI: colab exec <name> "<code>"
 *
 * Execute ad-hoc Python on a notebook's runtime. Core execution
 * primitive — connect, execute, disconnect. Kernel state persists
 * across calls.
 */

import { ok, err, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { KernelConnection, type ExecutionResult } from "../jupyter/connection.ts";
import { getOrCreateKernel } from "../jupyter/lifecycle.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
} from "../state/notebooks.ts";

// ── Exec data shape ──────────────────────────────────────────────────────

interface ExecData {
  name: string;
  result: ExecutionResult;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function execCommand(
  args: string[],
): Promise<CommandResult<ExecData>> {
  const name = args[0];
  const code = args[1];

  if (!name) {
    return err("exec", "USAGE", "Missing notebook name", 'Usage: colab exec <name> "<code>"');
  }
  if (!code) {
    return err("exec", "USAGE", "Missing code argument", 'Usage: colab exec <name> "print(42)"');
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("exec", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Load notebook state
  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err(
      "exec",
      "NOT_FOUND",
      `No notebook "${name}" found`,
      `Run: colab ensure ${name} --gpu t4`,
    );
  }

  // Refresh proxy token
  const client = new ColabClient();
  let proxyUrl: string;
  let proxyToken: string;
  try {
    const pt = await client.refreshProxyToken(token, state.endpoint);
    proxyUrl = pt.url;
    proxyToken = pt.token;
  } catch (e) {
    return err(
      "exec",
      "NOT_FOUND",
      `Runtime for "${name}" is no longer available: ${e}`,
      `Run: colab ensure ${name} --gpu ${state.gpu}`,
    );
  }

  // Get or create kernel
  let kernelId: string;
  try {
    const kernel = await getOrCreateKernel(proxyUrl, proxyToken, {
      sessionName: name,
    });
    kernelId = kernel.kernelId;
  } catch (e) {
    return err("exec", "ERROR", `Could not connect to kernel: ${e}`);
  }

  // Connect and execute
  const conn = new KernelConnection(proxyUrl, kernelId, proxyToken, {
    colabClient: client,
    accessToken: token,
    endpoint: state.endpoint,
  });

  let result: ExecutionResult;
  try {
    await conn.connect();
    result = await conn.execute(code);
  } catch (e) {
    return err("exec", "ERROR", `Execution failed: ${e}`);
  } finally {
    conn.close();
  }

  // Keep-alive side effect
  try {
    await client.keepAlive(token, state.endpoint);
    state.lastKeepAlive = new Date().toISOString();
    await saveNotebookState(projectRoot, name, state);
  } catch { /* non-fatal */ }

  // Return result
  if (result.status === "error") {
    return err(
      "exec",
      "EXEC_ERROR",
      `${result.error?.ename}: ${result.error?.evalue}`,
      undefined,
      { name, result },
    );
  }

  return ok("exec", { name, result });
}
