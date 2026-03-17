/**
 * Colab API response types.
 *
 * Derived from the colab-vscode reference implementation's Zod schemas
 * and response handling code. These cover both the tunnel domain
 * (colab.research.google.com) and the GAPI domain
 * (colab.pa.googleapis.com).
 */

// --- Enums ---

export enum Variant {
  DEFAULT = "DEFAULT",
  GPU = "GPU",
  TPU = "TPU",
}

export enum Shape {
  STANDARD = 0,
  HIGHMEM = 1,
}

export enum Outcome {
  UNDEFINED = 0,
  QUOTA_DENIED = 1,
  QUOTA_EXCEEDED = 2,
  SUCCESS = 4,
  DENYLISTED = 5,
}

export enum SubscriptionTier {
  NONE = 0,
  PRO = 1,
  PRO_PLUS = 2,
}

// --- Assign ---

/** GET /tun/m/assign response when no assignment exists yet. */
export interface GetAssignmentResponse {
  acc: string;
  nbh: string;
  p: boolean;
  token: string; // XSRF token for POST
  variant: string;
}

/** Runtime proxy info embedded in assignment responses. */
export interface RuntimeProxyInfo {
  token: string;
  tokenExpiresInSeconds: number;
  url: string;
}

/** POST /tun/m/assign response on success. */
export interface PostAssignmentResponse {
  accelerator: string;
  endpoint: string;
  fit: number;
  allowedCredentials: boolean;
  sub: number;
  subTier: number;
  outcome: Outcome;
  variant: number;
  machineShape: number;
  runtimeProxyInfo: RuntimeProxyInfo;
}

/** GET /v1/assignments list item (GAPI domain, live-validated 2026-03-11). */
export interface GapiAssignment {
  endpoint: string;
  variant: string; // "VARIANT_GPU"
  machineShape: string; // "SHAPE_DEFAULT"
  accelerator: string; // "T4"
  runtimeProxyInfo?: {
    token: string;
    tokenTtl: string; // e.g. "3600s"
    url: string;
  };
}

// --- Unassign ---

/** GET /tun/m/unassign/{endpoint} response. */
export interface UnassignTokenResponse {
  token: string; // XSRF token
}

// --- User Info ---

/** Accelerator model list from getUserInfo. */
export interface AcceleratorGroup {
  variant: string; // "VARIANT_GPU" | "VARIANT_TPU"
  models: string[]; // ["T4", "L4", "A100", ...]
}

/** GET /v1/user-info response (live-validated 2026-03-11, consumption fields 2026-03-17). */
export interface UserInfo {
  subscriptionTier: string; // "SUBSCRIPTION_TIER_PRO", etc.
  paidComputeUnitsBalance?: number;
  /** Current compute unit burn rate across all active runtimes (units/hour). */
  consumptionRateHourly?: number;
  /** Number of active runtime assignments. */
  assignmentsCount?: number;
  eligibleAccelerators?: AcceleratorGroup[];
  ineligibleAccelerators?: AcceleratorGroup[];
}

// --- Proxy Token Refresh ---

/** GET /v1/runtime-proxy-token response. */
export interface ProxyTokenResponse {
  token: string;
  tokenTtl: string; // e.g. "3600s"
  url: string;
}

// --- Sessions ---

/** Jupyter session from /api/sessions. */
export interface JupyterSession {
  id: string;
  path: string;
  name: string;
  type: string;
  kernel: {
    id: string;
    name: string;
    last_activity: string;
    execution_state: string;
    connections: number;
  };
}

// --- Assign parameters ---

export interface AssignParams {
  notebookHash: string;
  variant: Variant;
  accelerator: string;
  shape?: Shape;
  runtimeVersion?: string;
}

/** Map shape enum to URL param. */
export function shapeToParam(shape?: Shape): string | undefined {
  if (shape === Shape.HIGHMEM) return "hm";
  return undefined;
}

/**
 * Generate a notebook hash.
 *
 * Format: UUID v4 with dashes replaced by underscores,
 * padded with dots to 44 chars. Confirmed from pdwi2020
 * and live-validated.
 *
 * Example: "380b033e_4abf_4918_9f96_3d147452ff9a........"
 */
export function notebookHash(): string {
  const uuid = crypto.randomUUID();
  return uuid.replace(/-/g, "_") + ".".repeat(44 - uuid.length);
}
