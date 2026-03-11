/**
 * HTTP header constants for Colab API requests.
 *
 * Three layers of auth, each with its own header:
 * 1. OAuth2 access token → Authorization: Bearer
 * 2. XSRF token → X-Goog-Colab-Token (per-mutation, obtained via GET)
 * 3. Proxy token → X-Colab-Runtime-Proxy-Token (per-runtime)
 */

export const AUTHORIZATION = "Authorization";
export const XSRF_TOKEN = "X-Goog-Colab-Token";
export const PROXY_TOKEN = "X-Colab-Runtime-Proxy-Token";
export const CLIENT_AGENT = "X-Colab-Client-Agent";
// Must be "vscode" — the Colab API may gate behavior on this value.
export const CLIENT_AGENT_VALUE = "vscode";
export const TUNNEL = "X-Colab-Tunnel";
export const TUNNEL_VALUE = "Google";

/** Headers for Colab API requests (colab.research.google.com). */
export function colabHeaders(accessToken: string): Record<string, string> {
  return {
    [AUTHORIZATION]: `Bearer ${accessToken}`,
    Accept: "application/json",
    [CLIENT_AGENT]: CLIENT_AGENT_VALUE,
  };
}

/** Add XSRF token header for POST mutations. */
export function withXsrf(
  headers: Record<string, string>,
  xsrfToken: string,
): Record<string, string> {
  return { ...headers, [XSRF_TOKEN]: xsrfToken };
}

/** Headers for Colab GAPI requests (colab.pa.googleapis.com). */
export function gapiHeaders(accessToken: string): Record<string, string> {
  return {
    [AUTHORIZATION]: `Bearer ${accessToken}`,
    Accept: "application/json",
    [CLIENT_AGENT]: CLIENT_AGENT_VALUE,
  };
}

/** Headers for Jupyter proxy requests (runtime proxy URL). */
export function proxyHeaders(proxyToken: string): Record<string, string> {
  return {
    [PROXY_TOKEN]: proxyToken,
    [CLIENT_AGENT]: CLIENT_AGENT_VALUE,
  };
}

/** Headers for keep-alive requests (require tunnel header). */
export function keepAliveHeaders(
  accessToken: string,
): Record<string, string> {
  return {
    ...colabHeaders(accessToken),
    [TUNNEL]: TUNNEL_VALUE,
  };
}
