/**
 * CLI: colab restart <name>
 *
 * Restart the kernel without killing the runtime. Clears all Python
 * state (variables, imports) but preserves the runtime (GPU, installed
 * packages via pip).
 */

import { ok, err, streamErr, ensureFlag, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { SessionsClient } from "../jupyter/sessions.ts";
import { getOrCreateKernel } from "../jupyter/lifecycle.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  isValidNotebookName,
} from "../state/notebooks.ts";

// ── Data shape ───────────────────────────────────────────────────────────

interface RestartData {
  name: string;
  kernelId: string;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function restartCommand(
  args: string[],
): Promise<CommandResult<RestartData>> {
  const name = args[0];

  if (!name) {
    return err("restart", "USAGE", "Missing notebook name", "Usage: colab restart <name>");
  }
  if (!isValidNotebookName(name)) {
    return err("restart", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("restart", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Load notebook state
  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err(
      "restart",
      "NOT_FOUND",
      `No notebook "${name}" found`,
      `Run: colab ensure ${name} --gpu t4  (or --tpu, --cpu-only)`,
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
      "restart",
      "NOT_FOUND",
      `Runtime for "${name}" is no longer available: ${e}`,
      `Run: colab ensure ${name} ${ensureFlag(state.variant, state.accelerator, state.highMem)}`,
    );
  }

  // Get kernel ID
  let kernelId: string;
  try {
    const kernel = await getOrCreateKernel(proxyUrl, proxyToken, {
      sessionName: name,
      timeout: 30_000,
    });
    kernelId = kernel.kernelId;
  } catch (e) {
    return err("restart", "ERROR", `Could not connect to kernel: ${e}`);
  }

  // Restart
  const sessions = new SessionsClient(proxyUrl, proxyToken);
  try {
    await sessions.restartKernel(kernelId);
  } catch (e) {
    return err("restart", "ERROR", `Kernel restart failed: ${e}`);
  }

  // Keep-alive side effect
  try {
    await client.keepAlive(token, state.endpoint);
    state.lastKeepAlive = new Date().toISOString();
    await saveNotebookState(projectRoot, name, state);
  } catch { /* non-fatal */ }

  streamErr(`Kernel for "${name}" restarted. Python state cleared, runtime preserved.`);

  return ok("restart", { name, kernelId });
}
