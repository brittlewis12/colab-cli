/**
 * Serialize a Notebook to percent-format .py string.
 *
 * This is the `pull` direction: .ipynb → .py
 */

import type { Notebook, Cell } from "./types.ts";
import { serializeHeader } from "./header.ts";
import { commentMagics } from "./magic.ts";
import { FILTERED_METADATA_KEYS } from "./constants.ts";

// --- Markdown/Raw comment helpers ---

/** Comment lines for markdown/raw cells: prefix each line with `# `. */
function commentLines(source: string): string {
  if (source === "") return "#";
  const lines = source.split("\n");
  return lines
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .join("\n");
}

// --- PEP 8 blank lines ---

/**
 * Determine the number of blank lines after a cell (before the next cell marker).
 *
 * PEP 8: two blank lines around top-level function/class definitions.
 * In percent-format with interspersed markdown/raw cells, the gap belongs
 * on the code-cell side — non-code cells always get 1 blank line after them.
 * When a code cell precedes a def/class that's separated by markdown/raw cells,
 * we look ahead past those non-code cells to find the next code cell.
 */
function blankLinesAfterCell(cells: Cell[], prevIdx: number): number {
  const prevCell = cells[prevIdx]!;

  // Non-code cells always followed by 1 blank line
  if (prevCell.cell_type !== "code") return 1;

  // Code cell ending with function/class body → 2
  const prevSource = prevCell.source.trimEnd();
  const prevLines = prevSource.split("\n");
  const lastLine = prevLines[prevLines.length - 1]?.trimStart() ?? "";
  if (
    lastLine.startsWith("def ") ||
    lastLine.startsWith("class ") ||
    lastLine.startsWith("async def ") ||
    lastLine.startsWith("return ") ||
    lastLine === "return"
  ) {
    return 2;
  }

  // Look ahead past non-code cells to find next code cell
  for (let j = prevIdx + 1; j < cells.length; j++) {
    if (cells[j]!.cell_type === "code") {
      const nextSource = cells[j]!.source.trimStart();
      const firstLine = nextSource.split("\n")[0]?.trimStart() ?? "";
      if (
        firstLine.startsWith("def ") ||
        firstLine.startsWith("class ") ||
        firstLine.startsWith("async def ") ||
        firstLine.startsWith("@") // decorators before functions
      ) {
        return 2;
      }
      break;
    }
  }

  return 1;
}

// --- Cell metadata serialization ---


/** Serialize a metadata value to a string suitable for the cell marker line. */
function serializeMetaValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Match jupytext/Python json.dumps: spaces after : and , but NOT inside strings.
  return JSON.stringify(value, null, 0)
    .replace(/"(?:[^"\\]|\\.)*"|[:,]/g, (match) => {
      if (match === ",") return ", ";
      if (match === ":") return ": ";
      return match; // quoted string — leave untouched
    });
}

/** Serialize cell metadata to key=value pairs for the cell marker line. */
function serializeCellMetadata(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (FILTERED_METADATA_KEYS.has(key)) continue;
    if (value === undefined) continue;
    // Skip empty objects (but not empty arrays or null)
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) continue;
    // null values emit key without =value (jupytext convention for flags like .class)
    if (value === null) {
      parts.push(key);
    } else {
      parts.push(`${key}=${serializeMetaValue(value)}`);
    }
  }
  return parts.join(" ");
}

// --- Cell serialization ---

function serializeCell(cell: Cell): string {
  const meta = serializeCellMetadata(cell.metadata);

  switch (cell.cell_type) {
    case "markdown": {
      const marker = meta ? `# %% [markdown] ${meta}` : "# %% [markdown]";
      const body = commentLines(cell.source);
      return `${marker}\n${body}`;
    }
    case "raw": {
      const marker = meta ? `# %% [raw] ${meta}` : "# %% [raw]";
      const body = commentLines(cell.source);
      return `${marker}\n${body}`;
    }
    case "code": {
      // Frozen cells get their body commented out
      const isFrozen = (cell.metadata.run_control as Record<string, unknown>)?.frozen === true;

      const marker = meta ? `# %% ${meta}` : "# %%";
      if (isFrozen) {
        const body = commentLines(cell.source);
        return `${marker}\n${body}`;
      }
      const body = commentMagics(cell.source);
      return body ? `${marker}\n${body}` : marker;
    }
  }
}

// --- Main ---

/** Convert a Notebook to a percent-format .py string. */
export function ipynbToPercent(notebook: Notebook): string {
  const parts: string[] = [];

  // Check if first cell is a raw cell with YAML-like content (--- delimited)
  // If so, merge it into the YAML header (jupytext R Markdown compatibility)
  let startCellIdx = 0;
  let rawHeaderContent: string | null = null;

  if (
    notebook.cells.length > 0 &&
    notebook.cells[0]!.cell_type === "raw"
  ) {
    const rawSource = notebook.cells[0]!.source.trim();
    if (rawSource.startsWith("---") && rawSource.endsWith("---")) {
      // Extract YAML content between --- delimiters (preserve internal blank lines)
      let inner = rawSource.slice(3, -3);
      // Remove exactly one leading newline (the one after opening ---)
      if (inner.startsWith("\n")) inner = inner.slice(1);
      // Remove exactly one trailing newline (the one before closing ---)
      if (inner.endsWith("\n")) inner = inner.slice(0, -1);
      // Filter out any `jupyter:` block (it's in notebook.metadata already)
      const lines = inner.split("\n");
      const filtered: string[] = [];
      let inJupyter = false;
      for (const line of lines) {
        if (/^jupyter:\s*$/.test(line)) {
          inJupyter = true;
          continue;
        }
        if (inJupyter && /^\s+/.test(line)) continue;
        if (inJupyter && !/^\s+/.test(line)) inJupyter = false;
        if (!inJupyter) filtered.push(line);
      }
      rawHeaderContent = filtered.join("\n");
      startCellIdx = 1;
    }
  }

  // YAML header
  const header = serializeHeader(notebook.metadata);
  if (header && rawHeaderContent) {
    // Insert raw cell content before the jupyter: block
    const headerLines = header.split("\n");
    const jupyterIdx = headerLines.findIndex((l) => l.trim() === "# jupyter:");
    if (jupyterIdx !== -1) {
      const before = headerLines.slice(0, jupyterIdx);
      const after = headerLines.slice(jupyterIdx);
      const rawLines = rawHeaderContent.split("\n").map((l) => (l === "" ? "#" : `# ${l}`));
      parts.push([...before, ...rawLines, ...after].join("\n"));
    } else {
      parts.push(header);
    }
  } else if (header) {
    parts.push(header);
  } else if (rawHeaderContent !== null) {
    // No kernelspec header but raw cell was absorbed — emit it as a normal raw cell
    // instead of silently dropping it.
    startCellIdx = 0;
  }

  // Cells
  for (let i = startCellIdx; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]!;
    const serialized = serializeCell(cell);

    if (i === 0 && parts.length > 0) {
      // After header: one blank line separator
      parts.push("");
      parts.push(serialized);
    } else if (i === 0) {
      parts.push(serialized);
    } else {
      const blanks = blankLinesAfterCell(notebook.cells, i - 1);
      // `blanks` empty strings joined with \n produce the right number of blank lines.
      // 1 blank line = one "" between cells; 2 blank lines = two ""s.
      for (let b = 0; b < blanks; b++) {
        parts.push("");
      }
      parts.push(serialized);
    }
  }

  // Trailing newline
  return parts.join("\n") + "\n";
}
