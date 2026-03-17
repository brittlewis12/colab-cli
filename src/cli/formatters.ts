/**
 * Human-readable formatters for dashboard commands.
 *
 * Registered at CLI startup. Only used when stdout is a TTY
 * and --json is not set. Agents (no TTY) always get JSON.
 */

import { registerHumanFormatter, type CommandResult } from "./output.ts";

// ── version ──────────────────────────────────────────────────────────────

registerHumanFormatter("version", (result) => {
  if (!result.ok) return null;
  const d = result.data as { version: string };
  return `colab ${d.version}`;
});

// ── auth.status ──────────────────────────────────────────────────────────

registerHumanFormatter("auth.status", (result) => {
  if (!result.ok) {
    const e = result.error!;
    return `Error: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`;
  }

  const d = result.data as {
    loggedIn: boolean;
    email?: string;
    tier?: string;
    computeUnits?: number;
    consumptionRateHourly?: number;
    tokenExpired: boolean;
    eligibleGpus?: string[];
    eligibleTpus?: string[];
  };

  if (!d.loggedIn) return "Not logged in.\n\nRun: colab auth login";

  const lines: string[] = [];
  if (d.email) lines.push(`Email:    ${d.email}`);
  if (d.tier) lines.push(`Tier:     ${friendlyTier(d.tier)}`);
  if (d.computeUnits !== undefined) {
    let units = `Units:    ${d.computeUnits.toFixed(1)}`;
    if (d.consumptionRateHourly) units += ` (burning ${d.consumptionRateHourly}/hr)`;
    lines.push(units);
  }
  if (d.tokenExpired) lines.push(`Token:    expired`);
  if (d.eligibleGpus?.length) lines.push(`GPUs:     ${d.eligibleGpus.join(", ")}`);
  if (d.eligibleTpus?.length) lines.push(`TPUs:     ${d.eligibleTpus.join(", ")}`);

  return lines.join("\n");
});

// ── ls ───────────────────────────────────────────────────────────────────

registerHumanFormatter("ls", (result) => {
  if (!result.ok) {
    const e = result.error!;
    return `Error: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`;
  }

  const d = result.data as {
    notebooks: Array<{
      name: string;
      accelerator: string;
      endpoint: string;
      status: string;
      createdAt: string;
    }>;
    unmanaged: Array<{ endpoint: string; accelerator: string }>;
  };

  if (d.notebooks.length === 0 && d.unmanaged.length === 0) {
    return "No notebooks or runtimes found.";
  }

  const lines: string[] = [];

  if (d.notebooks.length > 0) {
    // Find max name length for alignment
    const maxName = Math.max(...d.notebooks.map((n) => n.name.length));
    for (const nb of d.notebooks) {
      const status = nb.status === "running" ? "running" : nb.status === "stopped" ? "stopped" : "unknown";
      lines.push(`  ${nb.name.padEnd(maxName)}  ${status.padEnd(7)}  ${nb.accelerator}`);
    }
  }

  if (d.unmanaged.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Unmanaged runtimes:");
    for (const u of d.unmanaged) {
      lines.push(`  ${u.endpoint}  ${u.accelerator}`);
    }
  }

  return lines.join("\n");
});

// ── status (dashboard) ───────────────────────────────────────────────────

registerHumanFormatter("status", (result) => {
  if (!result.ok) {
    const e = result.error!;
    return `Error: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`;
  }

  const d = result.data as Record<string, unknown>;

  // Single notebook status (has "endpoint" field)
  if ("endpoint" in d) {
    return formatNotebookStatus(d);
  }

  // Dashboard (has "auth" field)
  if ("auth" in d) {
    return formatDashboard(d);
  }

  return null; // fall back to JSON
});

function formatDashboard(d: Record<string, unknown>): string {
  const auth = d.auth as Record<string, unknown>;
  const notebooks = d.notebooks as Array<Record<string, unknown>>;
  const unmanaged = d.unmanaged as Array<Record<string, unknown>>;

  const lines: string[] = [];

  // Auth section
  if (auth.email) lines.push(`${auth.email}  ${friendlyTier(auth.tier as string)}`);
  if (auth.computeUnits !== undefined) {
    let units = `${(auth.computeUnits as number).toFixed(1)} compute units`;
    if (auth.consumptionRateHourly) units += ` (${auth.consumptionRateHourly}/hr)`;
    lines.push(units);
  }

  // Notebooks
  if (notebooks.length > 0) {
    lines.push("");
    const maxName = Math.max(...notebooks.map((n) => (n.name as string).length));
    for (const nb of notebooks) {
      const status = nb.status as string;
      lines.push(`  ${(nb.name as string).padEnd(maxName)}  ${status.padEnd(7)}  ${nb.accelerator}`);
    }
  }

  // Unmanaged
  if (unmanaged?.length > 0) {
    lines.push("");
    lines.push("Unmanaged runtimes:");
    for (const u of unmanaged) {
      lines.push(`  ${u.endpoint}  ${u.accelerator}`);
    }
  }

  if (notebooks.length === 0 && (!unmanaged || unmanaged.length === 0)) {
    lines.push("\nNo notebooks.");
  }

  return lines.join("\n");
}

function formatNotebookStatus(d: Record<string, unknown>): string {
  const lines: string[] = [];

  const name = d.name as string;
  const status = d.status as string;
  const accelerator = d.accelerator as string;

  lines.push(`${name}  ${status}  ${accelerator}`);

  if (d.uptimeSeconds !== undefined) {
    lines.push(`Uptime:   ${formatDuration(d.uptimeSeconds as number)}`);
  }
  if (d.kernelState) {
    lines.push(`Kernel:   ${d.kernelState}`);
  }
  if (d.computeUnits !== undefined) {
    lines.push(`Units:    ${(d.computeUnits as number).toFixed(1)}`);
  }
  if (d.dirty) {
    lines.push(`Dirty:    yes (local .py has unpushed changes)`);
  }
  if (d.driveEnabled) {
    lines.push(`Drive:    enabled${d.driveFileId ? ` (${d.driveFileId})` : ""}`);
  }

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function friendlyTier(tier?: string): string {
  if (!tier) return "";
  if (tier.includes("PRO_PLUS")) return "Pro+";
  if (tier.includes("PRO")) return "Pro";
  return tier.replace("SUBSCRIPTION_TIER_", "");
}

export function formatDuration(seconds: number): string {
  const sec = Math.floor(seconds);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
