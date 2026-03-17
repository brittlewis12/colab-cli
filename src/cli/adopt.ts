/**
 * CLI: colab adopt <endpoint> --name <name>
 *
 * Bind a name to an existing runtime endpoint from listAssignments().
 * Recovery path when .colab/ is deleted but runtimes are still alive.
 *
 * Note: adopt binds the runtime for exec/upload/download but does NOT
 * recover existing notebook contents. pull/push/run will use
 * content/<name>.ipynb which may differ from the original notebook path.
 * For full notebook recovery, push a local .py after adopting.
 */

import { ok, err, streamErr, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { getOrCreateKernel } from "../jupyter/lifecycle.ts";
import {
  findProjectRoot,
  loadNotebookState,
  saveNotebookState,
  isValidNotebookName,
  type NotebookState,
} from "../state/notebooks.ts";

// ── Data shape ───────────────────────────────────────────────────────────

interface AdoptData {
  name: string;
  endpoint: string;
  accelerator: string;
  kernelId: string;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function adoptCommand(
  args: string[],
): Promise<CommandResult<AdoptData>> {
  const endpoint = args[0];
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;

  if (!endpoint) {
    return err(
      "adopt",
      "USAGE",
      "Missing endpoint",
      "Usage: colab adopt <endpoint> --name <name>\nRun 'colab ls' to see available endpoints",
    );
  }
  if (!name) {
    return err(
      "adopt",
      "USAGE",
      "Missing --name flag",
      "Usage: colab adopt <endpoint> --name <name>",
    );
  }
  if (!isValidNotebookName(name)) {
    return err("adopt", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("adopt", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  // Check for name collision
  const projectRoot = await findProjectRoot();
  const existing = await loadNotebookState(projectRoot, name);
  if (existing) {
    return err(
      "adopt",
      "CONFLICT",
      `Notebook "${name}" already exists (endpoint: ${existing.endpoint})`,
      `Run: colab kill ${name}  # to release the name`,
    );
  }

  // Verify endpoint exists in live assignments
  const client = new ColabClient();
  let accelerator = "unknown";
  let variant: "gpu" | "tpu" | "cpu" = "gpu";
  try {
    const assignments = await client.listAssignments(token);
    const match = assignments.find((a) => a.endpoint === endpoint);
    if (!match) {
      return err(
        "adopt",
        "NOT_FOUND",
        `No live runtime with endpoint "${endpoint}"`,
        "Run 'colab ls' to see available endpoints",
      );
    }
    accelerator = match.accelerator?.toLowerCase() || "cpu";
    variant = match.variant === "VARIANT_TPU" ? "tpu"
      : match.variant === "VARIANT_GPU" ? "gpu"
      : "cpu";
  } catch (e) {
    return err("adopt", "ERROR", `Could not list assignments: ${e}`);
  }

  // Verify kernel accessibility
  let kernelId: string;
  try {
    const pt = await client.refreshProxyToken(token, endpoint);
    const kernel = await getOrCreateKernel(pt.url, pt.token, {
      sessionName: name,
      timeout: 30_000,
    });
    kernelId = kernel.kernelId;
  } catch (e) {
    return err("adopt", "ERROR", `Could not connect to kernel: ${e}`);
  }

  // Save state — use a synthetic notebookHash since we don't know the original
  const state: NotebookState = {
    notebookHash: `adopted_${endpoint.replace(/[^a-zA-Z0-9]/g, "_")}`,
    endpoint,
    accelerator,
    variant,
    createdAt: new Date().toISOString(),
    lastKeepAlive: new Date().toISOString(),
  };
  await saveNotebookState(projectRoot, name, state);

  streamErr(`Adopted runtime ${endpoint} as "${name}" (${accelerator}).`);

  return ok("adopt", { name, endpoint, accelerator, kernelId });
}
