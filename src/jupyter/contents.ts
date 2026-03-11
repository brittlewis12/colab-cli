/**
 * Jupyter Contents API client for file operations on Colab runtimes.
 *
 * Operates through the runtime proxy URL with proxy token auth.
 * Used for uploading/downloading .ipynb files.
 */

import { proxyHeaders } from "../colab/headers.ts";

type FetchFn = typeof globalThis.fetch;

export interface ContentsClientOptions {
  fetch?: FetchFn;
}

export class ContentsClient {
  private readonly baseUrl: string;
  private readonly proxyToken: string;
  private readonly fetch: FetchFn;

  constructor(
    baseUrl: string,
    proxyToken: string,
    opts: ContentsClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.proxyToken = proxyToken;
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string, params?: Record<string, string>): string {
    const url = new URL(`/api/contents/${path}`, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private headers(): Record<string, string> {
    return proxyHeaders(this.proxyToken);
  }

  /** Read a file as base64. */
  async readFile(path: string): Promise<Buffer> {
    const res = await this.fetch(
      this.url(path, { format: "base64", type: "file" }),
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Contents API GET ${path}: ${res.status}`);
    }
    const body = (await res.json()) as { content: string };
    return Buffer.from(body.content, "base64");
  }

  /** Read a file as text (for .ipynb JSON). */
  async readText(path: string): Promise<string> {
    const buf = await this.readFile(path);
    return buf.toString("utf-8");
  }

  /** Write a file from a Buffer. */
  async writeFile(path: string, content: Buffer): Promise<void> {
    const res = await this.fetch(this.url(path), {
      method: "PUT",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: content.toString("base64"),
        format: "base64",
        type: "file",
      }),
    });
    if (!res.ok) {
      throw new Error(`Contents API PUT ${path}: ${res.status}`);
    }
  }

  /** Write text content (for .ipynb JSON). */
  async writeText(path: string, text: string): Promise<void> {
    return this.writeFile(path, Buffer.from(text, "utf-8"));
  }

  /** List directory contents. */
  async listDir(path: string): Promise<ContentsEntry[]> {
    const res = await this.fetch(
      this.url(path, { type: "directory" }),
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Contents API list ${path}: ${res.status}`);
    }
    const body = (await res.json()) as { content: ContentsEntry[] };
    return body.content;
  }

  /** Delete a file or directory. */
  async delete(path: string): Promise<void> {
    const res = await this.fetch(this.url(path), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Contents API DELETE ${path}: ${res.status}`);
    }
  }

  /** Get file metadata without content. */
  async stat(path: string): Promise<ContentsEntry> {
    const res = await this.fetch(
      this.url(path, { content: "0" }),
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw new Error(`Contents API stat ${path}: ${res.status}`);
    }
    return (await res.json()) as ContentsEntry;
  }
}

export interface ContentsEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "notebook";
  size?: number;
  last_modified: string;
  created: string;
}
