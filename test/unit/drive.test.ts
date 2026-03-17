/**
 * Tests for drive.ts: generated Python code correctness and syncToDrive flow.
 *
 * We can't run the generated Python, but we can verify:
 * 1. `import urllib.parse` appears before first use (bug 1 fix)
 * 2. Injection-dangerous characters in names are escaped (bug 2 fix)
 * 3. syncToDrive calls propagateCredentials and handles results
 */

import { describe, test, expect } from "bun:test";

// driveUploadCode is private — we test through syncToDrive.
// But we need to verify the generated Python is valid, so we use
// syncToDrive with a mock KernelConnection that captures the code.

import { syncToDrive, type DriveSyncResult } from "../../src/colab/drive.ts";
import type { KernelConnection, ExecutionResult } from "../../src/jupyter/connection.ts";
import type { ColabClient } from "../../src/colab/client.ts";
import type { NotebookState } from "../../src/state/notebooks.ts";

// --- Helpers ---

function makeState(overrides?: Partial<NotebookState>): NotebookState {
  return {
    notebookHash: "abc",
    endpoint: "ep-1",
    accelerator: "t4",
    variant: "gpu",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Mock KernelConnection that captures executed code. */
function mockConn(output?: string): { conn: KernelConnection; executedCode: string[] } {
  const executedCode: string[] = [];
  const conn = {
    execute: async (code: string, _timeout?: number): Promise<ExecutionResult> => {
      executedCode.push(code);
      return {
        status: "ok",
        executionCount: 1,
        stdout: output ?? '{"fileId": "f123", "folderId": "d456"}',
        stderr: "",
        outputs: [],
      };
    },
    close: () => {},
  } as unknown as KernelConnection;
  return { conn, executedCode };
}

/** Mock ColabClient with controllable propagateCredentials. */
function mockClient(propagateResult?: Record<string, unknown>): ColabClient {
  return {
    propagateCredentials: async () => propagateResult ?? { success: true },
  } as unknown as ColabClient;
}

// --- Tests ---

describe("drive.ts generated Python", () => {
  test("imports urllib.parse before first use (bug 1 fix)", async () => {
    const { conn, executedCode } = mockConn();
    const client = mockClient();

    // No existing fileId → takes the "create new file" branch which uses urllib.parse
    await syncToDrive(conn, client, "tok", "ep-1", "/content/nb.ipynb", makeState());

    const code = executedCode[0]!;

    // Find the import statement and the first use of urllib.parse
    const importLine = code.indexOf("import json, urllib.request, urllib.error, urllib.parse");
    const firstUse = code.indexOf("urllib.parse.");

    expect(importLine).toBeGreaterThanOrEqual(0);
    expect(firstUse).toBeGreaterThan(0);
    // Import must come before first use
    expect(importLine).toBeLessThan(firstUse);

    // The old duplicate "import urllib.parse" should NOT appear
    const lines = code.split("\n");
    const importUrllibParseCount = lines.filter(
      (l) => l.trim() === "import urllib.parse"
    ).length;
    expect(importUrllibParseCount).toBe(0);
  });

  test("escapes double quotes in notebook path (bug 2 fix)", async () => {
    const { conn, executedCode } = mockConn();
    const client = mockClient();

    // Notebook path with a double quote (would break the Python string)
    await syncToDrive(
      conn, client, "tok", "ep-1",
      '/content/my"notebook.ipynb',
      makeState(),
    );

    const code = executedCode[0]!;

    // The raw double quote should NOT appear unescaped inside a Python string
    // The escaped form should be present
    expect(code).toContain('my\\"notebook.ipynb');
    // Should not have a bare unescaped " that breaks the string
    expect(code).not.toContain('my"notebook');
  });

  test("escapes backslashes in notebook path (bug 2 fix)", async () => {
    const { conn, executedCode } = mockConn();
    const client = mockClient();

    await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/path\\with\\backslashes.ipynb",
      makeState(),
    );

    const code = executedCode[0]!;
    // Backslashes should be double-escaped for Python
    expect(code).toContain("path\\\\with\\\\backslashes.ipynb");
  });

  test("escapes values in existingFileId and existingFolderId (bug 2 fix)", async () => {
    const { conn, executedCode } = mockConn();
    const client = mockClient();

    await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/nb.ipynb",
      makeState({
        driveFileId: 'id"with"quotes',
        driveFolderId: "folder\\with\\backslash",
      } as any),
    );

    const code = executedCode[0]!;
    expect(code).toContain('id\\"with\\"quotes');
    expect(code).toContain("folder\\\\with\\\\backslash");
  });

  test("update branch used when driveFileId exists", async () => {
    const { conn, executedCode } = mockConn();
    const client = mockClient();

    await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/nb.ipynb",
      makeState({ driveFileId: "existing-id" } as any),
    );

    const code = executedCode[0]!;
    expect(code).toContain("Update existing file");
    expect(code).toContain("existing-id");
    expect(code).not.toContain("Find or create");
  });

  test("create branch used when no driveFileId", async () => {
    const { conn, executedCode } = mockConn();
    const client = mockClient();

    await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/nb.ipynb",
      makeState(),
    );

    const code = executedCode[0]!;
    expect(code).toContain("Find or create");
    expect(code).not.toContain("Update existing file");
  });
});

describe("syncToDrive flow", () => {
  test("returns success with fileId and folderId from execution output", async () => {
    const { conn } = mockConn('{"fileId": "f123", "folderId": "d456"}');
    const client = mockClient();

    const result = await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/nb.ipynb", makeState(),
    );

    expect(result.success).toBe(true);
    expect(result.fileId).toBe("f123");
    expect(result.folderId).toBe("d456");
  });

  test("returns error when execution output has error field", async () => {
    const { conn } = mockConn('{"error": "drive folder: timeout"}');
    const client = mockClient();

    const result = await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/nb.ipynb", makeState(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("drive folder: timeout");
  });

  test("returns error when propagateCredentials fails", async () => {
    const { conn } = mockConn();
    const client = {
      propagateCredentials: async () => { throw new Error("network error"); },
    } as unknown as ColabClient;

    const result = await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/nb.ipynb", makeState(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("credential refresh failed");
  });

  test("returns error when execution throws", async () => {
    const conn = {
      execute: async () => { throw new Error("WebSocket closed"); },
      close: () => {},
    } as unknown as KernelConnection;
    const client = mockClient();

    const result = await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/nb.ipynb", makeState(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("WebSocket closed");
  });

  test("returns error when no stdout output", async () => {
    const conn = {
      execute: async (): Promise<ExecutionResult> => ({
        status: "ok",
        executionCount: 1,
        stdout: "",
        stderr: "",
        outputs: [],
      }),
      close: () => {},
    } as unknown as KernelConnection;
    const client = mockClient();

    const result = await syncToDrive(
      conn, client, "tok", "ep-1",
      "/content/nb.ipynb", makeState(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("no output from drive sync");
  });
});
