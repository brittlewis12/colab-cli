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
  let cache: Map<string, string> | null = null;

  return async (key: string) => {
    // Lazy-load on first request
    if (!cache) {
      cache = new Map();
      try {
        const secrets = await client.listSecrets(accessToken);
        for (const s of secrets) {
          cache.set(s.key, s.payload);
        }
      } catch {
        // If API fails, cache stays empty — env vars still work
      }
    }

    const payload = cache.get(key);
    if (payload !== undefined) {
      return { exists: true as const, payload };
    }
    return { exists: false as const };
  };
}
