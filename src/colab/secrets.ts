/**
 * Secret resolution for GetSecret colab_requests.
 *
 * Creates a SecretResolver that caches the /userdata/list response
 * in process memory (one API call per session). Never written to disk.
 */

import type { ColabClient } from "./client.ts";
import type { SecretResolver } from "../jupyter/connection.ts";

/**
 * Create a SecretResolver backed by the Colab secrets API.
 * The resolver is cached — first call fetches secrets, subsequent
 * calls use the cached map.
 */
export function createSecretResolver(
  client: ColabClient,
  accessToken: string,
): SecretResolver {
  // Promise-based cache prevents double-fetch on concurrent calls.
  // On success, the map is cached for the session lifetime.
  // On failure, the cache is cleared so the next call retries — and the
  // failed promise itself rejects, so in-flight callers also see the failure
  // and can retry on their next invocation.
  let cachePromise: Promise<Map<string, string>> | null = null;

  async function fetchSecrets(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const secrets = await client.listSecrets(accessToken);
    // API returns either an array of {key, payload} or an object keyed by name
    if (Array.isArray(secrets)) {
      for (const s of secrets) {
        map.set(s.key, s.payload);
      }
    } else if (secrets && typeof secrets === "object") {
      for (const [key, val] of Object.entries(secrets as Record<string, { payload: string }>)) {
        map.set(key, val.payload);
      }
    }
    return map;
  }

  return async (key: string) => {
    if (!cachePromise) {
      cachePromise = fetchSecrets().catch((err) => {
        // Clear cache so next call retries (don't poison permanently)
        cachePromise = null;
        throw err;
      });
    }

    let cache: Map<string, string>;
    try {
      cache = await cachePromise;
    } catch {
      // API failed — fall through to "not found" (env vars still work)
      return { exists: false as const };
    }

    const payload = cache.get(key);
    if (payload !== undefined) {
      return { exists: true as const, payload };
    }
    return { exists: false as const };
  };
}
