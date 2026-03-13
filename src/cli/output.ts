/**
 * CLI output formatting: JSON envelope, error types, exit codes.
 *
 * Every command returns a CommandResult<T>. The envelope is the same
 * regardless of command — agents parse `ok`, `error.code`, and `data`.
 */

// ── JSON Envelope ────────────────────────────────────────────────────────

export interface CommandError {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export interface CommandResult<T = unknown> {
  ok: boolean;
  command: string;
  ts: string;
  data?: T;
  error?: CommandError;
}

/** Build a success result. */
export function ok<T>(command: string, data?: T): CommandResult<T> {
  return {
    ok: true,
    command,
    ts: new Date().toISOString(),
    ...(data !== undefined ? { data } : {}),
  };
}

/** Build an error result. data may coexist with error (partial outputs). */
export function err<T>(
  command: string,
  code: ErrorCode,
  message: string,
  hint?: string,
  data?: T,
): CommandResult<T> {
  return {
    ok: false,
    command,
    ts: new Date().toISOString(),
    error: { code, message, ...(hint ? { hint } : {}) },
    ...(data !== undefined ? { data } : {}),
  };
}

// ── Error Codes ──────────────────────────────────────────────────────────

export type ErrorCode =
  | "ERROR"
  | "USAGE"
  | "NOT_FOUND"
  | "AUTH"
  | "QUOTA_EXCEEDED"
  | "TIMEOUT"
  | "EXEC_ERROR"
  | "DIRTY"
  | "CONFLICT";

// ── Exit Codes ───────────────────────────────────────────────────────────

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AUTH: 4,
  QUOTA: 5,
  TIMEOUT: 6,
  EXEC_ERROR: 7,
} as const;

/** Map an error code to an exit code. */
export function exitCode(code: ErrorCode): number {
  switch (code) {
    case "USAGE":
      return EXIT.USAGE;
    case "NOT_FOUND":
      return EXIT.NOT_FOUND;
    case "AUTH":
      return EXIT.AUTH;
    case "QUOTA_EXCEEDED":
      return EXIT.QUOTA;
    case "TIMEOUT":
      return EXIT.TIMEOUT;
    case "EXEC_ERROR":
      return EXIT.EXEC_ERROR;
    default:
      return EXIT.ERROR;
  }
}

// ── Output Helpers ───────────────────────────────────────────────────────

/** Write a CommandResult as JSON to stdout and return the exit code. */
export function outputJson<T>(result: CommandResult<T>): number {
  console.log(JSON.stringify(result));
  return result.ok ? EXIT.OK : exitCode(result.error!.code);
}

/** Write a message to stderr (for streaming/human output). */
export function streamErr(msg: string): void {
  process.stderr.write(msg + "\n");
}

// ── CLI Error (throwable) ────────────────────────────────────────────────

/** Error that carries an error code for structured reporting. */
export class CliError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
