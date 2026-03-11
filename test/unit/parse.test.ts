import { describe, test, expect } from "bun:test";
import { percentToCells } from "../../src/notebook/parse.ts";
import { ipynbToPercent } from "../../src/notebook/serialize.ts";
import type { Notebook, CodeCell } from "../../src/notebook/types.ts";

describe("percentToCells", () => {
  // --- Basic cell parsing ---

  test("single code cell", () => {
    const py = `# %%\nprint("hello")\n`;
    const { cells, metadata } = percentToCells(py);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cell_type).toBe("code");
    expect(cells[0]!.source).toBe('print("hello")');
  });

  test("bare marker with empty body", () => {
    const py = `# %%\n`;
    const { cells } = percentToCells(py);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cell_type).toBe("code");
    expect(cells[0]!.source).toBe("");
  });

  test("multiple code cells", () => {
    const py = `# %%\nx = 1\n\n# %%\ny = 2\n`;
    const { cells } = percentToCells(py);
    expect(cells).toHaveLength(2);
    expect(cells[0]!.source).toBe("x = 1");
    expect(cells[1]!.source).toBe("y = 2");
  });

  test("markdown cell", () => {
    const py = `# %% [markdown]\n# Hello **world**\n# Second line\n`;
    const { cells } = percentToCells(py);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cell_type).toBe("markdown");
    expect(cells[0]!.source).toBe("Hello **world**\nSecond line");
  });

  test("[md] shorthand", () => {
    const py = `# %% [md]\n# Short form\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.cell_type).toBe("markdown");
    expect(cells[0]!.source).toBe("Short form");
  });

  test("raw cell", () => {
    const py = `# %% [raw]\n# Raw content here\n`;
    const { cells } = percentToCells(py);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cell_type).toBe("raw");
    expect(cells[0]!.source).toBe("Raw content here");
  });

  test("markdown empty line uncomments bare #", () => {
    const py = `# %% [markdown]\n# Line one\n#\n# Line three\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.source).toBe("Line one\n\nLine three");
  });

  // --- Cell metadata ---

  test("cell metadata key=value pairs", () => {
    const py = `# %% deletable=false editable=false\ncode\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.metadata).toEqual({
      deletable: false,
      editable: false,
    });
  });

  test("cell metadata with JSON object value", () => {
    const py = `# %% run_control={"frozen": true}\n# frozen code\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.metadata).toEqual({
      run_control: { frozen: true },
    });
  });

  test("cell metadata with JSON array value", () => {
    const py = `# %% tags=["parameters"]\nparam = 4\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.metadata).toEqual({ tags: ["parameters"] });
  });

  test("cell metadata with string value", () => {
    const py = `# %% [raw] raw_mimetype="text/latex"\n# $1+1$\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.cell_type).toBe("raw");
    expect(cells[0]!.metadata).toEqual({ raw_mimetype: "text/latex" });
  });

  test("complex nested JSON metadata", () => {
    const py = `# %% [markdown] fonts={"styles": {"": {"body": {"width": "25%"}}}}\n# text\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.metadata).toEqual({
      fonts: { styles: { "": { body: { width: "25%" } } } },
    });
  });

  test("metadata string values with : and , survive round-trip (regression #1)", () => {
    // serializeMetaValue previously corrupted strings containing : or ,
    const py = `# %% cfg={"label": "a:b,c"}\nx = 1\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.metadata).toEqual({ cfg: { label: "a:b,c" } });
  });

  test("bare key flag (null value)", () => {
    const py = `# %% [markdown] .class\n# text\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.metadata).toEqual({ ".class": null });
  });

  // --- Magic command uncommenting ---

  test("magic commands uncommmented in code cells", () => {
    const py = `# %%\n# %matplotlib inline\nplot()\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.source).toBe("%matplotlib inline\nplot()");
  });

  test("shell commands uncommented in code cells", () => {
    const py = `# %%\n# !pip install torch\nimport torch\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.source).toBe("!pip install torch\nimport torch");
  });

  test("magics NOT uncommented in markdown cells", () => {
    const py = `# %% [markdown]\n# Use %matplotlib to enable plots\n`;
    const { cells } = percentToCells(py);
    // Markdown uncomments the `# ` prefix, but doesn't touch the remaining %
    expect(cells[0]!.source).toBe("Use %matplotlib to enable plots");
  });

  // --- Frozen cells ---

  test("frozen cell body is uncommented", () => {
    const py = `# %% run_control={"frozen": true}\n# x = 1\n# y = 2\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.cell_type).toBe("code");
    expect(cells[0]!.source).toBe("x = 1\ny = 2");
    expect(cells[0]!.metadata).toEqual({ run_control: { frozen: true } });
  });

  // --- YAML header ---

  test("parses YAML header metadata", () => {
    const py = [
      "# ---",
      "# jupyter:",
      "#   kernelspec:",
      "#     display_name: Python 3",
      "#     language: python",
      "#     name: python3",
      "# ---",
      "",
      "# %%",
      "x = 1",
      "",
    ].join("\n");
    const { cells, metadata } = percentToCells(py);
    expect(metadata.kernelspec).toEqual({
      display_name: "Python 3",
      language: "python",
      name: "python3",
    });
    expect(cells).toHaveLength(1);
    expect(cells[0]!.source).toBe("x = 1");
  });

  test("YAML header with single-quoted display_name round-trips (regression #13)", () => {
    // display_name with a single quote: serializer uses '' escaping
    const py = [
      "# ---",
      "# jupyter:",
      "#   kernelspec:",
      "#     display_name: 'Bob''s Python'",
      "#     language: python",
      "#     name: python3",
      "# ---",
      "",
      "# %%",
      "x = 1",
      "",
    ].join("\n");
    const { metadata } = percentToCells(py);
    expect(metadata.kernelspec!.display_name).toBe("Bob's Python");
  });

  test("no header — empty metadata", () => {
    const py = `# %%\nx = 1\n`;
    const { metadata } = percentToCells(py);
    expect(metadata).toEqual({});
  });

  // --- StringParser: false marker in string ---

  test("# %% inside triple-quoted string is NOT a cell marker", () => {
    const py = [
      "# %%",
      's = """',
      "# %% [markdown]",
      "this is inside a string",
      '"""',
      "",
      "# %%",
      "y = 2",
      "",
    ].join("\n");
    const { cells } = percentToCells(py);
    expect(cells).toHaveLength(2);
    expect(cells[0]!.source).toBe(
      's = """\n# %% [markdown]\nthis is inside a string\n"""',
    );
    expect(cells[1]!.source).toBe("y = 2");
  });

  // --- Commented cell magic vs cell marker ---

  test("# %%timeit is NOT a cell marker (commented magic)", () => {
    const py = `# %%\n# %%timeit\nx = 1\n`;
    const { cells } = percentToCells(py);
    expect(cells).toHaveLength(1);
    // %%timeit is a commented cell magic, gets uncommented
    expect(cells[0]!.source).toBe("%%timeit\nx = 1");
  });

  test("# %% timeit IS a cell marker with title", () => {
    const py = `# %%\nx = 1\n\n# %% timeit\ny = 2\n`;
    const { cells } = percentToCells(py);
    // "timeit" in options becomes metadata key with null value
    expect(cells).toHaveLength(2);
  });

  // --- Inter-cell blank lines stripped ---

  test("trailing blank lines between cells are stripped", () => {
    const py = `# %%\nx = 1\n\n\n# %%\ny = 2\n`;
    const { cells } = percentToCells(py);
    expect(cells[0]!.source).toBe("x = 1");
    expect(cells[1]!.source).toBe("y = 2");
  });

  // --- No cells ---

  test("empty file produces no cells", () => {
    const { cells } = percentToCells("");
    expect(cells).toHaveLength(0);
  });

  test("header-only file produces no cells", () => {
    const py = [
      "# ---",
      "# jupyter:",
      "#   kernelspec:",
      "#     display_name: Python 3",
      "#     language: python",
      "#     name: python3",
      "# ---",
      "",
    ].join("\n");
    const { cells, metadata } = percentToCells(py);
    expect(cells).toHaveLength(0);
    expect(metadata.kernelspec).toBeDefined();
  });

  // --- Raw cell on top merged into header ---

  test("raw cell on top is reconstructed from merged header", () => {
    const py = [
      "# ---",
      "# title: Quick test",
      "# output:",
      "#   ioslides_presentation:",
      "#     widescreen: true",
      "# jupyter:",
      "#   kernelspec:",
      "#     display_name: Python 3",
      "#     language: python",
      "#     name: python3",
      "# ---",
      "",
      "# %%",
      "1+2+3",
      "",
    ].join("\n");
    const { cells, metadata } = percentToCells(py);
    expect(cells).toHaveLength(2);
    // First cell is the reconstructed raw cell
    expect(cells[0]!.cell_type).toBe("raw");
    expect(cells[0]!.source).toBe(
      "---\ntitle: Quick test\noutput:\n  ioslides_presentation:\n    widescreen: true\n---",
    );
    // Second cell is the code cell
    expect(cells[1]!.cell_type).toBe("code");
    expect(cells[1]!.source).toBe("1+2+3");
    // Metadata still parsed correctly
    expect(metadata.kernelspec).toBeDefined();
  });

  test("header with only jupyter: does NOT produce raw cell", () => {
    const py = [
      "# ---",
      "# jupyter:",
      "#   kernelspec:",
      "#     display_name: Python 3",
      "#     language: python",
      "#     name: python3",
      "# ---",
      "",
      "# %%",
      "x = 1",
      "",
    ].join("\n");
    const { cells } = percentToCells(py);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.cell_type).toBe("code");
  });

  // --- Code cell defaults ---

  test("code cells get execution_count: null and outputs: []", () => {
    const py = `# %%\nx = 1\n`;
    const { cells } = percentToCells(py);
    const cell = cells[0] as any;
    expect(cell.execution_count).toBeNull();
    expect(cell.outputs).toEqual([]);
  });

  // --- Regression: serialize → parse round-trips for tricky metadata ---

  test("metadata with : and , in strings round-trips through serialize→parse (regression #1)", () => {
    const nb: Notebook = {
      nbformat: 4, nbformat_minor: 5,
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
      cells: [{
        cell_type: "code", source: "x = 1",
        metadata: { cfg: { label: "a:b,c", url: "http://example.com" } },
        execution_count: null, outputs: [],
      } as CodeCell],
    };
    const py = ipynbToPercent(nb);
    const { cells } = percentToCells(py);
     expect(cells[0]!.metadata).toEqual({ cfg: { label: "a:b,c", url: "http://example.com" } });
  });

  // --- Regression #7: malformed JSON in metadata should not crash ---

  test("malformed JSON string in metadata does not crash (regression #7)", () => {
    const py = `# %% key="unterminated\nprint("hello")\n`;
    expect(() => {
      const { cells } = percentToCells(py);
      expect(cells).toHaveLength(1);
    }).not.toThrow();
  });

  test("malformed JSON object in metadata does not crash (regression #7)", () => {
    const py = `# %% key={broken\nprint("hello")\n`;
    expect(() => {
      const { cells } = percentToCells(py);
      expect(cells).toHaveLength(1);
    }).not.toThrow();
  });

  test("malformed JSON array in metadata does not crash (regression #7)", () => {
    const py = `# %% key=[1, 2,\nprint("hello")\n`;
    expect(() => {
      const { cells } = percentToCells(py);
      expect(cells).toHaveLength(1);
    }).not.toThrow();
  });
});
