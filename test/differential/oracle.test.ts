import { describe, test, expect } from "bun:test";
import { parseIpynb } from "../../src/notebook/ipynb.ts";
import { ipynbToPercent } from "../../src/notebook/serialize.ts";
import { stripJupytextMeta } from "./helpers.ts";
import { readdirSync } from "node:fs";

// Find all golden .ipynb files that have a corresponding .py
const goldenDir = "test/fixtures/golden";
const allFiles = readdirSync(goldenDir);
const ipynbFiles = allFiles.filter((f) => f.endsWith(".ipynb"));
const pyFiles = new Set(allFiles.filter((f) => f.endsWith(".py")));

/**
 * Notebooks we intentionally skip — these test jupytext features that are
 * irrelevant to our Colab Python use case:
 * - R magic / multi-language cells (language= metadata extraction)
 * - Triple-quote markdown cell markers (cell_markers='"""')
 * - Raw cell on top merged into YAML header (R Markdown compatibility)
 */
const SKIP = new Set([
  "Notebook_with_R_magic",           // %%R cell magic → language= conversion
  "Notebook_with_more_R_magic_111",  // same
  "Notebook with html and latex cells", // %%html/%%latex → language= conversion
  "Line_breaks_in_LateX_305",        // triple-quote markdown (cell_markers='"""')
]);

const pairs = ipynbFiles
  .filter((f) => pyFiles.has(f.replace(".ipynb", ".py")))
  .filter((f) => !SKIP.has(f.replace(".ipynb", "")))
  .map((f) => ({
    name: f.replace(".ipynb", ""),
    ipynb: `${goldenDir}/${f}`,
    py: `${goldenDir}/${f.replace(".ipynb", ".py")}`,
  }));

describe("ipynb → py:percent (vs golden files)", () => {
  for (const pair of pairs) {
    test(pair.name, async () => {
      const ipynbContent = await Bun.file(pair.ipynb).text();
      const expectedPy = await Bun.file(pair.py).text();

      const notebook = parseIpynb(ipynbContent);
      const ourPy = ipynbToPercent(notebook);

      // Strip jupytext-specific metadata for fair comparison
      const ourStripped = stripJupytextMeta(ourPy);
      const expectedStripped = stripJupytextMeta(expectedPy);

      expect(ourStripped).toBe(expectedStripped);
    });
  }
});
