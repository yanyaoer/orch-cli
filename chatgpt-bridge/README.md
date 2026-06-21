# orch chatgpt-bridge

A **read-only** remote channel that lets ChatGPT (Developer Mode, e.g. `gpt-5.5-pro`)
inspect a local orch worktree — without any tunnel or inbound port. A Cloudflare
Worker is the only public surface; the local machine only ever dials **out**.

## Architecture

```
ChatGPT (Developer Mode)
   │  HTTPS MCP (Streamable HTTP)
   ▼
Worker  /mcp?token=T
   ├─ BridgeMcp (McpAgent)  exposes read-only MCP tools, validates token
   └─ BridgeDO (Durable Object)
         holds the local outbound WebSocket; turns each tool call into a
         request/response RPC over that socket, awaits the result
   ▲
   │  outbound WebSocket  /ws?token=T
local ws-agent (`orch chatgpt-bridge`)
   executes read-only tools inside the worktree, returns JSON
```

Only the Worker is reachable from the internet. The local agent opens an
**outbound** WebSocket, so no public ingress / tunnel is required. The Durable
Object matches each ChatGPT tool call with the local execution result by id.

## MCP tools (all read-only)

| Tool | Effect (local) |
|------|----------------|
| `open_workspace()` | worktree root, AGENTS.md/CLAUDE.md presence + first lines, `git status --short` |
| `read({path})` | read a UTF-8 file (worktree-scoped, truncated at 200 KB) |
| `search({query, path?})` | ripgrep (falls back to grep), matching lines |
| `show_changes()` | `git status --short` + `git diff` (large diffs truncated) |

### Safety

Every path is resolved to an absolute path and must stay inside the worktree
root. Traversal (`..`), absolute paths, and symlinks pointing outside the root
are rejected. `.env*`, `.git/`, `node_modules/`, `.ssh/`, and private-key files
(`*.pem`, `*.key`, `id_rsa`, …) are always blocked. There are no write tools.

## One-stop command

From the repo you want to expose (read-only), with `wrangler` installed and
`wrangler login` already done:

```bash
orch chatgpt-bridge --worktree .
```

On first run this **deploys the Worker**, generates a strong `BRIDGE_TOKEN`,
derives the MCP/WebSocket URLs, saves them to the config below, registers the
worktree, and connects. Later runs reuse the saved Worker. The printed `mcp_url`
is what you paste into ChatGPT (see *Connect ChatGPT* below).

```bash
orch chatgpt-bridge --no-connect    # deploy + print mcp_url only, do not connect
orch chatgpt-bridge --redeploy      # force a fresh deploy + new token
orch chatgpt-bridge --bridge-dir /path/to/chatgpt-bridge   # custom Worker source
```

Ordering note: a Cloudflare secret can only attach to an existing Worker, so the
command runs `wrangler deploy` first (creating the Worker), then
`wrangler secret put BRIDGE_TOKEN` (which triggers a new version with the secret).

### Config

`${XDG_CONFIG_HOME:-$HOME/.config}/orch/chatgpt-bridge.json` (mode `0600`, since
it stores the token) holds the deployed `worker` (name + url + mcp_url + ws_url),
the `token`, and the registered `workspaces`.

The agent reconnects automatically (exponential backoff, max 30 s) and exits
cleanly on Ctrl-C.

## Manual deploy (optional)

If you prefer to manage the Worker yourself:

1. `cd chatgpt-bridge && bun install`
2. `wrangler deploy` → note the URL, e.g. `https://orch-chatgpt-bridge.<acct>.workers.dev`
3. `wrangler secret put BRIDGE_TOKEN` — set a strong shared secret.

Then connect directly (does not deploy or overwrite the saved Worker):

```bash
orch chatgpt-bridge --worktree . \
  --url wss://orch-chatgpt-bridge.<acct>.workers.dev/ws \
  --token <BRIDGE_TOKEN>
```

## Connect ChatGPT

ChatGPT → Settings → Apps → Advanced → **Developer mode** → Create:

- URL: the `mcp_url` printed by `orch chatgpt-bridge`, e.g.
  `https://orch-chatgpt-bridge.<acct>.workers.dev/mcp?token=<BRIDGE_TOKEN>`

Then enable the app in a conversation and select model `gpt-5.5-pro`.

## Local development

```bash
# terminal 1 — Worker (token "test")
cd chatgpt-bridge && bun run dev          # wrangler dev on http://localhost:8787

# terminal 2 — local agent
orch chatgpt-bridge --url ws://localhost:8787/ws --token test --worktree .
```

For local `wrangler dev`, set the secret via `.dev.vars`:

```
BRIDGE_TOKEN=test
```

## Auth

Both `/mcp` (ChatGPT → Worker) and `/ws` (local → Worker) require
`?token=<T>` matching `env.BRIDGE_TOKEN`. Mismatches get `401`. The token is the
only credential, so treat it like a password and prefer `wss://` in production
(Workers serves TLS by default).
