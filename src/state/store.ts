/**
 * Generic state file read/write with atomic rename.
 *
 * Write to a .tmp file then rename — prevents partial reads from
 * concurrent CLI invocations. No flock.
 */

import { readFile, writeFile, rename, unlink, mkdir } from "fs/promises";
import { dirname } from "path";

/** Read a JSON state file. Returns null if not found. */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Write a JSON state file atomically (write .tmp → rename). */
export async function writeJson<T>(path: string, data: T): Promise<void> {
  const tmp = path + ".tmp";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmp, path);
}

/** Delete a state file. No-op if not found. */
export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
