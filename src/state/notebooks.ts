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
  /** GPU type (t4, a100, etc.). */
  gpu: string;
  /** When the runtime was first assigned. */
  createdAt: string;
  /** Last keep-alive timestamp. */
  lastKeepAlive?: string;
  /** SHA-256 of the last-pushed .py file contents. */
  pushedHash?: string;
}

// ── Path Conventions ─────────────────────────────────────────────────────

const COLAB_DIR = ".colab";
const NOTEBOOKS_DIR = "notebooks";

/** Contents API path for a notebook on the runtime. */
export function contentsPath(name: string): string {
  return `content/${name}.ipynb`;
}

/** Local .py working copy path. */
export function localPyPath(projectRoot: string, name: string): string {
  return join(projectRoot, `${name}.py`);
}

/** State file path: .colab/notebooks/<name>.json */
export function statePath(projectRoot: string, name: string): string {
  return join(projectRoot, COLAB_DIR, NOTEBOOKS_DIR, `${name}.json`);
}

/** Cache file path: .colab/notebooks/<name>.ipynb */
export function cachePath(projectRoot: string, name: string): string {
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

/** Load notebook state. Returns null if not found. */
export async function loadNotebookState(
  projectRoot: string,
  name: string,
): Promise<NotebookState | null> {
  return readJson<NotebookState>(statePath(projectRoot, name));
}

/** Save notebook state (atomic write). */
export async function saveNotebookState(
  projectRoot: string,
  name: string,
  state: NotebookState,
): Promise<void> {
  await writeJson(statePath(projectRoot, name), state);
}

/** Delete notebook state and cache. */
export async function deleteNotebookState(
  projectRoot: string,
  name: string,
): Promise<void> {
  await removeFile(statePath(projectRoot, name));
  await removeFile(cachePath(projectRoot, name));
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
