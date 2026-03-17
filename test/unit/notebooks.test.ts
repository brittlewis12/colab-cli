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
  isValidNotebookName,
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
    accelerator: "t4",
    variant: "gpu",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Name validation ──────────────────────────────────────────────────────

describe("isValidNotebookName", () => {
  test("accepts simple alphanumeric names", () => {
    expect(isValidNotebookName("train")).toBe(true);
    expect(isValidNotebookName("myNotebook")).toBe(true);
    expect(isValidNotebookName("experiment1")).toBe(true);
  });

  test("accepts names with hyphens, underscores, dots", () => {
    expect(isValidNotebookName("my-experiment")).toBe(true);
    expect(isValidNotebookName("my_experiment")).toBe(true);
    expect(isValidNotebookName("my.experiment")).toBe(true);
    expect(isValidNotebookName("v2.1-final_run")).toBe(true);
  });

  test("rejects empty name", () => {
    expect(isValidNotebookName("")).toBe(false);
  });

  test("rejects path traversal", () => {
    expect(isValidNotebookName("../../../etc/passwd")).toBe(false);
    expect(isValidNotebookName("..")).toBe(false);
    expect(isValidNotebookName("foo/../bar")).toBe(false);
    expect(isValidNotebookName("foo..bar")).toBe(false);
  });

  test("rejects names starting with dot", () => {
    expect(isValidNotebookName(".hidden")).toBe(false);
    expect(isValidNotebookName(".")).toBe(false);
  });

  test("rejects names with path separators", () => {
    expect(isValidNotebookName("foo/bar")).toBe(false);
    expect(isValidNotebookName("foo\\bar")).toBe(false);
  });

  test("rejects names with spaces or special characters", () => {
    expect(isValidNotebookName("foo bar")).toBe(false);
    expect(isValidNotebookName("foo@bar")).toBe(false);
    expect(isValidNotebookName("foo$bar")).toBe(false);
  });

  test("rejects names starting with hyphen or underscore", () => {
    expect(isValidNotebookName("-name")).toBe(false);
    expect(isValidNotebookName("_name")).toBe(false);
  });
});

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

  test("path functions throw on path traversal names", () => {
    expect(() => contentsPath("../../../etc/passwd")).toThrow("Invalid notebook name");
    expect(() => localPyPath("/project", "..")).toThrow("Invalid notebook name");
    expect(() => statePath("/project", "foo/../bar")).toThrow("Invalid notebook name");
    expect(() => cachePath("/project", ".hidden")).toThrow("Invalid notebook name");
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

  test("loadNotebookState migrates legacy gpu field to accelerator + infers variant", async () => {
    const legacyState = {
      notebookHash: "abc_def_123..........",
      endpoint: "gpu-t4-s-test",
      gpu: "t4",
      createdAt: new Date().toISOString(),
    };
    const { writeJson } = await import("../../src/state/store.ts");
    const { statePath } = await import("../../src/state/notebooks.ts");
    await writeJson(statePath(tmpDir, "legacy"), legacyState);

    const loaded = await loadNotebookState(tmpDir, "legacy");
    expect(loaded).not.toBeNull();
    expect(loaded!.accelerator).toBe("t4");
    expect(loaded!.variant).toBe("gpu");
    expect((loaded as any).gpu).toBeUndefined();
  });

  test("loadNotebookState migrates legacy gpu=none to accelerator=cpu, variant=cpu", async () => {
    const legacyState = {
      notebookHash: "abc_def_123..........",
      endpoint: "m-s-test",
      gpu: "none",
      createdAt: new Date().toISOString(),
    };
    const { writeJson } = await import("../../src/state/store.ts");
    const { statePath } = await import("../../src/state/notebooks.ts");
    await writeJson(statePath(tmpDir, "legacy-cpu"), legacyState);

    const loaded = await loadNotebookState(tmpDir, "legacy-cpu");
    expect(loaded).not.toBeNull();
    expect(loaded!.accelerator).toBe("cpu");
    expect(loaded!.variant).toBe("cpu");
  });

  test("loadNotebookState cleans stale gpu field when accelerator exists", async () => {
    const mixedState = {
      notebookHash: "abc_def_123..........",
      endpoint: "gpu-t4-s-test",
      accelerator: "a100",
      variant: "gpu",
      gpu: "t4", // stale leftover
      createdAt: new Date().toISOString(),
    };
    const { writeJson } = await import("../../src/state/store.ts");
    const { statePath } = await import("../../src/state/notebooks.ts");
    await writeJson(statePath(tmpDir, "mixed"), mixedState);

    const loaded = await loadNotebookState(tmpDir, "mixed");
    expect(loaded).not.toBeNull();
    expect(loaded!.accelerator).toBe("a100"); // accelerator takes precedence
    expect((loaded as any).gpu).toBeUndefined();
  });

  test("loadNotebookState handles empty gpu string", async () => {
    const legacyState = {
      notebookHash: "abc_def_123..........",
      endpoint: "m-s-test",
      gpu: "",
      createdAt: new Date().toISOString(),
    };
    const { writeJson } = await import("../../src/state/store.ts");
    const { statePath } = await import("../../src/state/notebooks.ts");
    await writeJson(statePath(tmpDir, "empty-gpu"), legacyState);

    const loaded = await loadNotebookState(tmpDir, "empty-gpu");
    expect(loaded).not.toBeNull();
    expect(loaded!.accelerator).toBe("cpu");
    expect(loaded!.variant).toBe("cpu");
  });

  test("loadNotebookState infers variant=tpu for TPU accelerator without variant field", async () => {
    const noVariantState = {
      notebookHash: "abc_def_123..........",
      endpoint: "tpu-v5e1-s-test",
      accelerator: "v5e1",
      createdAt: new Date().toISOString(),
    };
    const { writeJson } = await import("../../src/state/store.ts");
    const { statePath } = await import("../../src/state/notebooks.ts");
    await writeJson(statePath(tmpDir, "tpu-no-variant"), noVariantState);

    const loaded = await loadNotebookState(tmpDir, "tpu-no-variant");
    expect(loaded).not.toBeNull();
    expect(loaded!.variant).toBe("tpu");
  });

  test("loadNotebookState does NOT write to disk during migration (no write-on-read)", async () => {
    const legacyState = {
      notebookHash: "abc_def_123..........",
      endpoint: "gpu-t4-s-test",
      gpu: "t4",
      createdAt: new Date().toISOString(),
    };
    const { writeJson, readJson: rawRead } = await import("../../src/state/store.ts");
    const { statePath } = await import("../../src/state/notebooks.ts");
    const path = statePath(tmpDir, "no-write");
    await writeJson(path, legacyState);

    await loadNotebookState(tmpDir, "no-write");

    // The file on disk should still have the legacy "gpu" field
    const raw = await rawRead<Record<string, unknown>>(path);
    expect(raw!.gpu).toBe("t4"); // NOT migrated on disk
  });

  test("deleteNotebookState removes state but preserves .ipynb cache", async () => {
    await saveNotebookState(tmpDir, "train", makeState());
    // Write a fake cache file
    const cache = cachePath(tmpDir, "train");
    await writeFile(cache, "{}");

    await deleteNotebookState(tmpDir, "train");
    expect(await loadNotebookState(tmpDir, "train")).toBeNull();
    // Cache should be preserved for reclamation recovery
    const { stat: fsStat } = await import("fs/promises");
    const cacheExists = await fsStat(cache).then(() => true, () => false);
    expect(cacheExists).toBe(true);
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
