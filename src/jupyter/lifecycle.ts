/**
 * Kernel lifecycle: get-or-create a kernel session with retry.
 *
 * Runtime startup takes time after assign(). Session creation
 * is retried for up to 180s with 3s intervals (validated from
 * pdwi2020 reference and live testing).
 */

import { SessionsClient } from "./sessions.ts";
import type { JupyterSession } from "../colab/types.ts";

export interface KernelInfo {
  kernelId: string;
  sessionId: string;
}

export interface GetOrCreateKernelOptions {
  /** Session path/name to use when creating. */
  sessionName?: string;
  /** Max time to wait for session creation in ms (default: 180_000). */
  timeout?: number;
  /** Interval between retries in ms (default: 3_000). */
  interval?: number;
  /** Called on each retry attempt. */
  onRetry?: (attempt: number, remaining: number) => void;
}

/**
 * Get an existing kernel or create a new session.
 *
 * 1. List existing sessions
 * 2. If one exists, return its kernel ID
 * 3. If none, create a session with retry (runtime may still be starting)
 * 4. Return the kernel ID
 */
export async function getOrCreateKernel(
  proxyUrl: string,
  proxyToken: string,
  opts: GetOrCreateKernelOptions = {},
): Promise<KernelInfo> {
  const {
    sessionName = "colab-cli",
    timeout = 180_000,
    interval = 3_000,
    onRetry,
  } = opts;

  const sessions = new SessionsClient(proxyUrl, proxyToken);

  // Check for existing sessions
  try {
    const existing = await sessions.listSessions();
    if (existing.length > 0) {
      const session = existing[0]!;
      return {
        kernelId: session.kernel.id,
        sessionId: session.id,
      };
    }
  } catch {
    // Runtime may not be ready yet — fall through to retry loop
  }

  // Create session with retry
  const deadline = Date.now() + timeout;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const session = await sessions.createSession({
        path: sessionName,
        name: sessionName,
      });
      return {
        kernelId: session.kernel.id,
        sessionId: session.id,
      };
    } catch {
      const remaining = Math.max(0, deadline - Date.now());
      if (remaining <= 0) break;
      onRetry?.(attempt, Math.round(remaining / 1000));
      await sleep(Math.min(interval, remaining));
    }
  }

  throw new Error(
    `Kernel not ready after ${Math.round(timeout / 1000)}s. Runtime may still be starting.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
