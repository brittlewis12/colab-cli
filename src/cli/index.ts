#!/usr/bin/env bun
/**
 * CLI entry point and command router.
 *
 * Parses the first positional argument as the command name,
 * dispatches to the appropriate handler. All commands return
 * a CommandResult<T> as JSON.
 */

import { outputJson, err, EXIT, type CommandResult } from "./output.ts";

// ── Command handlers (lazy imports to keep startup fast) ─────────────────

async function runCommand(args: string[]): Promise<CommandResult> {
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "auth": {
      const { authCommand } = await import("./auth.ts");
      return authCommand(rest);
    }
    case "ensure": {
      const { ensureCommand } = await import("./ensure.ts");
      return ensureCommand(rest);
    }
    case "exec": {
      const { execCommand } = await import("./exec.ts");
      return execCommand(rest);
    }
    case "pull": {
      const { pullCommand } = await import("./pull.ts");
      return pullCommand(rest);
    }
    case "push": {
      const { pushCommand } = await import("./push.ts");
      return pushCommand(rest);
    }
    case "run": {
      const { runNotebookCommand } = await import("./run.ts");
      return runNotebookCommand(rest);
    }
    case "kill": {
      const { killCommand } = await import("./kill.ts");
      return killCommand(rest);
    }
    case "secrets": {
      const { secretsCommand } = await import("./secrets.ts");
      return secretsCommand(rest);
    }
    case "ls": {
      const { lsCommand } = await import("./ls.ts");
      return lsCommand(rest);
    }
    case "status": {
      const { statusCommand } = await import("./status.ts");
      return statusCommand(rest);
    }
    case undefined:
    case "--help":
    case "-h":
      return err("help", "USAGE", usage());

    default:
      return err(
        command,
        "USAGE",
        `Unknown command: ${command}`,
        `Run 'colab --help' for available commands`,
      );
  }
}

function usage(): string {
  return [
    "Usage: colab <command> [options]",
    "",
    "Auth:",
    "  auth login       OAuth2 login (opens browser)",
    "  auth status      Show auth state, tier, quota",
    "  auth logout      Revoke tokens",
    "",
    "Notebooks:",
    "  ensure <name> --gpu <type>   Get-or-create notebook + runtime",
    "  pull <name>                  Download .ipynb → .py",
    "  push <name>                  Upload .py → .ipynb (with merge)",
    "  run <name>                   Execute notebook cells",
    '  exec <name> "<code>"         Execute ad-hoc Python',
    "  kill <name>                  Teardown runtime",
    "",
    "Info:",
    "  ls                           List notebooks + runtime status",
    "  status [<name>]              Dashboard or notebook details",
    "  secrets list                 List available Colab secret names",
  ].join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

runCommand(args)
  .then((result) => {
    process.exit(outputJson(result));
  })
  .catch((error) => {
    const result = err("unknown", "ERROR", String(error));
    process.exit(outputJson(result));
  });
