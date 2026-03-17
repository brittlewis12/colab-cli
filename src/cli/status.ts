/**
 * CLI: colab status [<name>]
 *
 * No argument: combined dashboard — auth state, quota, all notebooks.
 * With argument: detailed status for one notebook — runtime state,
 * accelerator, kernel status, dirty state, Drive state. Sends keep-alive.
 */

import { ok, err, type CommandResult } from "./output.ts";
import { getAccessToken, loadCredentials, isExpired } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import { SessionsClient } from "../jupyter/sessions.ts";
import type { GapiAssignment } from "../colab/types.ts";
import {
  findProjectRoot,
  listNotebookNames,
  loadNotebookState,
  saveNotebookState,
  isDirty,
  isValidNotebookName,
} from "../state/notebooks.ts";

// ── Data shapes ──────────────────────────────────────────────────────────

interface DashboardData {
  auth: {
    loggedIn: boolean;
    email?: string;
    tier?: string;
    tokenExpired: boolean;
    computeUnits?: number;
    consumptionRateHourly?: number;
  };
  notebooks: Array<{
    name: string;
    accelerator: string;
    status: "running" | "stopped" | "unknown";
  }>;
  unmanaged: Array<{ endpoint: string; accelerator: string }>;
}

interface NotebookStatusData {
  name: string;
  accelerator: string;
  endpoint: string;
  status: "running" | "stopped" | "unknown";
  /** Seconds since runtime was created. Only present when running. */
  uptimeSeconds?: number;
  /** Kernel execution state: idle, busy, or unknown. */
  kernelState?: "idle" | "busy" | "unknown";
  /** Remaining paid compute units. */
  computeUnits?: number;
  dirty: boolean;
  createdAt: string;
  lastKeepAlive?: string;
  driveEnabled?: boolean;
  driveFileId?: string;
}

// ── Command ──────────────────────────────────────────────────────────────

export async function statusCommand(
  args: string[],
): Promise<CommandResult<DashboardData | NotebookStatusData>> {
  const name = args[0];

  if (name) {
    return notebookStatus(name);
  }
  return dashboard();
}

// ── Dashboard (no args) ──────────────────────────────────────────────────

async function dashboard(): Promise<CommandResult<DashboardData>> {
  const creds = await loadCredentials();

  const auth: DashboardData["auth"] = {
    loggedIn: !!creds?.refresh_token,
    email: creds?.email,
    tokenExpired: creds ? isExpired(creds) : true,
  };

  // Fetch live info if authed
  let assignments: GapiAssignment[] = [];
  let assignmentsFetched = false;
  if (creds?.refresh_token) {
    try {
      const token = await getAccessToken();
      const client = new ColabClient();
      const userInfo = await client.getUserInfo(token);
      auth.tier = userInfo.subscriptionTier;
      auth.computeUnits = userInfo.paidComputeUnitsBalance;
      auth.consumptionRateHourly = userInfo.consumptionRateHourly;
      assignments = await client.listAssignments(token);
      assignmentsFetched = true;
    } catch {
      // Non-fatal
    }
  }

  const liveEndpoints = new Set(assignments.map((a) => a.endpoint));
  const projectRoot = await findProjectRoot();
  const names = await listNotebookNames(projectRoot);

  const notebooks: DashboardData["notebooks"] = [];
  const managedEndpoints = new Set<string>();
  for (const n of names) {
    const state = await loadNotebookState(projectRoot, n);
    if (!state) continue;
    managedEndpoints.add(state.endpoint);
    notebooks.push({
      name: n,
      accelerator: state.accelerator,
      status: !assignmentsFetched ? "unknown" : liveEndpoints.has(state.endpoint) ? "running" : "stopped",
    });
  }

  // Unmanaged runtimes (live but not CLI-managed)
  const unmanaged = assignments
    .filter((a) => !managedEndpoints.has(a.endpoint))
    .map((a) => ({ endpoint: a.endpoint, accelerator: a.accelerator }));

  return ok("status", { auth, notebooks, unmanaged });
}

// ── Single notebook status ───────────────────────────────────────────────

async function notebookStatus(
  name: string,
): Promise<CommandResult<NotebookStatusData>> {
  if (!isValidNotebookName(name)) {
    return err("status", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }

  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("status", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);
  if (!state) {
    return err(
      "status",
      "NOT_FOUND",
      `No notebook "${name}" found`,
      `Run: colab ensure ${name} --gpu t4  (or --tpu, --cpu-only)`,
    );
  }

  // Check if runtime is alive
  const client = new ColabClient();
  let runtimeStatus: "running" | "stopped" | "unknown" = "unknown";
  try {
    const assignments = await client.listAssignments(token);
    runtimeStatus = assignments.some((a) => a.endpoint === state.endpoint) ? "running" : "stopped";
  } catch {
    // Non-fatal — remains "unknown"
  }

  // Gather runtime-level info if alive
  let uptimeSeconds: number | undefined;
  let kernelState: "idle" | "busy" | "unknown" | undefined;
  let computeUnits: number | undefined;

  if (runtimeStatus === "running") {
    // Keep-alive + persist timestamp
    try {
      await client.keepAlive(token, state.endpoint);
      state.lastKeepAlive = new Date().toISOString();
      await saveNotebookState(projectRoot, name, state);
    } catch { /* non-fatal */ }

    // Uptime from createdAt
    uptimeSeconds = Math.floor((Date.now() - new Date(state.createdAt).getTime()) / 1000);

    // Kernel execution state via proxy
    try {
      const pt = await client.refreshProxyToken(token, state.endpoint);
      const sessions = new SessionsClient(pt.url, pt.token);
      const sessionList = await sessions.listSessions();
      if (sessionList.length > 0) {
        const kernelExecState = sessionList[0]!.kernel.execution_state;
        kernelState = kernelExecState === "idle" ? "idle"
          : kernelExecState === "busy" ? "busy"
          : "unknown";
      } else {
        kernelState = "unknown";
      }
    } catch {
      kernelState = "unknown";
    }
  }

  // Compute units from user info
  try {
    const userInfo = await client.getUserInfo(token);
    computeUnits = userInfo.paidComputeUnitsBalance;
  } catch { /* non-fatal */ }

  const dirty = await isDirty(projectRoot, name);

  const data: NotebookStatusData = {
    name,
    accelerator: state.accelerator,
    endpoint: state.endpoint,
    status: runtimeStatus,
    ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
    ...(kernelState ? { kernelState } : {}),
    ...(computeUnits !== undefined ? { computeUnits } : {}),
    dirty,
    createdAt: state.createdAt,
    lastKeepAlive: state.lastKeepAlive,
    // Drive fields included when present
    ...(state.driveEnabled ? { driveEnabled: state.driveEnabled } : {}),
    ...(state.driveFileId ? { driveFileId: state.driveFileId } : {}),
  };

  return ok("status", data);
}
