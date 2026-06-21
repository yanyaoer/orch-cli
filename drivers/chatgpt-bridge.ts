#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { RPC, isRpcRequest, type RpcRequest, type RpcResponse } from "../chatgpt-bridge/src/protocol.ts";
import { buildBridgeUrls, parseWorkersUrl, type BridgeWorker } from "../src/config.ts";

export interface ChatgptBridgeOptions {
  url: string;
  token: string;
  worktree: string;
}

const MAX_READ_BYTES = 200_000;
const MAX_SEARCH_BYTES = 64_000;
const MAX_DIFF_BYTES = 64_000;
const SUMMARY_LINES = 20;
const MAX_BACKOFF_MS = 30_000;

// Directory/file names that are always off-limits regardless of scope.
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ".ssh"]);

function isBlockedPath(rel: string): boolean {
  const segments = rel.split(sep).join("/").split("/").filter(Boolean);
  for (const segment of segments) {
    if (BLOCKED_SEGMENTS.has(segment)) return true;
    if (segment === ".env" || segment.startsWith(".env.")) return true;
  }
  const base = segments[segments.length - 1] ?? "";
  if (/\.(pem|key)$/i.test(base)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)$/.test(base)) return true;
  return false;
}

// Resolve `requested` (relative to the worktree root) to an absolute path,
// rejecting anything that escapes the root, is blocked, or follows a symlink
// out of the root. Pure except for the optional symlink realpath check.
export function resolveSafePath(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new Error("path is required");
  }
  const abs = resolve(root, requested);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes worktree: ${requested}`);
  }
  if (isBlockedPath(rel)) {
    throw new Error(`path is blocked: ${requested}`);
  }
  // Symlink guard: if the target exists, its real location must stay in root.
  if (existsSync(abs)) {
    const realRoot = realpathSync(root);
    const real = realpathSync(abs);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`path resolves outside worktree: ${requested}`);
    }
  }
  return abs;
}

function truncate(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n... [truncated ${text.length - maxBytes} chars]`;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], cwd: string, stdin?: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Feed secrets through stdin (kept out of argv) when provided.
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// Locate the chatgpt-bridge Worker source. Prefer an explicit --bridge-dir;
// otherwise resolve it relative to this driver (repo-root/chatgpt-bridge). After
// bundling to a single binary that relative path is gone, so fail loudly with a
// hint instead of silently doing the wrong thing.
// A Worker source dir is one that holds wrangler.jsonc; accept either the dir
// itself or a `chatgpt-bridge/` subdir under it (so `--bridge-dir .` at the repo
// root works too).
function bridgeDirAt(dir: string): string | null {
  if (existsSync(join(dir, "wrangler.jsonc"))) return dir;
  const nested = join(dir, "chatgpt-bridge");
  if (existsSync(join(nested, "wrangler.jsonc"))) return nested;
  return null;
}

export function locateBridgeDir(explicit?: string): string {
  if (explicit) {
    const found = bridgeDirAt(resolve(explicit));
    if (!found) {
      throw new Error(`--bridge-dir has no chatgpt-bridge Worker source (no wrangler.jsonc): ${resolve(explicit)}`);
    }
    return found;
  }
  // Source runs resolve next to the repo; a compiled binary falls back to cwd.
  const found = bridgeDirAt(resolve(import.meta.dir, "..")) ?? bridgeDirAt(process.cwd());
  if (found) return found;
  throw new Error(
    "cannot locate the chatgpt-bridge Worker source; run inside the orch repo or pass --bridge-dir <path>.",
  );
}

// Idempotently deploy the Worker and attach a fresh BRIDGE_TOKEN, returning the
// saved worker record plus the token. Ordering matters: `wrangler deploy` must
// create the Worker before `wrangler secret put` can attach a secret to it.
export async function deployWorker(bridgeDir: string): Promise<{ worker: BridgeWorker; token: string }> {
  let who: RunResult;
  try {
    who = await run(["wrangler", "whoami"], bridgeDir);
  } catch {
    throw new Error("wrangler not found on PATH; install it and run `wrangler login` first.");
  }
  if (who.code !== 0) {
    throw new Error(`wrangler is not logged in; run \`wrangler login\` first.\n${(who.stderr || who.stdout).trim()}`);
  }

  if (!existsSync(join(bridgeDir, "node_modules"))) {
    log("installing Worker dependencies (bun install)");
    const install = await run(["bun", "install"], bridgeDir);
    if (install.code !== 0) throw new Error(`bun install failed in ${bridgeDir}\n${install.stderr.trim()}`);
  }

  log("deploying Worker (wrangler deploy)");
  const deploy = await run(["wrangler", "deploy"], bridgeDir);
  if (deploy.code !== 0) {
    throw new Error(`wrangler deploy failed\n${(deploy.stderr || deploy.stdout).trim()}`);
  }
  const url = parseWorkersUrl(`${deploy.stdout}\n${deploy.stderr}`);
  if (!url) throw new Error(`no *.workers.dev URL found in wrangler deploy output:\n${deploy.stdout}`);

  const token = randomBytes(24).toString("hex");
  log("setting BRIDGE_TOKEN secret (wrangler secret put)");
  const secret = await run(["wrangler", "secret", "put", "BRIDGE_TOKEN"], bridgeDir, `${token}\n`);
  if (secret.code !== 0) throw new Error(`wrangler secret put BRIDGE_TOKEN failed\n${(secret.stderr || secret.stdout).trim()}`);

  const { mcp_url, ws_url } = buildBridgeUrls(url, token);
  const name = new URL(url).hostname.split(".")[0] ?? "orch-chatgpt-bridge";
  return { worker: { name, url, mcp_url, ws_url, deployed_at: new Date().toISOString() }, token };
}

function fileSummary(root: string, name: string): { present: boolean; summary?: string } {
  try {
    const abs = resolveSafePath(root, name);
    if (!existsSync(abs)) return { present: false };
    const head = readFileSync(abs, "utf8").split("\n").slice(0, SUMMARY_LINES).join("\n");
    return { present: true, summary: head };
  } catch {
    return { present: false };
  }
}

async function openWorkspace(root: string): Promise<unknown> {
  const status = await run(["git", "-C", root, "status", "--short"], root);
  return {
    root,
    agents_md: fileSummary(root, "AGENTS.md"),
    claude_md: fileSummary(root, "CLAUDE.md"),
    git_status: status.code === 0 ? status.stdout.trim() : `(git unavailable: ${status.stderr.trim()})`,
  };
}

function readTool(root: string, params: unknown): string {
  const path = (params as { path?: unknown })?.path;
  if (typeof path !== "string") throw new Error("read requires a string `path`");
  const abs = resolveSafePath(root, path);
  if (!existsSync(abs)) throw new Error(`not found: ${path}`);
  if (statSync(abs).isDirectory()) throw new Error(`is a directory: ${path}`);
  return truncate(readFileSync(abs, "utf8"), MAX_READ_BYTES);
}

async function searchTool(root: string, params: unknown): Promise<unknown> {
  const { query, path } = (params ?? {}) as { query?: unknown; path?: unknown };
  if (typeof query !== "string" || query.length === 0) throw new Error("search requires a string `query`");
  const scope = typeof path === "string" && path.length > 0 ? resolveSafePath(root, path) : root;
  const hasRg = (await run(["sh", "-c", "command -v rg"], root)).code === 0;
  const cmd = hasRg
    ? ["rg", "--line-number", "--no-heading", "--color", "never", "--", query, scope]
    : ["grep", "-rn", "--", query, scope];
  const result = await run(cmd, root);
  // rg/grep exit 1 means "no matches" — not an error.
  if (result.code > 1) throw new Error(`search failed: ${result.stderr.trim()}`);
  return {
    tool: hasRg ? "rg" : "grep",
    matches: truncate(result.stdout.trim(), MAX_SEARCH_BYTES) || "(no matches)",
  };
}

async function showChanges(root: string): Promise<unknown> {
  const status = await run(["git", "-C", root, "status", "--short"], root);
  const diff = await run(["git", "-C", root, "diff"], root);
  return {
    status: status.stdout.trim(),
    diff: truncate(diff.stdout, MAX_DIFF_BYTES),
  };
}

async function handle(method: string, params: unknown, root: string): Promise<unknown> {
  switch (method) {
    case RPC.openWorkspace:
      return openWorkspace(root);
    case RPC.read:
      return readTool(root, params);
    case RPC.search:
      return searchTool(root, params);
    case RPC.showChanges:
      return showChanges(root);
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function execute(request: RpcRequest, root: string): Promise<RpcResponse> {
  try {
    const result = await handle(request.method, request.params, root);
    return { id: request.id, result };
  } catch (error) {
    return { id: request.id, error: { message: error instanceof Error ? error.message : String(error) } };
  }
}

function withToken(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(message: string): void {
  process.stderr.write(`[chatgpt-bridge] ${message}\n`);
}

// Connects once and resolves when the socket closes. Returns whether it ever
// opened (used to reset the reconnect backoff).
function connectOnce(wsUrl: string, root: string, onSocket: (ws: WebSocket) => void): Promise<boolean> {
  return new Promise((resolveClose) => {
    let opened = false;
    const ws = new WebSocket(wsUrl);
    onSocket(ws);
    ws.addEventListener("open", () => {
      opened = true;
      log("connected");
    });
    ws.addEventListener("message", async (event) => {
      let request: unknown;
      try {
        request = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (!isRpcRequest(request)) return;
      const response = await execute(request, root);
      try {
        ws.send(JSON.stringify(response));
      } catch {
        // socket closed mid-flight; reconnect loop handles it
      }
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
    ws.addEventListener("close", () => resolveClose(opened));
  });
}

export async function runChatgptBridge(opts: ChatgptBridgeOptions): Promise<number> {
  const root = realpathSync(resolve(opts.worktree));
  const wsUrl = withToken(opts.url, opts.token);
  log(`worktree: ${root}`);
  log(`endpoint: ${opts.url}`);

  let stopping = false;
  let current: WebSocket | null = null;
  const stop = () => {
    stopping = true;
    try {
      current?.close(1000, "shutdown");
    } catch {
      // ignore
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let backoff = 1000;
  while (!stopping) {
    const opened = await connectOnce(wsUrl, root, (ws) => {
      current = ws;
    });
    if (opened) backoff = 1000;
    if (stopping) break;
    log(`disconnected; reconnecting in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  log("stopped");
  return 0;
}

function usage(): string {
  return [
    "orch chatgpt-bridge: local read-only agent for the ChatGPT bridge Worker",
    "",
    "Usage:",
    "  orch chatgpt-bridge --url <ws(s)://host/ws> --token <T> [--worktree <path>]",
    "",
    "Flags:",
    "  --url <url>         Worker WebSocket endpoint, e.g. wss://<worker>.workers.dev/ws (required)",
    "  --token <token>     Shared secret matching the Worker's BRIDGE_TOKEN (required)",
    "  --worktree <path>   Worktree the remote may read; defaults to the current directory",
    "  --help              Show this help",
    "",
    "The agent dials out to the Worker over WebSocket and serves read-only tools",
    "(open_workspace, read, search, show_changes) scoped to the worktree.",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--help")) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const url = get("url");
  const token = get("token");
  if (!url || !token) {
    process.stderr.write("missing --url and/or --token\n\n");
    process.stderr.write(usage());
    process.exit(2);
  }
  runChatgptBridge({ url, token, worktree: get("worktree") ?? process.cwd() })
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    });
}
