/**
 * CLI: colab ensure <name> --gpu <type> | --tpu <type> | --cpu-only
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
  isValidNotebookName,
  type NotebookState,
} from "../state/notebooks.ts";

// ── Accelerator resolution ───────────────────────────────────────────────

/** Known GPU model names for cross-variant validation hints. */
const KNOWN_GPU_MODELS = new Set(["T4", "L4", "V100", "A100", "H100", "G4"]);
/** Known TPU model names for cross-variant validation hints. */
const KNOWN_TPU_MODELS = new Set(["V5E1", "V6E1"]);

interface ResolvedAccelerator {
  variant: Variant;
  accelerator: string;
  /** User-facing label for state/output (e.g. "t4", "v5e1", "cpu"). */
  label: string;
  /** Variant label for state persistence: "gpu", "tpu", or "cpu". */
  variantLabel: "gpu" | "tpu" | "cpu";
}

/** Resolve user-facing accelerator flags to assign() params, validated against the user's eligible accelerators. */
async function resolveAccelerator(
  client: ColabClient,
  token: string,
  flag: "gpu" | "tpu" | "cpu-only",
  model: string | undefined,
): Promise<ResolvedAccelerator> {
  if (flag === "cpu-only") {
    return { variant: Variant.DEFAULT, accelerator: "", label: "cpu", variantLabel: "cpu" };
  }

  // Fetch eligible accelerators from the user's account
  const userInfo = await client.getUserInfo(token);

  const variantKey = flag === "gpu" ? "VARIANT_GPU" : "VARIANT_TPU";
  const group = userInfo.eligibleAccelerators?.find(
    (a) => a.variant === variantKey,
  );
  const eligible = group?.models ?? [];

  // Case-insensitive match against eligible models
  const upper = model!.toUpperCase();
  const matched = eligible.find((m) => m.toUpperCase() === upper);

  if (!matched) {
    // Cross-variant hint: did they use the wrong flag?
    const crossVariant = flag === "gpu" ? "VARIANT_TPU" : "VARIANT_GPU";
    const crossGroup = userInfo.eligibleAccelerators?.find(
      (a) => a.variant === crossVariant,
    );
    const crossMatch = crossGroup?.models?.find(
      (m) => m.toUpperCase() === upper,
    );

    if (crossMatch) {
      const correctFlag = flag === "gpu" ? "--tpu" : "--gpu";
      const wrongType = flag === "gpu" ? "GPU" : "TPU";
      const rightType = flag === "gpu" ? "TPU" : "GPU";
      throw new AcceleratorError(
        upper,
        flag,
        eligible,
        `${upper} is a ${rightType} model, not a ${wrongType}. Did you mean: ${correctFlag} ${model}?`,
      );
    }

    // Offline cross-variant hints (when API doesn't have the model in either group)
    if (flag === "gpu" && KNOWN_TPU_MODELS.has(upper)) {
      throw new AcceleratorError(
        upper,
        flag,
        eligible,
        `${upper} is a TPU model, not a GPU. Did you mean: --tpu ${model}?`,
      );
    }
    if (flag === "tpu" && KNOWN_GPU_MODELS.has(upper)) {
      throw new AcceleratorError(
        upper,
        flag,
        eligible,
        `${upper} is a GPU model, not a TPU. Did you mean: --gpu ${model}?`,
      );
    }

    throw new AcceleratorError(upper, flag, eligible);
  }

  const variant = flag === "gpu" ? Variant.GPU : Variant.TPU;
  return { variant, accelerator: matched, label: matched.toLowerCase(), variantLabel: flag as "gpu" | "tpu" };
}

class AcceleratorError extends Error {
  /** True when the error message already contains a cross-variant correction hint. */
  public readonly crossVariantHint: boolean;
  constructor(
    public readonly requested: string,
    public readonly flag: string,
    public readonly eligible: string[],
    customMessage?: string,
  ) {
    super(
      customMessage ??
      (eligible.length > 0
        ? `${flag.toUpperCase()} "${requested}" not available. Eligible: ${eligible.join(", ")}`
        : `No ${flag.toUpperCase()}s available on your account`),
    );
    this.crossVariantHint = !!customMessage;
  }
}

// ── Ensure data shape ────────────────────────────────────────────────────

interface EnsureData {
  name: string;
  accelerator: string;
  endpoint: string;
  status: "created" | "existing";
  kernelId: string;
  driveEnabled?: boolean;
  driveConsentUrl?: string;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function ensureCommand(
  args: string[],
): Promise<CommandResult<EnsureData>> {
  // Parse args
  const name = args[0];
  const gpuIdx = args.indexOf("--gpu");
  const gpuArg = gpuIdx >= 0 ? args[gpuIdx + 1] : undefined;
  const tpuIdx = args.indexOf("--tpu");
  const tpuArg = tpuIdx >= 0 ? args[tpuIdx + 1] : undefined;
  const cpuOnly = args.includes("--cpu-only");
  const highMem = args.includes("--high-mem");
  const driveRequested = args.includes("--drive");

  // Warn on unrecognized flags (common agent footgun)
  const knownFlags = new Set(["--gpu", "--tpu", "--cpu-only", "--high-mem", "--drive"]);
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-") && !knownFlags.has(arg)) {
      streamErr(`Warning: unrecognized flag "${arg}" — ignored.`);
    }
  }

  if (!name) {
    return err("ensure", "USAGE", "Missing notebook name", "Usage: colab ensure <name> --gpu <type>");
  }
  if (!isValidNotebookName(name)) {
    return err("ensure", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }

  // Validate that --gpu and --tpu have a model argument (check before flag counting)
  if (gpuIdx >= 0 && (!gpuArg || gpuArg.startsWith("-"))) {
    return err("ensure", "USAGE", "--gpu requires a model argument", "Usage: colab ensure <name> --gpu t4");
  }
  if (tpuIdx >= 0 && (!tpuArg || tpuArg.startsWith("-"))) {
    return err("ensure", "USAGE", "--tpu requires a model argument", "Usage: colab ensure <name> --tpu v5e1");
  }

  // Reject duplicate flags (e.g. --gpu t4 --gpu a100)
  if (gpuIdx >= 0 && args.indexOf("--gpu", gpuIdx + 1) >= 0) {
    return err("ensure", "USAGE", "Duplicate --gpu flag", "Specify --gpu exactly once");
  }
  if (tpuIdx >= 0 && args.indexOf("--tpu", tpuIdx + 1) >= 0) {
    return err("ensure", "USAGE", "Duplicate --tpu flag", "Specify --tpu exactly once");
  }

  // Exactly one of --gpu, --tpu, --cpu-only required
  const flagCount = (gpuArg ? 1 : 0) + (tpuArg ? 1 : 0) + (cpuOnly ? 1 : 0);
  if (flagCount === 0) {
    return err(
      "ensure",
      "USAGE",
      "Missing accelerator flag",
      "Usage: colab ensure <name> --gpu t4  (or --tpu v5e1, or --cpu-only)",
    );
  }
  if (flagCount > 1) {
    return err(
      "ensure",
      "USAGE",
      "Specify exactly one of --gpu, --tpu, or --cpu-only",
      "Examples: --gpu t4, --tpu v5e1, --cpu-only",
    );
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("ensure", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  const client = new ColabClient();

  // Resolve accelerator against user's eligible accelerators
  const flag: "gpu" | "tpu" | "cpu-only" = gpuArg ? "gpu" : tpuArg ? "tpu" : "cpu-only";
  const model = gpuArg ?? tpuArg;

  let resolved: ResolvedAccelerator;
  let assignSpec: { variant: Variant; accelerator: string; shape?: Shape };
  try {
    resolved = await resolveAccelerator(client, token, flag, model);
    assignSpec = {
      variant: resolved.variant,
      accelerator: resolved.accelerator,
      ...(highMem ? { shape: Shape.HIGHMEM } : {}),
    };
  } catch (e) {
    if (e instanceof AcceleratorError) {
      // If the error already contains a cross-variant hint (e.g. "Did you mean --gpu t4?"),
      // use the message itself as the hint. Otherwise show available models or tier advice.
      const hint = e.crossVariantHint
        ? e.message
        : e.eligible.length > 0
          ? `Available ${e.flag.toUpperCase()}s: ${e.eligible.map((m) => m.toLowerCase()).join(", ")}`
          : "Check your Colab subscription tier";
      return err("ensure", "USAGE", e.message, hint);
    }
    return err("ensure", "ERROR", `Could not check accelerator availability: ${e}`);
  }

  const acceleratorLabel = resolved.label;
  const projectRoot = await findProjectRoot();

  // Check existing state
  const existing = await loadNotebookState(projectRoot, name);

  if (existing) {
    const specMismatch =
      existing.accelerator !== acceleratorLabel ||
      (!!existing.highMem) !== highMem;
    if (specMismatch) {
      const existingSpec = existing.accelerator + (existing.highMem ? " --high-mem" : "");
      const requestedSpec = acceleratorLabel + (highMem ? " --high-mem" : "");
      return err(
        "ensure",
        "USAGE",
        `Notebook "${name}" exists with spec [${existingSpec}], requested [${requestedSpec}]`,
        `Run: colab kill ${name}  # then re-ensure with new spec`,
      );
    }

    // Verify runtime is still alive — separate API failures from genuine reclamation
    let assignments;
    try {
      assignments = await client.listAssignments(token);
    } catch (e) {
      // API failure (network, auth) — don't assume runtime is dead
      return err("ensure", "ERROR", `Could not check runtime status: ${e}`);
    }

    const alive = assignments.find((a) => a.endpoint === existing.endpoint);

    if (alive) {
      // Runtime is in listAssignments — it's alive. If kernel/proxy probe fails,
      // that's a transient error (startup delay, network blip), NOT reclamation.
      // Return error instead of silently allocating a second runtime.
      let pt;
      try {
        pt = await client.refreshProxyToken(token, existing.endpoint);
      } catch (e) {
        return err("ensure", "ERROR", `Runtime is alive but proxy token refresh failed: ${e}`, "Retry the command, or: colab kill " + name);
      }

      let kernel;
      try {
        kernel = await getOrCreateKernel(pt.url, pt.token, {
          sessionName: name,
          timeout: 120_000, // match design spec default (120s)
          onRetry: (attempt, remaining) => {
            streamErr(`Waiting for kernel... attempt ${attempt} (${remaining}s left)`);
          },
        });
      } catch (e) {
        return err("ensure", "ERROR", `Runtime is alive but kernel not accessible: ${e}`, "Retry the command, or: colab kill " + name);
      }

      // Update keep-alive (non-fatal)
      try {
        await client.keepAlive(token, existing.endpoint);
        existing.lastKeepAlive = new Date().toISOString();
      } catch { /* non-fatal */ }

      // Handle --drive on existing runtime
      if (driveRequested && !existing.driveEnabled) {
        const driveResult = await propagateDrive(client, token, existing.endpoint);
        if (driveResult.success) {
          existing.driveEnabled = true;
          streamErr(`Drive credentials propagated.`);
        } else if (driveResult.consentUrl) {
          streamErr(`Drive requires browser consent. Open:\n\n  ${driveResult.consentUrl}\n`);
          const polled = await pollDriveConsent(client, token, existing.endpoint, 120_000, 3_000);
          if (polled) {
            existing.driveEnabled = true;
            streamErr(`Drive credentials propagated after consent.`);
          } else {
            streamErr(`Warning: Drive consent timed out. Runtime usable without Drive. Re-run with --drive to retry.`);
          }
        } else {
          streamErr(`Warning: Drive propagation failed. Re-run with --drive to retry.`);
        }
      }

      await saveNotebookState(projectRoot, name, existing);

      return ok("ensure", {
        name,
        accelerator: existing.accelerator,
        endpoint: existing.endpoint,
        status: "existing",
        kernelId: kernel.kernelId,
        ...(existing.driveEnabled ? { driveEnabled: true } : {}),
      });
    }

    // Endpoint not in listAssignments — runtime was genuinely reclaimed
    streamErr(`Runtime for "${name}" is no longer available. Creating new...`);
  }

  // Create new runtime
  const displayLabel = acceleratorLabel === "cpu" ? "CPU" : acceleratorLabel.toUpperCase();
  streamErr(`Allocating ${displayLabel} runtime for "${name}"...`);

  const nbh = notebookHash();
  let assignment;
  try {
    assignment = await client.assign(token, {
      notebookHash: nbh,
      variant: assignSpec.variant,
      accelerator: assignSpec.accelerator,
      shape: assignSpec.shape,
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("QUOTA") || msg.includes("quota")) {
      return err("ensure", "QUOTA_EXCEEDED", msg, "Try --cpu-only or a smaller accelerator");
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
    accelerator: acceleratorLabel,
    variant: resolved.variantLabel,
    ...(highMem ? { highMem: true } : {}),
    createdAt: new Date().toISOString(),
    lastKeepAlive: new Date().toISOString(),
  };

  // Drive credential propagation — only set driveEnabled after consent actually succeeds
  let driveConsentUrl: string | undefined;
  const wantsDrive = driveRequested || existing?.driveEnabled;
  if (wantsDrive) {
    // Preserve driveFileId from previous runtime (reuse same Drive file)
    if (existing?.driveFileId) state.driveFileId = existing.driveFileId;
    if (existing?.driveFolderId) state.driveFolderId = existing.driveFolderId;

    const driveResult = await propagateDrive(client, token, endpoint);
    if (driveResult.success) {
      state.driveEnabled = true;
      streamErr(`Drive credentials propagated.`);
    } else if (driveResult.consentUrl) {
      driveConsentUrl = driveResult.consentUrl;
      streamErr(`Drive requires browser consent. Open:\n\n  ${driveResult.consentUrl}\n`);

      // Poll for consent
      const polled = await pollDriveConsent(client, token, endpoint, 120_000, 3_000);
      if (polled) {
        state.driveEnabled = true;
        streamErr(`Drive credentials propagated after consent.`);
      } else {
        streamErr(`Warning: Drive consent timed out. Runtime usable without Drive. Re-run with --drive to retry.`);
      }
    } else {
      streamErr(`Warning: Drive propagation failed. Runtime usable without Drive. Re-run with --drive to retry.`);
    }
  }

  await saveNotebookState(projectRoot, name, state);

  streamErr(`Ready.`);

  return ok("ensure", {
    name,
    accelerator: acceleratorLabel,
    endpoint,
    status: "created",
    kernelId: kernel.kernelId,
    ...(state.driveEnabled ? { driveEnabled: true } : {}),
    ...(driveConsentUrl ? { driveConsentUrl } : {}),
  });
}

// ── Drive credential propagation ─────────────────────────────────────────

interface DriveResult {
  success: boolean;
  consentUrl?: string;
}

async function propagateDrive(
  client: ColabClient,
  token: string,
  endpoint: string,
): Promise<DriveResult> {
  try {
    const dry = await client.propagateCredentials(
      token,
      endpoint,
      "dfs_ephemeral",
      true,
    );
    const result = dry as Record<string, unknown>;

    if (result.success === true) {
      // Dry-run says credentials are available — do a real POST to propagate them
      await client.propagateCredentials(token, endpoint, "dfs_ephemeral", false);
      return { success: true };
    }

    const consentUrl =
      (result.unauthorized_redirect_uri as string) ??
      (result.unauthorizedRedirectUri as string);

    if (consentUrl) {
      return { success: false, consentUrl };
    }

    return { success: false };
  } catch {
    return { success: false };
  }
}

async function pollDriveConsent(
  client: ColabClient,
  token: string,
  endpoint: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // Use dry_run=true to check consent status without side effects
      const result = await client.propagateCredentials(
        token,
        endpoint,
        "dfs_ephemeral",
        true,
      );
      if ((result as Record<string, unknown>).success === true) {
        // Consent detected — do one real POST to propagate credentials
        await client.propagateCredentials(token, endpoint, "dfs_ephemeral", false);
        return true;
      }
    } catch {
      // Keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return false;
}
