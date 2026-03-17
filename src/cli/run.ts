/**
 * CLI: colab run <name>
 *
 * Execute cells of the notebook on its runtime. Reads cells from
 * the remote .ipynb, sends each as an execute_request sequentially.
 * Writes outputs back to the remote .ipynb after each cell.
 */

import { ok, err, streamErr, ensureFlag, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { ContentsClient } from "../jupyter/contents.ts";
import { KernelConnection, type ExecutionResult } from "../jupyter/connection.ts";
import { getOrCreateKernel } from "../jupyter/lifecycle.ts";
import { createSecretResolver } from "../colab/secrets.ts";
import { syncToDrive } from "../colab/drive.ts";
import { parseIpynb, serializeIpynb } from "../notebook/ipynb.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  contentsPath,
  cachePath,
  isDirty,
  isValidNotebookName,
} from "../state/notebooks.ts";
import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { CodeCell, Cell } from "../notebook/types.ts";

// ── Run data shape ───────────────────────────────────────────────────────

interface CellResult {
  index: number;
  result: ExecutionResult;
}

interface RunData {
  name: string;
  cellsExecuted: number;
  cellsTotal: number;
  results: CellResult[];
}

// ── Cell filtering ───────────────────────────────────────────────────────

/**
 * Resolve --cell ref to cell indices.
 * Resolution order: integer parse → title/name match → cell ID match.
 */
function resolveCellRef(cells: Cell[], ref: string): number[] {
  // Try integer parse first
  const idx = parseInt(ref, 10);
  if (!isNaN(idx) && String(idx) === ref) {
    if (idx < 0 || idx >= cells.length) return [];
    return [idx];
  }

  // Try title/name match
  const byTitle: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    if (cell.metadata?.title === ref || cell.metadata?.name === ref) {
      byTitle.push(i);
    }
  }
  if (byTitle.length > 0) return byTitle;

  // Try cell ID match
  for (let i = 0; i < cells.length; i++) {
    if (cells[i]!.id === ref) return [i];
  }

  return [];
}

// ── Output mapping ───────────────────────────────────────────────────────

/**
 * Map ExecutionResult back into CellOutput[] for .ipynb persistence.
 * ExecutionResult has stdout/stderr as strings and outputs[] with
 * display_data/execute_result. We convert these to the CellOutput format.
 */
function resultToCellOutputs(
  result: ExecutionResult,
): CodeCell["outputs"] {
  const outputs: CodeCell["outputs"] = [];

  // stdout
  if (result.stdout) {
    outputs.push({
      output_type: "stream",
      name: "stdout",
      text: result.stdout,
    });
  }

  // stderr
  if (result.stderr) {
    outputs.push({
      output_type: "stream",
      name: "stderr",
      text: result.stderr,
    });
  }

  // Rich outputs (display_data, execute_result)
  for (const out of result.outputs) {
    outputs.push({
      output_type: out.type,
      data: out.data,
      metadata: {},
      ...(out.type === "execute_result"
        ? { execution_count: result.executionCount }
        : {}),
    });
  }

  // Error output
  if (result.error) {
    outputs.push({
      output_type: "error",
      ename: result.error.ename,
      evalue: result.error.evalue,
      traceback: result.error.traceback,
    });
  }

  return outputs;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function runNotebookCommand(
  args: string[],
): Promise<CommandResult<RunData>> {
  const name = args[0];
  const pushFirst = args.includes("--push");
  const continueOnError = args.includes("--continue-on-error");
  const noDrive = args.includes("--no-drive");
  const cellIdx = args.indexOf("--cell");
  const cellRef = cellIdx >= 0 ? args[cellIdx + 1] : undefined;
  const timeoutIdx = args.indexOf("--timeout");
  const timeoutSec = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1]!, 10) : 300;

  if (!name) {
    return err("run", "USAGE", "Missing notebook name", "Usage: colab run <name>");
  }
  if (cellIdx >= 0 && (!cellRef || cellRef.startsWith("-"))) {
    return err("run", "USAGE", "--cell requires a cell reference (index, title, or ID)", "Usage: colab run <name> --cell 0");
  }
  if (!isValidNotebookName(name)) {
    return err("run", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }
  if (timeoutIdx >= 0 && (isNaN(timeoutSec) || timeoutSec <= 0)) {
    return err("run", "USAGE", "Invalid --timeout value", "Usage: colab run <name> --timeout 300");
  }

  // Warn on unrecognized flags
  const knownFlags = new Set(["--push", "--continue-on-error", "--no-drive", "--cell", "--timeout", "--force"]);
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-") && !knownFlags.has(arg)) {
      streamErr(`Warning: unrecognized flag "${arg}" — ignored.`);
    }
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("run", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Load notebook state
  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err(
      "run",
      "NOT_FOUND",
      `No notebook "${name}" found`,
      `Run: colab ensure ${name} --gpu t4  (or --tpu, --cpu-only)`,
    );
  }

  // Push first if requested
  if (pushFirst) {
    const { pushCommand } = await import("./push.ts");
    const pushArgs = [name];
    if (noDrive) pushArgs.push("--no-drive");
    if (args.includes("--force")) pushArgs.push("--force");
    const pushResult = await pushCommand(pushArgs);
    if (!pushResult.ok) {
      return err(
        "run",
        pushResult.error!.code,
        `Push failed: ${pushResult.error!.message}`,
      );
    }
  } else {
    // Dirty check warning (non-blocking)
    if (await isDirty(projectRoot, name)) {
      streamErr(`Warning: local ${name}.py has unpushed changes. Running remote version.`);
    }
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
      "run",
      "NOT_FOUND",
      `Runtime for "${name}" is no longer available: ${e}`,
      `Run: colab ensure ${name} ${ensureFlag(state.variant, state.accelerator, state.highMem)}`,
    );
  }

  // Fetch remote .ipynb
  const contents = new ContentsClient(proxyUrl, proxyToken);
  let notebook;
  try {
    const ipynbJson = await contents.readText(contentsPath(name));
    notebook = parseIpynb(ipynbJson);
  } catch (e) {
    return err(
      "run",
      "NOT_FOUND",
      `Could not fetch notebook from runtime: ${e}`,
      `Run: colab push ${name}`,
    );
  }

  // Determine which cells to run
  let cellIndices: number[];
  if (cellRef !== undefined) {
    cellIndices = resolveCellRef(notebook.cells, cellRef);
    if (cellIndices.length === 0) {
      return err("run", "NOT_FOUND", `No cell matching "${cellRef}"`);
    }
    // Filter to code cells only
    const unfilteredCount = cellIndices.length;
    cellIndices = cellIndices.filter(
      (i) => notebook.cells[i]!.cell_type === "code",
    );
    if (cellIndices.length === 0 && unfilteredCount > 0) {
      return err("run", "USAGE", `Cell "${cellRef}" matched ${unfilteredCount} non-code cell(s) — only code cells can be executed`);
    }
  } else {
    // All code cells
    cellIndices = notebook.cells
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.cell_type === "code")
      .map(({ i }) => i);
  }

  if (cellIndices.length === 0) {
    return ok("run", {
      name,
      cellsExecuted: 0,
      cellsTotal: notebook.cells.length,
      results: [],
    });
  }

  // Get or create kernel
  let kernelId: string;
  try {
    const kernel = await getOrCreateKernel(proxyUrl, proxyToken, {
      sessionName: name,
    });
    kernelId = kernel.kernelId;
  } catch (e) {
    return err("run", "ERROR", `Could not connect to kernel: ${e}`);
  }

  // Connect WebSocket
  const conn = new KernelConnection(proxyUrl, kernelId, proxyToken, {
    colabClient: client,
    accessToken: token,
    endpoint: state.endpoint,
    secretResolver: createSecretResolver(client, token),
  });

  const results: CellResult[] = [];
  let hadError = false;
  let connectionError: unknown = null;

  try {
    await conn.connect();

    for (const idx of cellIndices) {
      const cell = notebook.cells[idx]! as CodeCell;

      streamErr(`Running cell ${idx}...`);
      const result = await conn.execute(cell.source, timeoutSec * 1000);
      results.push({ index: idx, result });

      // Update cell outputs and execution_count
      cell.outputs = resultToCellOutputs(result);
      cell.execution_count = result.executionCount ?? null;

      // Persist after each cell (atomic write-back)
      try {
        const updatedJson = serializeIpynb(notebook);
        await contents.writeText(contentsPath(name), updatedJson);
      } catch (e) {
        streamErr(`Warning: could not write outputs for cell ${idx}: ${e}`);
      }

      // Stop on first error (unless --continue-on-error)
      if (result.status === "error") {
        hadError = true;
        streamErr(`Cell ${idx} failed: ${result.error?.ename}: ${result.error?.evalue}`);
        if (!continueOnError) break;
      }
    }

  } catch (e) {
    // WebSocket or connection error — capture but don't lose partial results
    connectionError = e;
  } finally {
    conn.close();
  }

  // Drive sync — outside main try so partial results still get synced on timeout/drop.
  // Uses a fresh connection since the original may be dead.
  if (state.driveEnabled && !noDrive && results.length > 0) {
    try {
      const pt2 = await client.refreshProxyToken(token, state.endpoint);
      const kernel2 = await getOrCreateKernel(pt2.url, pt2.token, { sessionName: name, timeout: 30_000 });
      const driveConn = new KernelConnection(pt2.url, kernel2.kernelId, pt2.token, {
        colabClient: client,
        accessToken: token,
        endpoint: state.endpoint,
        secretResolver: createSecretResolver(client, token),
      });
      try {
        await driveConn.connect();
        const driveResult = await syncToDrive(
          driveConn, client, token, state.endpoint,
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
        driveConn.close();
      }
    } catch (e) {
      streamErr(`Warning: Drive sync skipped: ${e}`);
    }
  }

  // Update local .ipynb cache with execution outputs
  if (results.length > 0) {
    try {
      const cache = cachePath(projectRoot, name);
      await mkdir(dirname(cache), { recursive: true });
      await writeFile(cache, serializeIpynb(notebook), "utf-8");
    } catch { /* non-fatal — cache is a convenience, not critical */ }
  }

  // Keep-alive side effect
  try {
    await client.keepAlive(token, state.endpoint);
    state.lastKeepAlive = new Date().toISOString();
    await saveNotebookState(projectRoot, name, state);
  } catch { /* non-fatal */ }

  const data: RunData = {
    name,
    cellsExecuted: results.length,
    cellsTotal: notebook.cells.length,
    results,
  };

  // Connection-level failure (timeout, WebSocket drop, protocol error)
  // Return partial results in data so agents can inspect what ran before the failure
  if (connectionError) {
    const msg = String(connectionError);
    const isTimeout = msg.includes("timed out");

    // Client wait budget exceeded or connection dropped.
    // Do NOT interrupt the kernel — remote execution may still be doing useful work.
    const code = isTimeout ? "TIMEOUT" as const : "ERROR" as const;
    const hint = isTimeout
      ? `Remote execution may still be running. Use: colab status ${name}  # check kernelState, then: colab interrupt ${name}  # to cancel`
      : undefined;
    return err("run", code, `Client wait timeout exceeded or connection lost: ${msg}`, hint, data);
  }

  if (hadError) {
    const lastFailed = results.findLast((r) => r.result.status === "error");
    if (lastFailed) {
      return err(
        "run",
        "EXEC_ERROR",
        `Cell ${lastFailed.index} failed: ${lastFailed.result.error?.ename}: ${lastFailed.result.error?.evalue}`,
        undefined,
        data,
      );
    }
  }

  streamErr(`Ran ${results.length} cells successfully.`);
  return ok("run", data);
}
