/**
 * Token storage, refresh, and lifecycle management.
 *
 * Credentials are stored at ~/.config/colab-cli/credentials.json (mode 0600).
 * The file is self-contained: includes client_id/secret alongside tokens
 * so refresh works without hardcoded constants.
 *
 * All functions that touch the filesystem accept an options bag for
 * overriding paths and fetch (for testing).
 */

import { mkdir, readFile, writeFile, unlink, chmod } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  TOKEN_ENDPOINT,
  refreshAccessToken,
  type TokenResponse,
} from "./oauth.ts";

// ── Types ────────────────────────────────────────────────────────────────

/** Persisted credential file shape. */
export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  /** ISO 8601 timestamp when the access token expires. */
  expires_at: string;
  /** User's email (from token info, if available). */
  email?: string;
}

export interface TokenOptions {
  /** Override the credentials file path. */
  credentialsPath?: string;
  /** Injectable fetch for refresh calls. */
  fetch?: typeof globalThis.fetch;
  /** Buffer in seconds before expiry to trigger refresh (default: 300). */
  refreshBuffer?: number;
}

// ── Paths ────────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".config", "colab-cli");
const DEFAULT_CREDENTIALS_PATH = join(CONFIG_DIR, "credentials.json");

/** Get the credentials file path, respecting overrides. */
export function getCredentialsPath(opts?: TokenOptions): string {
  return opts?.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
}

// ── Persistence ──────────────────────────────────────────────────────────

/** Load credentials from disk. Returns null if file doesn't exist. */
export async function loadCredentials(
  opts?: TokenOptions,
): Promise<StoredCredentials | null> {
  const path = getCredentialsPath(opts);
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as StoredCredentials;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Save credentials to disk with mode 0600. */
export async function saveCredentials(
  creds: StoredCredentials,
  opts?: TokenOptions,
): Promise<void> {
  const path = getCredentialsPath(opts);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2), "utf-8");
  await chmod(path, 0o600);
}

/** Delete credentials file. */
export async function deleteCredentials(opts?: TokenOptions): Promise<void> {
  const path = getCredentialsPath(opts);
  try {
    await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// ── Token Response → Stored Credentials ──────────────────────────────────

/** Convert an OAuth token response to stored credentials. */
export function tokenResponseToStored(
  tokenRes: TokenResponse,
  existing?: StoredCredentials | null,
): StoredCredentials {
  const expiresAt = new Date(
    Date.now() + tokenRes.expires_in * 1000,
  ).toISOString();

  return {
    access_token: tokenRes.access_token,
    // Refresh responses don't include refresh_token — keep the existing one
    refresh_token:
      tokenRes.refresh_token ?? existing?.refresh_token ?? "",
    token_uri: TOKEN_ENDPOINT,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    expires_at: expiresAt,
    email: existing?.email,
  };
}

// ── Token Lifecycle ──────────────────────────────────────────────────────

/** Check if the access token is expired or near-expiry. */
export function isExpired(
  creds: StoredCredentials,
  bufferSeconds: number = 300,
): boolean {
  const expiresAt = new Date(creds.expires_at).getTime();
  return Date.now() >= expiresAt - bufferSeconds * 1000;
}

/**
 * Get a valid access token. Refreshes automatically if expired.
 *
 * Returns the access token string. Throws if no credentials are stored
 * or if refresh fails.
 */
export async function getAccessToken(
  opts?: TokenOptions,
): Promise<string> {
  const creds = await loadCredentials(opts);
  if (!creds) {
    throw new TokenError("Not logged in. Run: colab auth login");
  }

  if (!creds.refresh_token) {
    throw new TokenError(
      "No refresh token stored. Run: colab auth login",
    );
  }

  if (!isExpired(creds, opts?.refreshBuffer)) {
    return creds.access_token;
  }

  // Refresh the token
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const tokenRes = await refreshAccessToken(creds.refresh_token, fetchFn);
  const updated = tokenResponseToStored(tokenRes, creds);
  await saveCredentials(updated, opts);
  return updated.access_token;
}

/** Check if credentials exist and have a refresh token. */
export async function isLoggedIn(opts?: TokenOptions): Promise<boolean> {
  const creds = await loadCredentials(opts);
  return creds != null && !!creds.refresh_token;
}

// ── Error ────────────────────────────────────────────────────────────────

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}
