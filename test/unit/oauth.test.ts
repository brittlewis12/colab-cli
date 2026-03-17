import { describe, test, expect } from "bun:test";
import {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  login,
  CLIENT_ID,
  CLIENT_SECRET,
  SCOPES,
  TOKEN_ENDPOINT,
  OAuthError,
} from "../../src/auth/oauth.ts";

// ── buildAuthUrl ─────────────────────────────────────────────────────────

describe("buildAuthUrl", () => {
  test("includes required OAuth params", () => {
    const url = buildAuthUrl("http://127.0.0.1:8085", "test-state");
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.pathname).toBe("/o/oauth2/v2/auth");
    expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8085");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("state")).toBe("test-state");
  });

  test("includes all required scopes", () => {
    const url = buildAuthUrl("http://127.0.0.1:9999", "test-state");
    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope")!;

    for (const s of SCOPES) {
      expect(scope).toContain(s);
    }
  });
});

// ── exchangeCode ─────────────────────────────────────────────────────────

describe("exchangeCode", () => {
  test("sends correct POST body and returns tokens", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;

    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          access_token: "ya29.test",
          refresh_token: "1//test",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "colaboratory profile email",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const tokens = await exchangeCode("auth-code-123", "http://127.0.0.1:8085", mockFetch as any);

    expect(capturedUrl).toBe(TOKEN_ENDPOINT);
    expect(tokens.access_token).toBe("ya29.test");
    expect(tokens.refresh_token).toBe("1//test");
    expect(tokens.expires_in).toBe(3600);

    // Verify the POST body contains required params
    const params = new URLSearchParams(capturedBody!);
    expect(params.get("code")).toBe("auth-code-123");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:8085");
    expect(params.get("grant_type")).toBe("authorization_code");
  });

  test("throws OAuthError on HTTP error", async () => {
    const mockFetch = async () =>
      new Response('{"error": "invalid_grant"}', { status: 400 });

    await expect(
      exchangeCode("bad-code", "http://127.0.0.1:8085", mockFetch as any),
    ).rejects.toThrow(OAuthError);
  });
});

// ── refreshAccessToken ───────────────────────────────────────────────────

describe("refreshAccessToken", () => {
  test("sends refresh_token and returns new tokens", async () => {
    let capturedBody: string | undefined;

    const mockFetch = async (_: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          access_token: "ya29.refreshed",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "colaboratory profile email",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const tokens = await refreshAccessToken("1//refresh-tok", mockFetch as any);

    expect(tokens.access_token).toBe("ya29.refreshed");
    // Refresh responses typically don't include a new refresh_token
    expect(tokens.refresh_token).toBeUndefined();

    const params = new URLSearchParams(capturedBody!);
    expect(params.get("refresh_token")).toBe("1//refresh-tok");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
  });

  test("throws OAuthError on expired refresh token", async () => {
    const mockFetch = async () =>
      new Response('{"error": "invalid_grant", "error_description": "Token has been revoked"}', {
        status: 400,
      });

    await expect(
      refreshAccessToken("1//revoked", mockFetch as any),
    ).rejects.toThrow(OAuthError);
  });
});

// ── login (loopback flow) ────────────────────────────────────────────────

describe("login", () => {
  test("starts server, receives code, exchanges tokens", async () => {
    let authUrl: string | undefined;

    const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "ya29.login-test",
          refresh_token: "1//login-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "colaboratory profile email",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    // Start login in background
    const loginPromise = login({
      port: 0, // random port
      timeout: 5_000,
      fetch: mockFetch as any,
      onAuthUrl: (url) => {
        authUrl = url;
      },
    });

    // Wait a tick for the server to start
    await new Promise((r) => setTimeout(r, 10));

    // Extract port and state from auth URL
    expect(authUrl).toBeDefined();
    const authParams = new URL(authUrl!).searchParams;
    const redirectUri = authParams.get("redirect_uri")!;
    const state = authParams.get("state")!;
    const port = new URL(redirectUri).port;
    expect(state).toBeTruthy(); // CSRF state parameter must be present

    // Simulate Google's redirect by hitting the loopback server (including state)
    const redirectResponse = await fetch(
      `http://127.0.0.1:${port}/?code=test-auth-code&state=${state}`,
    );
    expect(redirectResponse.status).toBe(200);
    const html = await redirectResponse.text();
    expect(html).toContain("successful");

    // Verify the login resolved with tokens
    const tokens = await loginPromise;
    expect(tokens.access_token).toBe("ya29.login-test");
    expect(tokens.refresh_token).toBe("1//login-refresh");
  });

  test("rejects on auth error from Google", async () => {
    let authUrl: string | undefined;

    const loginPromise = login({
      port: 0,
      timeout: 5_000,
      onAuthUrl: (url) => {
        authUrl = url;
      },
    });

    // Prevent unhandled rejection before we get to the assertion
    loginPromise.catch(() => {});

    await new Promise((r) => setTimeout(r, 10));

    const redirectUri = new URL(authUrl!).searchParams.get("redirect_uri")!;
    const port = new URL(redirectUri).port;

    // Simulate Google redirecting with an error
    // Server stops after rejecting, so the fetch may fail — ignore it
    await fetch(`http://127.0.0.1:${port}/?error=access_denied`).catch(() => {});

    // Now check that the login promise rejected with the right error
    let error: Error | undefined;
    try {
      await loginPromise;
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(OAuthError);
    expect(error!.message).toContain("Auth denied");
  });

  test("rejects on timeout", async () => {
    const loginPromise = login({
      port: 0,
      timeout: 50, // very short timeout
      onAuthUrl: () => {}, // suppress console output
    });

    await expect(loginPromise).rejects.toThrow("timed out");
  });
});
