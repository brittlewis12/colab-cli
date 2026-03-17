/**
 * CLI: colab push <name>
 *
 * Convert local .py to .ipynb, merge with remote, and upload.
 * Remote .ipynb is preferred merge base (implicit rebase); falls
 * back to local cache; falls back to fresh notebook.
 */

import { ok, err, streamErr, ensureFlag, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { ContentsClient } from "../jupyter/contents.ts";
import { percentToCells } from "../notebook/parse.ts";
import { parseIpynb, serializeIpynb } from "../notebook/ipynb.ts";
import { merge } from "../notebook/merge.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  contentsPath,
  localPyPath,
  cachePath,
  hashFile,
  isValidNotebookName,
} from "../state/notebooks.ts";
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { Notebook } from "../notebook/types.ts";
import { syncToDrive } from "../colab/drive.ts";
import { KernelConnection } from "../jupyter/connection.ts";
import { getOrCreateKernel } from "../jupyter/lifecycle.ts";
import { createSecretResolver } from "../colab/secrets.ts";

// ── Push data shape ──────────────────────────────────────────────────────

interface PushData {
  name: string;
  cells: number;
  merged: boolean;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function pushCommand(
  args: string[],
): Promise<CommandResult<PushData>> {
  const name = args[0];
  const noDrive = args.includes("--no-drive");
  const force = args.includes("--force");

  if (!name) {
    return err("push", "USAGE", "Missing notebook name", "Usage: colab push <name>");
  }
  if (!isValidNotebookName(name)) {
    return err("push", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("push", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Load notebook state
  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err(
      "push",
      "NOT_FOUND",
      `No notebook "${name}" found`,
      `Run: colab ensure ${name} --gpu t4  (or --tpu, --cpu-only)`,
    );
  }

  // Read local .py
  const pyPath = localPyPath(projectRoot, name);
  let pyContent: string;
  try {
    pyContent = await readFile(pyPath, "utf-8");
  } catch {
    return err(
      "push",
      "NOT_FOUND",
      `No local file: ${name}.py`,
      `Run: colab pull ${name}  # or create ${name}.py manually`,
    );
  }

  // Parse local .py into cells
  const { cells: localCells, metadata: localMetadata } = percentToCells(pyContent);

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
      "push",
      "NOT_FOUND",
      `Runtime for "${name}" is no longer available: ${e}`,
      `Run: colab ensure ${name} ${ensureFlag(state.variant, state.accelerator, state.highMem)}`,
    );
  }

  const contents = new ContentsClient(proxyUrl, proxyToken);

  // Resolve merge base: remote first, then cache, then nothing
  let mergeBase: Notebook | null = null;
  let remoteJson: string | null = null;

  // Try remote .ipynb (implicit rebase)
  try {
    remoteJson = await contents.readText(contentsPath(name));
    mergeBase = parseIpynb(remoteJson);
  } catch {
    // Remote doesn't exist — try local cache
    try {
      const cacheFile = cachePath(projectRoot, name);
      const cachedJson = await readFile(cacheFile, "utf-8");
      mergeBase = parseIpynb(cachedJson);
    } catch {
      // No cache either — fresh notebook
    }
  }

  // Advisory conflict detection: compare remote against our cached copy
  if (remoteJson && !force) {
    try {
      const cacheFile = cachePath(projectRoot, name);
      const cachedJson = await readFile(cacheFile, "utf-8");
      const { createHash } = await import("crypto");
      const remoteHash = createHash("sha256").update(remoteJson).digest("hex");
      const cachedHash = createHash("sha256").update(cachedJson).digest("hex");
      if (remoteHash !== cachedHash) {
        streamErr(
          `Warning: remote notebook was modified since last push/pull. ` +
          `Merging with remote version. Use --force to skip this check.`,
        );
      }
    } catch {
      // No cache to compare — skip conflict check
    }
  }

  // Build the .ipynb
  let notebook: Notebook;
  let merged = false;

  if (mergeBase) {
    notebook = merge(localCells, localMetadata, mergeBase);
    merged = true;
  } else {
    // Fresh notebook from local cells — no merge base.
    // Assign fresh cell IDs per spec (Section 7: "fresh UUIDs for new cells").
    const freshCells = localCells.map((cell) => ({
      ...cell,
      id: cell.id || crypto.randomUUID().replace(/-/g, "").slice(0, 8),
    }));
    const defaultKernelspec = {
      display_name: "Python 3",
      language: "python",
      name: "python3",
    };
    notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        ...localMetadata,
        kernelspec: localMetadata.kernelspec ?? defaultKernelspec,
      },
      cells: freshCells,
    };
  }

  // Serialize and upload
  const ipynbJson = serializeIpynb(notebook);
  try {
    await contents.writeText(contentsPath(name), ipynbJson);
  } catch (e) {
    return err("push", "ERROR", `Upload failed: ${e}`);
  }

  // Cache the .ipynb locally
  const cache = cachePath(projectRoot, name);
  await mkdir(dirname(cache), { recursive: true });
  await writeFile(cache, ipynbJson, "utf-8");

  // Update pushedHash (marks as clean) — save deferred until after drive sync + keep-alive
  const hash = await hashFile(pyPath);
  state.pushedHash = hash;

  // Drive sync (if enabled and not skipped)
  if (state.driveEnabled && !noDrive) {
    try {
      const kernel = await getOrCreateKernel(proxyUrl, proxyToken, {
        sessionName: name,
        timeout: 30_000,
      });
      const conn = new KernelConnection(proxyUrl, kernel.kernelId, proxyToken, {
        colabClient: client,
        accessToken: token,
        endpoint: state.endpoint,
        secretResolver: createSecretResolver(client, token),
      });
      try {
        await conn.connect();
        const driveResult = await syncToDrive(
          conn, client, token, state.endpoint,
          `/content/${name}.ipynb`, state,
        );
        if (driveResult.success) {
          if (driveResult.fileId) state.driveFileId = driveResult.fileId;
          if (driveResult.folderId) state.driveFolderId = driveResult.folderId;
          await saveNotebookState(projectRoot, name, state);
          streamErr(`Synced to Drive.`);
        } else {
          streamErr(`Warning: Drive sync failed: ${driveResult.error}`);
        }
      } finally {
        conn.close();
      }
    } catch (e) {
      streamErr(`Warning: Drive sync skipped: ${e}`);
    }
  }

  // Keep-alive side effect + single state save with all updates
  try {
    await client.keepAlive(token, state.endpoint);
    state.lastKeepAlive = new Date().toISOString();
  } catch { /* non-fatal */ }
  await saveNotebookState(projectRoot, name, state);

  streamErr(`Pushed ${name}.py → ${contentsPath(name)} (${notebook.cells.length} cells${merged ? ", merged" : ""})`);

  return ok("push", {
    name,
    cells: notebook.cells.length,
    merged,
  });
}
