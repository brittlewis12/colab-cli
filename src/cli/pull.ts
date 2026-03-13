/**
 * CLI: colab pull <name>
 *
 * Download the remote .ipynb and convert to a local .py file.
 * Caches the .ipynb locally for merge on push.
 */

import { ok, err, streamErr, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { ContentsClient } from "../jupyter/contents.ts";
import { parseIpynb } from "../notebook/ipynb.ts";
import { ipynbToPercent } from "../notebook/serialize.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  contentsPath,
  localPyPath,
  cachePath,
  hashFile,
  isDirty,
} from "../state/notebooks.ts";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

// ── Pull data shape ──────────────────────────────────────────────────────

interface PullData {
  name: string;
  pyPath: string;
  cells: number;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function pullCommand(
  args: string[],
): Promise<CommandResult<PullData>> {
  const name = args[0];
  const force = args.includes("--force");

  if (!name) {
    return err("pull", "USAGE", "Missing notebook name", "Usage: colab pull <name>");
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("pull", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Load notebook state
  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err(
      "pull",
      "NOT_FOUND",
      `No notebook "${name}" found`,
      `Run: colab ensure ${name} --gpu t4`,
    );
  }

  // Dirty check (unless --force)
  if (!force && (await isDirty(projectRoot, name))) {
    return err(
      "pull",
      "DIRTY",
      `Local ${name}.py has unpushed changes`,
      `Run: colab push ${name}  # push first, or: colab pull ${name} --force`,
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
      "pull",
      "NOT_FOUND",
      `Runtime for "${name}" is no longer available: ${e}`,
      `Run: colab ensure ${name} --gpu ${state.gpu}`,
    );
  }

  // Fetch .ipynb
  let ipynbJson: string;
  try {
    const contents = new ContentsClient(proxyUrl, proxyToken);
    ipynbJson = await contents.readText(contentsPath(name));
  } catch (e) {
    return err(
      "pull",
      "NOT_FOUND",
      `Could not fetch notebook from runtime: ${e}`,
      `Run: colab ensure ${name} --gpu ${state.gpu}`,
    );
  }

  // Parse and convert to percent format
  const notebook = parseIpynb(ipynbJson);
  const pyContent = ipynbToPercent(notebook);

  // Write .py file
  const pyPath = localPyPath(projectRoot, name);
  await writeFile(pyPath, pyContent, "utf-8");

  // Cache .ipynb
  const cache = cachePath(projectRoot, name);
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, ipynbJson, "utf-8");

  // Update pushedHash (marks as clean)
  const hash = await hashFile(pyPath);
  state.pushedHash = hash;
  await saveNotebookState(projectRoot, name, state);

  // Keep-alive side effect
  try {
    await client.keepAlive(token, state.endpoint);
    state.lastKeepAlive = new Date().toISOString();
    await saveNotebookState(projectRoot, name, state);
  } catch { /* non-fatal */ }

  streamErr(`Pulled ${name} → ${name}.py (${notebook.cells.length} cells)`);

  return ok("pull", {
    name,
    pyPath,
    cells: notebook.cells.length,
  });
}
