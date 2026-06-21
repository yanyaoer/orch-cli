import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json.ts";

export interface BridgeWorker {
  name: string;
  url: string;
  mcp_url: string;
  ws_url: string;
  deployed_at: string;
}

export interface BridgeWorkspace {
  path: string;
  added_at: string;
}

export interface BridgeConfig {
  worker?: BridgeWorker;
  token?: string;
  workspaces: BridgeWorkspace[];
}

export function configHome(): string {
  return process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`;
}

export function orchConfigDir(): string {
  return `${configHome()}/orch`;
}

export function chatgptBridgeConfigPath(): string {
  return `${orchConfigDir()}/chatgpt-bridge.json`;
}

export function readBridgeConfig(): BridgeConfig {
  return readJsonFile<BridgeConfig>(chatgptBridgeConfigPath(), { workspaces: [] });
}

// Persist the config 0600 — it stores the bridge token in plaintext.
export function writeBridgeConfig(cfg: BridgeConfig): void {
  const path = chatgptBridgeConfigPath();
  mkdirSync(orchConfigDir(), { recursive: true });
  writeJsonAtomic(path, cfg);
  chmodSync(path, 0o600);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

// Append `absPath` to the workspace list, deduped by canonical (realpath) path.
export function addWorkspace(cfg: BridgeConfig, absPath: string, now: string): BridgeConfig {
  const key = canonicalPath(absPath);
  const workspaces = cfg.workspaces.filter((w) => canonicalPath(w.path) !== key);
  workspaces.push({ path: absPath, added_at: now });
  return { ...cfg, workspaces };
}

// Extract the first https://<name>.<acct>.workers.dev URL from `wrangler deploy` output.
export function parseWorkersUrl(deployStdout: string): string | null {
  const match = deployStdout.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  return match ? match[0] : null;
}

// Derive the ChatGPT MCP URL (https, token in query) and the local WebSocket URL
// (wss, no token — `runChatgptBridge` appends it at connect time) from the base.
export function buildBridgeUrls(baseHttpsUrl: string, token: string): { mcp_url: string; ws_url: string } {
  const base = new URL(baseHttpsUrl);
  const mcp = new URL(base.toString());
  mcp.pathname = "/mcp";
  mcp.searchParams.set("token", token);
  const ws = new URL(base.toString());
  ws.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  ws.pathname = "/ws";
  return { mcp_url: mcp.toString(), ws_url: ws.toString() };
}
