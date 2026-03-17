/**
 * CLI: colab upload <name> <local> <remote>
 *
 * Upload a local file to the notebook's runtime via Contents API.
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
import { readFile } from "fs/promises";

// ── Data shape ───────────────────────────────────────────────────────────

interface UploadData {
  name: string;
  local: string;
  remote: string;
  bytes: number;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function uploadCommand(
  args: string[],
): Promise<CommandResult<UploadData>> {
  const name = args[0];
  const local = args[1];
  const remote = args[2];

  if (!name) {
    return err("upload", "USAGE", "Missing notebook name", "Usage: colab upload <name> <local> <remote>");
  }
  if (!isValidNotebookName(name)) {
    return err("upload", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }
  if (!local) {
    return err("upload", "USAGE", "Missing local path", "Usage: colab upload <name> <local> <remote>");
  }
  if (!remote) {
    return err("upload", "USAGE", "Missing remote path", "Usage: colab upload <name> <local> <remote>");
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("upload", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Load notebook state
  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err(
      "upload",
      "NOT_FOUND",
      `No notebook "${name}" found`,
      `Run: colab ensure ${name} --gpu t4  (or --tpu, --cpu-only)`,
    );
  }

  // Validate remote path (no traversal) — before any API calls
  if (!isValidRemotePath(remote)) {
    return err("upload", "USAGE", `Invalid remote path: ${remote}`, "Remote paths must be relative to /content/ with no '..' segments");
  }

  // Read local file
  let content: Buffer;
  try {
    content = await readFile(local);
  } catch {
    return err("upload", "NOT_FOUND", `Local file not found: ${local}`);
  }

  const bytes = content.length;

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
      "upload",
      "NOT_FOUND",
      `Runtime for "${name}" is no longer available: ${e}`,
      `Run: colab ensure ${name} ${ensureFlag(state.variant, state.accelerator, state.highMem)}`,
    );
  }

  // Upload via Contents API (prepend content/ for the kernel's working dir)
  const contentsPath = `content/${remote}`;
  const contents = new ContentsClient(proxyUrl, proxyToken);
  try {
    await contents.writeFile(contentsPath, content);
  } catch (e) {
    return err("upload", "ERROR", `Upload failed: ${e}`);
  }

  // Keep-alive side effect
  try {
    await client.keepAlive(token, state.endpoint);
    state.lastKeepAlive = new Date().toISOString();
    await saveNotebookState(projectRoot, name, state);
  } catch { /* non-fatal */ }

  streamErr(`Uploaded ${local} → /content/${remote} (${bytes} bytes)`);

  return ok("upload", { name, local, remote, bytes });
}
