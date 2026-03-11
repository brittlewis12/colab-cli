import { describe, test, expect } from "bun:test";
import { parseIpynb, serializeIpynb } from "../../src/notebook/ipynb.ts";
import { ipynbToPercent } from "../../src/notebook/serialize.ts";
import { percentToCells } from "../../src/notebook/parse.ts";
import type { Notebook } from "../../src/notebook/types.ts";

describe("parseIpynb", () => {
  test("parses basic notebook", async () => {
    const json = await Bun.file(
      "test/fixtures/golden/jupyter.ipynb",
    ).text();
    const nb = parseIpynb(json);

    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(2);
    expect(nb.cells).toHaveLength(6);

    // First cell is markdown
    expect(nb.cells[0]!.cell_type).toBe("markdown");
    expect(nb.cells[0]!.source).toContain("# Jupyter notebook");

    // Second cell is code with output
    const code = nb.cells[1]!;
    expect(code.cell_type).toBe("code");
    expect(code.source).toBe("a = 1\nb = 2\na + b");
    if (code.cell_type === "code") {
      expect(code.execution_count).toBe(1);
      expect(code.outputs).toHaveLength(1);
      expect(code.outputs[0]!.output_type).toBe("execute_result");
    }

    // Kernelspec
    expect(nb.metadata.kernelspec?.name).toBe("python3");
  });

  test("normalizes source arrays to strings", () => {
    const json = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: "code",
          source: ["line1\n", "line2"],
          metadata: {},
          outputs: [],
          execution_count: null,
        },
      ],
    });
    const nb = parseIpynb(json);
    expect(nb.cells[0]!.source).toBe("line1\nline2");
  });

  test("handles string source (not array)", () => {
    const json = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: "code",
          source: "single string",
          metadata: {},
          outputs: [],
          execution_count: null,
        },
      ],
    });
    const nb = parseIpynb(json);
    expect(nb.cells[0]!.source).toBe("single string");
  });

  test("preserves cell IDs (nbformat 4.5)", () => {
    const json = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: "code",
          source: "",
          metadata: {},
          outputs: [],
          execution_count: null,
          id: "abc-123",
        },
      ],
    });
    const nb = parseIpynb(json);
    expect(nb.cells[0]!.id).toBe("abc-123");
  });
});

describe("serializeIpynb", () => {
  test("round-trips basic notebook", async () => {
    const json = await Bun.file(
      "test/fixtures/golden/jupyter.ipynb",
    ).text();
    const nb = parseIpynb(json);
    const serialized = serializeIpynb(nb);
    const nb2 = parseIpynb(serialized);

    expect(nb2.nbformat).toBe(nb.nbformat);
    expect(nb2.cells).toHaveLength(nb.cells.length);
    for (let i = 0; i < nb.cells.length; i++) {
      expect(nb2.cells[i]!.cell_type).toBe(nb.cells[i]!.cell_type);
      expect(nb2.cells[i]!.source).toBe(nb.cells[i]!.source);
    }
  });

  test("splits source into lines", () => {
    const nb = parseIpynb(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: "code",
            source: "a = 1\nb = 2",
            metadata: {},
            outputs: [],
            execution_count: null,
          },
        ],
      }),
    );
    const serialized = serializeIpynb(nb);
    const raw = JSON.parse(serialized);
    // Source should be split into array
    expect(raw.cells[0].source).toEqual(["a = 1\n", "b = 2"]);
  });

  test("empty source produces empty array", () => {
    const nb = parseIpynb(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: "code",
            source: "",
            metadata: {},
            outputs: [],
            execution_count: null,
          },
        ],
      }),
    );
    const serialized = serializeIpynb(nb);
    const raw = JSON.parse(serialized);
    expect(raw.cells[0].source).toEqual([]);
  });

  test("raw cell on top not dropped when no kernelspec (regression #6)", () => {
    const nb: Notebook = {
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [
        { cell_type: "raw", source: "---\ntitle: test\n---", metadata: {} },
        { cell_type: "code", source: "print(1)", metadata: {}, execution_count: null, outputs: [] },
      ],
    };
    const py = ipynbToPercent(nb);
    const { cells } = percentToCells(py);
    // Raw cell should survive, not be silently dropped
    expect(cells.length).toBe(2);
    expect(cells[0]!.cell_type).toBe("raw");
    expect(cells[1]!.cell_type).toBe("code");
  });

  test("JSON object output data preserved on round-trip (regression #2)", () => {
    // Plotly outputs use JSON objects in data, not string arrays
    const plotlyData = { data: [{ type: "bar", y: [1, 2] }], layout: {} };
    const json = JSON.stringify({
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [{
        cell_type: "code", source: "fig.show()", metadata: {},
        execution_count: 1,
        outputs: [{
          output_type: "display_data",
          data: {
            "application/vnd.plotly.v1+json": plotlyData,
            "text/plain": ["<Figure>"],
          },
          metadata: {},
        }],
      }],
    });

    const nb = parseIpynb(json);
    const serialized = serializeIpynb(nb);
    const raw = JSON.parse(serialized);
    const outData = raw.cells[0].outputs[0].data;

    // Plotly JSON should survive as an object, not become a stringified array
    expect(outData["application/vnd.plotly.v1+json"]).toEqual(plotlyData);
    // Text should still be an array
    expect(outData["text/plain"]).toEqual(["<Figure>"]);
  });
});
