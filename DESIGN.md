# colab: Design Document

## Overview

A TypeScript CLI that lets AI coding agents execute Python code on Google Colab GPU runtimes. Not an MCP server — a plain CLI that agents call via bash. Notebook-centric, agent-first, non-interactive.

**Runtime**: Bun
**Language**: TypeScript (no Python runtime dependency)
**Binary**: `colab`

---

## 1. Design Principles

### P1: The Notebook Is the Object

Colab's actual abstraction is a notebook with a 1:1 runtime. We match that — no separate "VM" concept exposed. `colab ensure training --gpu t4` creates a notebook named "training" backed by a T4 runtime. The notebook is the unit of lifecycle, execution, and file management.

### P2: Explicit Lifecycle, No Defaults for Expensive Things

`ensure` not `open`. No default GPU type — the agent must say `--gpu t4` or `--gpu a100` explicitly. GPU allocation costs real money and real time. Making it explicit prevents agents from accidentally burning compute units.

### P3: Three-Tier State Model

State lives in three places, each with different durability:

1. **Runtime** (ephemeral): The `.ipynb` on the runtime filesystem at `/content/`. Lost when the runtime dies. This is the live working copy during a session.
2. **Local cache** (durable): `.colab/notebooks/<name>.ipynb` and the `.py` working copy. Updated on every `pull` and `push`. Survives runtime death. This is always available for recovery.
3. **Drive** (durable, optional): If `--drive` is enabled, the `.ipynb` is uploaded to Google Drive after `push` and `run`. Survives everything — visible in Colab UI, shareable, backed by Google infrastructure.

Without Drive, the local cache is the only copy that survives runtime reclamation. With Drive, both local cache and Drive are durable — but Drive can be independently modified or deleted, so the local cache remains the ground truth for the CLI's state tracking.

### P4: Git-Like Pull/Push Workflow

`pull` downloads the remote .ipynb and converts to a local .py for editing. `push` converts the .py back to .ipynb, merging to preserve cell IDs and outputs, and uploads. This separates editing from execution and makes the flow explicit.

### P5: State Always Visible

Every command that mutates state returns the new state. No fire-and-forget. `ensure` returns the full notebook status. `push` reports what changed. `run` streams outputs and returns results.

### P6: Idempotent by Default

`ensure` is get-or-create. Running it twice with the same args is a no-op. `push` when nothing changed is a no-op (content hash comparison). Agents can safely retry.

### P7: Cost-Awareness First-Class

Quota and compute-unit info surfaced in `ensure` output and `status`. Never let an agent burn units without visibility.

### P8: Non-Interactive Always

No prompts, no confirmations, no interactive input. Every operation is a single command with a deterministic result.

### P9: Actionable Errors with Recovery Hints

Every error includes: what happened, why, and the exact command to fix it.

```json
{
  "ok": false,
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "No compute units remaining for T4 GPU",
    "hint": "colab ensure training --gpu none  # use CPU runtime instead"
  }
}
```

### P10: Token Refresh Invisible

OAuth access tokens, proxy tokens, XSRF tokens — all refreshed automatically. The agent never sees auth plumbing.

---

## 2. Core Concepts

### Notebook = Name + Runtime + Kernel + Local Working Copy

A notebook named `training` maps to:

| Concept | Concrete thing |
|---|---|
| Identity | The name `training` |
| Remote state | A Colab .ipynb with a notebookHash |
| Compute | A runtime (VM) assigned to that notebook |
| Execution | A kernel running on that runtime |
| Local working copy | `training.py` (percent format) in the project directory |
| Local metadata | `.colab/notebooks/training.json` |
| Local cache | `.colab/notebooks/training.ipynb` (last known remote) |

This 1:1 mapping matches how Colab actually works. Each Colab notebook has exactly one runtime. We don't invent a separate VM abstraction.

### Names, Not Paths

Notebooks are referenced by name: `training`, `experiment-1`, `data-prep`. Never by file path or extension. The agent says `colab run training`, not `colab run training.ipynb` or `colab run ./training.py`. The name is the stable identifier across all commands.

### The .py File Is for Editing, Not Executing

The local .py (percent format) exists so agents can read and edit notebook source using standard file tools. It is not meant to be executed locally. The .ipynb on the remote runtime is what actually runs.

---

## 3. CLI Surface

### Auth

```
colab auth login          # OAuth2 flow (opens browser), stores tokens
colab auth status         # Auth state, email, tier, token expiry, quota
colab auth logout         # Revoke tokens, delete stored credentials
```

### Notebook Lifecycle

```
colab ensure <name> --gpu <type>   # Get-or-create notebook + runtime (blocks until ready)
colab ls                           # List all notebooks/runtimes
colab status [<name>]              # Overview (no arg) or notebook details
colab kill <name>                  # Teardown runtime, preserve local .py
```

### Notebook Workflow

```
colab pull <name>                  # Download .ipynb, convert to .py
colab push <name>                  # Convert .py to .ipynb (merge), upload
colab diff <name>                  # Cell-level diff: local .py vs remote .ipynb
```

### Execution

```
colab run <name>                   # Execute all cells
colab run <name> --cell <ref>      # Execute specific cell(s)
colab run <name> --push            # Push first, then run
```

### Escape Hatches

```
colab exec <name> "<code>"         # Execute ad-hoc Python on the runtime
colab restart <name>               # Restart kernel (preserve runtime)
colab interrupt <name>             # Cancel running execution
```

### Secrets

```
colab secrets list                      # List available Colab secret key names
```

### File Transfer (via Contents API)

```
colab upload <name> <local> <remote>    # Upload file to runtime
colab download <name> <remote> <local>  # Download file from runtime
```

---

## 4. Command Details

### `colab ensure <name> --gpu <type>`

Get-or-create a notebook with a runtime. Idempotent. Blocks until the runtime is *fully ready* — not just assigned, but kernel-accessible.

**Readiness means**: assignment exists, proxy token is obtainable, session creation succeeds, kernel is discoverable via `/api/kernels`. If `ensure` returns 0, the next `exec`/`run`/`push`/`pull` can proceed without waiting.

**Logic**:
1. Check `.colab/notebooks/<name>.json` for existing notebook
2. If found AND specs match → verify runtime still alive via `listAssignments()`
   - If alive → verify kernel accessible (hit `/api/status` via refreshed proxy token) → return
   - If `/api/status` fails → runtime is stale, fall through to step 4
   - If not in `listAssignments()` → reclaimed, fall through to step 4
3. If found AND specs don't match → error with hint to kill first
4. If not found (or reclaimed) → generate notebookHash → `assign(hash, {accelerator})` → wait for session creation with retry loop (up to 180s, 3s interval, matching live-validated startup behavior) → create empty .ipynb at `content/<name>.ipynb` via Contents API → write local state → return

**First-run behavior**: `ensure` creates an empty .ipynb on the runtime at Contents API path `content/<name>.ipynb` (one empty code cell, `python3` kernelspec). This means `pull` immediately after `ensure` gives a minimal .py file. The agent can also skip `pull` and write a .py from scratch — `push` handles the "no prior pull" case (see push logic).

**Reclamation recovery**: When `ensure` finds stale state pointing to a dead runtime, it creates a fresh runtime. The `notebookHash` is regenerated (it's random, not derived from the name). The next `push` restores the notebook from the local .ipynb cache. If `driveEnabled` was set, re-ensure triggers a fresh Drive consent flow (per-runtime consent does not persist across runtimes — see A9). The cached `driveFileId` is reused so subsequent uploads update the same Drive file. Note: `.colab/` deletion orphans runtimes — there is no way to reconnect to an orphaned runtime by name since the `notebookHash` is random. A `colab adopt` command for binding a name to an existing endpoint may be added in Phase 4.

**Session creation retry**: The runtime takes time to start after `assign()`. Session creation (`POST /api/sessions`) is retried with 3s intervals for up to 180s (validated from pdwi2020 reference and our own live testing). The retry loop is the same mechanism `run`/`exec` use when the kernel isn't yet available.

**Flags**:

| Flag | Type | Required | Description |
|---|---|---|---|
| `<name>` | positional | yes | Notebook name |
| `--gpu` | enum | yes | `none`, `t4`, `l4`, `v100`, `a100` |
| `--high-mem` | bool | no | High-memory VM variant |
| `--ttl` | duration | no, default `2h` | Auto-kill after duration. `0` = no TTL |
| `--timeout` | seconds | no, default `120` | Max wait for assignment |
| `--drive` | bool | no | Enable Drive persistence (requires one-time browser consent per runtime, see A9) |

No default GPU. The agent must be explicit about what it needs.

**Exit codes**: 0 = ready, 4 = auth error, 5 = quota exceeded, 6 = timeout

### `colab pull <name>`

Download the remote .ipynb and convert to a local .py file.

**Logic**:
1. Fetch .ipynb from runtime via Contents API
2. Convert .ipynb to percent-format .py (see Section 6)
3. Write `<name>.py` to project directory
4. Cache .ipynb to `.colab/notebooks/<name>.ipynb`
5. Update state: content hash of .py (`pushedHash`), `remoteModifiedAt` from Contents API response

**Safety**: If local .py exists and has unpushed changes (dirty), error with hint: `colab push <name>` first, or `colab pull <name> --force` to overwrite. If `<name>.py` doesn't exist yet, no conflict possible — just write it.

**Flags**:

| Flag | Type | Default | Description |
|---|---|---|---|
| `--force` | bool | false | Overwrite local .py even if dirty |

### `colab push <name>`

Convert local .py to .ipynb, merge with remote, and upload.

**Logic**:
1. Read local `<name>.py`, parse into cells
2. Resolve merge base:
   - Try fetching current remote .ipynb via Contents API (implicit rebase)
   - If remote exists → use as merge base, run conflict detection (see below)
   - If remote doesn't exist → fall back to local `.colab/notebooks/<name>.ipynb` cache
   - If no cache either → no merge base (fresh notebook: all cells get fresh UUIDs, empty outputs)
3. If merge base exists: content-addressed merge — local cells + merge base → merged .ipynb (see Section 7). If no merge base: build .ipynb from local cells directly.
4. Upload .ipynb via Contents API
5. Update local state: cached .ipynb, content hash (`pushedHash`), `remoteModifiedAt` from Contents API response

**Conflict detection**: Deferred to Phase 4. The `last_modified` timestamp from the Contents API is unreliable for conflict detection (filesystem mtime semantics, clock skew, resets on reclamation). The content-addressed merge already handles the real conflict case — if remote cells changed, the merge algorithm matches by content and preserves the right outputs. Advisory timestamp comparison may be added in Phase 4 if dogfooding surfaces a need for an extra safety net.

**Push-without-pull**: Works. If the agent writes `training.py` from scratch and pushes without ever pulling, push creates the .ipynb from the .py cells with fresh UUIDs and empty outputs. This is the simplest path for agents that don't need to inspect an existing notebook.

**Flags**:

| Flag | Type | Default | Description |
|---|---|---|---|
| `--force` | bool | false | Skip conflict detection |
| `--no-drive` | bool | false | Skip Drive upload even if `driveEnabled` is enabled |

**Safety**: `push --force` skips conflict detection. The merge still preserves outputs where possible.

**Drive sync**: If `driveEnabled` is enabled in notebook state, the uploaded `.ipynb` is also synced to Drive after a successful push (see A9). Use `--no-drive` to skip.

### `colab exec <name> "<code>"`

Execute ad-hoc Python on a notebook's runtime. This is the **core execution primitive** — `run` is built on top of it.

**Logic**:
1. Resolve notebook state → get endpoint
2. Refresh proxy token via `refreshProxyToken(endpoint)`
3. Get-or-create kernel: `GET /api/sessions` → if none, `POST /api/sessions` (with retry loop) → extract `kernel.id`
4. Connect WebSocket to kernel (fresh `session_id` per connection — ephemeral, not stored)
5. Send `execute_request` with the code string
6. Collect outputs (stdout, stderr, display_data, execute_result, error)
7. Disconnect WebSocket
8. Send keep-alive as side effect
9. Return results

**Design**: Code runs on the kernel, so variables and imports persist across `exec` calls (validated: 3 separate WebSocket connections share kernel state). But the code is not saved to the notebook — it's ephemeral. This is the escape hatch for debugging, inspection, and one-off commands.

**Output persistence**: `exec` does NOT write outputs back to the remote `.ipynb`. Outputs exist only in the CLI's response. This is by design — `exec` is for ephemeral computation, not notebook mutation. (Contrast with `run`, which writes outputs back to the `.ipynb` after execution.)

**Flags**:

| Flag | Type | Default | Description |
|---|---|---|---|
| `--timeout` | seconds | 300 | Max execution time |

### `colab run <name>`

Execute cells of the notebook on its runtime. Built on top of `exec` — reads cells from the remote `.ipynb`, then sends each cell's source as an `execute_request` sequentially.

**Logic**:
1. If `--push` flag: push first
2. If no `--push` and local is dirty: warn (stderr) but proceed (runs remote version)
3. Fetch remote `.ipynb` from `content/<name>.ipynb` via Contents API → parse cells
4. Filter cells by `--cell` if specified, otherwise all code cells
5. For each code cell sequentially: `execute_request` → collect outputs
6. Stop on first error (default) — `--continue-on-error` deferred to Phase 4
7. Return collected results for all cells

**Cell addressing** (`--cell <ref>`):
- Integer: cell index (0-based)
- String matching a cell title from `# %% <title>`: label-based
- Cell ID (from .ipynb): ID-based
- Resolution order: try integer parse, then title match, then ID match. Numeric titles are rare; if ambiguity arises, use cell ID.

**Output persistence**: After each cell executes, `run` writes the updated `.ipynb` (with that cell's `outputs` and `execution_count` filled in) back to `content/<name>.ipynb` via Contents API PUT. One atomic write per cell — if the process is killed after cell 3 of 5, outputs for cells 1-3 are already persisted. The cost is N PUTs for N code cells, but N is typically small and each PUT is a small JSON payload. The CLI response also returns outputs inline for immediate agent consumption.

**Why manual orchestration**: There is no "run notebook" API in Jupyter or Colab. Execution is exclusively via WebSocket `execute_request`, cell by cell. Even the Colab UI and VS Code extension do this — the Colab VS Code extension is a thin connection layer that delegates cell-by-cell execution to VS Code's built-in Jupyter extension. The pdwi2020 reference implementation does the same.

**Flags**:

| Flag | Type | Default | Description |
|---|---|---|---|
| `--cell` | string | (all cells) | Cell reference (index, title, or ID) |
| `--push` | bool | false | Push local changes before running |
| `--timeout` | seconds | 300 | Max execution time per cell |
| `--no-drive` | bool | false | Skip Drive upload even if `driveEnabled` is enabled |

**Drive sync**: If `driveEnabled` is enabled, the updated `.ipynb` (with outputs) is synced to Drive after `run` completes — including on `ok: false` (partial outputs from failed runs are valuable for debugging). Use `--no-drive` to skip. See A9.

### `colab diff <name>`

Show cell-level diff between local .py and remote .ipynb.

**Logic**:
1. Parse local .py into cells
2. Fetch remote .ipynb
3. Run the content-addressed matching algorithm (same as merge)
4. Display: added cells, deleted cells, modified cells (with source diff)

### `colab restart <name>`

Restart the kernel without killing the runtime. Clears all Python state (variables, imports) but preserves the runtime (GPU, installed packages via pip).

### `colab interrupt <name>`

Send interrupt signal to the kernel, cancelling any running execution. Useful when an agent starts a long-running cell and needs to bail.

### `colab ls`

List all known notebooks and their runtime status.

**Logic**:
1. Read all `.colab/notebooks/<name>.json` files (local state)
2. Call `listAssignments()` to get live runtime status
3. Merge: match local state to remote assignments by endpoint
4. Display: name, gpu, runtime status (running/dead/unknown), last activity

Notebooks with local state but dead runtimes show as "stopped." Remote assignments with no local state are listed as "unmanaged" (created in Colab web UI).

### `colab status [<name>]`

**No argument**: Combined dashboard — auth state, quota, all notebooks (same as `ls` but with quota info).

**With argument**: Detailed status for one notebook — runtime state, gpu, kernel status, dirty state, last push/pull timestamps, TTL remaining. Sends keep-alive as side effect.

### `colab upload <name> <local> <remote>`

Upload a local file to the notebook's runtime via Contents API.

**Logic**:
1. Read local file, base64-encode if binary
2. `PUT /api/contents/content/<remote>` with file content (note `content/` prefix — see Section 11 path mapping)
3. Report bytes transferred

Remote paths are user-facing as relative to `/content/` (the runtime's working directory). The CLI transparently prepends `content/` when calling the Contents API. So `colab upload training data.csv data.csv` → Contents API path `content/data.csv` → kernel sees `/content/data.csv`.

### `colab download <name> <remote> <local>`

Download a file from the notebook's runtime via Contents API.

**Logic**:
1. `GET /api/contents/content/<remote>` — returns content (base64 for binary, `content/` prefix applied by CLI)
2. Decode and write to local path
3. Report bytes transferred

---

### Project Root Discovery

The CLI finds the project root (where `.colab/` lives) by walking up from CWD, looking for `.colab/`. If not found, CWD is the project root (and `.colab/` is created on first `ensure`). This matches git's directory discovery behavior.

The `.py` working copies are written relative to the project root, not CWD. So `colab pull training` always writes `<project_root>/training.py` regardless of where in the project tree you invoke it.

---

## 5. Notebook Workflow

The core loop for agents:

```
ensure → pull → edit → push → run → pull (to see outputs)
```

### Detailed Flow

```
1. colab ensure training --gpu t4
   → Runtime allocated, notebook created
   → .colab/notebooks/training.json written

2. colab pull training
   → .ipynb downloaded from runtime
   → Converted to training.py (percent format)
   → .colab/notebooks/training.ipynb cached

3. Agent edits training.py
   → Standard file editing (read, write, edit tools)
   → The .py is a normal Python file with # %% cell markers

4. colab push training
   → training.py parsed into cells
   → Fetches fresh remote .ipynb (implicit rebase)
   → Content-addressed merge preserves cell IDs + outputs
   → Merged .ipynb uploaded to runtime

5. colab run training
   → Executes all cells on the runtime
   → Outputs streamed to terminal
   → Results returned (stdout, results, errors)

6. (Optional) Inspect results via exec
   → colab exec training "print(result)"
   → Quick variable inspection without pull/push cycle
```

After `run`, the remote `.ipynb` is updated with execution outputs (see `run` details). `pull` after `run` downloads the notebook with outputs, so the agent can inspect results in the .py context.

### Shortcuts

**`run --push`**: Steps 4+5 combined. Push then run. The most common agent pattern after editing.

**First time**: `ensure` + `pull` on a new notebook pulls an empty notebook (one empty code cell). Agent adds content, pushes, runs.

**Inspection loop**: After `run`, agent uses `colab exec training "print(result)"` for quick variable inspection. Since kernel state persists across connections, variables from `run` are accessible via `exec`.

---

## 6. Percent-Format Conversion

We implement jupytext's percent format in TypeScript — not a port of jupytext, but a compatible subset built for our specific use case.

### Why Not Ship jupytext as a Dependency

- No Python in the toolchain. The tool is Bun + TypeScript only.
- jupytext is a large Python package with its own dependency tree.
- We need a narrow slice of its functionality.

### Surface Area

Three core functions:

**`ipynbToPercent(notebook) → string`** — used by `pull`
- Serialize YAML front-matter (kernelspec, notebook metadata)
- Walk cells array
- Code cells: `# %%\n` + source (with magic commenting)
- Markdown cells: `# %% [markdown]\n` + comment-prefixed lines
- Raw cells: `# %% [raw]\n` + comment-prefixed lines
- PEP 8 blank line spacing between cells

**`percentToCells(text) → Cell[]`** — used by `push`
- Parse YAML front-matter (if present)
- Split on `# %%` cell markers using StringParser (respects triple-quoted strings)
- Detect cell type from `[markdown]`, `[raw]` annotations
- Parse cell metadata from `key=value` or JSON in marker line
- Uncomment markdown/raw cell content
- Uncomment magic commands (`# %matplotlib` → `%matplotlib`)

**`merge(localCells, remoteNotebook) → notebook`** — used by `push`
- Content-addressed cell matching (see Section 7)
- Preserve cell IDs, outputs, execution counts from remote
- Take source and cell type from local
- Generate fresh IDs for new cells

### Cell Marker Grammar

```
CELL_MARKER  := INDENT? "#" WS? "%%" EXTRA? (WS OPTIONS)?
EXTRA        := "%"*                              # sub-cells (ignored)
OPTIONS      := TITLE? CELL_TYPE? METADATA*
CELL_TYPE    := "[markdown]" | "[md]" | "[raw]"   # code is default
TITLE        := text before first [type] or key=
METADATA     := KEY "=" JSON_VALUE
```

The primary regex: `/^\s*#\s*%%(%*)\s(.*)$/`
The bare marker regex: `/^\s*#\s*%%\s*$/`

Critical: `# %%timeit` (no space after `%%`) is a commented cell magic, NOT a cell marker. `# %% timeit` (with space) IS a cell marker with title "timeit". The space is the distinguishing character.

### StringParser

Tracks triple-quoted string state line-by-line to prevent false `# %%` matches inside string literals. This is non-negotiable — agents generate code containing `# %%` in strings (e.g., code that manipulates notebook format).

~80 lines of TypeScript. Tracks `"""` and `'''` open/close state, handles escaped quotes, stops processing at `#` comments when not in a string.

### Magic Command Handling

When writing .py (pull): comment IPython magics
```
%matplotlib inline    →  # %matplotlib inline
!pip install torch    →  # !pip install torch
%%timeit              →  # %%timeit
```

When reading .py (push): uncomment them back
```
# %matplotlib inline  →  %matplotlib inline
# !pip install torch  →  !pip install torch
# %%timeit            →  %%timeit
```

Patterns recognized: lines starting with `%`, `%%`, `!`, `?`, common POSIX commands (`cd`, `ls`, `cat`, etc.), magic assignments (`x = %time expr`).

### Markdown Comment/Uncomment

Writing (pull):
- Non-empty line → `# <line>`
- Empty line → `#` (bare hash, no trailing space)

Reading (push):
- `# <text>` (hash + space + text) → `<text>`
- `#<text>` (hash + text, no space) → `<text>`
- `#` (bare hash) → empty string
- No hash prefix → leave as-is (silent passthrough)

### YAML Front-Matter

Optional header at top of .py file:
```python
# ---
# jupyter:
#   kernelspec:
#     display_name: Python 3
#     language: python
#     name: python3
# ---
```

On pull: serialize notebook metadata as YAML front-matter.
On push: parse and merge with remote notebook metadata. If absent, use remote's metadata as-is.

### Estimated Size

~760 lines of TypeScript, ~80-100 tests.

| Component | ~Lines |
|---|---|
| Cell marker parsing + StringParser | ~130 |
| Cell type + metadata parsing | ~120 |
| Comment/uncomment (markdown) | ~30 |
| Magic command handling | ~120 |
| YAML front-matter parse/serialize | ~120 |
| .ipynb JSON parse/serialize | ~100 |
| Content-addressed merge | ~140 |

---

## 7. Content-Addressed Merge

When pushing, the local .py is merged with the remote .ipynb to produce an updated .ipynb. The merge preserves cell IDs, outputs, execution counts, and cell metadata from the remote while taking source content and cell types from the local .py.

### Why Not Positional-Only

Positional matching (cell N in .py → cell N in .ipynb) breaks on insertion and deletion. If an agent deletes cell 3, positional matching maps every subsequent cell to the wrong counterpart — outputs get shuffled. Content-addressed matching finds where each cell actually went.

### The Matching Algorithm

Four passes, inspired by jupytext's `combine_inputs_with_outputs`:

**Pass 1: Exact match, in order.** For each local cell, find the first unmatched remote cell of the same type with the same normalized content. Sequential — preserves order.

**Pass 2: Exact match, out of order.** For remaining unmatched cells, match by type + normalized content regardless of position. Handles reordering.

**Pass 3: Suffix match.** For remaining unmatched cells, check if a remote cell's source ends with the local cell's source. Handles cells that were split.

**Pass 4: Positional fallback.** Match remaining unmatched cells by sequential position and cell type.

### Content Normalization (`sameContent`)

Collapse whitespace (runs of whitespace → single space, strip leading/trailing) before comparing. This is intentionally conservative — it survives indentation changes and trailing whitespace, which covers the most common autoformatter effects.

The more aggressive normalization (stripping quotes, parentheses, commas) that jupytext uses is dangerous: `f("a", "b")` would collide with `f"ab"`, causing wrong outputs on genuinely different cells. We start conservative and can loosen if autoformatter compat requires it.

**Duplicate cell handling**: When multiple cells have identical normalized content and type, Passes 1-2 match them in order (first unmatched local → first unmatched remote). This is stable and predictable. If it produces wrong matches, the agent can disambiguate by adding a distinguishing comment.

### What Comes From Where

| Field | Source |
|---|---|
| `cell.source` | Local .py |
| `cell.cell_type` | Local .py |
| `cell.id` | Remote .ipynb (or fresh UUID for new cells) |
| `cell.outputs` | Remote .ipynb (empty for new cells) |
| `cell.execution_count` | Remote .ipynb (null for new cells) |
| `cell.metadata` | Merged: filtered metadata from .py + unfiltered from .ipynb |
| `notebook.metadata` | Remote .ipynb (or from .py YAML header if present) |

### Edge Cases

- **Cell added in .py**: No matching remote cell → fresh UUID, empty outputs
- **Cell deleted from .py**: Remote cell orphaned → dropped from result
- **Cell reordered**: Pass 2 handles via out-of-order content match
- **Cell type changed** (code → markdown): Won't match (different type) → treated as delete + add
- **All cells modified**: Falls through to Pass 4 (positional), outputs preserved by position

---

## 8. Dirty State

Tracks whether the local .py has unpushed changes using a content hash.

### Mechanism

On push, store SHA-256 of the .py file contents in `.colab/notebooks/<name>.json` as `pushedHash`. On subsequent operations, compare current hash to stored hash.

### Where It Gates

| Command | If dirty | Behavior |
|---|---|---|
| `run` | warn on stderr | Proceeds (runs remote version). Agent sees: "local training.py has unpushed changes — running remote version. Use `colab run training --push` to push first." |
| `pull` | error | Refuses to overwrite. Hint: `colab push training` first, or `colab pull training --force` |
| `push` | expected | This is the normal flow — you edit, then push |

### What It Doesn't Do

No push history, no commit-like versioning. The .py file's edit history is in git. The notebook's execution history is in cell outputs. The hash answers exactly one question: "has the .py changed since last push?"

If this turns out to be insufficient during dogfooding, the most likely evolution is storing push timestamps alongside hashes — but we start minimal.

---

## 9. Auth Stack

### OAuth2 Flow

Uses the Colab VS Code extension's public OAuth client credentials (called "ClientNotSoSecret" in the extension source). Login flow:

1. CLI starts localhost HTTP server on random port
2. Opens Google consent screen
3. User consents in browser
4. Google redirects to `http://localhost:{port}/?code=...`
5. CLI exchanges code for access token + refresh token
6. Tokens stored to `~/.config/colab-cli/credentials.json` (mode 0600)

**Client ID**: `1014160490159-cvot3bea7tgkp72a4m29h20d9ddo6bne.apps.googleusercontent.com`
**Client Secret**: `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`
**Source**: `google.colab@0.3.0` VS Code extension (Apache-2.0)

**Why this client ID matters**: The Colab GAPI domain (`colab.pa.googleapis.com`) gates access by the OAuth client ID that issued the token. Tokens from gcloud's client ID (`764086051850-...`) get `SERVICE_DISABLED` because the API isn't enabled on gcloud's GCP project. Tokens from the VS Code extension's client ID route to Google's Colab project (`1014160490159`) where the API is enabled. Live-validated 2026-03-11.

**Scopes** (live-validated):
- `https://www.googleapis.com/auth/colaboratory`
- `profile`
- `email`

Google expands these to also include `openid`, `userinfo.email`, `userinfo.profile`. Set `OAUTHLIB_RELAX_TOKEN_SCOPE=1` (or equivalent) to accept expanded scopes without error.

**Token exchange params**: `access_type=offline&prompt=consent` to ensure refresh token is always returned.

### Three-Layer Token Stack

```
Layer 1: OAuth2 access token
  Used for: Colab REST API (assign, unassign, listAssignments, getUserInfo)
  Lifetime: ~1 hour, auto-refreshed via refresh_token
  Header: Authorization: Bearer <access_token>

Layer 2: Proxy token (per runtime)
  Used for: WebSocket + Jupyter API on runtime
  Obtained via: refreshConnection(endpoint) using Layer 1
  Lifetime: ~1 hour
  Header: X-Colab-Runtime-Proxy-Token: <proxy_token>

Layer 3: XSRF token (per mutation)
  Used for: assign(), unassign(), propagateCredentials()
  Obtained via: GET request to same endpoint
  Lifetime: single-use
  Header: X-Goog-Colab-Token: <xsrf_token>
  Pattern: GET (returns token) → POST (sends token)
```

All token refresh is invisible to the agent. The CLI handles it before each operation.

### Token Storage

**Global** (`~/.config/colab-cli/credentials.json`):
```json
{
  "access_token": "ya29...",
  "refresh_token": "1//...",
  "token_uri": "https://oauth2.googleapis.com/token",
  "client_id": "1014160490159-cvot3bea7tgkp72a4m29h20d9ddo6bne.apps.googleusercontent.com",
  "client_secret": "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",
  "expires_at": "2026-03-10T13:00:00Z",
  "email": "user@gmail.com"
}
```
Client ID and secret are stored alongside the tokens so the file is self-contained for refresh. These are public credentials (not user secrets).

---

## 10. WebSocket Kernel Execution

### Connection Flow

```
1. Resolve notebook → get endpoint from .colab/notebooks/<name>.json
2. Ensure fresh proxy token (refreshConnection if near expiry)
3. Get or create kernel (GET /api/sessions, or POST /api/sessions)
4. Connect WebSocket:
   wss://<proxy_url>/api/kernels/<kernel_id>/channels?session_id=<id>
   Headers: proxy token + client agent
   No subprotocol header (DEFAULT protocol)
5. Send execute_request, collect outputs
6. Execution complete when both execute_reply AND status:idle received
```

### Jupyter Message Protocol

Messages are JSON text over WebSocket. No binary framing for code execution.

**Outgoing (execute_request)**:
```json
{
  "channel": "shell",
  "header": {
    "msg_id": "<uuid>",
    "msg_type": "execute_request",
    "username": "colab-cli",
    "session": "<session_uuid>",
    "version": "5.3"
  },
  "content": {
    "code": "print('hello')",
    "silent": false,
    "store_history": true,
    "allow_stdin": true,
    "stop_on_error": true
  }
}
```

**Incoming message types**:

| Channel | msg_type | Description | Action |
|---|---|---|---|
| iopub | `status` | Kernel busy/idle | Track state, `idle` = half of completion |
| iopub | `stream` | stdout/stderr text | Collect + stream to agent |
| iopub | `execute_result` | Cell return value | Collect |
| iopub | `display_data` | Rich display output | Collect |
| iopub | `error` | Python exception | Collect (ename, evalue, traceback) |
| shell | `execute_reply` | Execution finished | Other half of completion |

**Completion**: The Jupyter spec states both `execute_reply` (shell) AND `status: idle` (iopub) should arrive. In practice on Colab, `execute_reply` arrives last and `stream` messages always precede it. However, to be safe against late-arriving iopub messages, the implementation should track both signals and resolve only when `gotReply && gotIdle`. The `gotReply`/`gotIdle` fields exist in the pending map for this purpose — they must be used. Empirically validated in A8: three separate WebSocket connections confirmed `execute_reply` arrives last on Colab.

**Colab-specific — `colab_request` (must be handled when present)**:

The kernel MAY send `colab_request` messages on the WebSocket to request credential propagation (for Drive mount, authenticated API calls, etc.). When sent, these are **not safely ignorable** — without handling them, the kernel blocks and execution returns empty stdout.

**When it triggers**: NOT for all execution — simple compute-only code (print, arithmetic, torch, etc.) executes without any `colab_request`. Triggered when the kernel needs specific auth credentials (Drive mount, authenticated GCP API calls). Live-validated 2026-03-11: basic execution with 3 separate WebSocket connections produced zero `colab_request` messages.

**Flow**:
1. Kernel sends `msg_type: "colab_request"` with `metadata.colab_request_type: "request_auth"` and `metadata.colab_msg_id`
2. `content.request.authType` is one of: `"dfs_ephemeral"` (Drive), `"auth_user_ephemeral"` (user auth)
3. Client calls credentials-propagation API (see Section 11): dry-run first, then real if dry-run succeeds
4. Client sends `input_reply` on stdin channel with `content.value: {"type": "colab_reply", "colab_msg_id": <id>}` (include `"error"` field if propagation failed)
5. Kernel unblocks and continues execution

**Credentials Propagation API** (tunnel domain, XSRF pattern):
```
GET  /tun/m/credentials-propagation/{endpoint}?authuser=0&authtype={type}&version=2&dryrun={bool}&propagate=true&record=false
POST /tun/m/credentials-propagation/{endpoint}  (with XSRF from GET)
```

If dry-run returns `unauthorized_redirect_uri` (snake_case — not camelCase), the auth type requires interactive browser consent. For Drive mounts, the CLI can facilitate this by printing the consent URL for the user to open (see A9).

**`allow_stdin` interaction**: `colab_request` arrives on the stdin channel. `allow_stdin: true` must be set in `execute_request` so the kernel sends `colab_request` messages when needed (credential propagation, `GetSecret`). This also means `input_request` messages (Python's `input()`) may arrive — reply with an error so the kernel doesn't block (agents don't do interactive input). Validated empirically: `colab_request` with `GetSecret` confirmed working (A10), Drive credential propagation confirmed working (A9).

### Connection Lifecycle

Each CLI invocation opens a new WebSocket. Kernel state (variables, imports) persists across connections — validated with 3 separate connections using different session IDs, all sharing the same kernel namespace. The kernel is the durable object; WebSocket connections are ephemeral handles. This means `colab exec` can connect → execute → disconnect without losing state, and `colab run` can use a fresh connection each time.

Note: the session ID passed as a WebSocket query param (`?session_id=`) does NOT need to match a Jupyter session from `/api/sessions`. A connection with any session ID can talk to the kernel. ~500ms overhead per connection is acceptable for agent workflows.

### Keep-Alive

Every command that touches a notebook's runtime sends `sendKeepAlive(endpoint)` as a side effect. No background daemon. If a runtime goes idle for ~30 minutes, Colab may reclaim it — next access gets a clear error with hint to `ensure` again.

---

## 11. Colab API Surface

Two backend domains, both accessible with the VS Code extension's OAuth client ID (see Section 9). Live-validated 2026-03-11.

**`colab.research.google.com`** — tunnel/data plane
- `/tun/m/assign` — allocate/query runtime (XSRF pattern)
- `/tun/m/unassign/{endpoint}` — release runtime (XSRF pattern)
- `/tun/m/{endpoint}/keep-alive/` — prevent idle timeout
- `/tun/m/{endpoint}/api/...` — proxied Jupyter API on runtime
- `/tun/m/credentials-propagation/{endpoint}` — auth propagation (XSRF pattern)
- Requires `?authuser=0` on all requests
- XSRF token pattern for mutations (GET to get token, POST with token)

**`colab.pa.googleapis.com`** — GAPI/control plane
- `/v1/user-info` — user profile, subscription tier, eligible accelerators, compute units
- `/v1/assignments` — list all active runtime assignments
- `/v1/runtime-proxy-token?endpoint=...` — refresh proxy token
- Bearer token auth, no `authuser` param
- **Access gated on OAuth client ID**: only works with tokens from the VS Code extension's client ID (`1014160490159-...`). Tokens from gcloud's client ID get `SERVICE_DISABLED`. The gate is which GCP project owns the client ID — the API is enabled on Google's Colab project, not on gcloud's.

### Core API Methods

| Method | Domain | Description | Used by |
|---|---|---|---|
| `getUserInfo()` | GAPI | Tier, compute units, eligible accelerators | auth status, ensure |
| `listAssignments()` | GAPI | All active runtime assignments | ls, ensure, status |
| `refreshProxyToken(endpoint)` | GAPI | Fresh proxy token + URL | long-lived sessions |
| `assign(nbHash, params)` | Tunnel | Allocate runtime (XSRF) | ensure |
| `unassign(endpoint)` | Tunnel | Release runtime (XSRF) | kill |
| `propagateCredentials(endpoint, authType)` | Tunnel | Credential propagation (XSRF) | ensure --drive, push, run |
| `listSecrets()` | Tunnel | List user's Colab secrets (`/userdata/list`) | secrets list, exec, run |
| `listSessions(endpoint)` | Tunnel | Jupyter sessions on runtime | run, exec |
| `sendKeepAlive(endpoint)` | Tunnel | Prevent idle timeout (~60s interval) | all runtime commands |

### Assign Response Shape

```json
{
  "endpoint": "gpu-t4-s-bcdhjyw4onbe",
  "fit": 3600,
  "sub": 2,
  "subTier": 1,
  "variant": 1,
  "machineShape": 0,
  "accelerator": "T4",
  "runtimeProxyInfo": {
    "token": "eyJ...",
    "tokenExpiresInSeconds": 3600,
    "url": "https://8080-gpu-t4-s-bcdhjyw4onbe-a.us-west4-2.prod.colab.dev"
  }
}
```

### getUserInfo Response Shape

```json
{
  "subscriptionTier": "SUBSCRIPTION_TIER_PRO",
  "paidComputeUnitsBalance": 300,
  "eligibleAccelerators": [
    { "variant": "VARIANT_GPU", "models": ["H100", "G4", "A100", "L4", "T4"] },
    { "variant": "VARIANT_TPU", "models": ["V6E1", "V5E1"] }
  ]
}
```

### Notebook Hash Format

UUID v4 with dashes replaced by underscores, padded with dots to 44 chars:
```
380b033e_4abf_4918_9f96_3d147452ff9a........
```
Generation: `uuid.replace(/-/g, '_') + '.'.repeat(44 - uuid.length)`

### Request Patterns

All tunnel domain responses have `)]}'` XSSI prefix (5 chars) — strip before JSON parse. GAPI responses do NOT have the prefix.

Custom headers:
```
Authorization: Bearer <access_token>      # all requests
X-Colab-Client-Agent: vscode              # all requests (must be "vscode")
X-Colab-Tunnel: Google                    # keep-alive requests
X-Colab-Runtime-Proxy-Token: <token>      # runtime/Jupyter requests
X-Goog-Colab-Token: <xsrf>               # mutations (assign, unassign, propagate)
```

Note: `X-Colab-Client-Agent` must be `"vscode"` — the API may gate behavior on this value.

### Contents API (File Transfer)

The Jupyter Contents API works through the runtime proxy URL:
- `GET/PUT/POST/DELETE /api/contents/{path}`
- Full CRUD for files and notebooks on the runtime
- Binary files are base64-encoded in JSON body
- Same proxy token auth as other runtime requests
- Size limit: ~384 MiB effective (512 MiB body - base64 overhead)

**Path mapping (live-validated):** The Contents API root maps to the filesystem root `/`, NOT to `/content/`. The kernel's working directory is `/content`. To write a file visible to the kernel at `/content/notebook.ipynb`, use Contents API path `content/notebook.ipynb`. Both directions:

```
Contents API path         →  Filesystem path
""                        →  / (root — lists bin, usr, sys, content, ...)
"content"                 →  /content (kernel's working dir)
"content/notebook.ipynb"  →  /content/notebook.ipynb
"content/sample_data"     →  /content/sample_data (Colab's default sample data)
```

Used for: `pull` (download .ipynb), `push` (upload .ipynb), `upload`/`download` (file transfer).

### Runtime State APIs

Available on the runtime proxy URL with proxy token auth (live-validated):

| Endpoint | Method | Returns |
|---|---|---|
| `/api/kernels` | GET | List of kernels: id, name, execution_state, connections, last_activity |
| `/api/sessions` | GET | Session list with embedded kernel state |
| `/api/status` | GET | Runtime summary: connections, kernels count, last_activity, started |
| `/api` | GET | Jupyter server version (e.g. `2.14.0`) |
| `/api/kernelspecs` | GET | Available kernel specs (python3, julia, ir on standard runtime) |

Used for: `status` (runtime health), `ls` (kernel state), reconnection logic.

---

## 12. Output Formatting

### Per-Command Defaults

| Command type | Default format | Rationale |
|---|---|---|
| Data commands (`ls`, `status`, `auth status`) | JSON | Agents parse these for information |
| Activity commands (`run`, `ensure`, `push`, `pull`) | Human-readable, streaming | Agents observe these; streaming matters for long operations |

`--json` flag on any command forces JSON output. Activity commands in JSON mode buffer all output and return a single JSON object at the end.

### JSON Envelope

Every command uses the same envelope:

```typescript
interface CommandResult<T = unknown> {
  ok: boolean;          // did the command achieve its primary purpose?
  command: string;      // "run", "ensure", "auth.login", etc.
  ts: string;           // ISO 8601
  data?: T;             // command-specific payload — present whenever there's useful data
  error?: {             // present when ok is false
    code: string;       // machine-readable: QUOTA_EXCEEDED, EXECUTION_ERROR, etc.
    message: string;    // human-readable
    hint?: string;      // recovery command or suggestion
  };
}
```

**`ok` semantics**: Reflects whether the command achieved its purpose. For `run`, the purpose is "execute code successfully." A Python exception means `ok: false`. A CLI-level failure (network, auth) also means `ok: false` — distinguished by `error.code` and exit code.

**`data` and `error` can coexist.** When `run` hits a Python error, `data` contains the execution outputs (including the traceback) and `error` contains the structured error. This lets agents inspect both the error and any partial outputs (e.g., stdout before the exception). `data` is not gated on `ok: true` — it's present whenever there's useful information to return.

### Exit Codes

| Code | Name | Description |
|---|---|---|
| 0 | OK | Success |
| 1 | ERROR | General/unexpected error |
| 2 | USAGE | Invalid arguments |
| 3 | NOT_FOUND | Notebook doesn't exist, runtime reclaimed |
| 4 | AUTH | Not authenticated, token expired |
| 5 | QUOTA | No compute units for requested resource |
| 6 | TIMEOUT | Assignment or execution timed out |
| 7 | EXEC_ERROR | Python code raised an exception |

Exit code 7 is intentional: agents use exit codes to distinguish "the CLI broke" (1) from "my Python code has a bug" (7).

---

## 13. State Management

### Local State File Layout

**Global** (`~/.config/colab-cli/`):
```
credentials.json     # OAuth2 tokens (mode 0600)
config.json          # User preferences (optional)
```

**Per-project** (`.colab/` in project root):
```
notebooks/
  <name>.json        # Runtime state: endpoint, tokens, kernel, pushedHash
  <name>.ipynb       # Cached remote .ipynb
```

`.colab/` should be gitignored (contains tokens, cached binary data). The `.py` files in the project root should be committed.

### Per-Notebook State (`.colab/notebooks/<name>.json`)

```json
{
  "notebookHash": "380b033e_4abf_4918_9f96_3d147452ff9a........",
  "endpoint": "gpu-t4-s-bcdhjyw4onbe",
  "gpu": "t4",
  "createdAt": "2026-03-10T12:00:00Z",
  "lastKeepAlive": "2026-03-10T12:30:00Z",
  "pushedHash": "sha256:abc123...",
  "driveEnabled": true,
  "driveFolderId": "1nHDhKPFLNAZjVcgw43vSPdmPZu6B8ek1",
  "driveFileId": "1iFe9O8icEenmD49FzyN5R4b1MoRcKRY6"
}
```

**What's NOT persisted (and why):**
- `proxyUrl`, `proxyToken`, `proxyTokenExpiresAt` — proxy tokens expire after ~1h, refreshed lazily via `refreshProxyToken(endpoint)` from the GAPI. Persisting short-lived tokens creates stale-state and secret-sprawl problems. Instead, every command that needs a proxy token calls `refreshProxyToken()` on demand.
- `sessionId` — WebSocket `session_id` is an ephemeral per-connection transport detail. Live testing confirmed it doesn't need to match a Jupyter session from `/api/sessions`, and multiple connections with different session IDs all share the same kernel state. Generated fresh at connect time.
- `kernelId` — discovered dynamically via `GET /api/sessions` or `POST /api/sessions` (with retry). Kernels can restart, reclaim, or change IDs between commands.
- `remoteModifiedAt` — deferred. Conflict detection via `last_modified` timestamps is fragile (clock skew, mtime semantics). The content-addressed merge already handles the real conflict case. May add advisory timestamp comparison in Phase 4 if dogfooding surfaces a need.
- `ttlExpiresAt` — deferred pending Q9 resolution.

**What IS persisted:**
- `notebookHash` — opaque identifier passed to `assign()`. Regenerated on each `ensure` (including reclamation recovery). Persisted so `listAssignments()` can match the current assignment.
- `endpoint` — needed to find the runtime via `listAssignments()` and `refreshProxyToken()`.
- `gpu` — needed to verify specs match on `ensure` re-entry.
- `createdAt`, `lastKeepAlive` — operational metadata.
- `pushedHash` — SHA-256 of the last-pushed .py, for dirty state tracking.
- `driveEnabled` — whether `--drive` was requested. Survives reclamation so re-ensure knows to re-trigger Drive consent. Only present when `--drive` is used.
- `driveFolderId` — the `Colab Notebooks` folder ID in Drive. Discovered on first upload, cached to avoid re-lookup.
- `driveFileId` — the Drive file ID of the uploaded `.ipynb`. Survives reclamation so subsequent uploads update the same file. Only present after first successful upload.

### Concurrency

Multiple CLI invocations may run simultaneously (multi-agent). For Phase 3, use atomic writes (write to `.tmp`, rename to final) to prevent partial reads. Advisory file locking (`flock`) deferred to Phase 4 — the real concurrency contention is at the Colab API level (two agents pushing to the same runtime), not local state files.

---

## 14. Testing Strategy

### Differential Oracle Testing (Primary)

Use `uvx jupytext` as a live test oracle. Run both our TypeScript converter and jupytext on identical inputs, diff outputs. Zero-install oracle — works anywhere `uv` is available.

```
Our .ipynb → .py    vs    uvx jupytext --to py:percent
Our .py → .ipynb    vs    uvx jupytext --to notebook
```

Every fixture file feeds the oracle test automatically. Adding one .ipynb file tests both conversion directions.

### Test Fixture Sources

**Tier 1 — Gold standard** (from jupytext repo):
- `tests/data/notebooks/inputs/ipynb_py/*.ipynb` — ~24 source notebooks
- `tests/data/notebooks/outputs/ipynb_to_percent/*.py` — expected percent output
- `tests/functional/simple_notebooks/test_read_simple_percent.py` — ~25 inline test cases

**Tier 2 — Schema validation** (from nbformat repo):
- `tests/test4.ipynb`, `tests/test4.5.ipynb` — reference .ipynb v4/v4.5

### Property-Based Testing (fast-check)

Round-trip invariants on generated notebooks:
- `parse(serialize(notebook)).cells.length === notebook.cells.length`
- Cell types preserved through round-trip
- Source content preserved (modulo trailing whitespace)
- `serialize(parse(text))` is idempotent after first pass
- Merge preserves cell IDs on unmodified cells
- Merge preserves outputs on unmodified cells

### Snapshot Testing (Bun built-in)

Golden-file validation with `toMatchSnapshot()`. Frozen expected output for each fixture. Update explicitly with `bun test --update-snapshots`.

### jupytext --test Validation

Use jupytext's own round-trip validator on our output:
```
Our TS produces .py → uvx jupytext --test our-output.py --to notebook
```
Catches "valid percent format but not compatible with jupytext" bugs.

### Corpus-Based Regression (Nightly)

Real-world notebooks from GitHub (permissive licenses). Glob-based test discovery — adding a .ipynb to the corpus directory automatically runs it through all test layers.

### Compounding

Every fixture feeds all layers simultaneously:

```
  New .ipynb fixture added
         │
    ┌────┼────┬──────────┐
    ▼    ▼    ▼          ▼
 Snapshot  Differential  Property   jupytext --test
 testing   oracle        round-trip  validation
```

One fixture addition = four layers of testing. Fast-check failures become new fixtures, which then feed all other layers.

### Implementation Order

1. Golden files + differential oracle (TDD from day 1)
2. Snapshot tests (free on top of golden files)
3. Unit tests for StringParser, magic handling, metadata parsing
4. Property-based round-trips (after basic parsing works)
5. `jupytext --test` validation
6. Corpus regression (after core stabilizes)

---

## 15. Project Structure

```
colab-cli/
├── src/
│   ├── cli/                     # Command parsing and dispatch
│   │   ├── index.ts             # Entry point, command router
│   │   ├── auth.ts              # auth login/status/logout
│   │   ├── ensure.ts            # ensure command
│   │   ├── run.ts               # run command
│   │   ├── exec.ts              # exec command
│   │   ├── pull.ts              # pull command
│   │   ├── push.ts              # push command
│   │   ├── diff.ts              # diff command
│   │   ├── ls.ts                # ls command
│   │   ├── status.ts            # status command
│   │   ├── kill.ts              # kill command
│   │   ├── secrets.ts           # secrets list command
│   │   ├── restart.ts           # restart command
│   │   ├── interrupt.ts         # interrupt command
│   │   └── output.ts            # JSON/human-readable formatting
│   ├── notebook/                # Percent-format conversion
│   │   ├── parse.ts             # .py percent → cell list
│   │   ├── serialize.ts         # notebook → .py percent
│   │   ├── merge.ts             # Content-addressed merge
│   │   ├── string-parser.ts     # Triple-quote tracking
│   │   ├── magic.ts             # Magic command comment/uncomment
│   │   ├── header.ts            # YAML front-matter
│   │   ├── types.ts             # Notebook/cell type definitions
│   │   └── ipynb.ts             # .ipynb JSON parse/serialize
│   ├── colab/                   # Colab API client
│   │   ├── client.ts            # HTTP client for Colab APIs
│   │   ├── headers.ts           # Custom header construction
│   │   ├── types.ts             # Zod schemas for API responses
│   │   └── xssi.ts              # XSSI prefix stripping
│   ├── jupyter/                 # Jupyter kernel communication
│   │   ├── connection.ts        # KernelConnection (WebSocket)
│   │   ├── messages.ts          # Jupyter message types
│   │   ├── contents.ts          # Contents API client
│   │   └── api.ts               # Jupyter REST API (sessions, kernels)
│   ├── auth/                    # OAuth2 implementation
│   │   ├── oauth.ts             # OAuth2 flow (PKCE, loopback)
│   │   ├── tokens.ts            # Token storage and refresh
│   │   └── scopes.ts            # Required scopes
│   ├── state/                   # Local state management
│   │   ├── store.ts             # State file read/write with locking
│   │   ├── notebooks.ts         # Per-notebook state
│   │   └── config.ts            # User/project config
│   └── util/
│       ├── errors.ts            # Error types with codes and hints
│       ├── hash.ts              # Content hashing (SHA-256)
│       ├── ids.ts               # ID generation (notebookHash, names)
│       └── time.ts              # Duration parsing, TTL
├── test/
│   ├── fixtures/
│   │   ├── golden/              # Known-good .ipynb/.py pairs
│   │   └── corpus/              # Real-world notebooks (gitignored)
│   ├── unit/                    # Unit tests per module
│   ├── snapshot/                # Snapshot/golden-file tests
│   ├── differential/            # Oracle tests (vs uvx jupytext)
│   ├── property/                # fast-check property tests
│   └── corpus/                  # Corpus regression tests
├── DESIGN.md
├── SKILL.md
├── package.json
├── tsconfig.json
└── bunfig.toml
```

---

## 16. Open Questions

### Q1: OAuth Scopes — RESOLVED

Scopes: `colaboratory`, `profile`, `email`. We use the VS Code extension's public OAuth client credentials (not our own app). See Section 9 and Addendum A7.

### Q2: Colab API Stability

Undocumented API — could change. Mitigation: Zod schemas for response validation. Track changes via colab-vscode extension updates.

### Q3: Rate Limits

Unknown. Mitigation: retry with exponential backoff for 429 responses.

### Q4: notebookHash Generation — RESOLVED

UUID v4 with dashes replaced by underscores, padded with dots to 44 chars. Example: `380b033e_4abf_4918_9f96_3d147452ff9a........`. Confirmed from pdwi2020/mcp-server-colab-exec and live-validated. See Section 11.

### Q5: Cell Addressing UX — RESOLVED

Resolution order: integer → title → ID. Cell IDs are UUIDs so they never collide with integers. The only ambiguity is integer vs. title-that-looks-like-an-integer, which is rare in practice (who names a cell "3"?). If dogfooding surfaces a real problem, add prefix syntax then. Closed as accepted.

### Q6: Multi-Cell Execution Semantics — RESOLVED

Sequential execution, stop on first error. Matches Colab's "Run All" behavior and the `stop_on_error: true` already set in `execute_request`. `--continue-on-error` flag deferred to Phase 4. The sequential cell loop in `run` checks the previous cell's result before sending the next.

### Q7: Streaming Format

Activity commands stream human-readable output by default. What exactly does streaming look like for `colab run` with multiple cells? Need to design the cell-by-cell progress output.

### Q8: Drive Persistence Mechanism — RESOLVED

Contents API writes are runtime-local only — they do NOT sync to Drive. The runtime filesystem at `/content/` is ephemeral and lost when the runtime dies. Drive persistence requires separate Drive REST API calls using credentials obtained through Colab's credential propagation mechanism. See addendum A9 for the full empirical findings and designed solution.

### Q9: TTL Enforcement

`--ttl` is accepted by `ensure` but no enforcement mechanism exists. No daemon, no confirmed server-side support in `assign()`. Options: best-effort on next CLI invocation, background timer via Bun subprocess, or discover that `assign()` accepts a TTL parameter. Resolve during Phase 2.

---

## 17. Implementation Roadmap

### Phase 1: Percent-Format Conversion + Test Infra

Can be built and fully tested without touching the Colab API. Pure TypeScript, pure local.

- [x] Project scaffolding (bun init, tsconfig, directory structure)
- [x] Fetch jupytext test fixtures (sparse clone golden pairs)
- [x] Set up differential oracle infra (`uvx jupytext` test helpers)
- [x] `src/notebook/types.ts` — Notebook/Cell type definitions, .ipynb JSON types
- [x] `src/notebook/ipynb.ts` — .ipynb parse/serialize (handle source as string vs array, cell IDs, nbformat 4/4.5)
- [x] `src/notebook/string-parser.ts` — Triple-quote state tracker
- [x] `src/notebook/magic.ts` — Magic command comment/uncomment
- [x] `src/notebook/header.ts` — YAML front-matter parse/serialize
- [x] `src/notebook/serialize.ts` — `ipynbToPercent()`: notebook → .py
- [x] Differential oracle tests: 20/20 golden pairs passing (4 skipped: R magic ×2, html/latex language=, triple-quote markdown — all irrelevant to Colab)
- [x] `src/notebook/parse.ts` — `percentToCells()`: .py → cell list
- [x] Round-trip differential tests: 20/20 golden .py → cells matches golden .ipynb
- [x] `src/notebook/merge.ts` — Content-addressed merge (4-pass)
- [x] Full pipeline round-trip tests: 20/20 (.ipynb → .py → cells → merge → verify)
- [x] Property-based round-trip tests (fast-check): 16 properties, 500 runs each
- [x] `jupytext --to notebook --test` validation: 20/20 pass
- [x] Code review fixes (round 1): #1 serializeMetaValue, #2 Plotly outputs, #3 POSIX uncommenting, #4 FILTERED_METADATA_KEYS dedup, #5 StringParser escaped triple quotes, #6 raw cell without kernelspec, #7 parseMetaValue crash, #8 `//` in MAGIC_RE, #9 freshCellId entropy
- [x] Dead code cleanup (header.ts: indentedComment, serializeYamlValue, HEADER_ALLOWED_EXTRA_KEYS)
- [x] Code review fixes (round 2): #10 same-line triple-quote escape, #11 merge pass 4 gap-bounded, #12 bare POSIX without args, #13 YAML single-quote unescaping
- [ ] Snapshot tests for all golden pairs

### Phase 2: Colab API Proof-of-Life

Prove the undocumented API works end-to-end. Manually tested, script-driven.

**Auth:**
- [x] OAuth scopes identified: `colaboratory`, `profile`, `email` (resolves Q1)
- [x] Client ID identified: VS Code extension's public credentials (resolves auth approach)
- [x] Live-validated: token from VS Code client ID unlocks BOTH tunnel and GAPI domains
- [x] `src/auth/oauth.ts` — OAuth2 loopback flow: buildAuthUrl, exchangeCode, refreshAccessToken, login (10 tests)
- [x] `src/auth/tokens.ts` — Token storage (0600), refresh, expiry check, getAccessToken (20 tests)

**API client layer:**
- [x] `src/colab/xssi.ts` — XSSI prefix stripping (8 tests)
- [x] `src/colab/headers.ts` — Custom header construction
- [x] `src/colab/types.ts` — API response types (live-validated shapes)
- [x] `src/colab/client.ts` — ColabClient: assign, unassign, keepAlive, propagateCredentials (tunnel methods)
- [x] `src/colab/client.ts` — GAPI methods: getUserInfo, listAssignments, refreshProxyToken
- [x] `src/jupyter/contents.ts` — Contents API client (6 tests)
- [x] `src/jupyter/sessions.ts` — Sessions + Kernels REST API (6 tests)
- [x] `src/jupyter/messages.ts` — Jupyter message types + builders
- [x] `src/jupyter/connection.ts` — KernelConnection WebSocket + `colab_request` handler (5 tests)

**Live validation (all confirmed 2026-03-11 — see A8):**
- [x] Tunnel auth: assign T4, get endpoint + proxy token + proxy URL
- [x] Session creation via proxy URL (with retry loop for startup)
- [x] WebSocket connect to kernel
- [x] GAPI getUserInfo: subscription tier, compute units, eligible accelerators
- [x] GAPI listAssignments: sees tunnel-allocated runtimes
- [x] GAPI refreshProxyToken: fresh token + URL
- [x] Unassign cleanup
- [x] End-to-end execution: `print("hello world")` → stdout captured, `status=ok`
- [x] Variable persistence: `x=42` → `print(x*2)` → `84`
- [x] GPU access: `torch.cuda.is_available()=True`, `Tesla T4`
- [x] Error handling: `1/0` → `status=error`, `ZeroDivisionError`
- [x] Out-of-band: 3 separate WebSocket connections share kernel state
- [x] Runtime state APIs: `/api/kernels`, `/api/sessions`, `/api/status`, `/api/kernelspecs`
- [x] Contents API: write/read/stat/delete files and notebooks
- [x] Contents API path mapping: root=`/`, kernel cwd=`/content`, use `content/` prefix
- [x] Kernel ↔ Contents API interop: bidirectional file visibility (with correct paths)
- [x] notebookHash format confirmed (resolves Q4)
- [ ] Credential propagation: not triggered during testing (simple execution doesn't need it)

### Phase 3: Core CLI Commands

Wire the pieces together into real commands. Build order revised per A8 live validation — resolve unknowns first, build the output shell, then commands from simplest to most complex.

**Step 1: Resolve unknowns**
- [x] Resolve Q8 empirically — Contents API writes are runtime-local only, Drive persistence requires separate REST API calls via credential propagation (see A9).
- [ ] Resolve Q9 if possible (does assign accept TTL params?) — if not, defer `--ttl` to Phase 4

**Step 2: Output + state scaffolding**
- [ ] `src/cli/output.ts` — JSON envelope (`CommandResult<T>`), error types with codes + hints, exit code mapping, human-readable formatting. Every command depends on this.
- [ ] `src/state/store.ts` — State file read/write with atomic rename (write .tmp → rename). No flock.
- [ ] `src/state/notebooks.ts` — Per-notebook state (project root discovery, .colab/ management, notebook path convention: `content/<name>.ipynb`)
- [ ] `src/cli/index.ts` — Entry point, command router

**Step 3: Auth command (simplest, validates output pipeline)**
- [ ] `src/cli/auth.ts` — `colab auth login/status/logout`

**Step 4: ensure (the critical path)**
- [ ] `src/cli/ensure.ts` — `colab ensure` (assign + session retry + kernel readiness check + empty .ipynb creation at `content/<name>.ipynb`)
- [ ] `src/jupyter/lifecycle.ts` — `getOrCreateKernel(proxyUrl, proxyToken)`: list sessions, create if needed (with 180s retry), return kernel ID. Shared by ensure, exec, run, restart, interrupt.

**Step 5: exec (core execution primitive)**
- [ ] `src/cli/exec.ts` — `colab exec` (connect → execute → disconnect, proxy token refresh, keep-alive side effect)
- [ ] Fix `KernelConnection` completion: use `gotReply && gotIdle` dual-signal (see Section 10, Completion)
- [ ] Set `allow_stdin: true` in `makeExecuteRequest` (required for `colab_request` handling — see Section 10, `allow_stdin` interaction)

**Step 6: pull/push (file transfer with correct paths)**
- [ ] `src/cli/pull.ts` — `colab pull` (Contents API `content/<name>.ipynb` → ipynbToPercent → write .py, dirty check)
- [ ] `src/cli/push.ts` — `colab push` (percentToCells → merge → Contents API `content/<name>.ipynb`, no timestamp conflict detection — merge handles it)
- [ ] `src/cli/kill.ts` — `colab kill` (unassign + clean up state)

**Step 7: run (cell selection + sequential exec)**
- [ ] `src/cli/run.ts` — `colab run` (fetch remote .ipynb, parse cells, sequential execute_request per cell, --push, --cell, stop-on-error)

**Step 8: Dogfood**
- [ ] Dogfood: ensure → pull → edit → push → run → exec cycle works end-to-end
- [ ] Dogfood: reclamation recovery (kill, re-ensure, push from cache)

### Phase 4: Supporting Commands + Polish

- [ ] `src/cli/secrets.ts` — `colab secrets list` (calls `/userdata/list`, returns key names only — see A10)
- [ ] `GetSecret` handler in `KernelConnection` (env var > Colab API > not found — see A10)
- [ ] `ensure --drive` — Drive credential propagation + consent polling (see A9)
- [ ] Drive auto-sync in `push`/`run` — upload `.ipynb` to Drive via runtime exec (see A9)
- [ ] `src/cli/ls.ts` — `colab ls`
- [ ] `src/cli/status.ts` — `colab status` (include `driveEnabled`/`driveFileId` in output)
- [ ] `src/cli/diff.ts` — `colab diff`
- [ ] `src/cli/restart.ts` — `colab restart`
- [ ] `src/cli/interrupt.ts` — `colab interrupt`
- [ ] `colab upload` / `colab download` (with `content/` path prefix)
- [ ] `colab adopt` — bind a name to an existing endpoint from `listAssignments()` (recovery from `.colab/` deletion)
- [ ] Advisory conflict detection for push (content hash comparison, not timestamps)
- [ ] `--continue-on-error` flag for `run`
- [ ] `--ttl` enforcement (pending Q9 resolution)
- [ ] File locking (`flock`) if multi-agent concurrency becomes a real problem
- [ ] SKILL.md (agent-facing guide, written against real CLI)
- [ ] Corpus regression tests (nightly)
- [ ] `run` data shape finalized and documented
- [ ] Resolve remaining open questions from dogfooding

---

## 18. Addendums

Design tweaks, discoveries, and decisions made during implementation. Newest first.

### A10: Colab secrets — empirical findings and design (2026-03-12)

#### Findings

**Colab secrets are retrieved via kernel comms.** `google.colab.userdata.get('KEY')` sends a `blocking_request('GetSecret', {'key': 'KEY'})` over the Jupyter kernel's ZMQ messaging — the same `colab_request` mechanism used by Drive mount and credential propagation. The frontend responds with `{exists: bool, access: bool, payload: string}`. Our `KernelConnection.handleColabRequest` already intercepts `GetSecret` requests (currently replies with "unsupported").

**The `/userdata/list` API returns all secrets.** `GET https://colab.research.google.com/userdata/list?authuser=0&notebookid=<any>` returns every secret the user has stored in Colab, with full payloads. Requires a valid `colaboratory`-scoped OAuth token (our existing auth). Returns 401 without auth.

**The `notebookid` parameter is not validated.** Any non-empty string works — `notebookid=x` returns the same secrets as a real Drive file ID. The `access` field in the response is purely cosmetic (reflects the per-notebook toggle in the Colab UI sidebar); payloads are returned regardless.

**No runtime or Drive dependency.** The API is on `colab.research.google.com`, not the tunnel domain. It works from the local CLI with our existing token. No runtime needed, no Drive auth needed, no extra scopes needed.

#### Designed Flow

**Listing secrets (agent discoverability):**

```
colab secrets list
```

Local command — calls `/userdata/list` with the user's OAuth token, returns **key names only** (payloads stripped). Agents use this to discover what secrets are available before writing code that references them.

```json
{"ok": true, "command": "secrets.list", "data": {"keys": ["HF_TOKEN", "huggingface", "wandb"]}}
```

**Resolving secrets at execution time (`GetSecret` handler):**

When the kernel sends a `colab_request` with type `GetSecret` during `exec` or `run`:

1. Check environment variables: if `os.environ[key]` exists on the local CLI process, use that value. This allows env var overrides for CI, automation, or non-Colab secrets.
2. Otherwise, call `/userdata/list?notebookid=_` (cached per-session — one API call covers all `GetSecret` requests for the session).
3. Reply on the WebSocket with `{exists: true, access: true, payload: "<value>"}` if found, or `{exists: false}` if not.

**Precedence:** env var > Colab API > not found.

**Security properties:**
- Secret values never appear in CLI output or command results.
- The `/userdata/list` response is cached in process memory only — never written to disk.
- Env vars are the caller's responsibility (standard practice for secret injection).
- The Colab API requires the user's OAuth token, which is already stored in `~/.config/colab-cli/credentials.json`.

#### Design Rationale

We chose **Colab API + env var passthrough** over a local secret store because:
- We're not a secret manager — env vars are the universal interface, every CI/agent framework speaks them.
- Zero config for Colab users — existing Colab secrets just work with no re-entry.
- No new files to secure, no sync to maintain, no dual source of truth.
- Env var override is the natural escape hatch for all cases (CI, non-Colab secrets, overrides).

#### Note on Drive scope expansion

Adding `drive` scope to our OAuth flow would allow direct Drive uploads from the local CLI (no per-runtime consent), enumeration of existing Colab notebooks, and a simpler upload path. However, the current per-runtime credential propagation approach is more secure — Drive access is transient and requires explicit human action per runtime. This is arguably a feature for a tool that agents use autonomously. The scope can be expanded later if the per-runtime consent proves too painful in practice; the change is backward-compatible.

### A9: Drive persistence — empirical findings and design (2026-03-12)

#### Findings

**Contents API writes are runtime-local, not Drive.** The Jupyter Contents API writes to `/content/` on the runtime filesystem. These files are ephemeral — lost when the runtime dies. There is no automatic sync to Google Drive. Notebooks created via our `push` command are invisible to Colab's web UI.

**`drive.mount()` requires browser-based OAuth consent.** The `google.colab.drive.mount()` function works by: (1) sending a `colab_request` with `authType: dfs_ephemeral` to the frontend, (2) the frontend triggers a browser-based Google OAuth consent flow with Drive-specific scopes, (3) credentials are provisioned onto an ephemeral metadata server at `TBE_EPHEM_CREDS_ADDR` (typically `172.28.0.1:8009`), (4) the DriveFS FUSE binary reads tokens from that metadata server. This is tightly coupled to the Colab frontend — there is no way to skip the browser consent.

**We can facilitate the consent flow from the CLI.** The `propagateCredentials` API endpoint (used by Colab's frontend to handle `colab_request` messages) is accessible with our existing OAuth token. When called, it returns either `{success: true}` (credentials provisioned) or `{success: false, unauthorized_redirect_uri: "<url>"}` (user must consent). The redirect URL uses `response_type=none+gsession` — the browser consent goes entirely through Google's servers to Colab's backend. No tokens flow through the CLI or the chat.

**Drive REST API works with the provisioned token.** After successful credential propagation, the ephemeral metadata server serves OAuth tokens with Drive scopes (`drive`, `drive.activity.readonly`, `drive.photos.readonly`, etc.). These tokens can be used directly with the Google Drive REST API (`googleapis.com/drive/v3/`) from the runtime — no FUSE mount, no DriveFS binary needed.

**Notebook upload to Drive validated.** Uploading a `.ipynb` file with `mimeType: application/vnd.google.colaboratory` to the `Colab Notebooks` folder in Drive makes it visible and openable in Colab's web UI. Outputs are preserved.

**Consent does NOT persist across runtimes.** Each new runtime requires the user to re-consent via the browser. However, Google remembers prior scope grants — the consent screen shows "most of this was already approved" and requires only one click. The redirect URL is unique per propagation call (contains a runtime-specific state token with the endpoint ID).

**Token TTL is ~47 minutes, refreshable.** The ephemeral metadata server token expires but can be refreshed by re-calling `propagateCredentials` (no browser consent needed within the same runtime session). This should be done transparently before each Drive upload.

#### Designed Flow

**Enabling Drive persistence:**

```
colab ensure train --gpu t4 --drive
```

1. Allocate runtime normally.
2. Call `propagateCredentials(endpoint, 'dfs_ephemeral', dry_run=true)`.
3. If `success: true` → done (shouldn't happen on fresh runtime, but handle it).
4. If `success: false` → print the `unauthorized_redirect_uri` for the user to open.
5. Poll `propagateCredentials(endpoint, 'dfs_ephemeral', dry_run=false)` every 3 seconds, timeout 120s.
6. On `success: true` → store `driveEnabled: true` and `driveFolderId` in notebook state.
7. On timeout → warn but don't fail the ensure. Runtime is usable without Drive.

**Auto-sync on push/run:**

When `driveEnabled` is set in notebook state, `push` and `run` automatically upload the `.ipynb` to Drive after their primary operation completes. For `run`, this includes failed runs (`ok: false`) — partial outputs from cells that executed before the error are valuable for debugging. The upload path:

1. Re-call `propagateCredentials` to ensure token freshness (handles TTL).
2. Execute a Python snippet on the runtime that: fetches the token from the ephemeral metadata server, reads the `.ipynb` from `/content/`, and uploads via Drive REST API.
3. On first upload: create file in `Colab Notebooks` folder, store the Drive `fileId` in notebook state.
4. On subsequent uploads: update the existing file by ID (PUT, not create).
5. Upload failure is non-fatal — warn but don't fail the push/run.

`--no-drive` flag on push/run skips the upload.

**Drive upload runs entirely on the runtime.** The token lives on the ephemeral metadata server and is fetched by a Python snippet executed via `exec`. No tokens transit through the local CLI or appear in command output.

#### Constraints and Limitations

- **Per-runtime consent**: Each new runtime requires one browser click. Cannot be automated. Acceptable for the human-in-the-loop `ensure` step.
- **Drive deletion**: The Drive copy can be independently deleted or modified. The local `.colab/` cache remains ground truth for the CLI. A `colab status` command could detect Drive staleness by comparing the cached fileId against Drive.
- **No query by name**: We can't look up a Drive notebook by name to "resume" after the local cache is lost. The Drive `fileId` stored in notebook state is the only link. If both the local cache and the runtime die, the Drive copy exists but is orphaned from the CLI's perspective.
- **Scope limitations**: The Drive token only has Drive-related scopes. It cannot be used for Gemini API, Vertex AI, or other Google services. Those would require separate credential propagation with different auth types.

### A8: Live validation — full end-to-end proof (2026-03-11)

Allocated a T4 runtime and ran comprehensive live tests against the real Colab API. All tests passed. Key findings:

**Execution works without credential propagation for simple code.** `print("hello world")` returns stdout immediately with `status=ok`. No `colab_request` messages were observed during basic execution (arithmetic, variable assignment, torch CUDA queries, intentional errors). This contradicts our earlier assumption that credential propagation blocks ALL execution — it appears to only be triggered when the kernel needs specific auth (Drive mount, authenticated API calls). The `colab_request` handler is still needed for those cases, but simple compute-only execution works without it.

**Out-of-band execution validated.** Three separate WebSocket connections (each with a different session ID) to the same kernel all share state. Variables set by connection 1 (`x=42`) are visible to connection 2 and 3. Variables set by connection 2 (`y='from_conn2'`) are visible to connection 3. The kernel is the durable object; WebSocket connections are ephemeral handles. This is critical for our architecture — `colab exec` can connect, execute, disconnect without losing state.

**Contents API path mapping discovery.** The Jupyter Contents API root maps to the filesystem root `/`, NOT to `/content/`. A directory listing of `""` (empty path) returns `bin`, `usr`, `sys`, `content`, etc. The kernel's working directory is `/content`. To write a file that the kernel sees at `/content/foo.txt`, the Contents API path must be `content/foo.txt`. Both directions work: kernel writes to `/content/bar.txt` → Contents API reads `content/bar.txt`, and vice versa. This affects `pull`/`push` — notebook uploads must use the `content/` prefix.

**Runtime state APIs available:**

| Endpoint | Returns |
|---|---|
| `GET /api/kernels` | `id`, `execution_state`, `connections`, `last_activity`, `name` |
| `GET /api/sessions` | Session list with embedded kernel state |
| `GET /api/status` | `connections`, `kernels` count, `last_activity`, `started` timestamp |
| `GET /api` | Jupyter version (`2.14.0`) |
| `GET /api/kernelspecs` | Available kernels: `python3`, `julia`, `ir` |

Additional runtime info queryable via kernel execution: `nvidia-smi` for GPU state (name, memory total/used/free, utilization, temp), `psutil` for RAM/disk/CPU count. On a T4 runtime: 13.6GB RAM, 253GB disk, 2 CPUs, 15GB VRAM.

**Contents API operations validated:** `PUT` (create/overwrite), `GET` (read with base64 encoding), `GET ?content=0` (stat — name, type, size, last_modified), `DELETE`, directory listing, notebook round-trip (write .ipynb → read back → cells and metadata preserved).

### A7: API surface research — full picture (2026-03-11)

Broad research beyond the VS Code extension revealed prior art and resolved critical unknowns.

**Prior art — `pdwi2020/mcp-server-colab-exec`**: A working Python MCP server (MIT, Feb 2026) that allocates Colab GPU runtimes and executes code. 492-line `colab_runtime.py` with the complete tunnel-domain flow. Key contributions to our understanding:

1. **Credential propagation is mandatory for execution.** *(Partially superseded by A8: credential propagation is only triggered for Drive/authenticated operations, not simple compute-only execution.)* The kernel sends `colab_request` messages on the WebSocket requesting auth propagation. Without handling these, the kernel blocks indefinitely — this was the cause of our earlier empty-stdout bug. The endpoint is `GET/POST /tun/m/credentials-propagation/{endpoint}` with the standard XSRF pattern.

2. **VS Code extension's OAuth client ID unlocks the GAPI.** pdwi2020 uses client ID `1014160490159-...` (from `google.colab@0.3.0`). We tested this and confirmed: tokens from this client ID get 200 OK from `colab.pa.googleapis.com/v1/assignments` and `/v1/user-info`. Tokens from gcloud's client ID (`764086051850-...`) get 403 `SERVICE_DISABLED`. The gate is which GCP project owns the client ID — Google's Colab project has the API enabled.

3. **Session creation needs retry loop.** Runtime takes time to start. pdwi2020 retries `POST /api/sessions` for up to 180s with 3s sleep between attempts.

4. **Keep-alive at 60s interval.** `GET /tun/m/{endpoint}/keep-alive/` with `X-Colab-Tunnel: Google` header.

**Other approaches surveyed:**

- **DagsHub "Reverse Engineering Google Colab" (2022)**: Confirmed tunnel proxy architecture (`/tun/m/{id}/` proxies to runtime Jupyter). Discovered `/_proxy/{port}/` generic port proxy. Auth via cookies + `X-Colab-Tunnel: Google` header.
- **SSH/tunnel projects** (colab-ssh, colab-connect, remocolab, VSColab): All deprecated or blocked by Colab TOS changes. Remote desktop/SSH from runtimes is now disallowed for free tier.
- **Colab Enterprise (Vertex AI)**: Completely separate paid product with proper REST API (`aiplatform.googleapis.com`). Different runtime pool, requires GCP project + billing. Not relevant to consumer Colab.
- **Selenium/Puppeteer automation**: Brittle browser automation, not API-level. Not viable.

**Live-validated API surface** (all confirmed 2026-03-11 with VS Code extension client ID token):

| Endpoint | Method | Status | Response |
|---|---|---|---|
| `colab.pa.googleapis.com/v1/user-info` | GET | 200 | Tier, compute units, eligible GPUs/TPUs |
| `colab.pa.googleapis.com/v1/assignments` | GET | 200 | All active runtime assignments |
| `colab.research.google.com/tun/m/assign` | GET+POST | 200 | XSRF → runtime allocation |
| `colab.research.google.com/tun/m/unassign/{ep}` | GET+POST | 204 | Runtime released |
| Proxy URL `/api/sessions` | POST | 200 | Kernel session created |
| Proxy URL `/api/kernels/{id}/channels` | WSS | Connected | Jupyter WebSocket |

**Conclusion**: The full Colab API surface — both tunnel (data plane) and GAPI (control plane) — is accessible from external code using the VS Code extension's public OAuth credentials. No capabilities are lost vs. the extension itself.

### A6: Code review round 2 hardening (fixes #10-#13)

Second round of independent reviews (Opus subagent + Codex CLI). Both found the same two bugs (#10, #13). All fixed with red-green discipline:

**Correctness fixes:**
- **#10** StringParser same-line triple-quote close used `indexOf` — didn't skip `\` escapes. `x = """foo\"""` falsely closed the string. Fixed with character-by-character scan matching the multi-line close logic.
- **#11** Merge pass 4 global FIFO misassigned cells across anchor boundaries. Remote `[A, B, C, D]`, local `[A_mod, C, D_mod]` gave D_mod → B's ID instead of D's. Fixed with gap-bounded matching: anchored matches from passes 1-3 partition into gaps, FIFO runs within each gap. Within-gap ambiguity (1 local, 2+ remotes, can't tell which was deleted) remains an inherent limitation.
- **#12** Bare POSIX commands without arguments (`ls`, `cd` alone) weren't matched by `isMagic` — only the "command + space + args" path fired. Fixed by checking `POSIX_COMMANDS.has(trimmed)` when no space found.
- **#13** YAML header parser didn't unescape `''` → `'` in single-quoted scalars. `display_name: 'Bob''s Python'` parsed as `Bob''s Python`. Fixed by adding `.replace(/''/g, "'")` after stripping outer quotes.

Test count: 166 → 174 (8 regression tests added). All 174 passing.

### A5: Code review hardening (fixes #1-#9)

Two independent reviews (Opus subagent + Codex CLI) found the same critical bugs. All fixed with red-green discipline:

**Correctness fixes:**
- **#1** `serializeMetaValue` corrupted strings — global `.replace(/,/g, ", ")` hit inside quoted values. Fixed with regex that skips quoted regions.
- **#2** Plotly JSON output objects corrupted — `JSON.stringify` on parse then `splitSource` on serialize turned objects into stringified arrays. Fixed by preserving objects as-is in `CellOutput.data`.
- **#3** POSIX commands turned into magics — `# mv tmp` → `mv tmp`. Fixed by making `uncommentMagics` use strict mode: only uncomment unambiguous `%`, `!`, `?` prefixed magics.
- **#5** `StringParser.indexOf` didn't handle escaped triple quotes — `\"\"\"` inside triple-quoted strings caused false close. Fixed with character-by-character scan that skips `\X` escape sequences.
- **#6** Raw cell on top silently dropped without kernelspec — `startCellIdx` advanced but header returned null. Fixed by resetting `startCellIdx = 0` when header is null but raw cell content exists.
- **#7** `parseMetaValue` crashed on malformed JSON — uncaught `JSON.parse`. Fixed with try-catch fallback to raw string value.

**Cleanup fixes:**
- **#4** `FILTERED_METADATA_KEYS` duplicated in serialize.ts, merge.ts, and tests. Extracted to `constants.ts`.
- **#8** `//` in MAGIC_RE is not an IPython magic. Removed.
- **#9** `freshCellId` only 32 bits entropy (8 hex chars). Changed to full UUID (128 bits).
- Dead code removed from header.ts: `indentedComment()`, `serializeYamlValue()`, `HEADER_ALLOWED_EXTRA_KEYS` (extra-keys loop was unreachable).

Test count: 160 → 166 (6 regression tests added). All 166 passing.

### A4: Magic commenting is inherently lossy for ambiguous comments

Property-based testing surfaced this: a Python comment `# !ls -la` is byte-identical to a commented-out shell magic `!ls -la`. On push, `uncommentMagics` assumes the latter. jupytext has the same behavior — it's inherent to the percent format.

In practice this rarely matters: agents write actual code, not comments that happen to start with `%`, `!`, `?`. If it becomes a problem, the workaround is to add a non-magic character: `# Note: !ls -la`.

Similarly, cell sources with trailing `\n` can't round-trip because trailing newlines are indistinguishable from inter-cell PEP 8 spacing. Real .ipynb sources don't end with `\n` (convention: last source array element has no trailing newline).

### A3: PEP 8 blank lines must look ahead past non-code cells

The `blankLinesAfterCell` function (serialize.ts) can't just examine the immediate prev/next cell pair. When markdown/raw cells sit between code cells, the PEP 8 two-blank-line gap for function/class definitions must go on the code-cell side, not the non-code→code boundary.

Rule: non-code cells always get 1 blank line after them. Code cells look ahead past intervening markdown/raw to find the next code cell — if it starts with `def`/`class`/`@`, the 2-line gap is front-loaded after the code cell.

### A2: Magic command commenting matches jupytext defaults

jupytext's percent format comments IPython magics by default (`comment_magics=True` in the format options). Our implementation matches: `%matplotlib` → `# %matplotlib`. Cell magic `# %%timeit` (no space after `%%`) is a commented magic, NOT a cell marker. `# %% timeit` (with space) IS a cell marker with title "timeit".

Recognized patterns: `%`, `%%`, `!`, `?`, POSIX commands (`cd`, `ls`, `cat`, `pip`, etc.), magic assignments (`x = %time expr`). False positive guard: `cat = 42` is NOT a magic (assignment to a POSIX command name).

### A1: Content normalization kept conservative

The merge `sameContent` function uses whitespace-only normalization (collapse runs, strip trailing). jupytext's aggressive normalization (stripping quotes, parentheses, commas) is dangerous — `f("a", "b")` would collide with `f"ab"`, causing wrong outputs on genuinely different cells. We start conservative.
