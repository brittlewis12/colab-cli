import { describe, test, expect } from "bun:test";
import { merge } from "../../src/notebook/merge.ts";
import type {
  Cell,
  CodeCell,
  MarkdownCell,
  Notebook,
  NotebookMetadata,
} from "../../src/notebook/types.ts";

// --- Helpers ---

function codeCell(
  source: string,
  opts: {
    id?: string;
    execution_count?: number | null;
    outputs?: any[];
    metadata?: Record<string, unknown>;
  } = {},
): CodeCell {
  return {
    cell_type: "code",
    source,
    metadata: opts.metadata ?? {},
    id: opts.id,
    execution_count: opts.execution_count ?? null,
    outputs: opts.outputs ?? [],
  };
}

function mdCell(
  source: string,
  opts: { id?: string; metadata?: Record<string, unknown> } = {},
): MarkdownCell {
  return {
    cell_type: "markdown",
    source,
    metadata: opts.metadata ?? {},
    id: opts.id,
  };
}

function notebook(cells: Cell[], metadata: NotebookMetadata = {}): Notebook {
  return { nbformat: 4, nbformat_minor: 5, metadata, cells };
}

// --- Tests ---

describe("merge", () => {
  // --- Pass 1: Exact match, in order ---

  test("identical cells preserve IDs and outputs", () => {
    const local = [codeCell("x = 1"), codeCell("y = 2")];
    const remote = notebook([
      codeCell("x = 1", {
        id: "abc",
        execution_count: 1,
        outputs: [{ output_type: "stream", text: "1" }],
      }),
      codeCell("y = 2", {
        id: "def",
        execution_count: 2,
        outputs: [{ output_type: "stream", text: "2" }],
      }),
    ]);

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]!.id).toBe("abc");
    expect((result.cells[0] as CodeCell).execution_count).toBe(1);
    expect((result.cells[0] as CodeCell).outputs).toHaveLength(1);
    expect(result.cells[1]!.id).toBe("def");
  });

  test("whitespace differences still match (normalization)", () => {
    const local = [codeCell("x  =  1")]; // extra spaces
    const remote = notebook([
      codeCell("x = 1", { id: "abc", execution_count: 5 }),
    ]);

    const result = merge(local, {}, remote);
    expect(result.cells[0]!.id).toBe("abc");
    // Source comes from local
    expect(result.cells[0]!.source).toBe("x  =  1");
  });

  // --- New cells ---

  test("new cell gets fresh ID and empty outputs", () => {
    const local = [codeCell("x = 1"), codeCell("y = 2")];
    const remote = notebook([codeCell("x = 1", { id: "abc" })]);

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]!.id).toBe("abc");
    // New cell should have a fresh ID
    expect(result.cells[1]!.id).toBeDefined();
    expect(result.cells[1]!.id).not.toBe("abc");
    expect((result.cells[1] as CodeCell).outputs).toEqual([]);
    expect((result.cells[1] as CodeCell).execution_count).toBeNull();
  });

  // --- Deleted cells ---

  test("deleted cell is dropped from result", () => {
    const local = [codeCell("y = 2")]; // cell "x = 1" deleted
    const remote = notebook([
      codeCell("x = 1", { id: "abc" }),
      codeCell("y = 2", { id: "def" }),
    ]);

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.id).toBe("def");
  });

  // --- Pass 2: Out of order ---

  test("reordered cells match out of order", () => {
    const local = [codeCell("y = 2"), codeCell("x = 1")]; // swapped
    const remote = notebook([
      codeCell("x = 1", { id: "abc", execution_count: 1 }),
      codeCell("y = 2", { id: "def", execution_count: 2 }),
    ]);

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(2);
    // First cell in result should have the ID of remote cell "y = 2"
    expect(result.cells[0]!.id).toBe("def");
    expect(result.cells[0]!.source).toBe("y = 2");
    // Second cell in result should have the ID of remote cell "x = 1"
    expect(result.cells[1]!.id).toBe("abc");
    expect(result.cells[1]!.source).toBe("x = 1");
  });

  // --- Pass 3: Suffix match ---

  test("cell split: suffix matches original", () => {
    // Remote had one cell, local split it into two
    const local = [codeCell("x = 1"), codeCell("y = 2\nz = 3")];
    const remote = notebook([
      codeCell("x = 1\ny = 2\nz = 3", {
        id: "abc",
        execution_count: 1,
        outputs: [{ output_type: "stream", text: "done" }],
      }),
    ]);

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(2);
    // The suffix "y = 2\nz = 3" matches the remote cell
    // "x = 1" doesn't suffix-match (it matches as prefix, not suffix)
    // So "y = 2\nz = 3" gets the remote ID
    expect(result.cells[1]!.id).toBe("abc");
    expect((result.cells[1] as CodeCell).execution_count).toBe(1);
    // "x = 1" is new
    expect(result.cells[0]!.id).toBeDefined();
    expect(result.cells[0]!.id).not.toBe("abc");
  });

  // --- Pass 4: Positional fallback ---

  test("all cells modified falls through to positional match", () => {
    const local = [codeCell("a = 1"), codeCell("b = 2")];
    const remote = notebook([
      codeCell("x = 1", { id: "abc", execution_count: 1 }),
      codeCell("y = 2", { id: "def", execution_count: 2 }),
    ]);

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(2);
    // Positional: local[0] → remote[0], local[1] → remote[1]
    expect(result.cells[0]!.id).toBe("abc");
    expect(result.cells[0]!.source).toBe("a = 1"); // source from local
    expect(result.cells[1]!.id).toBe("def");
    expect(result.cells[1]!.source).toBe("b = 2");
  });

  test("positional respects cell type", () => {
    const local = [mdCell("# Title"), codeCell("x = 1")];
    const remote = notebook([
      codeCell("old code", { id: "abc" }),
      mdCell("old title", { id: "def" }),
    ]);

    const result = merge(local, {}, remote);
    // Markdown local matches markdown remote (by type), even though positions differ
    expect(result.cells[0]!.id).toBe("def"); // markdown matches markdown
    expect(result.cells[1]!.id).toBe("abc"); // code matches code
  });

  // --- Cell type mismatch ---

  test("cell type change treated as delete + add", () => {
    // Remote has code cell, local has markdown with same-ish content
    const local = [mdCell("x = 1")];
    const remote = notebook([codeCell("x = 1", { id: "abc" })]);

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.cell_type).toBe("markdown");
    // Won't match (different types) — gets fresh ID
    expect(result.cells[0]!.id).not.toBe("abc");
  });

  // --- Metadata merge ---

  test("internal metadata preserved from remote", () => {
    const local = [codeCell("x = 1", { metadata: { tags: ["test"] } })];
    const remote = notebook([
      codeCell("x = 1", {
        id: "abc",
        metadata: {
          ExecuteTime: { start: "2024-01-01" },
          tags: ["old"],
        },
      }),
    ]);

    const result = merge(local, {}, remote);
    // ExecuteTime preserved from remote (internal key)
    expect((result.cells[0]!.metadata as any).ExecuteTime).toEqual({
      start: "2024-01-01",
    });
    // tags updated from local
    expect((result.cells[0]!.metadata as any).tags).toEqual(["test"]);
  });

  test("non-internal metadata removed if absent from local", () => {
    const local = [codeCell("x = 1", { metadata: {} })]; // no tags
    const remote = notebook([
      codeCell("x = 1", {
        id: "abc",
        metadata: { tags: ["old"], ExecuteTime: { start: "2024" } },
      }),
    ]);

    const result = merge(local, {}, remote);
    // tags removed (not in local, not internal)
    expect((result.cells[0]!.metadata as any).tags).toBeUndefined();
    // ExecuteTime preserved (internal)
    expect((result.cells[0]!.metadata as any).ExecuteTime).toBeDefined();
  });

  // --- Notebook metadata ---

  test("notebook metadata from remote, kernelspec overridden by local", () => {
    const localMeta = {
      kernelspec: {
        display_name: "Python 3.11",
        language: "python",
        name: "python3",
      },
    };
    const remote = notebook([], {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: { name: "python" } as any,
    });

    const result = merge([], localMeta, remote);
    expect(result.metadata.kernelspec!.display_name).toBe("Python 3.11");
    // language_info preserved from remote
    expect(result.metadata.language_info).toBeDefined();
  });

  test("no local kernelspec preserves remote", () => {
    const remote = notebook([], {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
    });

    const result = merge([], {}, remote);
    expect(result.metadata.kernelspec!.display_name).toBe("Python 3");
  });

  // --- Duplicate cells ---

  test("duplicate cells matched in order", () => {
    const local = [codeCell("x = 1"), codeCell("x = 1")];
    const remote = notebook([
      codeCell("x = 1", { id: "first", execution_count: 1 }),
      codeCell("x = 1", { id: "second", execution_count: 2 }),
    ]);

    const result = merge(local, {}, remote);
    expect(result.cells[0]!.id).toBe("first");
    expect(result.cells[1]!.id).toBe("second");
  });

  // --- Empty notebooks ---

  test("empty local produces empty result", () => {
    const remote = notebook([codeCell("x = 1", { id: "abc" })]);
    const result = merge([], {}, remote);
    expect(result.cells).toHaveLength(0);
  });

  test("empty remote produces all-new cells", () => {
    const local = [codeCell("x = 1")];
    const remote = notebook([]);
    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]!.id).toBeDefined();
  });

  // --- Markdown cell merge ---

  test("markdown cells preserve IDs", () => {
    const local = [mdCell("# Updated Title")];
    const remote = notebook([mdCell("# Title", { id: "md1" })]);

    // Different content, same type — falls to positional
    const result = merge(local, {}, remote);
    expect(result.cells[0]!.id).toBe("md1");
    expect(result.cells[0]!.source).toBe("# Updated Title");
  });

  // --- Regression #11: Pass 4 span-bounded matching ---

  test("within-gap ambiguity assigns FIFO (regression #11 limitation)", () => {
    // Remote: [A, B, C], Local: [B_modified, C]
    // User deleted A and edited B, but within a single gap this is
    // indistinguishable from "edited A, deleted B". FIFO assigns
    // B_modified → A's ID. This is an inherent limitation of
    // positional heuristics without content similarity.
    const remote = notebook([
      codeCell("a = 1", { id: "id-a", execution_count: 1 }),
      codeCell("b = 2", { id: "id-b", execution_count: 2 }),
      codeCell("c = 3", { id: "id-c", execution_count: 3 }),
    ]);
    const local = [
      codeCell("b = 222"),  // edited (ambiguous which remote it came from)
      codeCell("c = 3"),    // unchanged C
    ];

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(2);
    expect(result.cells[1]!.id).toBe("id-c");
    // Within-gap FIFO: B_modified gets A's ID (first in gap)
    expect(result.cells[0]!.id).toBe("id-a");
  });

  test("delete last cell + edit second-to-last gets correct ID (regression #11)", () => {
    // Remote: [A, B, C], Local: [A, B_modified]
    // User deleted C and edited B. B_modified should get B's ID.
    const remote = notebook([
      codeCell("a = 1", { id: "id-a", execution_count: 1 }),
      codeCell("b = 2", { id: "id-b", execution_count: 2 }),
      codeCell("c = 3", { id: "id-c", execution_count: 3 }),
    ]);
    const local = [
      codeCell("a = 1"),    // unchanged A
      codeCell("b = 222"),  // edited B
    ];

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(2);
    expect(result.cells[0]!.id).toBe("id-a");
    // B_modified should get B's ID (nearest to anchor), not C's
    expect(result.cells[1]!.id).toBe("id-b");
  });

  test("delete middle cell, edit remains get correct IDs (regression #11)", () => {
    // Remote: [A, B, C, D], Local: [A_modified, C, D_modified]
    // User deleted B, edited A and D.
    const remote = notebook([
      codeCell("a = 1", { id: "id-a" }),
      codeCell("b = 2", { id: "id-b" }),
      codeCell("c = 3", { id: "id-c" }),
      codeCell("d = 4", { id: "id-d" }),
    ]);
    const local = [
      codeCell("a = 111"),  // edited A
      codeCell("c = 3"),    // unchanged C
      codeCell("d = 444"),  // edited D
    ];

    const result = merge(local, {}, remote);
    expect(result.cells).toHaveLength(3);
    // A_modified is before anchor C→id-c; only unmatched remote before C is A, B
    // A_modified should get A's ID (right-aligned: closest to start of gap)
    expect(result.cells[0]!.id).toBe("id-a");
    expect(result.cells[1]!.id).toBe("id-c");
    // D_modified is after anchor C→id-c; only unmatched remote after C is D
    expect(result.cells[2]!.id).toBe("id-d");
  });
});
