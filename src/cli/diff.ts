/**
 * CLI: colab diff <name>
 *
 * Show cell-level diff between local .py and remote .ipynb.
 * Uses the same content-addressed matching as merge to identify
 * added, deleted, and modified cells.
 */

import { ok, err, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { ContentsClient } from "../jupyter/contents.ts";
import { parseIpynb } from "../notebook/ipynb.ts";
import { percentToCells } from "../notebook/parse.ts";
import { matchCells } from "../notebook/merge.ts";
import type { Cell } from "../notebook/types.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  contentsPath,
  localPyPath,
  isValidNotebookName,
} from "../state/notebooks.ts";
import { readFile } from "fs/promises";

// ── Data shapes ──────────────────────────────────────────────────────────

interface CellDiff {
  index: number;
  type: "added" | "deleted" | "modified" | "unchanged";
  cellType: string;
  /** First line of source (for identification). */
  preview: string;
  /** For modified cells: the remote source. */
  remotePreview?: string;
}

interface DiffData {
  name: string;
  localCells: number;
  remoteCells: number;
  added: number;
  deleted: number;
  modified: number;
  unchanged: number;
  cells: CellDiff[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function preview(source: string): string {
  const first = source.split("\n")[0] ?? "";
  return first.length > 80 ? first.slice(0, 77) + "..." : first;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function diffCommand(
  args: string[],
): Promise<CommandResult<DiffData>> {
  const name = args[0];

  if (!name) {
    return err("diff", "USAGE", "Missing notebook name", "Usage: colab diff <name>");
  }
  if (!isValidNotebookName(name)) {
    return err("diff", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("diff", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Load local .py
  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err("diff", "NOT_FOUND", `No notebook "${name}" found`, `Run: colab ensure ${name} --gpu t4  (or --tpu, --cpu-only)`);
  }

  const pyPath = localPyPath(projectRoot, name);
  let pyContent: string;
  try {
    pyContent = await readFile(pyPath, "utf-8");
  } catch {
    return err("diff", "NOT_FOUND", `No local file: ${name}.py`, `Run: colab pull ${name}`);
  }

  const { cells: localCells } = percentToCells(pyContent);

  // Fetch remote .ipynb
  const client = new ColabClient();
  let remoteCells: Cell[];
  try {
    const pt = await client.refreshProxyToken(token, state.endpoint);
    const contents = new ContentsClient(pt.url, pt.token);
    const ipynbJson = await contents.readText(contentsPath(name));
    const notebook = parseIpynb(ipynbJson);
    remoteCells = notebook.cells;
  } catch (e) {
    return err(
      "diff",
      "NOT_FOUND",
      `Could not fetch remote notebook: ${e}`,
      `Run: colab push ${name}`,
    );
  }

  // Match cells using the same 4-pass algorithm as merge
  const { localToRemote } = matchCells(localCells, remoteCells);
  const remoteMatched = new Set<number>();
  for (const ri of localToRemote) {
    if (ri !== -1) remoteMatched.add(ri);
  }

  const cells: CellDiff[] = [];
  let added = 0;
  let modified = 0;
  let unchanged = 0;

  // Local cells: matched with same content = unchanged,
  // matched with different content = modified, unmatched = added
  for (let li = 0; li < localCells.length; li++) {
    const lc = localCells[li]!;
    const ri = localToRemote[li]!;

    if (ri !== -1) {
      // Matched — check if content actually changed
      const rc = remoteCells[ri]!;
      const localNorm = lc.source.replace(/\s+/g, " ").trim();
      const remoteNorm = rc.source.replace(/\s+/g, " ").trim();
      if (localNorm === remoteNorm) {
        cells.push({
          index: li,
          type: "unchanged",
          cellType: lc.cell_type,
          preview: preview(lc.source),
        });
        unchanged++;
      } else {
        cells.push({
          index: li,
          type: "modified",
          cellType: lc.cell_type,
          preview: preview(lc.source),
          remotePreview: preview(rc.source),
        });
        modified++;
      }
    } else {
      cells.push({
        index: li,
        type: "added",
        cellType: lc.cell_type,
        preview: preview(lc.source),
      });
      added++;
    }
  }

  // Unmatched remote cells = deleted
  let deleted = 0;
  for (let ri = 0; ri < remoteCells.length; ri++) {
    if (!remoteMatched.has(ri)) {
      cells.push({
        index: ri,
        type: "deleted",
        cellType: remoteCells[ri]!.cell_type,
        preview: preview(remoteCells[ri]!.source),
      });
      deleted++;
    }
  }

  // Keep-alive side effect
  try {
    await client.keepAlive(token, state.endpoint);
    state.lastKeepAlive = new Date().toISOString();
    await saveNotebookState(projectRoot, name, state);
  } catch { /* non-fatal */ }

  return ok("diff", {
    name,
    localCells: localCells.length,
    remoteCells: remoteCells.length,
    added,
    deleted,
    modified,
    unchanged,
    cells,
  });
}
