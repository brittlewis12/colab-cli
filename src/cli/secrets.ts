/**
 * CLI: colab secrets list
 *
 * List available Colab secret key names. Payloads are stripped —
 * agents use this to discover what secrets exist before writing
 * code that references them via google.colab.userdata.get().
 *
 * No runtime or Drive dependency — calls the Colab API directly.
 */

import { ok, err, type CommandResult } from "./output.ts";
import { getAccessToken } from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";

// ── Data shapes ──────────────────────────────────────────────────────────

interface SecretsListData {
  keys: string[];
}

// ── Command ──────────────────────────────────────────────────────────────

export async function secretsCommand(
  args: string[],
): Promise<CommandResult<SecretsListData>> {
  const sub = args[0];

  switch (sub) {
    case "list":
      return secretsList();
    default:
      return err(
        "secrets",
        "USAGE",
        `Unknown secrets subcommand: ${sub ?? "(none)"}`,
        "Usage: colab secrets list",
      );
  }
}

async function secretsList(): Promise<CommandResult<SecretsListData>> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return err("secrets.list", "AUTH", "Not authenticated", "Run: colab auth login");
  }

  const client = new ColabClient();
  let secrets: unknown;
  try {
    secrets = await client.listSecrets(token);
  } catch (e) {
    return err("secrets.list", "ERROR", `Could not fetch secrets: ${e}`);
  }

  // API returns either an array of {key, payload} or an object keyed by name
  let keys: string[];
  if (Array.isArray(secrets)) {
    keys = secrets.map((s: { key: string }) => s.key);
  } else if (secrets && typeof secrets === "object") {
    keys = Object.keys(secrets);
  } else {
    keys = [];
  }
  return ok("secrets.list", { keys });
}
