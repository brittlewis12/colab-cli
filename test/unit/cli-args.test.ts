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
import { restartCommand } from "../../src/cli/restart.ts";
import { interruptCommand } from "../../src/cli/interrupt.ts";
import { diffCommand } from "../../src/cli/diff.ts";
import { uploadCommand } from "../../src/cli/upload.ts";
import { downloadCommand } from "../../src/cli/download.ts";
import { adoptCommand } from "../../src/cli/adopt.ts";

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

  test("name but no accelerator flag → USAGE", async () => {
    const r = await ensureCommand(["mynotebook"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("accelerator flag");
  });

  test("--gpu and --tpu together → USAGE (mutual exclusion)", async () => {
    const r = await ensureCommand(["mynotebook", "--gpu", "t4", "--tpu", "v5e1"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("exactly one");
  });

  test("--gpu and --cpu-only together → USAGE (mutual exclusion)", async () => {
    const r = await ensureCommand(["mynotebook", "--gpu", "t4", "--cpu-only"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("exactly one");
  });

  test("--tpu and --cpu-only together → USAGE (mutual exclusion)", async () => {
    const r = await ensureCommand(["mynotebook", "--tpu", "v5e1", "--cpu-only"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("exactly one");
  });

  test("--gpu without model arg → USAGE", async () => {
    const r = await ensureCommand(["mynotebook", "--gpu"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("--gpu requires a model");
  });

  test("--tpu without model arg → USAGE", async () => {
    const r = await ensureCommand(["mynotebook", "--tpu"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("--tpu requires a model");
  });

  test("--gpu with flag as model → USAGE (--gpu --tpu)", async () => {
    const r = await ensureCommand(["mynotebook", "--gpu", "--tpu", "v5e1"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("--gpu requires a model");
  });

  test("--tpu with flag as model → USAGE (--tpu --gpu)", async () => {
    const r = await ensureCommand(["mynotebook", "--tpu", "--gpu", "t4"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("--tpu requires a model");
  });

  test("--gpu with --high-mem as model → USAGE", async () => {
    const r = await ensureCommand(["mynotebook", "--gpu", "--high-mem"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("--gpu requires a model");
  });

  test("--gpu with single-dash arg as model → USAGE", async () => {
    const r = await ensureCommand(["mynotebook", "--gpu", "-v"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("--gpu requires a model");
  });

  test("duplicate --gpu flags → USAGE", async () => {
    const r = await ensureCommand(["mynotebook", "--gpu", "t4", "--gpu", "a100"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("Duplicate --gpu");
  });

  test("duplicate --tpu flags → USAGE", async () => {
    const r = await ensureCommand(["mynotebook", "--tpu", "v5e1", "--tpu", "v6e1"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.error!.message).toContain("Duplicate --tpu");
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

// ── restart ──────────────────────────────────────────────────────────────

describe("restart arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await restartCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("restart");
  });
});

// ── interrupt ────────────────────────────────────────────────────────────

describe("interrupt arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await interruptCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("interrupt");
  });
});

// ── diff ─────────────────────────────────────────────────────────────────

describe("diff arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await diffCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("diff");
  });
});

// ── upload ───────────────────────────────────────────────────────────────

describe("upload arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await uploadCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("upload");
  });

  test("no local path → USAGE", async () => {
    const r = await uploadCommand(["nb"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });

  test("no remote path → USAGE", async () => {
    const r = await uploadCommand(["nb", "file.csv"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });
});

// ── download ─────────────────────────────────────────────────────────────

describe("download arg validation", () => {
  test("no name → USAGE", async () => {
    const r = await downloadCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("download");
  });

  test("no remote path → USAGE", async () => {
    const r = await downloadCommand(["nb"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });

  test("no local path → USAGE", async () => {
    const r = await downloadCommand(["nb", "data.csv"]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
  });
});

// ── adopt ────────────────────────────────────────────────────────────────

describe("adopt arg validation", () => {
  test("no endpoint → USAGE", async () => {
    const r = await adoptCommand([]);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("USAGE");
    expect(r.command).toBe("adopt");
  });

  test("no --name → USAGE", async () => {
    const r = await adoptCommand(["gpu-t4-s-abc123"]);
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
