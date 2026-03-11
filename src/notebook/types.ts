/**
 * TypeScript types for Jupyter Notebook format (nbformat v4/v4.5).
 *
 * These mirror the JSON structure of .ipynb files. The `source` field
 * in .ipynb can be either a string or an array of strings (each line
 * ending with \n except the last). We normalize to a single string
 * internally and convert back on serialization.
 */

// --- Cell types ---

export type CellType = "code" | "markdown" | "raw";

export interface CellOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  // stream
  name?: "stdout" | "stderr";
  text?: string | string[];
  // execute_result / display_data
  // Values are usually string | string[], but can be raw JSON objects
  // (e.g., Plotly's application/vnd.plotly.v1+json)
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  // error
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface BaseCell {
  cell_type: CellType;
  source: string; // normalized to single string internally
  metadata: Record<string, unknown>;
  id?: string; // nbformat 4.5+
}

export interface CodeCell extends BaseCell {
  cell_type: "code";
  execution_count: number | null;
  outputs: CellOutput[];
}

export interface MarkdownCell extends BaseCell {
  cell_type: "markdown";
}

export interface RawCell extends BaseCell {
  cell_type: "raw";
}

export type Cell = CodeCell | MarkdownCell | RawCell;

// --- Notebook metadata ---

export interface KernelSpec {
  display_name: string;
  language: string;
  name: string;
}

export interface LanguageInfo {
  name: string;
  codemirror_mode?: string | { name: string; version: number };
  file_extension?: string;
  mimetype?: string;
  nbconvert_exporter?: string;
  pygments_lexer?: string;
  version?: string;
}

export interface NotebookMetadata {
  kernelspec?: KernelSpec;
  language_info?: LanguageInfo;
  [key: string]: unknown;
}

// --- Notebook ---

export interface Notebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: NotebookMetadata;
  cells: Cell[];
}

// --- Raw .ipynb JSON types (before normalization) ---
// The source field in .ipynb can be string | string[]

export interface RawCell_JSON {
  cell_type: string;
  source: string | string[];
  metadata: Record<string, unknown>;
  id?: string;
  execution_count?: number | null;
  outputs?: RawCellOutput_JSON[];
}

export interface RawCellOutput_JSON {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface RawNotebook_JSON {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: RawCell_JSON[];
}
