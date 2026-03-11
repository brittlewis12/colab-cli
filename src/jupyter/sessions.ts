/**
 * Jupyter Sessions + Kernels REST API client.
 *
 * Used to create/list sessions and manage kernels on Colab runtimes.
 * Operates through the runtime proxy URL.
 */

import { proxyHeaders } from "../colab/headers.ts";
import type { JupyterSession } from "../colab/types.ts";

type FetchFn = typeof globalThis.fetch;

export interface SessionsClientOptions {
  fetch?: FetchFn;
}

export class SessionsClient {
  private readonly baseUrl: string;
  private readonly proxyToken: string;
  private readonly fetch: FetchFn;

  constructor(
    baseUrl: string,
    proxyToken: string,
    opts: SessionsClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.proxyToken = proxyToken;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private headers(): Record<string, string> {
    return {
      ...proxyHeaders(this.proxyToken),
      "Content-Type": "application/json",
    };
  }

  // --- Sessions ---

  async listSessions(): Promise<JupyterSession[]> {
    const res = await this.fetch(this.url("/api/sessions"), {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Sessions API list: ${res.status}`);
    }
    return (await res.json()) as JupyterSession[];
  }

  async createSession(opts: {
    path: string;
    name: string;
    kernelName?: string;
  }): Promise<JupyterSession> {
    const res = await this.fetch(this.url("/api/sessions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        path: opts.path,
        name: opts.name,
        type: "notebook",
        kernel: { name: opts.kernelName ?? "python3" },
      }),
    });
    if (!res.ok) {
      throw new Error(`Sessions API create: ${res.status}`);
    }
    return (await res.json()) as JupyterSession;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.fetch(this.url(`/api/sessions/${sessionId}`), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Sessions API delete ${sessionId}: ${res.status}`);
    }
  }

  // --- Kernels ---

  async interruptKernel(kernelId: string): Promise<void> {
    const res = await this.fetch(
      this.url(`/api/kernels/${kernelId}/interrupt`),
      { method: "POST", headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Kernels API interrupt ${kernelId}: ${res.status}`);
    }
  }

  async restartKernel(kernelId: string): Promise<void> {
    const res = await this.fetch(
      this.url(`/api/kernels/${kernelId}/restart`),
      { method: "POST", headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Kernels API restart ${kernelId}: ${res.status}`);
    }
  }
}
