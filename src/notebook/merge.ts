/**
 * Content-addressed merge: combine local .py cells with remote .ipynb.
 *
 * Used by `push` to produce an updated .ipynb that:
 * - Takes source and cell_type from local .py
 * - Preserves cell IDs, outputs, execution counts from remote .ipynb
 * - Merges metadata (local edits + remote internal metadata)
 *
 * Four-pass matching algorithm (see DESIGN.md Section 7).
 */

import type {
  Cell,
  CodeCell,
  MarkdownCell,
  RawCell,
  CellType,
  Notebook,
  NotebookMetadata,
} from "./types.ts";
import { FILTERED_METADATA_KEYS } from "./constants.ts";

// --- Content normalization ---

/**
 * Normalize cell content for comparison.
 * Collapse runs of whitespace to single space, strip leading/trailing.
 * Conservative — avoids false collisions while surviving autoformatter changes.
 */
function normalizeContent(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

/** Check if two cells match on type and normalized content. */
function sameContent(a: Cell, b: Cell): boolean {
  if (a.cell_type !== b.cell_type) return false;
  return normalizeContent(a.source) === normalizeContent(b.source);
}

/** Check if remote's normalized content ends with local's normalized content. */
function suffixMatch(local: Cell, remote: Cell): boolean {
  if (local.cell_type !== remote.cell_type) return false;
  const localNorm = normalizeContent(local.source);
  const remoteNorm = normalizeContent(remote.source);
  if (localNorm === "" || remoteNorm === "") return false;
  return remoteNorm.endsWith(localNorm);
}

// --- Cell construction ---

/** Generate a fresh cell ID (full UUID without dashes, 128 bits of entropy). */
function freshCellId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}


/**
 * Merge cell metadata: remote base + local overrides.
 *
 * - Internal keys (ExecuteTime, collapsed, etc.) preserved from remote
 * - Non-internal keys from local override remote
 * - Non-internal keys only in remote but not in local are removed
 *   (the user deleted them from the .py cell marker)
 */
function mergeMeta(
  localMeta: Record<string, unknown>,
  remoteMeta: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Preserve internal keys from remote
  for (const [k, v] of Object.entries(remoteMeta)) {
    if (FILTERED_METADATA_KEYS.has(k)) {
      result[k] = v;
    }
  }

  // Non-internal keys come from local (overrides remote, deletions reflected)
  for (const [k, v] of Object.entries(localMeta)) {
    result[k] = v;
  }

  return result;
}

/** Build a merged cell: source/type from local, id/outputs from remote. */
function buildMergedCell(local: Cell, remote: Cell): Cell {
  const metadata = mergeMeta(local.metadata, remote.metadata);

  if (local.cell_type === "code") {
    const remoteCode = remote.cell_type === "code" ? remote : null;
    return {
      cell_type: "code",
      source: local.source,
      metadata,
      id: remote.id,
      execution_count: remoteCode?.execution_count ?? null,
      outputs: remoteCode?.outputs ?? [],
    } as CodeCell;
  }

  const cell: Cell = {
    cell_type: local.cell_type,
    source: local.source,
    metadata,
  } as MarkdownCell | RawCell;
  if (remote.id) cell.id = remote.id;
  return cell;
}

/** Build a new cell (no remote match). */
function buildNewCell(local: Cell): Cell {
  const id = freshCellId();

  if (local.cell_type === "code") {
    return {
      cell_type: "code",
      source: local.source,
      metadata: { ...local.metadata },
      id,
      execution_count: null,
      outputs: [],
    } as CodeCell;
  }

  return {
    cell_type: local.cell_type,
    source: local.source,
    metadata: { ...local.metadata },
    id,
  } as Cell;
}

// --- Four-pass matching ---

interface MatchResult {
  /** For each local cell index, the matched remote cell index (or -1). */
  localToRemote: number[];
}

function matchCells(localCells: Cell[], remoteCells: Cell[]): MatchResult {
  const localToRemote = new Array<number>(localCells.length).fill(-1);
  const remoteMatched = new Set<number>();

  // Pass 1: Exact match, in order.
  // For each local cell, find the first unmatched remote cell with same
  // type + normalized content, scanning forward from the last match.
  let remoteStart = 0;
  for (let li = 0; li < localCells.length; li++) {
    for (let ri = remoteStart; ri < remoteCells.length; ri++) {
      if (remoteMatched.has(ri)) continue;
      if (sameContent(localCells[li]!, remoteCells[ri]!)) {
        localToRemote[li] = ri;
        remoteMatched.add(ri);
        remoteStart = ri + 1;
        break;
      }
    }
  }

  // Pass 2: Exact match, out of order.
  // For remaining unmatched local cells, match by type + content anywhere.
  for (let li = 0; li < localCells.length; li++) {
    if (localToRemote[li] !== -1) continue;
    for (let ri = 0; ri < remoteCells.length; ri++) {
      if (remoteMatched.has(ri)) continue;
      if (sameContent(localCells[li]!, remoteCells[ri]!)) {
        localToRemote[li] = ri;
        remoteMatched.add(ri);
        break;
      }
    }
  }

  // Pass 3: Suffix match.
  // For remaining unmatched local cells, check if any remote cell's
  // content ends with the local cell's content (handles cell splits).
  for (let li = 0; li < localCells.length; li++) {
    if (localToRemote[li] !== -1) continue;
    for (let ri = 0; ri < remoteCells.length; ri++) {
      if (remoteMatched.has(ri)) continue;
      if (suffixMatch(localCells[li]!, remoteCells[ri]!)) {
        localToRemote[li] = ri;
        remoteMatched.add(ri);
        break;
      }
    }
  }

  // Pass 4: Gap-bounded positional fallback.
  // Use anchors from passes 1-3 to partition into gaps. Within each gap,
  // FIFO-match unmatched locals to unmatched remotes by type.
  // This prevents cross-anchor misassignment (e.g., edited cells on both
  // sides of an unchanged cell getting swapped).
  const anchors: Array<[number, number]> = [];
  let lastAnchorRi = -1;
  for (let li = 0; li < localCells.length; li++) {
    const ri = localToRemote[li]!;
    if (ri !== -1 && ri > lastAnchorRi) {
      anchors.push([li, ri]);
      lastAnchorRi = ri;
    }
  }

  // Gap boundaries: sentinels + anchors
  const bounds: Array<[number, number]> = [
    [-1, -1],
    ...anchors,
    [localCells.length, remoteCells.length],
  ];

  for (let g = 0; g < bounds.length - 1; g++) {
    const [lStart, rStart] = bounds[g]!;
    const [lEnd, rEnd] = bounds[g + 1]!;

    // Collect unmatched remotes in this gap, grouped by type
    const gapRemoteByType = new Map<CellType, number[]>();
    for (let ri = rStart + 1; ri < rEnd; ri++) {
      if (remoteMatched.has(ri)) continue;
      const type = remoteCells[ri]!.cell_type;
      if (!gapRemoteByType.has(type)) gapRemoteByType.set(type, []);
      gapRemoteByType.get(type)!.push(ri);
    }

    // FIFO match unmatched locals within this gap
    const gapTypeIdx = new Map<CellType, number>();
    for (let li = lStart + 1; li < lEnd; li++) {
      if (localToRemote[li] !== -1) continue;
      const type = localCells[li]!.cell_type;
      const candidates = gapRemoteByType.get(type);
      if (!candidates) continue;
      const idx = gapTypeIdx.get(type) ?? 0;
      if (idx < candidates.length) {
        localToRemote[li] = candidates[idx]!;
        remoteMatched.add(candidates[idx]!);
        gapTypeIdx.set(type, idx + 1);
      }
    }
  }

  return { localToRemote };
}

// --- Main ---

/**
 * Merge local cells (from .py) with a remote notebook (.ipynb).
 * Returns a new Notebook with local content + remote metadata/outputs.
 *
 * @param localCells - Cells parsed from local .py via percentToCells()
 * @param localMetadata - Notebook metadata parsed from .py YAML header
 * @param remote - The remote .ipynb notebook
 */
export function merge(
  localCells: Cell[],
  localMetadata: NotebookMetadata,
  remote: Notebook,
): Notebook {
  const { localToRemote } = matchCells(localCells, remote.cells);

  // Build merged cells in local order
  const cells: Cell[] = localCells.map((local, i) => {
    const ri = localToRemote[i]!;
    if (ri !== -1) {
      return buildMergedCell(local, remote.cells[ri]!);
    }
    return buildNewCell(local);
  });

  // Notebook metadata: remote is base, overlay kernelspec from local if present
  const metadata: NotebookMetadata = { ...remote.metadata };
  if (localMetadata.kernelspec) {
    metadata.kernelspec = localMetadata.kernelspec;
  }

  return {
    nbformat: remote.nbformat,
    nbformat_minor: remote.nbformat_minor,
    metadata,
    cells,
  };
}
