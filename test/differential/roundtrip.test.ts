/**
 * Round-trip differential tests: golden .py → percentToCells() → compare against golden .ipynb.
 *
 * Validates that our parser produces cells matching the original notebook.
 * Comparison is on (cell_type, source, filtered metadata) — outputs,
 * execution_count, and cell IDs come from the remote on push, not from .py.
 */

import { describe, test, expect } from "bun:test";
import { parseIpynb } from "../../src/notebook/ipynb.ts";
import { percentToCells } from "../../src/notebook/parse.ts";
import { FILTERED_METADATA_KEYS } from "../../src/notebook/constants.ts";
import { readdirSync } from "node:fs";
import type { Cell } from "../../src/notebook/types.ts";

const goldenDir = "test/fixtures/golden";
const allFiles = readdirSync(goldenDir);
const ipynbFiles = allFiles.filter((f) => f.endsWith(".ipynb"));
const pyFiles = new Set(allFiles.filter((f) => f.endsWith(".py")));

/**
 * Same skip list as oracle.test.ts — these use jupytext features
 * irrelevant to Colab Python notebooks.
 */
const SKIP = new Set([
  "Notebook_with_R_magic", // %%R cell magic → language= conversion
  "Notebook_with_more_R_magic_111", // same
  "Notebook with html and latex cells", // %%html/%%latex → language= conversion
  "Line_breaks_in_LateX_305", // triple-quote markdown (cell_markers='"""')
]);

const pairs = ipynbFiles
  .filter((f) => pyFiles.has(f.replace(".ipynb", ".py")))
  .filter((f) => !SKIP.has(f.replace(".ipynb", "")))
  .map((f) => ({
    name: f.replace(".ipynb", ""),
    ipynb: `${goldenDir}/${f}`,
    py: `${goldenDir}/${f.replace(".ipynb", ".py")}`,
  }));


/** Strip metadata keys that don't survive serialization. */
function filterMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FILTERED_METADATA_KEYS.has(k)) continue;
    // Skip empty objects (serialize.ts skips these)
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v as object).length === 0
    )
      continue;
    filtered[k] = v;
  }
  return filtered;
}

/** Extract comparable cell data (type, source, filtered metadata). */
function cellFingerprint(cell: Cell) {
  return {
    cell_type: cell.cell_type,
    source: cell.source,
    metadata: filterMeta(cell.metadata),
  };
}

/**
 * Strip jupytext-specific YAML lines from a .py file before parsing,
 * since our parser doesn't know about jupytext_version etc.
 */
function stripJupytextYaml(py: string): string {
  return py
    .split("\n")
    .filter((line) => {
      const trimmed = line.replace(/^#\s*/, "");
      if (trimmed.startsWith("jupytext:")) return false;
      if (trimmed.startsWith("text_representation:")) return false;
      if (trimmed.startsWith("extension:")) return false;
      if (trimmed.startsWith("format_name:")) return false;
      if (trimmed.startsWith("format_version:")) return false;
      if (trimmed.startsWith("jupytext_version:")) return false;
      return true;
    })
    .join("\n");
}

describe("py → cells (round-trip vs golden .ipynb)", () => {
  for (const pair of pairs) {
    test(pair.name, async () => {
      const pyContent = await Bun.file(pair.py).text();
      const ipynbContent = await Bun.file(pair.ipynb).text();

      // Parse .py with our parser
      const { cells: ourCells } = percentToCells(stripJupytextYaml(pyContent));

      // Parse .ipynb as ground truth
      const notebook = parseIpynb(ipynbContent);
      const expectedCells = notebook.cells;

      // Compare cell count
      expect(ourCells.length).toBe(expectedCells.length);

      // Compare each cell
      for (let i = 0; i < ourCells.length; i++) {
        const ours = cellFingerprint(ourCells[i]!);
        const expected = cellFingerprint(expectedCells[i]!);

        expect(ours.cell_type).toBe(expected.cell_type);
        expect(ours.source).toBe(expected.source);
        expect(ours.metadata).toEqual(expected.metadata);
      }
    });
  }
});
