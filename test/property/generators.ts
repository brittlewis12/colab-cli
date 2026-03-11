/**
 * fast-check arbitraries for notebook structures.
 *
 * These generate realistic-ish Python code, markdown, and notebook
 * structures to exercise edge cases in the conversion pipeline.
 */

import fc from "fast-check";
import type {
  Cell,
  CodeCell,
  MarkdownCell,
  RawCell,
  Notebook,
  KernelSpec,
  NotebookMetadata,
} from "../../src/notebook/types.ts";

// --- Python-like source generators ---

/**
 * A line of Python-like code.
 *
 * Avoids two ambiguous patterns that can't round-trip:
 * - `# %%` at line start (cell marker)
 * - `# <magic>` where <magic> starts with %, !, ?, or a POSIX command
 *   (indistinguishable from a commented-out IPython magic)
 */
export const arbPythonLine = fc.oneof(
  // Assignment
  fc.tuple(fc.stringMatching(/^[a-z_]\w{0,10}$/), fc.integer()).map(
    ([name, val]) => `${name} = ${val}`,
  ),
  // Function call
  fc.stringMatching(/^[a-z_]\w{0,10}$/).map((name) => `print(${name})`),
  // Comment — safe prefix (NOT starting with %, !, ?, //, or POSIX commands)
  fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 _.,]{0,30}$/).map((s) => `# ${s}`),
  // Import
  fc.stringMatching(/^[a-z_]\w{0,10}$/).map((m) => `import ${m}`),
  // Empty line
  fc.constant(""),
  // Indented line
  fc.stringMatching(/^[a-z_]\w{0,10}$/).map((s) => `    ${s} = None`),
);

/**
 * Multi-line Python source for a code cell.
 * Source never ends with \n — matching .ipynb convention where
 * the last element of the source array has no trailing newline.
 * (Trailing \n would be indistinguishable from inter-cell spacing.)
 */
export const arbCodeSource = fc
  .array(arbPythonLine, { minLength: 0, maxLength: 8 })
  .map((lines) => lines.join("\n").replace(/\n+$/, ""));

/**
 * Source that contains unambiguous IPython magics (round-trip safe).
 *
 * Excludes bare POSIX commands (cd, ls, cat) — these are commented by
 * commentMagics but intentionally NOT uncommented (ambiguous with comments).
 * Users should use `!cmd` for unambiguous shell commands.
 */
export const arbMagicSource = fc.oneof(
  fc.constant("%matplotlib inline"),
  fc.constant("%%timeit"),
  fc.constant("!pip install torch"),
  fc.constant("?print"),
  fc.stringMatching(/^[a-z_]\w{0,10}$/).map((v) => `${v} = %time expr`),
  fc.constant("!ls -la"),
  fc.constant("!cd /tmp"),
);

/** Source with triple-quoted strings (the string parser's domain). */
export const arbTripleQuotedSource = fc
  .tuple(
    fc.stringMatching(/^[a-z_]\w{0,6}$/),
    fc.oneof(fc.constant('"""'), fc.constant("'''")),
    // Content inside the string — may contain # %% to tempt the parser
    fc.array(
      fc.oneof(
        fc.constant("# %% [markdown]"),
        fc.constant("# %%"),
        fc.constant("just a line"),
        fc.constant(""),
        fc.stringMatching(/^[a-zA-Z0-9 #%!]{0,30}$/),
      ),
      { minLength: 0, maxLength: 4 },
    ),
  )
  .map(([name, q, inner]) => `${name} = ${q}\n${inner.join("\n")}\n${q}`);

/** A line of markdown (no leading #, that's added by the comment layer). */
const arbMarkdownLine = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9 _.,!?*#\[\]()]{0,50}$/),
  fc.constant(""),
);

/** Multi-line markdown source. No trailing newline (ipynb convention). */
export const arbMarkdownSource = fc
  .array(arbMarkdownLine, { minLength: 1, maxLength: 6 })
  .map((lines) => lines.join("\n").replace(/\n+$/, "") || "text");

/** Multi-line raw source. No trailing newline (ipynb convention). */
export const arbRawSource = fc
  .array(
    fc.stringMatching(/^[a-zA-Z0-9 _.,<>\/\-:]{0,30}$/),
    { minLength: 1, maxLength: 4 },
  )
  .map((lines) => lines.join("\n").replace(/\n+$/, "") || "raw");

// --- Cell generators ---

/** Simple metadata values that survive serialization round-trip. */
export const arbCellMeta: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.constant({}),
  fc.record({
    tags: fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    custom_key: fc.boolean(),
  }),
);

export const arbCodeCell: fc.Arbitrary<CodeCell> = fc
  .tuple(arbCodeSource, arbCellMeta)
  .map(([source, metadata]) => ({
    cell_type: "code" as const,
    source,
    metadata,
    execution_count: null,
    outputs: [],
  }));

export const arbMarkdownCell: fc.Arbitrary<MarkdownCell> = fc
  .tuple(arbMarkdownSource, arbCellMeta)
  .map(([source, metadata]) => ({
    cell_type: "markdown" as const,
    source,
    metadata,
  }));

export const arbRawCell: fc.Arbitrary<RawCell> = arbRawSource.map((source) => ({
  cell_type: "raw" as const,
  source,
  metadata: {},
}));

export const arbCell: fc.Arbitrary<Cell> = fc.oneof(
  { weight: 5, arbitrary: arbCodeCell },
  { weight: 2, arbitrary: arbMarkdownCell },
  { weight: 1, arbitrary: arbRawCell },
);

// --- Notebook generator ---

const arbKernelSpec: fc.Arbitrary<KernelSpec> = fc.constant({
  display_name: "Python 3",
  language: "python",
  name: "python3",
});

export const arbNotebookMeta: fc.Arbitrary<NotebookMetadata> = arbKernelSpec.map(
  (ks) => ({ kernelspec: ks }),
);

export const arbNotebook: fc.Arbitrary<Notebook> = fc
  .tuple(
    fc.array(arbCell, { minLength: 1, maxLength: 8 }),
    arbNotebookMeta,
  )
  .map(([cells, metadata]) => ({
    nbformat: 4,
    nbformat_minor: 5,
    metadata,
    cells,
  }));
