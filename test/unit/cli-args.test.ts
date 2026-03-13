/**
 * CLI argument validation tests.
 *
 * Tests that all commands return USAGE errors for missing/bad args.
 * No auth, network, or filesystem mocking needed — commands check
 * args before touching anything else.
 */

import { describe, test, expect } from "bun:test";
import { killCommand } from "../../src/cli/kill.ts";
import { pullCommand } from "../../src/cli/pull.ts";
import { pushCommand } from "../../src/cli/push.ts";
import { runNotebookCommand } from "../../src/cli/run.ts";
import { execCommand } from "../../src/cli/exec.ts";
import { ensureCommand } from "../../src/cli/ensure.ts";
import { authCommand } from "../../src/cli/auth.ts";
import { secretsCommand } from "../../src/cli/secrets.ts";
import { statusCommand } from "../../src/cli/status.ts";

// ── kill ─────────────────────────────────────────────────────────────────

describe("kill arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await killCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("kill");
  });
});

// ── pull ─────────────────────────────────────────────────────────────────

describe("pull arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await pullCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("pull");
  });
});

// ── push ─────────────────────────────────────────────────────────────────

describe("push arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await pushCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("push");
  });
});

// ── run ──────────────────────────────────────────────────────────────────

describe("run arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await runNotebookCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("run");
  });
});

// ── exec ─────────────────────────────────────────────────────────────────

describe("exec arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await execCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("exec");
  });

  test("name but no code → USAGE", async () => {
    const r = await execCommand(["mynotebook"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("exec");
  });
});

// ── ensure ───────────────────────────────────────────────────────────────

describe("ensure arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await ensureCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("ensure");
  });

  test("name but no --gpu → USAGE", async () => {
    const r = await ensureCommand(["mynotebook"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("ensure");
  });
});

// ── exec --timeout ───────────────────────────────────────────────────────

describe("exec --timeout validation", () => {
  test("invalid --timeout → USAGE", async () => {
    const r = await execCommand(["nb", "print(1)", "--timeout", "abc"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });

  test("negative --timeout → USAGE", async () => {
    const r = await execCommand(["nb", "print(1)", "--timeout", "-5"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });
});

// ── run --timeout ────────────────────────────────────────────────────────

describe("run --timeout validation", () => {
  test("invalid --timeout → USAGE", async () => {
    const r = await runNotebookCommand(["nb", "--timeout", "abc"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });

  test("negative --timeout → USAGE", async () => {
    const r = await runNotebookCommand(["nb", "--timeout", "-5"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });
});

// ── secrets ──────────────────────────────────────────────────────────────

describe("secrets arg validation", () => {
  test("no subcommand → USAGE", async () => {
    const r = await secretsCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("secrets");
  });

  test("unknown subcommand → USAGE", async () => {
    const r = await secretsCommand(["bogus"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });
});

// ── auth ─────────────────────────────────────────────────────────────────

describe("auth arg validation", () => {
  test("no subcommand → USAGE", async () => {
    const r = await authCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("auth");
  });

  test("unknown subcommand → USAGE", async () => {
    const r = await authCommand(["bogus"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });
});
