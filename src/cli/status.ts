/**
 * CLI: colab status [<name>]
 *
 * No argument: combined dashboard — auth state, quota, all notebooks.
 * With argument: detailed status for one notebook — runtime state,
 * gpu, kernel status, dirty state, Drive state. Sends keep-alive.
 */

import { ok, err, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { loadCredentials, isExpired } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import type { GapiAssignment } from "../colab/types.ts";
import {
  findProjectRoot,
  listNotebookNames,
  loadNotebookState,
  isDirty,
} from "../state/notebooks.ts";

// ── Data shapes ──────────────────────────────────────────────────────────

interface DashboardData {
  auth: {
    loggedIn: boolean;
    email?: string;
    tier?: string;
    tokenExpired: boolean;
    computeUnits?: number;
  };
  notebooks: Array<{
    name: string;
    gpu: string;
    status: "running" | "stopped" | "unknown";
  }>;
}

interface NotebookStatusData {
  name: string;
  gpu: string;
  endpoint: string;
  status: "running" | "stopped" | "unknown";
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
  if (creds?.refresh_token) {
    try {
      const token = await getAccessToken();
      const client = new ColabClient();
      const userInfo = await client.getUserInfo(token);
      auth.tier = userInfo.subscriptionTier;
      auth.computeUnits = userInfo.paidComputeUnitsBalance;
      assignments = await client.listAssignments(token);
    } catch {
      // Non-fatal
    }
  }

  const liveEndpoints = new Set(assignments.map((a) => a.endpoint));
  const projectRoot = await findProjectRoot();
  const names = await listNotebookNames(projectRoot);

  const notebooks: DashboardData["notebooks"] = [];
  for (const n of names) {
    const state = await loadNotebookState(projectRoot, n);
    if (!state) continue;
    notebooks.push({
      name: n,
      gpu: state.gpu,
      status: liveEndpoints.has(state.endpoint) ? "running" : "stopped",
    });
  }

  return ok("status", { auth, notebooks });
}

// ── Single notebook status ───────────────────────────────────────────────

async function notebookStatus(
  name: string,
): Promise<CommandResult<NotebookStatusData>> {
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
      `Run: colab ensure ${name} --gpu t4`,
    );
  }

  // Check if runtime is alive
  const client = new ColabClient();
  let alive = false;
  try {
    const assignments = await client.listAssignments(token);
    alive = assignments.some((a) => a.endpoint === state.endpoint);
  } catch {
    // Non-fatal — mark as unknown
  }

  // Send keep-alive if alive
  if (alive) {
    try {
      await client.keepAlive(token, state.endpoint);
    } catch { /* non-fatal */ }
  }

  const dirty = await isDirty(projectRoot, name);

  const data: NotebookStatusData = {
    name,
    gpu: state.gpu,
    endpoint: state.endpoint,
    status: alive ? "running" : "stopped",
    dirty,
    createdAt: state.createdAt,
    lastKeepAlive: state.lastKeepAlive,
    // Drive fields included when present
    ...("driveEnabled" in state ? { driveEnabled: (state as any).driveEnabled } : {}),
    ...("driveFileId" in state ? { driveFileId: (state as any).driveFileId } : {}),
  };

  return ok("status", data);
}
