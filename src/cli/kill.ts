/**
 * CLI: colab kill <name>
 *
 * Teardown runtime, preserve local .py. Unassigns the runtime
 * and cleans up notebook state.
 */

import { ok, err, streamErr, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";
import {
  findProjectRoot,
  loadNotebookState,
  deleteNotebookState,
  isValidNotebookName,
} from "../state/notebooks.ts";

export async function killCommand(
  args: string[],
): Promise<CommandResult> {
  const name = args[0];
  if (!name) {
    return err("kill", "USAGE", "Missing notebook name", "Usage: colab kill <name>");
  }
  if (!isValidNotebookName(name)) {
    return err("kill", "USAGE", `Invalid notebook name: "${name}". Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`);
  }

  const projectRoot = await findProjectRoot();
  const state = await loadNotebookState(projectRoot, name);

  if (!state) {
    return err("kill", "NOT_FOUND", `No notebook "${name}" found`);
  }

  // Auth
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    // Can't unassign without auth — warn but don't delete state (runtime may still be burning compute)
    return err(
      "kill",
      "AUTH",
      `Not authenticated — cannot release runtime for "${name}"`,
      `Run: colab auth login  # then retry: colab kill ${name}`,
    );
  }

  // Unassign runtime
  const client = new ColabClient();
  let unassigned = false;
  try {
    await client.unassign(token, state.endpoint);
    unassigned = true;
    streamErr(`Runtime ${state.endpoint} released.`);
  } catch (e) {
    streamErr(`Could not unassign runtime: ${e}`);
    // Runtime may already be dead — still safe to clean up state
  }

  // Only delete state after unassign attempt (regardless of success —
  // if unassign failed, the runtime was likely already dead)
  await deleteNotebookState(projectRoot, name);

  return ok("kill", { name, unassigned, stateDeleted: true });
}
