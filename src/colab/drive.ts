/**
 * Drive auto-sync: upload .ipynb to Google Drive via runtime execution.
 *
 * The Drive token lives on the runtime's ephemeral metadata server
 * (172.28.0.1:8009). We execute Python on the runtime to:
 * 1. Fetch the OAuth token from the metadata server
 * 2. Read the .ipynb from /content/
 * 3. Upload to Drive via REST API
 *
 * No tokens transit through the local CLI.
 */

import type { KernelConnection } from "../jupyter/connection.ts";
import type { ColabClient } from "./client.ts";
import type { NotebookState } from "../state/notebooks.ts";

/**
 * Escape a string for safe embedding in a Python string literal (double-quoted).
 * Handles backslashes, double quotes, and newlines.
 */
function pyEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Generate Python code to upload an .ipynb to Drive.
 *
 * On first upload (no fileId): creates file in Colab Notebooks folder.
 * On subsequent uploads: updates existing file by ID.
 *
 * Prints JSON result: {"fileId": "...", "folderId": "..."} on success,
 * {"error": "..."} on failure.
 */
function driveUploadCode(
  notebookPath: string,
  existingFileId?: string,
  existingFolderId?: string,
): string {
  // Escape all interpolated values for safe Python string embedding
  const safePath = pyEscape(notebookPath);
  const safeFileId = existingFileId ? pyEscape(existingFileId) : "";
  const safeFolderId = existingFolderId ? pyEscape(existingFolderId) : "";
  const safeFileName = pyEscape(notebookPath.split("/").pop() ?? "notebook.ipynb");

  return `
import json, urllib.request, urllib.error, urllib.parse

def _colab_cli_drive_sync():
    # 1. Get token from ephemeral metadata server
    try:
        req = urllib.request.Request(
            "http://172.28.0.1:8009/computeMetadata/v1/instance/attributes/config",
            headers={"Metadata-Flavor": "Google"}
        )
        config = json.loads(urllib.request.urlopen(req, timeout=5).read())
        token = config.get("access_token", "")
        if not token:
            print(json.dumps({"error": "no token from metadata server"}))
            return
    except Exception as e:
        print(json.dumps({"error": f"metadata server: {e}"}))
        return

    # 2. Read notebook from /content/
    try:
        with open("${safePath}", "r") as f:
            nb_content = f.read()
    except Exception as e:
        print(json.dumps({"error": f"read notebook: {e}"}))
        return

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    ${existingFileId ? `
    # 3a. Update existing file
    file_id = "${safeFileId}"
    folder_id = "${safeFolderId}"
    try:
        upload_url = f"https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media"
        req = urllib.request.Request(
            upload_url,
            data=nb_content.encode("utf-8"),
            headers={**headers, "Content-Type": "application/octet-stream"},
            method="PATCH"
        )
        resp = json.loads(urllib.request.urlopen(req, timeout=30).read())
        print(json.dumps({"fileId": resp.get("id", file_id), "folderId": folder_id}))
    except Exception as e:
        print(json.dumps({"error": f"drive update: {e}"}))
    ` : `
    # 3b. Find or create "Colab Notebooks" folder, then create file
    folder_id = "${safeFolderId}"
    if not folder_id:
        try:
            search_url = "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode({
                "q": "name='Colab Notebooks' and mimeType='application/vnd.google-apps.folder' and trashed=false",
                "fields": "files(id)",
                "pageSize": "1"
            })
            req = urllib.request.Request(search_url, headers=headers)
            resp = json.loads(urllib.request.urlopen(req, timeout=15).read())
            files = resp.get("files", [])
            if files:
                folder_id = files[0]["id"]
            else:
                # Create folder
                create_req = urllib.request.Request(
                    "https://www.googleapis.com/drive/v3/files",
                    data=json.dumps({"name": "Colab Notebooks", "mimeType": "application/vnd.google-apps.folder"}).encode(),
                    headers=headers,
                    method="POST"
                )
                create_resp = json.loads(urllib.request.urlopen(create_req, timeout=15).read())
                folder_id = create_resp["id"]
        except Exception as e:
            print(json.dumps({"error": f"drive folder: {e}"}))
            return

    # Create file
    try:
        metadata = json.dumps({
            "name": "${safeFileName}",
            "mimeType": "application/vnd.google.colaboratory",
            "parents": [folder_id]
        }).encode()
        boundary = "colab_cli_boundary"
        body = (
            f"--{boundary}\r\n"
            f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        ).encode() + metadata + (
            f"\r\n--{boundary}\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode() + nb_content.encode("utf-8") + f"\r\n--{boundary}--".encode()

        req = urllib.request.Request(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
            data=body,
            headers={**headers, "Content-Type": f"multipart/related; boundary={boundary}"},
            method="POST"
        )
        resp = json.loads(urllib.request.urlopen(req, timeout=30).read())
        print(json.dumps({"fileId": resp["id"], "folderId": folder_id}))
    except Exception as e:
        print(json.dumps({"error": f"drive create: {e}"}))
    `}

_colab_cli_drive_sync()
del _colab_cli_drive_sync
`.trim();
}

export interface DriveSyncResult {
  success: boolean;
  fileId?: string;
  folderId?: string;
  error?: string;
}

/**
 * Sync a notebook to Drive by executing Python on the runtime.
 *
 * Refreshes Drive credentials first (handles token TTL).
 * Non-fatal — returns result but callers should not fail on errors.
 */
export async function syncToDrive(
  conn: KernelConnection,
  client: ColabClient,
  token: string,
  endpoint: string,
  runtimeNotebookPath: string,
  state: NotebookState,
): Promise<DriveSyncResult> {
  // Refresh Drive credentials (handles ~47min TTL)
  try {
    await client.propagateCredentials(token, endpoint, "dfs_ephemeral", false);
  } catch {
    return { success: false, error: "credential refresh failed" };
  }

  const code = driveUploadCode(
    runtimeNotebookPath,
    state.driveFileId,
    state.driveFolderId,
  );

  try {
    const result = await conn.execute(code, 60_000);
    if (result.stdout) {
      // Find the last line that looks like JSON (defensive against warnings/deprecation notices)
      const lines = result.stdout.trim().split("\n");
      const jsonLine = lines.findLast((l) => l.startsWith("{")) ?? lines[lines.length - 1]!;
      const parsed = JSON.parse(jsonLine) as Record<string, string>;
      if (parsed.error) {
        return { success: false, error: parsed.error };
      }
      return {
        success: true,
        fileId: parsed.fileId,
        folderId: parsed.folderId,
      };
    }
    return { success: false, error: "no output from drive sync" };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
