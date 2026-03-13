import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  contentsPath,
  localPyPath,
  statePath,
  cachePath,
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  deleteNotebookState,
  listNotebookNames,
  hashFile,
  isDirty,
  type NotebookState,
} from "../../src/state/notebooks.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "colab-nb-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeState(overrides?: Partial<NotebookState>): NotebookState {
  return {
    notebookHash: "abc_def_123..........",
    endpoint: "gpu-t4-s-test",
    gpu: "t4",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Path conventions ─────────────────────────────────────────────────────

describe("path conventions", () => {
  test("contentsPath returns content/<name>.ipynb", () => {
    expect(contentsPath("training")).toBe("content/training.ipynb");
    expect(contentsPath("my-experiment")).toBe("content/my-experiment.ipynb");
  });

  test("localPyPath returns <root>/<name>.py", () => {
    expect(localPyPath("/project", "training")).toBe("/project/training.py");
  });

  test("statePath returns .colab/notebooks/<name>.json", () => {
    expect(statePath("/project", "training")).toBe(
      "/project/.colab/notebooks/training.json",
    );
  });

  test("cachePath returns .colab/notebooks/<name>.ipynb", () => {
    expect(cachePath("/project", "training")).toBe(
      "/project/.colab/notebooks/training.ipynb",
    );
  });
});

// ── Project root discovery ───────────────────────────────────────────────

describe("findProjectRoot", () => {
  test("finds .colab/ in ancestor directory", async () => {
    const root = join(tmpDir, "project");
    const sub = join(root, "src", "deep");
    await mkdir(join(root, ".colab"), { recursive: true });
    await mkdir(sub, { recursive: true });

    const found = await findProjectRoot(sub);
    expect(found).toBe(root);
  });

  test("returns from dir when no .colab/ found", async () => {
    const dir = join(tmpDir, "no-colab");
    await mkdir(dir, { recursive: true });

    const found = await findProjectRoot(dir);
    expect(found).toBe(dir);
  });
});

// ── State operations ─────────────────────────────────────────────────────

describe("notebook state", () => {
  test("loadNotebookState returns null when not found", async () => {
    expect(await loadNotebookState(tmpDir, "nope")).toBeNull();
  });

  test("save and load round-trip", async () => {
    const state = makeState();
    await saveNotebookState(tmpDir, "train", state);
    const loaded = await loadNotebookState(tmpDir, "train");
    expect(loaded).toEqual(state);
  });

  test("deleteNotebookState removes state and cache", async () => {
    await saveNotebookState(tmpDir, "train", makeState());
    // Write a fake cache file
    const cache = cachePath(tmpDir, "train");
    await writeFile(cache, "{}");

    await deleteNotebookState(tmpDir, "train");
    expect(await loadNotebookState(tmpDir, "train")).toBeNull();
  });

  test("deleteNotebookState is no-op when not found", async () => {
    await deleteNotebookState(tmpDir, "nope"); // should not throw
  });
});

// ── List notebooks ───────────────────────────────────────────────────────

describe("listNotebookNames", () => {
  test("returns empty for no notebooks", async () => {
    expect(await listNotebookNames(tmpDir)).toEqual([]);
  });

  test("returns names from .json files", async () => {
    await saveNotebookState(tmpDir, "alpha", makeState());
    await saveNotebookState(tmpDir, "beta", makeState());

    const names = await listNotebookNames(tmpDir);
    expect(names.sort()).toEqual(["alpha", "beta"]);
  });
});

// ── Dirty state ──────────────────────────────────────────────────────────

describe("dirty state", () => {
  test("isDirty returns true when no pushedHash and .py exists", async () => {
    const pyPath = localPyPath(tmpDir, "train");
    await writeFile(pyPath, "# never pushed\n");
    await saveNotebookState(tmpDir, "train", makeState());
    expect(await isDirty(tmpDir, "train")).toBe(true);
  });

  test("isDirty returns false when no pushedHash and no .py file", async () => {
    // No .py file = nothing to push/overwrite = not dirty
    await saveNotebookState(tmpDir, "train", makeState());
    expect(await isDirty(tmpDir, "train")).toBe(false);
  });

  test("hashFile returns sha256: prefixed hex", async () => {
    const pyPath = localPyPath(tmpDir, "train");
    await writeFile(pyPath, "print('hello')\n");
    const hash = await hashFile(pyPath);
    expect(hash).toStartWith("sha256:");
    expect(hash.slice(7)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("isDirty returns false when hash matches", async () => {
    const pyPath = localPyPath(tmpDir, "train");
    await writeFile(pyPath, "print('hello')\n");
    const hash = await hashFile(pyPath);

    await saveNotebookState(tmpDir, "train", makeState({ pushedHash: hash }));
    expect(await isDirty(tmpDir, "train")).toBe(false);
  });

  test("isDirty returns true when hash differs", async () => {
    const pyPath = localPyPath(tmpDir, "train");
    await writeFile(pyPath, "print('hello')\n");

    await saveNotebookState(
      tmpDir,
      "train",
      makeState({ pushedHash: "sha256:different" }),
    );
    expect(await isDirty(tmpDir, "train")).toBe(true);
  });

  test("isDirty returns false when .py doesn't exist", async () => {
    await saveNotebookState(
      tmpDir,
      "train",
      makeState({ pushedHash: "sha256:something" }),
    );
    // No .py file — nothing to push
    expect(await isDirty(tmpDir, "train")).toBe(false);
  });
});
