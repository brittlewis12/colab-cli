/**
 * XSSI (Cross-Site Script Inclusion) prefix stripping.
 *
 * All responses from colab.research.google.com are prefixed with )]}'
 * followed by a newline to prevent direct script inclusion attacks.
 * We strip this before JSON parsing.
 */

const XSSI_PREFIX = ")]}'\n";

/** Strip the XSSI prefix if present, then JSON-parse. */
export function parseXssiJson<T = unknown>(body: string): T {
  const stripped = body.startsWith(XSSI_PREFIX)
    ? body.slice(XSSI_PREFIX.length)
    : body;
  return JSON.parse(stripped) as T;
}
