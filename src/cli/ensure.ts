/**
 * CLI: colab ensure <name> --gpu <type>
 *
 * Get-or-create a notebook with a runtime. Idempotent.
 * Blocks until the runtime is fully ready (kernel accessible).
 */

import { ok, err, streamErr, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { notebookHash, Variant, Shape } from "../colab/types.ts";
import { ContentsClient } from "../jupyter/contents.ts";
import { getOrCreateKernel } from "../jupyter/lifecycle.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  contentsPath,
  type NotebookState,
} from "../state/notebooks.ts";

// ── GPU resolution ───────────────────────────────────────────────────────

/** Resolve a user-facing GPU name to assign() params, validated against the user's eligible accelerators. */
async function resolveGpu(
  client: ColabClient,
  token: string,
  gpuArg: string,
): Promise<{ variant: Variant; accelerator: string; eligible: string[] }> {
  if (gpuArg.toLowerCase() === "none") {
    return { variant: Variant.DEFAULT, accelerator: "", eligible: [] };
  }

  // Fetch eligible accelerators from the user's account
  const userInfo = await client.getUserInfo(token);
  const gpuGroup = userInfo.eligibleAccelerators?.find(
    (a) => a.variant === "VARIANT_GPU",
  );
  const eligible = gpuGroup?.models ?? [];

  // Case-insensitive match against eligible models
  const upper = gpuArg.toUpperCase();
  const matched = eligible.find((m) => m.toUpperCase() === upper);

  if (!matched) {
    throw new GpuError(upper, eligible);
  }

  return { variant: Variant.GPU, accelerator: matched, eligible };
}

class GpuError extends Error {
  constructor(
    public readonly requested: string,
    public readonly eligible: string[],
  ) {
    super(
      eligible.length > 0
        ? `GPU "${requested}" not available. Eligible: ${eligible.join(", ")}`
        : `No GPUs available on your account`,
    );
  }
}

// ── Ensure data shape ────────────────────────────────────────────────────

interface EnsureData {
  name: string;
  gpu: string;
  endpoint: string;
  status: "created" | "existing";
  kernelId: string;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function ensureCommand(
  args: string[],
): Promise<CommandResult<EnsureData>> {
  // Parse args
  const name = args[0];
  const gpuIdx = args.indexOf("--gpu");
  const gpuArg = gpuIdx >= 0 ? args[gpuIdx + 1] : undefined;
  const highMem = args.includes("--high-mem");

  if (!name) {
    return err("ensure", "USAGE", "Missing notebook name", "Usage: colab ensure <name> --gpu <type>");
  }
  if (!gpuArg) {
    return err("ensure", "USAGE", "Missing --gpu flag", "Usage: colab ensure <name> --gpu t4");
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("ensure", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  const client = new ColabClient();

  // Resolve GPU against user's eligible accelerators
  let gpuSpec: { variant: Variant; accelerator: string; shape?: Shape };
  try {
    const resolved = await resolveGpu(client, token, gpuArg);
    gpuSpec = {
      variant: resolved.variant,
      accelerator: resolved.accelerator,
      ...(highMem ? { shape: Shape.HIGHMEM } : {}),
    };
  } catch (e) {
    if (e instanceof GpuError) {
      const hint = e.eligible.length > 0
        ? `Available GPUs: ${e.eligible.map((g) => g.toLowerCase()).join(", ")}`
        : "Check your Colab subscription tier";
      return err("ensure", "USAGE", e.message, hint);
    }
    return err("ensure", "ERROR", `Could not check GPU availability: ${e}`);
  }
  const projectRoot = await findProjectRoot();

  // Check existing state
  const existing = await loadNotebookState(projectRoot, name);

  if (existing) {
    if (existing.gpu !== gpuArg.toLowerCase()) {
      return err(
        "ensure",
        "USAGE",
        `Notebook "${name}" exists with gpu=${existing.gpu}, requested gpu=${gpuArg}`,
        `Run: colab kill ${name}  # then re-ensure with new GPU`,
      );
    }

    // Verify runtime is still alive
    try {
      const assignments = await client.listAssignments(token);
      const alive = assignments.find((a) => a.endpoint === existing.endpoint);

      if (alive) {
        // Verify kernel accessibility
        const pt = await client.refreshProxyToken(token, existing.endpoint);

        const kernel = await getOrCreateKernel(pt.url, pt.token, {
          sessionName: name,
          timeout: 30_000, // shorter timeout for existing runtime
          onRetry: (attempt, remaining) => {
            streamErr(`Waiting for kernel... attempt ${attempt} (${remaining}s left)`);
          },
        });

        // Update keep-alive
        await client.keepAlive(token, existing.endpoint);
        existing.lastKeepAlive = new Date().toISOString();
        await saveNotebookState(projectRoot, name, existing);

        return ok("ensure", {
          name,
          gpu: existing.gpu,
          endpoint: existing.endpoint,
          status: "existing",
          kernelId: kernel.kernelId,
        });
      }
    } catch {
      // Runtime dead or inaccessible — fall through to create new
    }

    streamErr(`Runtime for "${name}" is no longer available. Creating new...`);
  }

  // Create new runtime
  streamErr(`Allocating ${gpuArg.toUpperCase()} runtime for "${name}"...`);

  const nbh = notebookHash();
  let assignment;
  try {
    assignment = await client.assign(token, {
      notebookHash: nbh,
      variant: gpuSpec.variant,
      accelerator: gpuSpec.accelerator,
      shape: gpuSpec.shape,
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("QUOTA") || msg.includes("quota")) {
      return err("ensure", "QUOTA_EXCEEDED", msg, "Try a smaller GPU: colab ensure <name> --gpu t4");
    }
    return err("ensure", "ERROR", `Assignment failed: ${msg}`);
  }

  const endpoint = assignment.endpoint;
  const proxyUrl = assignment.runtimeProxyInfo.url;
  const proxyToken = assignment.runtimeProxyInfo.token;

  streamErr(`Assigned: ${endpoint}. Waiting for kernel...`);

  // Wait for kernel readiness
  let kernel;
  try {
    kernel = await getOrCreateKernel(proxyUrl, proxyToken, {
      sessionName: name,
      onRetry: (attempt, remaining) => {
        streamErr(`Kernel starting... attempt ${attempt} (${remaining}s left)`);
      },
    });
  } catch (e) {
    // Clean up the assignment if kernel never came up
    try {
      await client.unassign(token, endpoint);
    } catch { /* best effort */ }
    return err("ensure", "TIMEOUT", String(e));
  }

  // Create empty .ipynb on the runtime
  const emptyNotebook = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
    },
    cells: [
      {
        cell_type: "code",
        id: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
        source: "",
        metadata: {},
        outputs: [],
        execution_count: null,
      },
    ],
  });

  try {
    // Refresh proxy token (original may be stale after waiting)
    const pt = await client.refreshProxyToken(token, endpoint);
    const contents = new ContentsClient(pt.url, pt.token);
    await contents.writeText(contentsPath(name), emptyNotebook);
  } catch (e) {
    streamErr(`Warning: could not create empty notebook: ${e}`);
    // Non-fatal — push will create it
  }

  // Save state
  const state: NotebookState = {
    notebookHash: nbh,
    endpoint,
    gpu: gpuArg.toLowerCase(),
    createdAt: new Date().toISOString(),
    lastKeepAlive: new Date().toISOString(),
  };
  await saveNotebookState(projectRoot, name, state);

  streamErr(`Ready.`);

  return ok("ensure", {
    name,
    gpu: gpuArg.toLowerCase(),
    endpoint,
    status: "created",
    kernelId: kernel.kernelId,
  });
}
