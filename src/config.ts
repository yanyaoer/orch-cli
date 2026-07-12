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

export interface OrchWorkspace {
  id: string;
  path: string;
  added_at: string;
}

export interface OrchConfig {
  version: 1;
  workspaces: Record<string, OrchWorkspace>;
}

export interface MailAgentDefinition {
  id: string;
  address: string;
  provider: string;
  roles: string[];
  capabilities: string[];
  trust: "internal" | "external";
  auto_invite: boolean;
  work_mode: string;
  provider_session_mode: "ephemeral" | "fresh_persistent" | "resume_exact";
  updated_at: string;
}

export interface MailAgentsConfig {
  version: 1;
  agents: Record<string, MailAgentDefinition>;
}

export interface MailControlConfig {
  version: 1;
  account: { user: string; password?: string; password_cmd?: string[] };
  imap: { host: string; port: number };
  smtp: { host: string; port: number; mode: "implicit" | "starttls"; from?: string };
  allowed_senders: string[];
  trusted_authserv_id: string;
  workspace: string;
  reconcile_interval_sec: number;
  subject_token: string | null;
  require_auth_results: boolean;
  controller: { agent: "claude"; model: string | null; timeout_sec: number; max_spawns_per_hour: number };
  reports: { policy: "auto" | "always" | "never"; max_per_hour: number; max_body_bytes: number };
  notify: { enabled: boolean; to?: string; max_per_hour: number; since?: string };
}

const DEFAULT_MAIL_CONTROL_CONFIG: MailControlConfig = {
  version: 1,
  account: { user: "" },
  imap: { host: "", port: 993 },
  smtp: { host: "", port: 465, mode: "implicit" },
  allowed_senders: [],
  trusted_authserv_id: "",
  workspace: "",
  reconcile_interval_sec: 60,
  subject_token: null,
  require_auth_results: true,
  controller: { agent: "claude", model: null, timeout_sec: 1800, max_spawns_per_hour: 6 },
  reports: { policy: "auto", max_per_hour: 4, max_body_bytes: 16384 },
  notify: { enabled: false, max_per_hour: 30 },
};

export function configHome(): string {
  return process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`;
}

export function orchConfigDir(): string {
  return `${configHome()}/orch`;
}

export function chatgptBridgeConfigPath(): string {
  return `${orchConfigDir()}/chatgpt-bridge.json`;
}

export function mailAgentsConfigPath(): string {
  return `${orchConfigDir()}/mail-agents.json`;
}

export function mailControlConfigPath(): string {
  return `${orchConfigDir()}/mail-control.json`;
}

export function orchConfigPath(): string {
  return `${orchConfigDir()}/config.json`;
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

export function readMailAgentsConfig(): MailAgentsConfig {
  return readJsonFile<MailAgentsConfig>(mailAgentsConfigPath(), { version: 1, agents: {} });
}

export function writeMailAgentsConfig(cfg: MailAgentsConfig): void {
  const path = mailAgentsConfigPath();
  mkdirSync(orchConfigDir(), { recursive: true });
  writeJsonAtomic(path, cfg);
  chmodSync(path, 0o600);
}

export function readMailControlConfig(): MailControlConfig {
  const cfg = readJsonFile<Partial<MailControlConfig> | null>(mailControlConfigPath(), null);
  if (!cfg) return { ...DEFAULT_MAIL_CONTROL_CONFIG, notify: { ...DEFAULT_MAIL_CONTROL_CONFIG.notify } };
  let notify = cfg.notify as unknown;
  if (notify === null || notify === undefined) notify = { ...DEFAULT_MAIL_CONTROL_CONFIG.notify };
  else if (typeof notify === "object" && !Array.isArray(notify)) notify = { ...DEFAULT_MAIL_CONTROL_CONFIG.notify, ...notify };
  return { ...cfg, notify } as MailControlConfig;
}

export function writeMailControlConfig(cfg: MailControlConfig): void {
  const path = mailControlConfigPath();
  mkdirSync(orchConfigDir(), { recursive: true });
  writeJsonAtomic(path, cfg);
  chmodSync(path, 0o600);
}

export function validateMailControlConfig(cfg: MailControlConfig): void {
  assertObject(cfg, "config");
  if (cfg.version !== 1) throw new Error("mail control config version must be 1");
  assertObject(cfg.account, "account");
  assertNonEmptyString(cfg.account.user, "account.user");
  if (cfg.account.password !== undefined && typeof cfg.account.password !== "string") {
    throw new Error("mail control account.password must be a string when set");
  }
  if (cfg.account.password_cmd !== undefined) assertStringArray(cfg.account.password_cmd, "account.password_cmd");

  assertObject(cfg.imap, "imap");
  assertNonEmptyString(cfg.imap.host, "imap.host");
  assertTcpPort(cfg.imap.port, "imap.port");

  assertObject(cfg.smtp, "smtp");
  assertNonEmptyString(cfg.smtp.host, "smtp.host");
  assertTcpPort(cfg.smtp.port, "smtp.port");
  if (cfg.smtp.mode !== "implicit" && cfg.smtp.mode !== "starttls") {
    throw new Error("mail control smtp.mode must be implicit or starttls");
  }
  if (cfg.smtp.from !== undefined && typeof cfg.smtp.from !== "string") {
    throw new Error("mail control smtp.from must be a string when set");
  }

  assertStringArray(cfg.allowed_senders, "allowed_senders");
  if (cfg.allowed_senders.length === 0) throw new Error("mail control allowed_senders must be non-empty");
  for (const sender of cfg.allowed_senders) {
    if (!sender || sender !== sender.toLowerCase() || /[<>\s]/.test(sender)) {
      throw new Error("mail control allowed_senders entries must be lower-cased bare addresses");
    }
  }

  assertNonEmptyString(cfg.trusted_authserv_id, "trusted_authserv_id");
  assertNonEmptyString(cfg.workspace, "workspace");
  assertPositiveFiniteNumber(cfg.reconcile_interval_sec, "reconcile_interval_sec");
  if (cfg.subject_token !== null && typeof cfg.subject_token !== "string") {
    throw new Error("mail control subject_token must be a string or null");
  }
  if (typeof cfg.require_auth_results !== "boolean") {
    throw new Error("mail control require_auth_results must be a boolean");
  }

  assertObject(cfg.controller, "controller");
  if (cfg.controller.agent !== "claude") throw new Error("mail control controller.agent must be claude");
  if (cfg.controller.model !== null && typeof cfg.controller.model !== "string") {
    throw new Error("mail control controller.model must be a string or null");
  }
  assertPositiveFiniteNumber(cfg.controller.timeout_sec, "controller.timeout_sec");
  assertPositiveFiniteNumber(cfg.controller.max_spawns_per_hour, "controller.max_spawns_per_hour");

  assertObject(cfg.reports, "reports");
  if (cfg.reports.policy !== "auto" && cfg.reports.policy !== "always" && cfg.reports.policy !== "never") {
    throw new Error("mail control reports.policy must be auto, always, or never");
  }
  assertPositiveFiniteNumber(cfg.reports.max_per_hour, "reports.max_per_hour");
  assertPositiveFiniteNumber(cfg.reports.max_body_bytes, "reports.max_body_bytes");

  assertObject(cfg.notify, "notify");
  if (typeof cfg.notify.enabled !== "boolean") {
    throw new Error("mail control notify.enabled must be a boolean");
  }
  if (cfg.notify.to !== undefined) {
    const to = cfg.notify.to;
    const at = to.indexOf("@");
    // Exactly one bare addr-spec: a comma/semicolon-separated list would fan
    // the progress email out to every listed address via the To header.
    if (!to || to !== to.toLowerCase() || /[<>,;\s]/.test(to) || at <= 0 || at !== to.lastIndexOf("@") || at === to.length - 1) {
      throw new Error("mail control notify.to must be a single lower-cased bare address when set");
    }
  }
  assertPositiveFiniteNumber(cfg.notify.max_per_hour, "notify.max_per_hour");
  if (cfg.notify.since !== undefined && (typeof cfg.notify.since !== "string" || !Number.isFinite(Date.parse(cfg.notify.since)))) {
    throw new Error("mail control notify.since must be an ISO-8601 timestamp when set");
  }
}

export async function resolveMailPassword(cfg: MailControlConfig): Promise<string> {
  const passwordCmd = cfg.account.password_cmd;
  if (passwordCmd !== undefined) {
    assertStringArray(passwordCmd, "account.password_cmd");
    if (passwordCmd.length === 0) throw new Error("mail control account.password_cmd must be a non-empty argv array");
    const proc = Bun.spawn(passwordCmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const message = stderr.trim();
      throw new Error(`mail control account.password_cmd failed with exit code ${exitCode}${message ? `: ${message}` : ""}`);
    }
    return stdout.replace(/[\r\n]+$/, "");
  }
  if (cfg.account.password !== undefined) return cfg.account.password;
  throw new Error("mail control account.password or account.password_cmd is required");
}

export function readOrchConfig(): OrchConfig {
  return readJsonFile<OrchConfig>(orchConfigPath(), { version: 1, workspaces: {} });
}

export function writeOrchConfig(cfg: OrchConfig): void {
  const path = orchConfigPath();
  mkdirSync(orchConfigDir(), { recursive: true });
  writeJsonAtomic(path, cfg);
  chmodSync(path, 0o600);
}

export function upsertWorkspace(cfg: OrchConfig, id: string, path: string, now: string): OrchConfig {
  const resolved = canonicalPath(path);
  const workspaces = Object.fromEntries(Object.entries(cfg.workspaces).filter(([, workspace]) => canonicalPath(workspace.path) !== resolved));
  workspaces[id] = { id, path: resolved, added_at: now };
  return { version: 1, workspaces };
}

export function upsertMailAgent(cfg: MailAgentsConfig, agent: MailAgentDefinition): MailAgentsConfig {
  return {
    version: 1,
    agents: {
      ...cfg.agents,
      [agent.id]: agent,
    },
  };
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

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`mail control ${field} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`mail control ${field} is required`);
  }
}

function assertPositiveFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`mail control ${field} must be a finite positive number`);
  }
}

function assertTcpPort(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`mail control ${field} must be an integer TCP port in range 1..65535`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`mail control ${field} must be a string argv array`);
  }
}
