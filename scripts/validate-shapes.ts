#!/usr/bin/env bun
/**
 * Empirical validation: which accelerator models require high-mem shape?
 *
 * For each eligible accelerator on the authenticated account, attempts
 * assignment with standard shape, then high-mem shape. Records results
 * and classifies each model.
 *
 * Usage: bun scripts/validate-shapes.ts
 * Requires: prior `colab auth login`
 *
 * WARNING: This creates real runtimes and consumes compute units.
 * Each successful assignment is immediately unassigned.
 */

import { getAccessToken } from "../src/auth/tokens.ts";
import { ColabClient, ColabApiError } from "../src/colab/client.ts";
import { notebookHash, Variant, Shape, Outcome } from "../src/colab/types.ts";

const client = new ColabClient();

// ── Global cleanup registry ──────────────────────────────────────────────

const activeEndpoints = new Set<string>();
let aborted = false;

async function cleanupAll(signal: string) {
  if (aborted) return; // prevent re-entrant cleanup
  aborted = true;
  console.error(`\n${signal} received — cleaning up ${activeEndpoints.size} active runtime(s)...`);
  const token = await getAccessToken();
  for (const ep of activeEndpoints) {
    try {
      await client.unassign(token, ep);
      console.error(`  Cleaned up ${ep}`);
    } catch (e) {
      console.error(`  FAILED to clean up ${ep}: ${e}`);
    }
  }
  process.exit(130);
}

process.on("SIGINT", () => cleanupAll("SIGINT"));
process.on("SIGTERM", () => cleanupAll("SIGTERM"));

// ── Helpers ──────────────────────────────────────────────────────────────

/** Wait until an endpoint disappears from listAssignments. */
async function waitForUnassign(token: string, endpoint: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const assignments = await client.listAssignments(token);
    if (!assignments.some((a) => a.endpoint === endpoint)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Unassign and verify, tracking in the global registry. */
async function safeUnassign(token: string, endpoint: string): Promise<boolean> {
  try {
    await client.unassign(token, endpoint);
  } catch (e) {
    console.error(`  Unassign failed: ${e}`);
  }
  activeEndpoints.delete(endpoint);
  const gone = await waitForUnassign(token, endpoint);
  if (!gone) {
    console.error(`  WARNING: endpoint ${endpoint} still visible after unassign`);
  }
  return gone;
}

type ProbeResult =
  | { status: "ok"; endpoint: string; outcome: number; machineShape: number; reused: boolean }
  | { status: "error"; error: string; httpStatus?: number };

/** Attempt a single assignment. Returns structured result, never throws. */
async function probe(
  token: string,
  variant: Variant,
  accelerator: string,
  shape?: Shape,
): Promise<ProbeResult> {
  try {
    const result = await client.assign(token, {
      notebookHash: notebookHash(),
      variant,
      accelerator,
      shape,
    });
    activeEndpoints.add(result.endpoint);
    // assign() can return a reused assignment via GET path, which may
    // lack outcome/machineShape. Treat as present but flag if missing.
    return {
      status: "ok",
      endpoint: result.endpoint,
      outcome: result.outcome ?? -1,
      machineShape: result.machineShape ?? -1,
      reused: result.outcome === undefined,
    };
  } catch (e) {
    return {
      status: "error",
      error: String(e).slice(0, 500),
      httpStatus: e instanceof ColabApiError ? e.status : undefined,
    };
  }
}

/** Classify whether an error looks like quota/capacity vs shape rejection. */
function isQuotaOrTransient(r: ProbeResult): boolean {
  if (r.status !== "error") return false;
  const s = r.error.toLowerCase();
  return (
    s.includes("quota") ||
    s.includes("capacity") ||
    s.includes("429") ||
    s.includes("503") ||
    s.includes("500") ||
    (r.httpStatus !== undefined && r.httpStatus >= 500)
  );
}

// ── Result types ─────────────────────────────────────────────────────────

type ShapeStatus = "standard_ok" | "requires_highmem" | "inconclusive";

interface ModelResult {
  model: string;
  variant: string;
  status: ShapeStatus;
  standard: ProbeResult;
  highmem: ProbeResult;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  let token = await getAccessToken();
  const userInfo = await client.getUserInfo(token);

  console.error(`Tier: ${userInfo.subscriptionTier}`);
  console.error(`Compute units: ${userInfo.paidComputeUnitsBalance}`);
  console.error();

  // Check for existing assignments
  const existing = await client.listAssignments(token);
  if (existing.length > 0) {
    console.error(`WARNING: ${existing.length} existing assignment(s) detected:`);
    for (const a of existing) {
      console.error(`  ${a.endpoint} (${a.accelerator})`);
    }
    console.error(`These will not be touched but may affect quota.\n`);
  }

  // Collect eligible models, skip unknown variants
  const groups = userInfo.eligibleAccelerators ?? [];
  const models: Array<{ model: string; variant: Variant }> = [];

  for (const group of groups) {
    if (group.variant === "VARIANT_GPU") {
      for (const model of group.models) models.push({ model, variant: Variant.GPU });
    } else if (group.variant === "VARIANT_TPU") {
      for (const model of group.models) models.push({ model, variant: Variant.TPU });
    } else {
      console.error(`Skipping unknown variant: ${group.variant} (models: ${group.models.join(", ")})`);
    }
  }

  if (models.length === 0) {
    console.error("No eligible accelerators found.");
    process.exit(1);
  }

  console.error(`Testing ${models.length} accelerator(s):`);
  for (const { model, variant } of models) {
    console.error(`  ${model} (${variant})`);
  }
  console.error();

  const results: ModelResult[] = [];

  for (const { model, variant } of models) {
    if (aborted) break;

    // Refresh token each iteration in case of long runs
    token = await getAccessToken();

    console.error(`--- ${model} (${variant}) ---`);

    // Test 1: Standard shape (no shape param)
    console.error(`  Standard: assigning...`);
    const standard = await probe(token, variant, model);

    if (standard.status === "ok") {
      console.error(`  Standard: OK (endpoint: ${standard.endpoint}, outcome: ${standard.outcome}, shape: ${standard.machineShape})`);
      await safeUnassign(token, standard.endpoint);
    } else {
      console.error(`  Standard: FAILED — ${standard.error}`);
    }

    // Test 2: High-mem shape
    if (!aborted) {
      console.error(`  High-mem: assigning...`);
      const highmem = await probe(token, variant, model, Shape.HIGHMEM);

      if (highmem.status === "ok") {
        console.error(`  High-mem: OK (endpoint: ${highmem.endpoint}, outcome: ${highmem.outcome}, shape: ${highmem.machineShape})`);
        await safeUnassign(token, highmem.endpoint);
      } else {
        console.error(`  High-mem: FAILED — ${highmem.error}`);
      }

      // Classify
      let status: ShapeStatus;
      if (
        standard.status === "ok" &&
        !standard.reused &&
        standard.outcome === Outcome.SUCCESS
      ) {
        status = "standard_ok";
      } else if (
        standard.status === "error" &&
        !isQuotaOrTransient(standard) &&
        highmem.status === "ok" &&
        !highmem.reused &&
        highmem.outcome === Outcome.SUCCESS
      ) {
        status = "requires_highmem";
      } else {
        status = "inconclusive";
      }

      results.push({ model, variant, status, standard, highmem });
      console.error(`  → ${status}`);
      console.error();
    }

    // Pause between models
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Output structured JSON to stdout
  const summary = {
    date: new Date().toISOString(),
    tier: userInfo.subscriptionTier,
    computeUnits: userInfo.paidComputeUnitsBalance,
    results: results.map((r) => ({
      model: r.model,
      variant: r.variant,
      status: r.status,
      standard: r.standard,
      highmem: r.highmem,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));

  // Human-readable summary to stderr
  console.error("=== SUMMARY ===");
  console.error();
  const groups2 = {
    requires_highmem: results.filter((r) => r.status === "requires_highmem"),
    standard_ok: results.filter((r) => r.status === "standard_ok"),
    inconclusive: results.filter((r) => r.status === "inconclusive"),
  };
  if (groups2.requires_highmem.length > 0) {
    console.error(`Requires high-mem:  ${groups2.requires_highmem.map((r) => r.model).join(", ")}`);
  }
  if (groups2.standard_ok.length > 0) {
    console.error(`Standard shape OK:  ${groups2.standard_ok.map((r) => r.model).join(", ")}`);
  }
  if (groups2.inconclusive.length > 0) {
    console.error(`Inconclusive:       ${groups2.inconclusive.map((r) => r.model).join(", ")}`);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e}`);
  process.exit(1);
});
