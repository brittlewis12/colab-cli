/**
 * CLI: colab download <name> <remote> <local>
 *
 * Download a file from the notebook's runtime via Contents API.
 * Remote paths are user-facing as relative to /content/ (the runtime's
 * working directory). The CLI transparently prepends content/ when
 * calling the Contents API.
 */

import { ok, err, streamErr, ensureFlag, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { ContentsClient } from "../jupyter/contents.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  isValidRemotePath,
  isValidNotebookName,
} from "../state/notebooks.ts";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

// ── Data shape ───────────────────────────────────────────────────────────

interface DownloadData {
  name: string;
  remote: string;
  local: string;
  bytes: number;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function downloadCommand(
  args: string[],
): Promise<CommandResult<DownloadData>> {
  const name = args[0];
  const remote = args[1];
  const local = args[2];

  if (!name) {
    return err("download", "USAGE", "Missing notebook name", "Usage: colab download <name> <remote> <local>");
  }
  if (!isValidNotebookName(name)) {
    return err("download", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }
  if (!remote) {
    return err("download", "USAGE", "Missing remote path", "Usage: colab download <name> <remote> <local>");
  }
  if (!local) {
    return err("download", "USAGE", "Missing local path", "Usage: colab download <name> <remote> <local>");
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("download", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Load notebook state
  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err(
      "download",
      "NOT_FOUND",
      `No notebook "${name}" found`,
      `Run: colab ensure ${name} --gpu t4  (or --tpu, --cpu-only)`,
    );
  }

  // Validate remote path (no traversal) — before any API calls
  if (!isValidRemotePath(remote)) {
    return err("download", "USAGE", `Invalid remote path: ${remote}`, "Remote paths must be relative to /content/ with no '..' segments");
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
      "download",
      "NOT_FOUND",
      `Runtime for "${name}" is no longer available: ${e}`,
      `Run: colab ensure ${name} ${ensureFlag(state.variant, state.accelerator, state.highMem)}`,
    );
  }

  // Download via Contents API (prepend content/ for the kernel's working dir)
  const contentsPath = `content/${remote}`;
  const contents = new ContentsClient(proxyUrl, proxyToken);
  let content: Buffer;
  try {
    content = await contents.readFile(contentsPath);
  } catch (e) {
    const msg = String(e);
    const code = msg.includes("404") ? "NOT_FOUND" as const : "ERROR" as const;
    return err(
      "download",
      code,
      code === "NOT_FOUND" ? `Remote file not found: /content/${remote}` : `Download failed: ${msg}`,
    );
  }

  // Write to local path
  const bytes = content.length;
  try {
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, content);
  } catch (e) {
    return err("download", "ERROR", `Could not write local file: ${e}`);
  }

  // Keep-alive side effect
  try {
    await client.keepAlive(token, state.endpoint);
    state.lastKeepAlive = new Date().toISOString();
    await saveNotebookState(projectRoot, name, state);
  } catch { /* non-fatal */ }

  streamErr(`Downloaded /content/${remote} → ${local} (${bytes} bytes)`);

  return ok("download", { name, remote, local, bytes });
}
