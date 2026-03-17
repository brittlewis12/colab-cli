/**
 * Per-notebook state management.
 *
 * Handles project root discovery, .colab/ directory structure,
 * and per-notebook state files.
 *
 * State file: .colab/notebooks/<name>.json
 * Cache file: .colab/notebooks/<name>.ipynb
 * Notebook on runtime: content/<name>.ipynb (Contents API path)
 */

import { join, resolve } from "path";
import { readdir, stat } from "fs/promises";
import { readJson, writeJson, removeFile } from "./store.ts";
import { createHash } from "crypto";
import { readFile } from "fs/promises";

// ── Types ────────────────────────────────────────────────────────────────

export interface NotebookState {
  /** Notebook hash used for runtime assignment. */
  notebookHash: string;
  /** Runtime endpoint identifier. */
  endpoint: string;
  /** Accelerator type (t4, a100, v5e1, etc.) or "cpu" for CPU-only. */
  accelerator: string;
  /** Accelerator variant: "gpu", "tpu", or "cpu". Used to reconstruct --gpu/--tpu/--cpu-only flags. */
  variant: "gpu" | "tpu" | "cpu";
  /** Whether --high-mem was requested. */
  highMem?: boolean;
  /** When the runtime was first assigned. */
  createdAt: string;
  /** Last keep-alive timestamp. */
  lastKeepAlive?: string;
  /** SHA-256 of the last-pushed .py file contents. */
  pushedHash?: string;
  /** Whether --drive was requested. Survives reclamation. */
  driveEnabled?: boolean;
  /** Drive folder ID for "Colab Notebooks". Discovered on first upload. */
  driveFolderId?: string;
  /** Drive file ID of the uploaded .ipynb. Reused across runtimes. */
  driveFileId?: string;
}

// ── Name Validation ──────────────────────────────────────────────────────

/**
 * Allowed notebook name pattern: starts with alphanumeric, followed by
 * alphanumerics, hyphens, underscores, or single dots.
 * Disallows path separators, ".." sequences, leading dots, and other
 * special characters that could cause path traversal.
 */
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Validate a notebook name. Returns true if the name is safe for use
 * in filesystem paths and Contents API paths.
 */
export function isValidNotebookName(name: string): boolean {
  if (!name) return false;
  if (!VALID_NAME.test(name)) return false;
  if (name.includes("..")) return false;
  return true;
}

/**
 * Assert that a notebook name is valid, throwing if not.
 * Used as a defense-in-depth check in path construction functions.
 */
function assertValidName(name: string): void {
  if (!isValidNotebookName(name)) {
    throw new Error(
      `Invalid notebook name: "${name}". ` +
      `Names must start with a letter or digit and contain only alphanumerics, hyphens, underscores, and dots.`,
    );
  }
}

// ── Path Conventions ─────────────────────────────────────────────────────

const COLAB_DIR = ".colab";
const NOTEBOOKS_DIR = "notebooks";

/** Contents API path for a notebook on the runtime. */
export function contentsPath(name: string): string {
  assertValidName(name);
  return `content/${name}.ipynb`;
}

/** Local .py working copy path. */
export function localPyPath(projectRoot: string, name: string): string {
  assertValidName(name);
  return join(projectRoot, `${name}.py`);
}

/** State file path: .colab/notebooks/<name>.json */
export function statePath(projectRoot: string, name: string): string {
  assertValidName(name);
  return join(projectRoot, COLAB_DIR, NOTEBOOKS_DIR, `${name}.json`);
}

/** Cache file path: .colab/notebooks/<name>.ipynb */
export function cachePath(projectRoot: string, name: string): string {
  assertValidName(name);
  return join(projectRoot, COLAB_DIR, NOTEBOOKS_DIR, `${name}.ipynb`);
}

// ── Project Root Discovery ───────────────────────────────────────────────

/**
 * Find the project root by walking up from cwd looking for .colab/.
 * If not found, cwd is the project root (.colab/ created on first ensure).
 */
export async function findProjectRoot(from?: string): Promise<string> {
  let dir = resolve(from ?? process.cwd());

  // Walk up looking for .colab/
  while (true) {
    try {
      const s = await stat(join(dir, COLAB_DIR));
      if (s.isDirectory()) return dir;
    } catch {
      // not found, keep walking
    }

    const parent = resolve(dir, "..");
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Not found — cwd is the project root
  return resolve(from ?? process.cwd());
}

// ── State Operations ─────────────────────────────────────────────────────

/** Load notebook state. Returns null if not found. Migrates legacy fields in-memory (no write-on-read). */
export async function loadNotebookState(
  projectRoot: string,
  name: string,
): Promise<NotebookState | null> {
  const raw = await readJson<NotebookState & { gpu?: string }>(statePath(projectRoot, name));
  if (!raw) return null;

  // Migrate legacy "gpu" field → "accelerator" (pre-v0.2 state files).
  // In-memory only — the file is rewritten on the next saveNotebookState call,
  // avoiding write-on-read races under concurrent CLI invocations.
  if (!raw.accelerator || raw.accelerator === "") {
    raw.accelerator = !raw.gpu || raw.gpu === "none" || raw.gpu === "" ? "cpu" : raw.gpu;
  }
  delete raw.gpu; // clean stale field from the returned object

  // Infer variant if missing (pre-variant state files or adopted runtimes)
  if (!raw.variant) {
    raw.variant = raw.accelerator === "cpu" ? "cpu"
      : /^v\d+e/i.test(raw.accelerator) ? "tpu"
      : "gpu";
  }

  return raw;
}

/** Save notebook state (atomic write). */
export async function saveNotebookState(
  projectRoot: string,
  name: string,
  state: NotebookState,
): Promise<void> {
  await writeJson(statePath(projectRoot, name), state);
}

/** Delete notebook state. Preserves .ipynb cache for recovery after reclamation. */
export async function deleteNotebookState(
  projectRoot: string,
  name: string,
): Promise<void> {
  await removeFile(statePath(projectRoot, name));
}

/** Validate a remote path for Contents API. Rejects traversal attempts. */
export function isValidRemotePath(remotePath: string): boolean {
  if (!remotePath) return false;
  // Reject absolute paths, path traversal, and null bytes
  if (remotePath.startsWith("/")) return false;
  if (remotePath.includes("\0")) return false;
  const segments = remotePath.split("/");
  return segments.every((s) => s !== ".." && s !== "." && s !== "");
}

/** List all known notebook names (from .colab/notebooks/*.json). */
export async function listNotebookNames(
  projectRoot: string,
): Promise<string[]> {
  const dir = join(projectRoot, COLAB_DIR, NOTEBOOKS_DIR);
  try {
    const entries = await readdir(dir);
    return entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => e.slice(0, -5)); // strip .json
  } catch {
    return [];
  }
}

// ── Dirty State ──────────────────────────────────────────────────────────

/** Compute SHA-256 hash of a file's contents. Returns `sha256:<hex>`. */
export async function hashFile(path: string): Promise<string> {
  const content = await readFile(path);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Check if the local .py has unpushed changes. */
export async function isDirty(
  projectRoot: string,
  name: string,
): Promise<boolean> {
  const state = await loadNotebookState(projectRoot, name);
  const pyPath = localPyPath(projectRoot, name);

  // Check if .py exists
  let currentHash: string;
  try {
    currentHash = await hashFile(pyPath);
  } catch {
    return false; // no .py file = not dirty (nothing to push/overwrite)
  }

  // .py exists but no pushedHash → never pushed → dirty
  if (!state?.pushedHash) return true;

  return currentHash !== state.pushedHash;
}
