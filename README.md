# colab

CLI for Google Colab. Manage GPU/TPU runtimes, sync notebooks, execute code, and transfer files — all from the terminal.

Works great with AI coding agents (structured JSON output, non-interactive, deterministic) but is a general-purpose Colab CLI.

## Why

**Use Colab GPUs without the browser.** Colab's web UI is built for interactive exploration. This CLI is built for automation — scripted training runs, agent-driven experimentation, CI pipelines, or just people who prefer terminals over notebooks.

**Edit notebooks as plain Python.** Notebooks are synced as [percent-format](https://jupytext.readthedocs.io/en/latest/formats-scripts.html#the-percent-format) `.py` files — standard Python with `# %%` cell markers. Edit with any tool, diff with git, review in PRs. `push` merges your edits back into the `.ipynb`, preserving cell IDs and outputs from previous runs.

**Colab GPUs from your terminal.** The same T4/A100/TPU runtimes available in the Colab UI, allocated and managed via CLI. Your existing Colab subscription and compute units work as-is.

**Structured output for automation.** Human-readable output in the terminal, JSON when piped or invoked by agents (TTY detection). `--json` flag forces JSON. Consistent envelope (`ok`, `command`, `data`, `error`) with semantic exit codes.

**Cost-aware by default.** `auth status` shows your compute balance and current burn rate. `status` shows per-runtime uptime and kernel state. `kill` releases runtimes. No hidden background processes burning credits.

See [SKILL.md](SKILL.md) for the agent integration guide.
See [DESIGN.md](DESIGN.md) for the design specification.

## Agent Skill

Install the [Agent Skill](https://agentskills.io) to make the CLI discoverable by your AI coding agents (Claude Code, Codex, Cursor, and [others](https://agentskills.io)):

```bash
bunx skills add brittlewis12/colab-cli    # or: npx skills add
```

This installs the skill into all detected agents. Once installed, agents automatically know how to use the CLI when relevant tasks come up.

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/brittlewis12/colab-cli.git
cd colab-cli
bun install
```

**Option A: Run from source** (for development)

```bash
bun run colab auth login
bun run colab ensure training --gpu t4
```

**Option B: Compile to a standalone binary**

```bash
bun build --compile src/cli/index.ts --outfile colab
# move to somewhere on your PATH:
mv colab ~/.local/bin/    # or /usr/local/bin/, etc.
```

Then use directly:

```bash
colab auth login
colab ensure training --gpu t4
colab run training --push
```

## Quick Start

```bash
colab auth login                    # one-time OAuth (opens browser)
colab auth status                   # verify tier, compute units, eligible GPUs
colab ensure training --gpu t4      # allocate runtime (blocks until ready)
# write training.py using any editor or agent tool
colab run training --push           # push .py to runtime and execute all cells
colab exec training "print(result)" # inspect live kernel state
colab status training               # check runtime state, kernel idle/busy, compute balance
colab kill training                 # release runtime when done
```

## Commands

| Command | Purpose |
|---------|---------|
| `ensure <name> --gpu/--tpu/--cpu-only` | Create or reconnect to a runtime (`--drive` for Drive persistence) |
| `pull <name>` | Download remote notebook as local `.py` |
| `push <name>` | Upload local `.py` as notebook (merge preserves outputs) |
| `run <name>` | Execute notebook cells on the runtime |
| `exec <name> "<code>"` | Run ad-hoc Python on the live kernel |
| `status [<name>]` | Dashboard or detailed notebook status |
| `ls` | List all notebooks + runtime status |
| `diff <name>` | Cell-level diff: local vs remote |
| `kill <name>` | Release the runtime |
| `restart <name>` | Restart kernel (clear Python state, keep runtime) |
| `interrupt <name>` | Cancel running execution |
| `upload <name> <local> <remote>` | Upload file to runtime |
| `download <name> <remote> <local>` | Download file from runtime |
| `adopt <endpoint> --name <name>` | Bind a name to an existing runtime |
| `secrets list` | List available Colab secret names |
| `auth login/status/logout` | OAuth authentication |

All commands return structured JSON on stdout. See [SKILL.md](SKILL.md) for the full output contract, error codes, and agent integration guide.

## Development

```bash
bun test                # run all tests
bun run typecheck       # tsc --noEmit
bun test test/unit      # unit tests only
bun test test/differential  # differential oracle tests (vs jupytext)
bun test test/property  # property-based round-trip tests
```

## Architecture

```
src/
├── cli/          # 16 command handlers + output formatting
├── auth/         # OAuth2 loopback flow + token management
├── colab/        # Colab API client (tunnel + GAPI domains)
├── jupyter/      # WebSocket kernel connection + REST APIs
├── notebook/     # .ipynb ↔ .py percent-format conversion + merge
└── state/        # Per-notebook state files + project root discovery
```

## Acknowledgments

- [jupytext](https://github.com/mwouts/jupytext) — the percent format spec and test fixtures that our notebook conversion pipeline is built against
- [Google Colab VS Code extension](https://marketplace.visualstudio.com/items?itemName=google.colab) (Apache-2.0) — OAuth client credentials and API surface reference
- [pdwi2020/mcp-server-colab-exec](https://github.com/pdwi2020/mcp-server-colab-exec) (MIT) — prior art that helped us understand the tunnel API and credential propagation flow

## License

MIT
