import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  tokenResponseToStored,
  isExpired,
  getAccessToken,
  isLoggedIn,
  getCredentialsPath,
  type StoredCredentials,
  type TokenOptions,
  TokenError,
} from "../../src/auth/tokens.ts";
import { CLIENT_ID, CLIENT_SECRET, TOKEN_ENDPOINT } from "../../src/auth/oauth.ts";

// ── Test fixture helpers ─────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "colab-cli-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function testOpts(overrides?: Partial<TokenOptions>): TokenOptions {
  return {
    credentialsPath: join(tmpDir, "credentials.json"),
    ...overrides,
  };
}

function makeCreds(overrides?: Partial<StoredCredentials>): StoredCredentials {
  return {
    access_token: "ya29.test-access",
    refresh_token: "1//test-refresh",
    token_uri: TOKEN_ENDPOINT,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    email: "test@example.com",
    ...overrides,
  };
}

// ── getCredentialsPath ───────────────────────────────────────────────────

describe("getCredentialsPath", () => {
  test("returns default path when no override", () => {
    const path = getCredentialsPath();
    expect(path).toContain(".config/colab-cli/credentials.json");
  });

  test("respects override", () => {
    const path = getCredentialsPath({ credentialsPath: "/tmp/custom.json" });
    expect(path).toBe("/tmp/custom.json");
  });
});

// ── loadCredentials / saveCredentials ────────────────────────────────────

describe("loadCredentials + saveCredentials", () => {
  test("returns null when file doesn't exist", async () => {
    const creds = await loadCredentials(testOpts());
    expect(creds).toBeNull();
  });

  test("round-trips credentials", async () => {
    const opts = testOpts();
    const original = makeCreds();
    await saveCredentials(original, opts);

    const loaded = await loadCredentials(opts);
    expect(loaded).toEqual(original);
  });

  test("creates parent directories", async () => {
    const opts = testOpts({
      credentialsPath: join(tmpDir, "nested", "dir", "creds.json"),
    });
    const original = makeCreds();
    await saveCredentials(original, opts);

    const loaded = await loadCredentials(opts);
    expect(loaded).toEqual(original);
  });

  test("file permissions are 0600", async () => {
    const opts = testOpts();
    await saveCredentials(makeCreds(), opts);

    const file = Bun.file(getCredentialsPath(opts));
    // Bun doesn't expose file mode directly, but we can stat it
    const proc = Bun.spawnSync(["stat", "-f", "%Lp", getCredentialsPath(opts)]);
    const mode = proc.stdout.toString().trim();
    expect(mode).toBe("600");
  });
});

// ── deleteCredentials ────────────────────────────────────────────────────

describe("deleteCredentials", () => {
  test("deletes existing file", async () => {
    const opts = testOpts();
    await saveCredentials(makeCreds(), opts);
    await deleteCredentials(opts);

    const loaded = await loadCredentials(opts);
    expect(loaded).toBeNull();
  });

  test("no-op when file doesn't exist", async () => {
    // Should not throw
    await deleteCredentials(testOpts());
  });
});

// ── tokenResponseToStored ────────────────────────────────────────────────

describe("tokenResponseToStored", () => {
  test("converts token response with refresh_token", () => {
    const stored = tokenResponseToStored({
      access_token: "ya29.new",
      refresh_token: "1//new-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "colaboratory",
    });

    expect(stored.access_token).toBe("ya29.new");
    expect(stored.refresh_token).toBe("1//new-refresh");
    expect(stored.client_id).toBe(CLIENT_ID);
    expect(stored.client_secret).toBe(CLIENT_SECRET);
    expect(stored.token_uri).toBe(TOKEN_ENDPOINT);

    // expires_at should be ~1 hour from now
    const expiresAt = new Date(stored.expires_at).getTime();
    const diff = expiresAt - Date.now();
    expect(diff).toBeGreaterThan(3500_000);
    expect(diff).toBeLessThan(3700_000);
  });

  test("preserves existing refresh_token when response omits it", () => {
    const existing = makeCreds({ refresh_token: "1//keep-this" });
    const stored = tokenResponseToStored(
      {
        access_token: "ya29.refreshed",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "colaboratory",
      },
      existing,
    );

    expect(stored.access_token).toBe("ya29.refreshed");
    expect(stored.refresh_token).toBe("1//keep-this");
    expect(stored.email).toBe("test@example.com");
  });
});

// ── isExpired ────────────────────────────────────────────────────────────

describe("isExpired", () => {
  test("not expired when well within lifetime", () => {
    const creds = makeCreds({
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(isExpired(creds)).toBe(false);
  });

  test("expired when past expiry", () => {
    const creds = makeCreds({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(isExpired(creds)).toBe(true);
  });

  test("expired when within buffer", () => {
    // 200 seconds from now, but buffer is 300
    const creds = makeCreds({
      expires_at: new Date(Date.now() + 200_000).toISOString(),
    });
    expect(isExpired(creds, 300)).toBe(true);
  });

  test("not expired when just outside buffer", () => {
    // 400 seconds from now, buffer is 300
    const creds = makeCreds({
      expires_at: new Date(Date.now() + 400_000).toISOString(),
    });
    expect(isExpired(creds, 300)).toBe(false);
  });
});

// ── getAccessToken ───────────────────────────────────────────────────────

describe("getAccessToken", () => {
  test("returns stored token when not expired", async () => {
    const opts = testOpts();
    await saveCredentials(makeCreds({ access_token: "ya29.valid" }), opts);

    const token = await getAccessToken(opts);
    expect(token).toBe("ya29.valid");
  });

  test("refreshes and saves when expired", async () => {
    const opts = testOpts({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            access_token: "ya29.refreshed",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "colaboratory",
          }),
          { status: 200 },
        )) as any,
    });

    // Save expired credentials
    await saveCredentials(
      makeCreds({
        access_token: "ya29.expired",
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
      opts,
    );

    const token = await getAccessToken(opts);
    expect(token).toBe("ya29.refreshed");

    // Verify the saved credentials were updated
    const saved = await loadCredentials(opts);
    expect(saved!.access_token).toBe("ya29.refreshed");
    // Original refresh_token should be preserved
    expect(saved!.refresh_token).toBe("1//test-refresh");
  });

  test("throws TokenError when not logged in", async () => {
    await expect(getAccessToken(testOpts())).rejects.toThrow(TokenError);
    await expect(getAccessToken(testOpts())).rejects.toThrow("Not logged in");
  });

  test("throws TokenError when no refresh token", async () => {
    const opts = testOpts();
    await saveCredentials(
      makeCreds({
        refresh_token: "",
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
      opts,
    );

    await expect(getAccessToken(opts)).rejects.toThrow("No refresh token");
  });
});

// ── isLoggedIn ───────────────────────────────────────────────────────────

describe("isLoggedIn", () => {
  test("false when no credentials file", async () => {
    expect(await isLoggedIn(testOpts())).toBe(false);
  });

  test("true when credentials exist with refresh token", async () => {
    const opts = testOpts();
    await saveCredentials(makeCreds(), opts);
    expect(await isLoggedIn(opts)).toBe(true);
  });

  test("false when credentials exist but no refresh token", async () => {
    const opts = testOpts();
    await saveCredentials(makeCreds({ refresh_token: "" }), opts);
    expect(await isLoggedIn(opts)).toBe(false);
  });
});
