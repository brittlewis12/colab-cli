/**
 * OAuth2 loopback flow for Colab authentication.
 *
 * Uses the Colab VS Code extension's public OAuth client credentials
 * (called "ClientNotSoSecret" in the extension source). The loopback
 * flow starts a localhost HTTP server, directs the user to Google's
 * consent screen, and catches the redirect with the auth code.
 *
 * All functions accept an injectable fetch for testing.
 */

// ── Constants (public, from google.colab@0.3.0 VS Code extension) ────────

export const CLIENT_ID =
  "1014160490159-cvot3bea7tgkp72a4m29h20d9ddo6bne.apps.googleusercontent.com";
export const CLIENT_SECRET = "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";

export const SCOPES = [
  "https://www.googleapis.com/auth/colaboratory",
  "profile",
  "email",
];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// ── Types ────────────────────────────────────────────────────────────────

/** Raw token response from Google's token endpoint. */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface LoginOptions {
  /** Port for the loopback server (0 = random). */
  port?: number;
  /** Timeout in ms waiting for the redirect (default: 120_000). */
  timeout?: number;
  /** Injectable fetch for testing. */
  fetch?: typeof globalThis.fetch;
  /** Called with the auth URL the user should open. */
  onAuthUrl?: (url: string) => void;
}

// ── Auth URL ─────────────────────────────────────────────────────────────

/** Build the Google OAuth consent URL with CSRF-protection state parameter. */
export function buildAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ── Token Exchange ───────────────────────────────────────────────────────

/** Exchange an authorization code for tokens. */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new OAuthError(`Token exchange failed: ${res.status} ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

/** Refresh an access token using a refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new OAuthError(`Token refresh failed: ${res.status} ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

// ── Loopback Login Flow ──────────────────────────────────────────────────

/**
 * Run the full OAuth2 loopback login flow.
 *
 * 1. Start localhost HTTP server
 * 2. Build auth URL → call onAuthUrl (or print to stderr)
 * 3. Wait for Google redirect with ?code=...
 * 4. Exchange code for tokens
 * 5. Return tokens
 *
 * The server shuts down after receiving the code or on timeout.
 */
export async function login(opts: LoginOptions = {}): Promise<TokenResponse> {
  const {
    port = 0,
    timeout = 120_000,
    fetch: fetchFn = globalThis.fetch,
    onAuthUrl,
  } = opts;

  // Generate a random state nonce for CSRF protection
  const oauthState = crypto.randomUUID();

  return new Promise<TokenResponse>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",

      async fetch(req) {
        const url = new URL(req.url);

        // Only handle the redirect path
        if (url.pathname !== "/") {
          return new Response("Not found", { status: 404 });
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const returnedState = url.searchParams.get("state");

        // Validate state parameter to prevent CSRF
        if (code && returnedState !== oauthState) {
          settled = true;
          clearTimeout(timer);
          server.stop();
          reject(new OAuthError("OAuth state mismatch — possible CSRF attack. Please retry login."));
          return new Response(
            "<html><body><h1>Invalid state parameter</h1><p>Possible CSRF attack. Please try again.</p></body></html>",
            { status: 403, headers: { "Content-Type": "text/html" } },
          );
        }

        if (error) {
          settled = true;
          clearTimeout(timer);
          server.stop();
          reject(new OAuthError(`Auth denied: ${error}`));
          return new Response(
            "<html><body><h1>Authentication failed</h1><p>You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        if (!code) {
          return new Response(
            "<html><body><h1>Waiting for auth...</h1></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        }

        // Exchange code for tokens
        const redirectUri = `http://127.0.0.1:${server.port}`;
        try {
          const tokens = await exchangeCode(code, redirectUri, fetchFn);
          settled = true;
          clearTimeout(timer);
          server.stop();
          resolve(tokens);
          return new Response(
            "<html><body><h1>Authentication successful</h1><p>You can close this tab.</p></body></html>",
            { headers: { "Content-Type": "text/html" } },
          );
        } catch (err) {
          settled = true;
          clearTimeout(timer);
          server.stop();
          reject(err);
          return new Response(
            "<html><body><h1>Token exchange failed</h1></body></html>",
            { headers: { "Content-Type": "text/html" }, status: 500 },
          );
        }
      },
    });

    // Build and emit auth URL
    const redirectUri = `http://127.0.0.1:${server.port}`;
    const authUrl = buildAuthUrl(redirectUri, oauthState);

    if (onAuthUrl) {
      onAuthUrl(authUrl);
    } else {
      console.error(`Open this URL to authenticate:\n\n  ${authUrl}\n`);
    }

    // Timeout
    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.stop();
        reject(new OAuthError(`Login timed out after ${timeout / 1000}s`));
      }
    }, timeout);
  });
}

// ── Error ────────────────────────────────────────────────────────────────

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}
