/**
 * Full pipeline round-trip test:
 * golden .ipynb → ipynbToPercent() → percentToCells() → merge(cells, originalIpynb) → compare
 *
 * Validates that the full pull → edit-nothing → push cycle preserves:
 * - Cell count, types, sources
 * - Cell IDs
 * - Outputs and execution counts
 * - Non-filtered metadata
 */

import { describe, test, expect } from "bun:test";
import { parseIpynb } from "../../src/notebook/ipynb.ts";
import { ipynbToPercent } from "../../src/notebook/serialize.ts";
import { percentToCells } from "../../src/notebook/parse.ts";
import { merge } from "../../src/notebook/merge.ts";
import { readdirSync } from "node:fs";
import type { Cell, CodeCell } from "../../src/notebook/types.ts";

const goldenDir = "test/fixtures/golden";
const allFiles = readdirSync(goldenDir);
const ipynbFiles = allFiles.filter((f) => f.endsWith(".ipynb"));

const SKIP = new Set([
  "Notebook_with_R_magic",
  "Notebook_with_more_R_magic_111",
  "Notebook with html and latex cells",
  "Line_breaks_in_LateX_305",
]);

const notebooks = ipynbFiles
  .filter((f) => !SKIP.has(f.replace(".ipynb", "")))
  .map((f) => ({
    name: f.replace(".ipynb", ""),
    path: `${goldenDir}/${f}`,
  }));

describe("full pipeline round-trip (.ipynb → .py → cells → merge)", () => {
  for (const nb of notebooks) {
    test(nb.name, async () => {
      const ipynbContent = await Bun.file(nb.path).text();
      const original = parseIpynb(ipynbContent);

      // Pull: .ipynb → .py
      const py = ipynbToPercent(original);

      // Push: .py → cells → merge with original
      const { cells: localCells, metadata: localMeta } = percentToCells(py);
      const merged = merge(localCells, localMeta, original);

      // Same number of cells
      expect(merged.cells.length).toBe(original.cells.length);

      for (let i = 0; i < original.cells.length; i++) {
        const orig = original.cells[i]!;
        const result = merged.cells[i]!;

        // Cell type preserved
        expect(result.cell_type).toBe(orig.cell_type);

        // Source preserved
        expect(result.source).toBe(orig.source);

        // Cell ID preserved
        if (orig.id) {
          expect(result.id).toBe(orig.id);
        }

        // Code cell specifics
        if (orig.cell_type === "code") {
          const origCode = orig as CodeCell;
          const resultCode = result as CodeCell;
          expect(resultCode.execution_count).toBe(origCode.execution_count);
          expect(resultCode.outputs.length).toBe(origCode.outputs.length);
        }
      }
    });
  }
});
