import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json.ts";
import type { AgentName, RunRole } from "./types.ts";

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

// Per-role run defaults. A bare string is shorthand for { agent }. Explicit
// run create flags always win. `model` is written in the agent's own ref
// format, so it applies only when the run's agent is this entry's agent — a
// `--agent` override never inherits it. It becomes spec.model (careful: for
// claude that also overrides the role's model tier, e.g. reviewer/opus).
export interface RoleDefaults {
  agent?: AgentName;
  model?: string;
  timeout_sec?: number;
}

export interface OrchDefaults {
  // `orch run create` falls back to these when the corresponding flag is
  // omitted. Recommended profile: implementer -> pi (see README).
  agents?: Partial<Record<RunRole, AgentName | RoleDefaults>>;
  // Default model per agent, in that CLI's own ref format (pi/omp
  // `<provider>/<model>`, codex bare name, claude alias or full id). Used when
  // neither --model nor a matching role default names one; snapshotted into
  // spec.model, so for claude it also replaces the reviewer/researcher tiers.
  models?: Partial<Record<AgentName, string>>;
  // Mail-agent ids the fixed-pair fan-outs dispatch to when --to-agent is
  // omitted, replacing the built-in claude+omp pairs. Every id must exist in
  // mail-agents.json.
  fanout?: { "cross-review"?: string[]; investigate?: string[] };
}

export interface OrchConfig {
  version: 1;
  workspaces: Record<string, OrchWorkspace>;
  defaults?: OrchDefaults;
  // Publication language for MR/PR comment bodies and worker result prose:
  // "中文" or "english". Missing or any other value behaves as english.
  language?: string;
  // When true, every provider spawn (claude/codex/pi/omp) runs under one
  // orch-generated macOS Seatbelt write jail (engine seatbelt-v1, see
  // docs/sandbox-design.md): writes confined to the role's worktree posture,
  // per-run scratch, and the selected provider's own state; reads, exec, and
  // network stay open. Snapshotted into spec.sandbox_engine at run create;
  // fail-closed (the run refuses to start) off darwin or whenever the sandbox
  // cannot be applied — never a silent downgrade.
  sandbox?: boolean;
  // Explicit user-owned escape hatch: extra absolute directories granted as
  // write subpaths to every sandboxed run (e.g. "~/.gradle" is deliberately
  // NOT granted by default — prefer the built-in ORCH_WORKER_CACHE). Each
  // entry is snapshotted into spec.sandbox_write_dirs at run create and
  // re-vetted fail-closed by the driver (canonicalized, narrow-dir gate, and
  // orch's own config dir + state root are always refused: a worker must
  // never be able to edit this list or forge run state). This shifts the
  // blast-radius responsibility for the listed dirs to the user.
  sandbox_write_dirs?: string[];
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
  // Absent = the built-in IMAP/SMTP client. "maildir": an external fetcher
  // fills <path>/new (sync_cmd runs before every listing) and an external
  // submitter takes rfc822 on stdin (send_cmd); without send_cmd the built-in
  // SMTP client still sends, so imap.* is unused but smtp.* stays required.
  transport?: { kind: "imap-smtp" } | { kind: "maildir"; path: string; sync_cmd?: string[]; send_cmd?: string[] };
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

  const transport = cfg.transport;
  if (transport !== undefined) {
    assertObject(transport, "transport");
    if (transport.kind !== "imap-smtp" && transport.kind !== "maildir") {
      throw new Error("mail control transport.kind must be imap-smtp or maildir");
    }
    if (transport.kind === "maildir") {
      assertNonEmptyString(transport.path, "transport.path");
      for (const key of ["sync_cmd", "send_cmd"] as const) {
        const argv = transport[key];
        if (argv === undefined) continue;
        assertStringArray(argv, `transport.${key}`);
        if (argv.length === 0) throw new Error(`mail control transport.${key} must be a non-empty argv array`);
      }
    }
  }
  const maildir = transport?.kind === "maildir" ? transport : null;

  if (!maildir) {
    assertObject(cfg.imap, "imap");
    assertNonEmptyString(cfg.imap.host, "imap.host");
    assertTcpPort(cfg.imap.port, "imap.port");
  }

  if (!maildir?.send_cmd) {
    assertObject(cfg.smtp, "smtp");
    assertNonEmptyString(cfg.smtp.host, "smtp.host");
    assertTcpPort(cfg.smtp.port, "smtp.port");
    if (cfg.smtp.mode !== "implicit" && cfg.smtp.mode !== "starttls") {
      throw new Error("mail control smtp.mode must be implicit or starttls");
    }
    if (cfg.smtp.from !== undefined && typeof cfg.smtp.from !== "string") {
      throw new Error("mail control smtp.from must be a string when set");
    }
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

const ORCH_CONFIG_KEYS = ["version", "workspaces", "defaults", "language", "sandbox", "sandbox_write_dirs"] as const;
const ORCH_DEFAULTS_KEYS = ["agents", "models", "fanout"] as const;
const ROLE_DEFAULT_KEYS = ["agent", "model", "timeout_sec"] as const;
const FANOUT_KEYS = ["cross-review", "investigate"] as const;
const RUN_ROLES: readonly string[] = ["implementer", "reviewer", "verifier", "controller", "researcher"];
const AGENT_NAMES: readonly string[] = ["codex", "claude", "pi", "omp"];

// Shape check for config.json. Unknown keys and unrecognized enum-like values
// are warnings (the field is ignored, which is exactly what must not stay
// silent: `default.agents` or `sandbox_wirte_dirs` otherwise looks like a
// working config); a known key holding a value of the wrong type is an error,
// since acting on it would be wrong rather than merely ineffective.
export function validateOrchConfig(raw: unknown): { warnings: string[] } {
  const warnings: string[] = [];
  // Explicitly typed so TypeScript narrows after a bare `fail(...)` statement.
  const fail: (message: string) => never = (message) => {
    throw new Error(`config.json: ${message}`);
  };
  const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const unknownKeys = (obj: Record<string, unknown>, known: readonly string[], where: string): void => {
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) warnings.push(`unknown key ${where}${key} is ignored (known: ${known.join(", ")})`);
    }
  };
  if (!isObject(raw)) return fail("must be a JSON object");
  unknownKeys(raw, ORCH_CONFIG_KEYS, "");
  if (raw.version !== undefined && raw.version !== 1) fail("version must be 1");
  if (raw.workspaces !== undefined && !isObject(raw.workspaces)) fail("workspaces must be an object");
  if (raw.language !== undefined && raw.language !== "中文" && raw.language !== "english") {
    warnings.push(`language ${JSON.stringify(raw.language)} is not "中文" or "english"; english applies`);
  }
  if (raw.sandbox !== undefined && typeof raw.sandbox !== "boolean") {
    warnings.push(`sandbox ${JSON.stringify(raw.sandbox)} is not a boolean; the sandbox stays off`);
  }
  if (raw.sandbox_write_dirs !== undefined && (!Array.isArray(raw.sandbox_write_dirs) || raw.sandbox_write_dirs.some((d) => typeof d !== "string"))) {
    fail("sandbox_write_dirs must be an array of strings");
  }
  const defaults = raw.defaults;
  if (defaults === undefined) return { warnings };
  if (!isObject(defaults)) return fail("defaults must be an object");
  unknownKeys(defaults, ORCH_DEFAULTS_KEYS, "defaults.");

  if (defaults.agents !== undefined) {
    if (!isObject(defaults.agents)) fail("defaults.agents must be an object");
    for (const [role, entry] of Object.entries(defaults.agents)) {
      const where = `defaults.agents.${role}`;
      if (!RUN_ROLES.includes(role)) warnings.push(`unknown role ${where} is ignored (roles: ${RUN_ROLES.join(", ")})`);
      if (typeof entry === "string") {
        if (!AGENT_NAMES.includes(entry)) fail(`${where} names unknown agent ${JSON.stringify(entry)} (agents: ${AGENT_NAMES.join(", ")})`);
        continue;
      }
      if (!isObject(entry)) return fail(`${where} must be an agent name or an object`);
      unknownKeys(entry, ROLE_DEFAULT_KEYS, `${where}.`);
      if (entry.agent !== undefined && (typeof entry.agent !== "string" || !AGENT_NAMES.includes(entry.agent))) {
        fail(`${where}.agent names unknown agent ${JSON.stringify(entry.agent)} (agents: ${AGENT_NAMES.join(", ")})`);
      }
      if (entry.model !== undefined && (typeof entry.model !== "string" || entry.model === "")) fail(`${where}.model must be a non-empty string`);
      if (entry.timeout_sec !== undefined && (typeof entry.timeout_sec !== "number" || !Number.isFinite(entry.timeout_sec) || entry.timeout_sec <= 0)) {
        fail(`${where}.timeout_sec must be a positive number`);
      }
    }
  }

  if (defaults.models !== undefined) {
    if (!isObject(defaults.models)) fail("defaults.models must be an object keyed by agent");
    for (const [agent, model] of Object.entries(defaults.models)) {
      if (!AGENT_NAMES.includes(agent)) warnings.push(`unknown agent defaults.models.${agent} is ignored (agents: ${AGENT_NAMES.join(", ")})`);
      if (typeof model !== "string" || model === "") fail(`defaults.models.${agent} must be a non-empty string`);
    }
  }

  if (defaults.fanout !== undefined) {
    if (!isObject(defaults.fanout)) fail("defaults.fanout must be an object");
    unknownKeys(defaults.fanout, FANOUT_KEYS, "defaults.fanout.");
    for (const [command, ids] of Object.entries(defaults.fanout)) {
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || id === "")) {
        fail(`defaults.fanout.${command} must be a non-empty array of mail-agent ids`);
      }
    }
  }
  return { warnings };
}

// Each distinct warning is printed once per process: readOrchConfig is called
// from many commands and repeatedly inside one, and a typo must be visible
// without flooding stderr.
const warnedConfigIssues = new Set<string>();

export function readOrchConfig(): OrchConfig {
  const raw = readJsonFile<unknown>(orchConfigPath(), { version: 1, workspaces: {} });
  const { warnings } = validateOrchConfig(raw);
  for (const warning of warnings) {
    if (warnedConfigIssues.has(warning)) continue;
    warnedConfigIssues.add(warning);
    process.stderr.write(`[orch] config.json: ${warning}\n`);
  }
  const cfg = raw as OrchConfig;
  return { ...cfg, version: 1, workspaces: cfg.workspaces ?? {} };
}

export type OrchLanguage = "中文" | "english";

// Lenient on purpose: only the exact string 中文 flips the language; a missing
// field, "english", or a typo all fall back to english rather than failing a
// command over config spelling.
export function orchLanguage(): OrchLanguage {
  return readOrchConfig().language === "中文" ? "中文" : "english";
}

// Snapshotted into the spec at run-create time (like language): the driver must
// not depend on live global config, and the spec stays auditable.
export function orchSandbox(): boolean {
  return readOrchConfig().sandbox === true;
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
  // Spread first: workspace registration must not drop defaults/language.
  return { ...cfg, version: 1, workspaces };
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
