/**
 * Parse and serialize .ipynb JSON files.
 *
 * Handles the source field normalization (string[] → string on read,
 * string → string[] on write) and cell type coercion.
 */

import type {
  Notebook,
  Cell,
  CodeCell,
  MarkdownCell,
  RawCell,
  CellOutput,
  RawNotebook_JSON,
  RawCell_JSON,
  RawCellOutput_JSON,
  NotebookMetadata,
} from "./types.ts";

// --- Helpers ---

/** Join source lines into a single string. .ipynb source can be string | string[]. */
function normalizeSource(source: string | string[]): string {
  if (typeof source === "string") return source;
  return source.join("");
}

/** Split a string into .ipynb source array format: each line ends with \n except possibly the last. */
function splitSource(source: string): string[] {
  if (source === "") return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      lines.push(source.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < source.length) {
    lines.push(source.slice(start));
  }
  return lines;
}

/** Normalize multiline text fields in outputs (text, data values). */
function normalizeOutputText(
  text: string | string[] | undefined,
): string | undefined {
  if (text === undefined) return undefined;
  if (typeof text === "string") return text;
  return text.join("");
}

/** Split text back to array for serialization. */
function splitOutputText(
  text: string | string[] | undefined,
): string[] | undefined {
  if (text === undefined) return undefined;
  if (Array.isArray(text)) return text; // already split
  return splitSource(text);
}

// --- Parse ---

function parseOutput(raw: RawCellOutput_JSON): CellOutput {
  const output: CellOutput = {
    output_type: raw.output_type as CellOutput["output_type"],
  };

  if (raw.name !== undefined) output.name = raw.name as CellOutput["name"];
  if (raw.text !== undefined) output.text = normalizeOutputText(raw.text);
  if (raw.execution_count !== undefined)
    output.execution_count = raw.execution_count;
  if (raw.metadata !== undefined) output.metadata = raw.metadata;
  if (raw.ename !== undefined) output.ename = raw.ename;
  if (raw.evalue !== undefined) output.evalue = raw.evalue;
  if (raw.traceback !== undefined) output.traceback = raw.traceback;

  if (raw.data !== undefined) {
    const data: Record<string, unknown> = {};
    for (const [mime, value] of Object.entries(raw.data)) {
      if (typeof value === "string") {
        data[mime] = value;
      } else if (Array.isArray(value)) {
        if (
          mime.startsWith("image/") ||
          mime === "application/pdf"
        ) {
          // Keep image data as array (it's base64 lines)
          data[mime] = value;
        } else {
          data[mime] = value.join("");
        }
      } else {
        // Object values (e.g., plotly JSON) — preserve as-is
        data[mime] = value;
      }
    }
    output.data = data;
  }

  return output;
}

function parseCell(raw: RawCell_JSON): Cell {
  const source = normalizeSource(raw.source);
  const metadata = raw.metadata ?? {};
  const id = raw.id;

  switch (raw.cell_type) {
    case "code": {
      const cell: CodeCell = {
        cell_type: "code",
        source,
        metadata,
        execution_count: raw.execution_count ?? null,
        outputs: (raw.outputs ?? []).map(parseOutput),
      };
      if (id) cell.id = id;
      return cell;
    }
    case "markdown": {
      const cell: MarkdownCell = {
        cell_type: "markdown",
        source,
        metadata,
      };
      if (id) cell.id = id;
      return cell;
    }
    case "raw": {
      const cell: RawCell = {
        cell_type: "raw",
        source,
        metadata,
      };
      if (id) cell.id = id;
      return cell;
    }
    default:
      // Unknown cell types treated as raw
      const cell: RawCell = {
        cell_type: "raw",
        source,
        metadata,
      };
      if (id) cell.id = id;
      return cell;
  }
}

/** Parse .ipynb JSON string into a Notebook. */
export function parseIpynb(json: string): Notebook {
  let raw: RawNotebook_JSON;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`Failed to parse .ipynb: ${e instanceof Error ? e.message : e}`);
  }
  return {
    nbformat: raw.nbformat,
    nbformat_minor: raw.nbformat_minor,
    metadata: raw.metadata as NotebookMetadata,
    cells: raw.cells.map(parseCell),
  };
}

// --- Serialize ---

function serializeOutput(output: CellOutput): RawCellOutput_JSON {
  const raw: RawCellOutput_JSON = {
    output_type: output.output_type,
  };

  if (output.name !== undefined) raw.name = output.name;
  if (output.text !== undefined) raw.text = splitOutputText(output.text);
  if (output.execution_count !== undefined)
    raw.execution_count = output.execution_count;
  if (output.metadata !== undefined) raw.metadata = output.metadata;
  if (output.ename !== undefined) raw.ename = output.ename;
  if (output.evalue !== undefined) raw.evalue = output.evalue;
  if (output.traceback !== undefined) raw.traceback = output.traceback;

  if (output.data !== undefined) {
    const data: Record<string, unknown> = {};
    for (const [mime, value] of Object.entries(output.data)) {
      if (typeof value === "string") {
        data[mime] = splitSource(value);
      } else {
        // Arrays (image base64), objects (Plotly JSON) — pass through as-is
        data[mime] = value;
      }
    }
    raw.data = data;
  }

  return raw;
}

function serializeCell(cell: Cell): RawCell_JSON {
  const raw: RawCell_JSON = {
    cell_type: cell.cell_type,
    source: splitSource(cell.source),
    metadata: cell.metadata,
  };

  if (cell.id !== undefined) raw.id = cell.id;

  if (cell.cell_type === "code") {
    raw.execution_count = cell.execution_count;
    raw.outputs = cell.outputs.map(serializeOutput);
  }

  return raw;
}

/** Serialize a Notebook to .ipynb JSON string. */
export function serializeIpynb(notebook: Notebook): string {
  const raw: RawNotebook_JSON = {
    cells: notebook.cells.map(serializeCell),
    metadata: notebook.metadata,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor,
  };
  return JSON.stringify(raw, null, 1) + "\n";
}
