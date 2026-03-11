/**
 * ColabClient: typed HTTP client for the Colab API.
 *
 * Covers both domains:
 * - colab.research.google.com (tunnel/proxy, XSSI-prefixed responses)
 * - colab.pa.googleapis.com (REST/GAPI, standard JSON responses)
 *
 * All methods accept an access token and handle XSSI stripping,
 * authuser param injection, and header construction.
 */

import { parseXssiJson } from "./xssi.ts";
import {
  colabHeaders,
  gapiHeaders,
  keepAliveHeaders,
  withXsrf,
} from "./headers.ts";
import type {
  AssignParams,
  GetAssignmentResponse,
  PostAssignmentResponse,
  GapiAssignment,
  UnassignTokenResponse,
  UserInfo,
  ProxyTokenResponse,
} from "./types.ts";
import { shapeToParam } from "./types.ts";

const COLAB_DOMAIN = "https://colab.research.google.com";
const GAPI_DOMAIN = "https://colab.pa.googleapis.com";
const TUN_PREFIX = "/tun/m";

type FetchFn = typeof globalThis.fetch;

export interface ColabClientOptions {
  colabDomain?: string;
  gapiDomain?: string;
  /** Injectable fetch for testing. */
  fetch?: FetchFn;
}

export class ColabClient {
  private readonly colabDomain: string;
  private readonly gapiDomain: string;
  private readonly fetch: FetchFn;

  constructor(opts: ColabClientOptions = {}) {
    this.colabDomain = opts.colabDomain ?? COLAB_DOMAIN;
    this.gapiDomain = opts.gapiDomain ?? GAPI_DOMAIN;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // --- Helpers ---

  /** Build a tunnel URL with authuser=0. */
  private tunUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(`${TUN_PREFIX}${path}`, this.colabDomain);
    url.searchParams.set("authuser", "0");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  /** Build a GAPI URL. */
  private gapiUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.gapiDomain);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  /** Fetch from colab domain, strip XSSI, parse JSON. */
  private async colabGet<T>(
    path: string,
    token: string,
    params?: Record<string, string>,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await this.fetch(this.tunUrl(path, params), {
      headers: { ...colabHeaders(token), ...extraHeaders },
    });
    if (!res.ok) {
      throw new ColabApiError(res.status, await res.text(), path);
    }
    return parseXssiJson<T>(await res.text());
  }

  /** POST to colab domain with XSRF token. */
  private async colabPost<T>(
    path: string,
    token: string,
    xsrfToken: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const res = await this.fetch(this.tunUrl(path, params), {
      method: "POST",
      headers: withXsrf(colabHeaders(token), xsrfToken),
    });
    if (!res.ok) {
      throw new ColabApiError(res.status, await res.text(), path);
    }
    return parseXssiJson<T>(await res.text());
  }

  /** Fetch from GAPI domain, parse JSON. */
  private async gapiGet<T>(
    path: string,
    token: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const res = await this.fetch(this.gapiUrl(path, params), {
      headers: gapiHeaders(token),
    });
    if (!res.ok) {
      throw new ColabApiError(res.status, await res.text(), path);
    }
    return (await res.json()) as T;
  }

  // --- User Info ---

  async getUserInfo(token: string): Promise<UserInfo> {
    return this.gapiGet<UserInfo>("/v1/user-info", token, {
      get_ccu_consumption_info: "true",
    });
  }

  // --- Assignments ---

  /** List all active assignments. */
  async listAssignments(token: string): Promise<GapiAssignment[]> {
    const res = await this.gapiGet<{ assignments?: GapiAssignment[] }>(
      "/v1/assignments",
      token,
    );
    return res.assignments ?? [];
  }

  /** Step 1 of assign: GET to retrieve XSRF token + current state. */
  async getAssignment(
    token: string,
    params: AssignParams,
  ): Promise<GetAssignmentResponse | PostAssignmentResponse> {
    const qp: Record<string, string> = {
      nbh: params.notebookHash,
      variant: params.variant,
      accelerator: params.accelerator,
    };
    const sp = shapeToParam(params.shape);
    if (sp) qp.shape = sp;
    if (params.runtimeVersion) {
      qp.runtime_version_label = params.runtimeVersion;
    }
    return this.colabGet<GetAssignmentResponse | PostAssignmentResponse>(
      "/assign",
      token,
      qp,
    );
  }

  /** Step 2 of assign: POST with XSRF token to create assignment. */
  async postAssignment(
    token: string,
    xsrfToken: string,
    params: AssignParams,
  ): Promise<PostAssignmentResponse> {
    const qp: Record<string, string> = {
      nbh: params.notebookHash,
      variant: params.variant,
      accelerator: params.accelerator,
    };
    const sp = shapeToParam(params.shape);
    if (sp) qp.shape = sp;
    return this.colabPost<PostAssignmentResponse>(
      "/assign",
      token,
      xsrfToken,
      qp,
    );
  }

  /**
   * Assign a runtime: GET for XSRF → POST to create.
   * If GET returns an existing assignment, returns it directly.
   */
  async assign(
    token: string,
    params: AssignParams,
  ): Promise<PostAssignmentResponse> {
    const getResp = await this.getAssignment(token, params);

    // If already assigned, the GET response IS the assignment
    if ("endpoint" in getResp && "runtimeProxyInfo" in getResp) {
      return getResp as PostAssignmentResponse;
    }

    // Otherwise, POST with the XSRF token
    const xsrf = (getResp as GetAssignmentResponse).token;
    return this.postAssignment(token, xsrf, params);
  }

  /** Step 1 of unassign: GET XSRF token. */
  async getUnassignToken(
    token: string,
    endpoint: string,
  ): Promise<string> {
    const resp = await this.colabGet<UnassignTokenResponse>(
      `/unassign/${endpoint}`,
      token,
    );
    return resp.token;
  }

  /** Unassign a runtime: GET XSRF → POST to unassign. */
  async unassign(token: string, endpoint: string): Promise<void> {
    const xsrf = await this.getUnassignToken(token, endpoint);
    const res = await this.fetch(
      this.tunUrl(`/unassign/${endpoint}`),
      {
        method: "POST",
        headers: withXsrf(colabHeaders(token), xsrf),
      },
    );
    if (!res.ok) {
      throw new ColabApiError(
        res.status,
        await res.text(),
        `/unassign/${endpoint}`,
      );
    }
  }

  // --- Credential Propagation ---

  /**
   * Propagate credentials to the runtime for auth challenges.
   *
   * The kernel sends `colab_request` messages on the WebSocket when
   * it needs credentials (Drive mount, user auth, etc.). The client
   * must call this endpoint and then reply on the WebSocket.
   *
   * XSRF pattern: GET to get token, POST to propagate.
   */
  async propagateCredentials(
    token: string,
    endpoint: string,
    authType: string,
    dryRun: boolean,
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {
      authtype: authType,
      version: "2",
      dryrun: dryRun ? "true" : "false",
      propagate: "true",
      record: "false",
    };

    // Step 1: GET for XSRF token
    const data = await this.colabGet<{ token?: string; xsrfToken?: string }>(
      `/credentials-propagation/${endpoint}`,
      token,
      params,
    );

    const xsrf = data.token ?? data.xsrfToken;
    if (!xsrf) {
      throw new ColabApiError(0, "No XSRF token in propagation response", `/credentials-propagation/${endpoint}`);
    }

    // Step 2: POST with XSRF token
    return this.colabPost<Record<string, unknown>>(
      `/credentials-propagation/${endpoint}`,
      token,
      xsrf,
      params,
    );
  }

  // --- Keep-Alive ---

  async keepAlive(token: string, endpoint: string): Promise<void> {
    const url = this.tunUrl(`/${endpoint}/keep-alive/`);
    const res = await this.fetch(url, {
      headers: keepAliveHeaders(token),
    });
    if (!res.ok) {
      throw new ColabApiError(
        res.status,
        await res.text(),
        `/${endpoint}/keep-alive/`,
      );
    }
  }

  // --- Proxy Token ---

  async refreshProxyToken(
    token: string,
    endpoint: string,
  ): Promise<ProxyTokenResponse> {
    return this.gapiGet<ProxyTokenResponse>(
      "/v1/runtime-proxy-token",
      token,
      { endpoint, port: "8080" },
    );
  }
}

// --- Error ---

export class ColabApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
  ) {
    super(`Colab API error ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = "ColabApiError";
  }
}
