import { describe, test, expect } from "bun:test";
import {
  ok,
  err,
  exitCode,
  ensureFlag,
  EXIT,
  type CommandResult,
} from "../../src/cli/output.ts";

describe("ok", () => {
  test("creates success result with data", () => {
    const r = ok("test", { x: 1 });
    expect(r.ok).toBe(true);
    expect(r.command).toBe("test");
    expect(r.data).toEqual({ x: 1 });
    expect(r.error).toBeUndefined();
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("creates success result without data", () => {
    const r = ok("test");
    expect(r.ok).toBe(true);
    expect(r.data).toBeUndefined();
  });
});

describe("err", () => {
  test("creates error result with code, message, hint", () => {
    const r = err("test", "AUTH", "not logged in", "run: colab auth login");
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("AUTH");
    expect(r.error!.message).toBe("not logged in");
    expect(r.error!.hint).toBe("run: colab auth login");
  });

  test("data and error can coexist", () => {
    const r = err("run", "EXEC_ERROR", "ZeroDivisionError", undefined, {
      stdout: "partial output",
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("EXEC_ERROR");
    expect(r.data).toEqual({ stdout: "partial output" });
  });

  test("hint is omitted when undefined", () => {
    const r = err("test", "ERROR", "oops");
    expect(r.error!.hint).toBeUndefined();
    expect("hint" in r.error!).toBe(false);
  });
});

describe("exitCode", () => {
  test("maps error codes to exit codes", () => {
    expect(exitCode("USAGE")).toBe(EXIT.USAGE);
    expect(exitCode("NOT_FOUND")).toBe(EXIT.NOT_FOUND);
    expect(exitCode("AUTH")).toBe(EXIT.AUTH);
    expect(exitCode("QUOTA_EXCEEDED")).toBe(EXIT.QUOTA);
    expect(exitCode("TIMEOUT")).toBe(EXIT.TIMEOUT);
    expect(exitCode("EXEC_ERROR")).toBe(EXIT.EXEC_ERROR);
    expect(exitCode("ERROR")).toBe(EXIT.ERROR);
    expect(exitCode("DIRTY")).toBe(EXIT.ERROR);
  });
});

describe("ensureFlag", () => {
  test("GPU variant produces --gpu flag", () => {
    expect(ensureFlag("gpu", "t4")).toBe("--gpu t4");
    expect(ensureFlag("gpu", "a100")).toBe("--gpu a100");
    expect(ensureFlag("gpu", "v100")).toBe("--gpu v100");
  });

  test("TPU variant produces --tpu flag", () => {
    expect(ensureFlag("tpu", "v5e1")).toBe("--tpu v5e1");
    expect(ensureFlag("tpu", "v6e1")).toBe("--tpu v6e1");
  });

  test("CPU variant produces --cpu-only flag", () => {
    expect(ensureFlag("cpu", "cpu")).toBe("--cpu-only");
    expect(ensureFlag("cpu", "")).toBe("--cpu-only");
  });

  test("highMem appends --high-mem flag", () => {
    expect(ensureFlag("gpu", "t4", true)).toBe("--gpu t4 --high-mem");
    expect(ensureFlag("tpu", "v5e1", true)).toBe("--tpu v5e1 --high-mem");
    expect(ensureFlag("gpu", "a100", false)).toBe("--gpu a100");
    expect(ensureFlag("cpu", "cpu", true)).toBe("--cpu-only");
  });
});


