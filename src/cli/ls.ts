/**
 * CLI: colab ls
 *
 * List all known notebooks and their runtime status.
 * Merges local state (.colab/notebooks/*.json) with live
 * assignments from listAssignments().
 */

import { ok, err, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import type { GapiAssignment } from "../colab/types.ts";
import {
  findProjectRoot,
  listNotebookNames,
  loadNotebookState,
} from "../state/notebooks.ts";

// ── Data shape ───────────────────────────────────────────────────────────

interface NotebookEntry {
  name: string;
  accelerator: string;
  endpoint: string;
  status: "running" | "stopped" | "unknown";
  createdAt: string;
  lastKeepAlive?: string;
}

interface LsData {
  notebooks: NotebookEntry[];
  unmanaged: Array<{ endpoint: string; accelerator: string }>;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function lsCommand(
  _args: string[],
): Promise<CommandResult<LsData>> {
  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("ls", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  const projectRoot = await findProjectRoot();
  const names = await listNotebookNames(projectRoot);

  // Fetch live assignments
  const client = new ColabClient();
  let assignments: GapiAssignment[] = [];
  let assignmentsFetched = false;
  try {
    assignments = await client.listAssignments(token);
    assignmentsFetched = true;
  } catch {
    // Non-fatal — we'll mark all as "unknown"
  }

  const liveEndpoints = new Set(assignments.map((a) => a.endpoint));
  const managedEndpoints = new Set<string>();

  // Build notebook entries from local state
  const notebooks: NotebookEntry[] = [];
  for (const name of names) {
    const state = await loadNotebookState(projectRoot, name);
    if (!state) continue;

    managedEndpoints.add(state.endpoint);

    notebooks.push({
      name,
      accelerator: state.accelerator,
      endpoint: state.endpoint,
      status: !assignmentsFetched ? "unknown" : liveEndpoints.has(state.endpoint) ? "running" : "stopped",
      createdAt: state.createdAt,
      lastKeepAlive: state.lastKeepAlive,
    });
  }

  // Find unmanaged runtimes (live assignments with no local state)
  const unmanaged = assignments
    .filter((a) => !managedEndpoints.has(a.endpoint))
    .map((a) => ({ endpoint: a.endpoint, accelerator: a.accelerator }));

  return ok("ls", { notebooks, unmanaged });
}
