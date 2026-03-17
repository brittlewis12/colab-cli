import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { readJson, writeJson, removeFile } from "../../src/state/store.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "colab-store-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readJson", () => {
  test("returns null for missing file", async () => {
    expect(await readJson(join(tmpDir, "nope.json"))).toBeNull();
  });

  test("parses JSON file", async () => {
    const path = join(tmpDir, "data.json");
    await Bun.write(path, '{"x":1}');
    const result = await readJson<{ x: number }>(path);
    expect(result).not.toBeNull();
    expect(result!).toEqual({ x: 1 });
  });
});

describe("writeJson", () => {
  test("creates file with formatted JSON", async () => {
    const path = join(tmpDir, "out.json");
    await writeJson(path, { a: "b", c: 2 });
    const text = await readFile(path, "utf-8");
    expect(JSON.parse(text)).toEqual({ a: "b", c: 2 });
    expect(text).toContain("\n"); // formatted, not minified
  });

  test("creates parent directories", async () => {
    const path = join(tmpDir, "nested", "deep", "out.json");
    await writeJson(path, { ok: true });
    const result = await readJson<{ ok: boolean }>(path);
    expect(result).not.toBeNull();
    expect(result!).toEqual({ ok: true });
  });

  test("atomic: .tmp file does not persist", async () => {
    const path = join(tmpDir, "atomic.json");
    await writeJson(path, { x: 1 });
    // .tmp should not exist after rename
    let tmpExists = true;
    try {
      await stat(path + ".tmp");
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });

  test("overwrites existing file", async () => {
    const path = join(tmpDir, "over.json");
    await writeJson(path, { v: 1 });
    await writeJson(path, { v: 2 });
    const result2 = await readJson<{ v: number }>(path);
    expect(result2).not.toBeNull();
    expect(result2!).toEqual({ v: 2 });
  });
});

describe("removeFile", () => {
  test("deletes existing file", async () => {
    const path = join(tmpDir, "del.json");
    await writeJson(path, {});
    await removeFile(path);
    expect(await readJson(path)).toBeNull();
  });

  test("no-op for missing file", async () => {
    await removeFile(join(tmpDir, "nope.json")); // should not throw
  });
});
