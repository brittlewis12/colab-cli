import { describe, test, expect } from "bun:test";
import { ContentsClient } from "../../src/jupyter/contents.ts";

function mockFetch(
  handler: (req: Request) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(handler(new Request(input, init)));
  }) as typeof globalThis.fetch;
}

describe("ContentsClient", () => {
  test("readText fetches base64, decodes to UTF-8", async () => {
    const text = '{"cells":[],"nbformat":4}';
    const b64 = Buffer.from(text).toString("base64");

    const fetch = mockFetch((req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/api/contents/notebook.ipynb");
      expect(url.searchParams.get("format")).toBe("base64");
      expect(url.searchParams.get("type")).toBe("file");
      expect(req.headers.get("X-Colab-Runtime-Proxy-Token")).toBe("ptok");
      return new Response(JSON.stringify({ content: b64 }));
    });

    const client = new ContentsClient(
      "https://proxy.test",
      "ptok",
      { fetch },
    );
    const result = await client.readText("notebook.ipynb");
    expect(result).toBe(text);
  });

  test("writeText sends base64-encoded body", async () => {
    const text = '{"cells":[]}';
    let capturedBody: any;

    const fetch = mockFetch(async (req) => {
      expect(req.method).toBe("PUT");
      expect(new URL(req.url).pathname).toBe("/api/contents/nb.ipynb");
      capturedBody = await req.json();
      return new Response("", { status: 201 });
    });

    const client = new ContentsClient(
      "https://proxy.test",
      "ptok",
      { fetch },
    );
    await client.writeText("nb.ipynb", text);

    expect(capturedBody.format).toBe("base64");
    expect(capturedBody.type).toBe("file");
    expect(Buffer.from(capturedBody.content, "base64").toString()).toBe(text);
  });

  test("listDir returns directory entries", async () => {
    const entries = [
      {
        name: "file.py",
        path: "content/file.py",
        type: "file",
        last_modified: "2025-01-01T00:00:00Z",
        created: "2025-01-01T00:00:00Z",
      },
    ];
    const fetch = mockFetch((req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("type")).toBe("directory");
      return new Response(JSON.stringify({ content: entries }));
    });

    const client = new ContentsClient("https://proxy.test", "ptok", { fetch });
    const result = await client.listDir("content");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("file.py");
  });

  test("stat fetches metadata without content", async () => {
    const entry = {
      name: "nb.ipynb",
      path: "content/nb.ipynb",
      type: "notebook",
      size: 1234,
      last_modified: "2025-01-01T00:00:00Z",
      created: "2025-01-01T00:00:00Z",
    };
    const fetch = mockFetch((req) => {
      expect(new URL(req.url).searchParams.get("content")).toBe("0");
      return new Response(JSON.stringify(entry));
    });

    const client = new ContentsClient("https://proxy.test", "ptok", { fetch });
    const result = await client.stat("content/nb.ipynb");
    expect(result.size).toBe(1234);
  });

  test("delete sends DELETE method", async () => {
    const fetch = mockFetch((req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/api/contents/old.py");
      return new Response("", { status: 204 });
    });

    const client = new ContentsClient("https://proxy.test", "ptok", { fetch });
    await client.delete("old.py");
  });

  test("error response throws", async () => {
    const fetch = mockFetch(() => {
      return new Response("not found", { status: 404 });
    });

    const client = new ContentsClient("https://proxy.test", "ptok", { fetch });
    expect(client.readText("missing.ipynb")).rejects.toThrow("404");
  });
});
