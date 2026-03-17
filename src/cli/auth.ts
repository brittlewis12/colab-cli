/**
 * CLI: colab auth login|status|logout
 */

import { ok, err, type CommandResult } from "./output.ts";
import { login, type TokenResponse } from "../auth/oauth.ts";
import {
  saveCredentials,
  deleteCredentials,
  loadCredentials,
  tokenResponseToStored,
  isExpired,
  getAccessToken,
} from "../auth/tokens.ts";
import { ColabClient } from "../colab/client.ts";

// ── Auth subcommand router ───────────────────────────────────────────────

export async function authCommand(args: string[]): Promise<CommandResult> {
  const sub = args[0];

  switch (sub) {
    case "login":
      return authLogin();
    case "status":
      return authStatus();
    case "logout":
      return authLogout();
    default:
      return err(
        "auth",
        "USAGE",
        `Unknown auth subcommand: ${sub ?? "(none)"}`,
        "Usage: colab auth login|status|logout",
      );
  }
}

// ── Login ────────────────────────────────────────────────────────────────

interface LoginData {
  email?: string;
  tier?: string;
}

async function authLogin(): Promise<CommandResult<LoginData>> {
  let tokens: TokenResponse;
  try {
    tokens = await login({
      onAuthUrl: (url) => {
        process.stderr.write(`Open this URL to authenticate:\n\n  ${url}\n\n`);
      },
    });
  } catch (e) {
    return err("auth.login", "AUTH", String(e));
  }

  // Save credentials
  const stored = tokenResponseToStored(tokens);
  await saveCredentials(stored);

  // Fetch user info to get email and tier
  const data: LoginData = {};
  try {
    const client = new ColabClient();
    const userInfo = await client.getUserInfo(tokens.access_token);
    data.tier = userInfo.subscriptionTier;

    // Try to get email from userinfo endpoint
    const emailRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );
    if (emailRes.ok) {
      const info = (await emailRes.json()) as { email?: string };
      if (info.email) {
        stored.email = info.email;
        data.email = info.email;
      }
    }

    await saveCredentials(stored);
  } catch {
    // Non-fatal — login succeeded even if we couldn't fetch user info
  }

  return ok("auth.login", data);
}

// ── Status ───────────────────────────────────────────────────────────────

interface StatusData {
  loggedIn: boolean;
  email?: string;
  tier?: string;
  computeUnits?: number;
  /** Current compute unit burn rate across all active runtimes (units/hour). 0 when no runtimes active. */
  consumptionRateHourly?: number;
  tokenExpired: boolean;
  eligibleGpus?: string[];
  eligibleTpus?: string[];
}

async function authStatus(): Promise<CommandResult<StatusData>> {
  const creds = await loadCredentials();

  if (!creds || !creds.refresh_token) {
    return ok("auth.status", {
      loggedIn: false,
      tokenExpired: true,
    });
  }

  const data: StatusData = {
    loggedIn: true,
    email: creds.email,
    tokenExpired: isExpired(creds),
  };

  // Fetch live info if possible
  try {
    const token = await getAccessToken();
    const client = new ColabClient();
    const userInfo = await client.getUserInfo(token);
    data.tier = userInfo.subscriptionTier;
    data.computeUnits = userInfo.paidComputeUnitsBalance;
    data.consumptionRateHourly = userInfo.consumptionRateHourly;
    data.eligibleGpus = userInfo.eligibleAccelerators
      ?.find((a) => a.variant === "VARIANT_GPU")
      ?.models;
    data.eligibleTpus = userInfo.eligibleAccelerators
      ?.find((a) => a.variant === "VARIANT_TPU")
      ?.models;
  } catch {
    // Non-fatal — return what we have from stored creds
  }

  return ok("auth.status", data);
}

// ── Logout ───────────────────────────────────────────────────────────────

async function authLogout(): Promise<CommandResult> {
  const creds = await loadCredentials();

  if (creds?.refresh_token) {
    // Revoke refresh token (best-effort). The refresh token is the long-lived
    // credential; revoking it also invalidates derived access tokens.
    // Token sent in POST body, not query string, to avoid proxy/log exposure.
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `token=${creds.refresh_token}`,
      });
    } catch {
      // Non-fatal
    }
  }

  await deleteCredentials();
  return ok("auth.logout");
}
