/**
 * Parse a percent-format .py string into cells and notebook metadata.
 *
 * This is the `push` direction: .py → cell list.
 * Used by `push` to convert local edits back into notebook cells,
 * which are then merged with the remote .ipynb via merge.ts.
 */

import type {
  Cell,
  CodeCell,
  MarkdownCell,
  RawCell,
  CellType,
  NotebookMetadata,
} from "./types.ts";
import { parseHeader } from "./header.ts";
import { uncommentMagics } from "./magic.ts";
import { StringParser } from "./string-parser.ts";

// --- Types ---

export interface ParseResult {
  cells: Cell[];
  metadata: NotebookMetadata;
}

// --- Cell marker detection ---

/**
 * Matches a percent-format cell marker.
 *
 * Valid: `# %%`, `# %% [markdown]`, `# %% key=value`, `# %%%`
 * Invalid: `# %%timeit` (commented cell magic — no space after %%)
 *
 * After `%%` and optional extra `%`s, either nothing (bare marker)
 * or whitespace followed by options.
 */
const CELL_MARKER_RE = /^(\s*)#\s*%%(%*)(\s+(.*))?$/;

// --- Marker option parsing ---

/**
 * Parse the options portion of a cell marker line.
 *
 * Options string looks like: `[markdown] key1=value1 key2={"json": true}`
 * or just: `key1=value1 key2=value2`
 * or just: `[markdown]`
 * or empty.
 */
function parseMarkerOptions(optionsStr: string): {
  cellType: CellType;
  metadata: Record<string, unknown>;
} {
  let cellType: CellType = "code";
  let rest = optionsStr.trim();

  // Check for cell type annotation
  if (rest.startsWith("[markdown]")) {
    cellType = "markdown";
    rest = rest.slice("[markdown]".length).trim();
  } else if (rest.startsWith("[md]")) {
    cellType = "markdown";
    rest = rest.slice("[md]".length).trim();
  } else if (rest.startsWith("[raw]")) {
    cellType = "raw";
    rest = rest.slice("[raw]".length).trim();
  }

  const metadata = parseMetadataString(rest);

  // For code cells, if the first token in the options is a bare identifier
  // (starts with a letter/digit/underscore, no `=`), it's a cell title.
  // `# %% data_prep` → title is "data_prep". Store it in metadata.title for
  // cell addressing via `run --cell data_prep`. The bare key is also kept in
  // metadata for round-trip compatibility (jupytext uses { data_prep: null }).
  // Tokens starting with `.` or other special chars (e.g., `.class`) are CSS
  // class annotations, not titles.
  if (cellType === "code" && rest) {
    const firstToken = rest.split(/\s/)[0]!;
    if (firstToken && !firstToken.includes("=") && /^\w/.test(firstToken)) {
      metadata.title = firstToken;
    }
  }

  return { cellType, metadata };
}

/**
 * Parse key=value metadata pairs from a string.
 *
 * Handles:
 * - `key="string"` — JSON string values
 * - `key={"nested": "json"}` — JSON object values
 * - `key=["array"]` — JSON array values
 * - `key=123`, `key=true`, `key=false` — literal values
 * - `key` alone — null flag value
 *
 * Keys can contain any character except `=` and space (e.g., `@scope/pkg-name`).
 */
function parseMetadataString(str: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  let i = 0;

  while (i < str.length) {
    // Skip whitespace
    while (i < str.length && str[i] === " ") i++;
    if (i >= str.length) break;

    // Read key (until = or space or end)
    const keyStart = i;
    while (i < str.length && str[i] !== "=" && str[i] !== " ") i++;
    const key = str.slice(keyStart, i);
    if (!key) break;

    if (i >= str.length || str[i] === " ") {
      // Bare key (flag) — null value
      metadata[key] = null;
      continue;
    }

    // Skip =
    i++;

    // Parse value
    const { value, end } = parseMetaValue(str, i);
    metadata[key] = value;
    i = end;
  }

  return metadata;
}

/**
 * Parse a single metadata value starting at position `start`.
 * Returns the parsed value and the position after it.
 */
function parseMetaValue(
  str: string,
  start: number,
): { value: unknown; end: number } {
  if (start >= str.length) return { value: null, end: start };

  const ch = str[start]!;

  // JSON string: "..."
  if (ch === '"') {
    let i = start + 1;
    while (i < str.length) {
      if (str[i] === "\\") {
        i += 2;
        continue;
      }
      if (str[i] === '"') {
        i++;
        break;
      }
      i++;
    }
    const raw = str.slice(start, i);
    try {
      return { value: JSON.parse(raw), end: i };
    } catch {
      return { value: raw, end: i };
    }
  }

  // JSON object or array: {...} or [...]
  if (ch === "{" || ch === "[") {
    const close = ch === "{" ? "}" : "]";
    let depth = 1;
    let i = start + 1;
    let inString = false;
    while (i < str.length && depth > 0) {
      if (str[i] === "\\") {
        i += 2;
        continue;
      }
      if (str[i] === '"') {
        inString = !inString;
        i++;
        continue;
      }
      if (!inString) {
        if (str[i] === ch) depth++;
        if (str[i] === close) depth--;
      }
      i++;
    }
    const raw = str.slice(start, i);
    try {
      return { value: JSON.parse(raw), end: i };
    } catch {
      return { value: raw, end: i };
    }
  }

  // Unquoted value: scan until space or end
  let i = start;
  while (i < str.length && str[i] !== " ") i++;
  const raw = str.slice(start, i);

  if (raw === "true") return { value: true, end: i };
  if (raw === "false") return { value: false, end: i };
  if (raw === "null") return { value: null, end: i };
  const num = Number(raw);
  if (!isNaN(num) && raw !== "") return { value: num, end: i };

  // Bare string (shouldn't happen in well-formed output, but be safe)
  return { value: raw, end: i };
}

// --- Body processing ---

/**
 * Uncomment lines for markdown/raw/frozen cell bodies.
 *
 * - `# text` (hash + space + text) → `text`
 * - `#text` (hash + text, no space) → `text`
 * - `#` (bare hash) → empty string
 * - No hash prefix → leave as-is (passthrough)
 */
function uncommentLines(lines: string[]): string {
  return lines
    .map((line) => {
      if (line.startsWith("# ")) return line.slice(2);
      if (line === "#") return "";
      if (line.startsWith("#")) return line.slice(1);
      return line;
    })
    .join("\n");
}

// --- Raw cell on top detection ---

/**
 * Detect if the YAML header contains non-jupyter content that was merged
 * from a raw cell on top during serialization. If so, reconstruct the
 * raw cell source.
 *
 * Returns the raw cell source (with --- delimiters) or null if no raw
 * cell content is present.
 */
function extractRawCellFromHeader(lines: string[], headerEnd: number): string | null {
  // Find the `# ---` delimiters
  let start = -1;
  for (let i = 0; i < headerEnd; i++) {
    if (lines[i]!.trim() === "# ---") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = -1;
  for (let i = start + 1; i < headerEnd; i++) {
    if (lines[i]!.trim() === "# ---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  // Extract all header YAML lines (strip `# ` prefix)
  const yamlLines: string[] = [];
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    if (line.startsWith("# ")) {
      yamlLines.push(line.slice(2));
    } else if (line === "#") {
      yamlLines.push("");
    } else if (line.startsWith("#")) {
      yamlLines.push(line.slice(1));
    } else {
      yamlLines.push(line);
    }
  }

  // Check if there's non-jupyter content (lines before `jupyter:` at root level)
  const jupyterIdx = yamlLines.findIndex((l) => /^jupyter:\s*$/.test(l));
  if (jupyterIdx <= 0) return null; // No non-jupyter content, or jupyter: is first

  // Only the lines BEFORE `jupyter:` belong to the raw cell.
  // The jupyter: block is notebook metadata (already parsed by parseHeader).
  // Trailing blank lines are preserved — they're part of the raw cell content.
  const nonJupyterLines = yamlLines.slice(0, jupyterIdx);
  if (nonJupyterLines.length === 0) return null;

  return `---\n${nonJupyterLines.join("\n")}\n---`;
}

// --- Main ---

/**
 * Parse a percent-format .py string into cells and notebook metadata.
 *
 * This is the inverse of `ipynbToPercent()`.
 */
export function percentToCells(text: string): ParseResult {
  const lines = text.split("\n");

  // Remove trailing empty line from file's trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  // Parse YAML header for notebook metadata
  const { metadata, bodyStart } = parseHeader(lines);

  // Check for raw cell on top merged into header
  const rawCellSource = extractRawCellFromHeader(lines, bodyStart);

  // Find cell boundaries using StringParser to avoid false markers in strings
  const parser = new StringParser();
  const cellStarts: { lineIdx: number; options: string }[] = [];

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]!;

    if (!parser.isQuoted()) {
      const match = line.match(CELL_MARKER_RE);
      if (match) {
        cellStarts.push({ lineIdx: i, options: match[4] ?? "" });
        // Don't feed marker lines to StringParser — they're comments
        continue;
      }
    }

    parser.readLine(line);
  }

  const cells: Cell[] = [];

  // If we extracted a raw cell from the header, add it first
  if (rawCellSource) {
    cells.push({
      cell_type: "raw",
      source: rawCellSource,
      metadata: {},
    } as RawCell);
  }

  // If no cell markers found, treat entire body as a single code cell
  if (cellStarts.length === 0) {
    const body = lines.slice(bodyStart).join("\n").trim();
    if (body) {
      cells.push({
        cell_type: "code",
        source: uncommentMagics(body),
        metadata: {},
        execution_count: null,
        outputs: [],
      } as CodeCell);
    }
    return { cells, metadata };
  }

  // Build cells from marker boundaries
  for (let c = 0; c < cellStarts.length; c++) {
    const { lineIdx, options } = cellStarts[c]!;
    const { cellType, metadata: cellMeta } = parseMarkerOptions(options);

    // Cell body: lines after marker, up to next marker (or end of file)
    const bodyFirstLine = lineIdx + 1;
    const bodyLastLine =
      c + 1 < cellStarts.length ? cellStarts[c + 1]!.lineIdx : lines.length;

    // Collect body lines, strip trailing blank lines (inter-cell spacing)
    const bodyLines = lines.slice(bodyFirstLine, bodyLastLine);
    while (
      bodyLines.length > 0 &&
      bodyLines[bodyLines.length - 1]!.trim() === ""
    ) {
      bodyLines.pop();
    }

    // Build source based on cell type
    let source: string;

    if (cellType === "markdown" || cellType === "raw") {
      source = uncommentLines(bodyLines);
    } else {
      // Code cell — check if frozen (body was commented during serialization)
      const isFrozen =
        (cellMeta.run_control as Record<string, unknown> | undefined)
          ?.frozen === true;
      if (isFrozen) {
        source = uncommentLines(bodyLines);
      } else {
        source = uncommentMagics(bodyLines.join("\n"));
      }
    }

    // Create the cell
    if (cellType === "code") {
      cells.push({
        cell_type: "code",
        source,
        metadata: cellMeta,
        execution_count: null,
        outputs: [],
      } as CodeCell);
    } else {
      cells.push({
        cell_type: cellType,
        source,
        metadata: cellMeta,
      } as Cell);
    }
  }

  return { cells, metadata };
}
