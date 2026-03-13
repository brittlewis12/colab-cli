/**
 * CLI: colab run <name>
 *
 * Execute cells of the notebook on its runtime. Reads cells from
 * the remote .ipynb, sends each as an execute_request sequentially.
 * Writes outputs back to the remote .ipynb after each cell.
 */

import { ok, err, streamErr, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { ContentsClient } from "../jupyter/contents.ts";
import { KernelConnection, type ExecutionResult } from "../jupyter/connection.ts";
import { getOrCreateKernel } from "../jupyter/lifecycle.ts";
import { parseIpynb, serializeIpynb } from "../notebook/ipynb.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  contentsPath,
  isDirty,
} from "../state/notebooks.ts";
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
  const cellIdx = args.indexOf("--cell");
  const cellRef = cellIdx >= 0 ? args[cellIdx + 1] : undefined;

  if (!name) {
    return err("run", "USAGE", "Missing notebook name", "Usage: colab run <name>");
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
      `Run: colab ensure ${name} --gpu t4`,
    );
  }

  // Push first if requested
  if (pushFirst) {
    const { pushCommand } = await import("./push.ts");
    const pushResult = await pushCommand([name]);
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
      `Run: colab ensure ${name} --gpu ${state.gpu}`,
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
    cellIndices = cellIndices.filter(
      (i) => notebook.cells[i]!.cell_type === "code",
    );
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
  });

  const results: CellResult[] = [];
  let hadError = false;

  try {
    await conn.connect();

    for (const idx of cellIndices) {
      const cell = notebook.cells[idx]! as CodeCell;

      streamErr(`Running cell ${idx}...`);
      const result = await conn.execute(cell.source);
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

      // Stop on first error
      if (result.status === "error") {
        hadError = true;
        streamErr(`Cell ${idx} failed: ${result.error?.ename}: ${result.error?.evalue}`);
        break;
      }
    }
  } finally {
    conn.close();
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

  if (hadError) {
    const lastResult = results[results.length - 1]!;
    return err(
      "run",
      "EXEC_ERROR",
      `Cell ${lastResult.index} failed: ${lastResult.result.error?.ename}: ${lastResult.result.error?.evalue}`,
      undefined,
      data,
    );
  }

  streamErr(`Ran ${results.length} cells successfully.`);
  return ok("run", data);
}
