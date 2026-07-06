import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import type { MailControlConfig } from "./config.ts";
import {
  mailControlConfigPath,
  readMailAgentsConfig,
  readOrchConfig,
  resolveMailPassword,
  upsertMailAgent,
  validateMailControlConfig,
  writeMailAgentsConfig,
  writeMailControlConfig,
  type OrchWorkspace,
} from "./config.ts";
import { MaildirBus, type BusTaskEvent } from "./bus.ts";
import { sha256 } from "./hash.ts";
import { appendJsonLine, readJsonFile, writeJsonAtomic, writeJsonExclusive, writeTextAtomic } from "./json.ts";
import { acquirePidfileLock, acquirePidfileLockWait, LockHeldError } from "./locks.ts";
import { defaultMailAgents, type MailCliContext } from "./mail-cli.ts";
import { deliverLocalMail, ensureMailDirs, mailThreadDir } from "./mail.ts";
import {
  decodeHeader,
  extractMailText,
  headerValues,
  parseAddress,
  parseAuthenticationResults,
  parseReferences,
  type AuthenticationResultsCheck,
  type ParsedAddress,
} from "./mime.ts";
import { ImapClient, filterNewUids, planUidScan } from "./imap.ts";
import { isTerminal, looksStale, collectMrRuns } from "./overview.ts";
import { getRepoIdentity, mailControlStateDir, mrStateDir, statePathSegment } from "./paths.ts";
import { assertNoPrivateLeak } from "./leak.ts";
import { buildReplyMessage, submitSmtpMessage } from "./smtp.ts";
import type { RunStatus } from "./types.ts";
import { assertKnownFlags, CliError, collectFlags, flagBool, flagNumber, flagString, type ParsedArgs } from "./cli.ts";

export interface MailCursor {
  uidvalidity: number | null;
  last_uid: number | null;
  last_poll_at: string | null;
  consecutive_failures?: number;
  last_error?: string | null;
  last_alert_at?: string | null;
  alerted_streak?: number | null;
}

export interface MailMessageRef {
  uid: number;
  mailbox?: string;
  message_id?: string;
  uidvalidity?: number | null;
}

export interface MailTransport {
  listNew(sinceDays: number, cursor: MailCursor | null): Promise<MailMessageRef[]>;
  fetchRaw(ref: MailMessageRef): Promise<string>;
  markProcessed(ref: MailMessageRef): Promise<void>;
  sendReply(rfc822: string): Promise<void>;
  idleOnce?(timeoutMs: number, cursor: MailCursor | null): Promise<void>;
}

export interface MailctlContext {
  config: MailControlConfig;
  transport: MailTransport;
  now(): number;
  orch: MailCliContext;
}

export type GateRejectReason = "sender" | "self" | "auto" | "sentinel" | "auth" | "token" | "html_only" | "parse_error";

export interface GateResult {
  accepted: boolean;
  rejectReason?: GateRejectReason;
  from: string | null;
  bodyText: string;
  htmlOnly: boolean;
  auth?: AuthenticationResultsCheck;
  messageId: string;
}

export interface KnownMailThread {
  orch_thread?: string;
  thread?: string;
  threadId?: string;
  message_ids: string[];
}

export interface MergeThreadResult {
  thread: string;
  threadId: string;
  isNew: boolean;
  messageId: string;
  rootMessageId: string;
  references: string[];
  matchedMessageId?: string;
}

export interface BuildControllerTaskInput {
  thread: string;
  workspace: string;
  triggerReason: string;
  unackedMailText: string;
  notesTail?: string;
  sentReportSummary?: string;
}

export interface PollResult {
  skipped: boolean;
  listed: number;
  fetched: number;
  accepted: number;
  rejected: number;
  duplicate: number;
  errors: number;
  cursor: MailCursor | null;
  reconciled?: ReconcileResult;
}

export interface ReconcileResult {
  skipped: boolean;
  active_threads: number;
  spawned: Array<{ thread: string; gen: number; run_id: string; trigger_fp: string }>;
  live: Array<{ thread: string; run_id: string; state: string }>;
  throttled: Array<{ thread: string; trigger_fp: string }>;
  closed: Array<{ thread: string; run_id: string }>;
  retried_reports: number;
  errors: Array<{ thread?: string; error: string }>;
}

export interface ReplyResult {
  dryRun: boolean;
  duplicate: boolean;
  sent: boolean;
  pending: boolean;
  rawMessage?: string;
  messageId?: string;
  sentPath?: string;
  pendingPath?: string;
  nextAttemptAt?: string;
}

export type PollFault = "publish-before-marker" | "attention-before-marker" | "marker-before-STORE" | "before-cursor";

export interface PollOptions {
  fault?: PollFault;
  reconcile?: boolean;
}

export interface ReplyOptions {
  thread: string;
  reportKey: string;
  body: string;
  dryRun?: boolean;
}

export interface WatchOptions {
  iterations?: number;
  signal?: AbortSignal;
}

export interface InitResult {
  config_path: string;
  trusted_authserv_id: string;
  agents_seeded: string[];
}

export interface StatusCursorSummary {
  last_uid: number | null;
  consecutive_failures: number;
  last_error: string | null;
}

export interface StatusControllerGeneration {
  gen: number;
  run_id: string;
  state: string | null;
  spawned_at: string;
  trigger_reasons: string[];
}

export interface StatusThreadSummary {
  thread: string;
  status: "active" | "settled";
  unacked_attention: number;
  pending_outbound: number;
  dropped_outbound: number;
  controller: {
    current_run_id: string | null;
    final_report_sent: boolean;
    generations: StatusControllerGeneration[];
  };
}

export interface StatusSummary {
  cursor: StatusCursorSummary;
  active_threads: number;
  threads: StatusThreadSummary[];
  outbound: {
    pending: number;
    dropped: number;
  };
}

export interface AckResult {
  thread: string;
  attention: string;
  acknowledged: boolean;
  done: boolean;
}

export interface GuidanceInstruction {
  attention: string;
  from: string;
  subject: string;
  body: string;
  parent_event_id: string | null;
  task_event_id: string;
  created_at: string;
}

export interface GuidanceResult {
  thread: string;
  instructions: GuidanceInstruction[];
}

interface ControllerGeneration {
  gen: number;
  idempotency_key: string;
  trigger_fp: string;
  trigger_reasons: string[];
  task_path: string;
  run_id: string;
  run_dir: string | null;
  status_path: string | null;
  spawned_at: string;
  payload: unknown;
}

interface MailctlThreadState {
  schema: "orch.mailctl/thread/v1";
  thread: string;
  threadId: string;
  thread_sha: string;
  status: "active" | "settled";
  workspace_id: string;
  workspace_path: string;
  repo_key: string;
  thread_dir: string;
  root_message_id: string;
  message_ids: string[];
  references: string[];
  subject: string;
  reply_to: string | null;
  last_instruction_event_id: string | null;
  decision?: unknown;
  controller: {
    current_run_id: string | null;
    generations: ControllerGeneration[];
    last_trigger_fp: string | null;
    throttled_at?: string;
    throttled_reason?: string;
    final_report_sent?: boolean;
  };
  created_at: string;
  updated_at: string;
}

interface MessageMarker {
  schema: "orch.mailctl/message-marker/v1";
  msg_sha: string;
  message_id: string;
  raw_sha: string;
  uid: number;
  status: "accepted" | `rejected_${GateRejectReason}` | "rejected_conflict" | "rejected_error" | "duplicate" | "self";
  thread: string | null;
  task_event_id?: string | null;
  attention_path?: string | null;
  flag_synced: boolean;
  thread_synced: boolean;
  created_at: string;
  updated_at: string;
}

interface AttentionRecord {
  schema: "orch.mailctl/attention/v1";
  thread: string;
  msg_sha: string;
  uid: number;
  message_id: string;
  from: string;
  subject: string;
  body: string;
  parent_event_id: string | null;
  task_event_id: string;
  workspace_id: string;
  workspace_path: string;
  repo_key: string;
  created_at: string;
}

interface PendingReplyRecord {
  schema: "orch.mailctl/outbox-email/v1";
  report_key: string;
  thread: string;
  body: string;
  raw: string;
  message_id: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  next_attempt_at: string;
  last_error: string | null;
  dropped_at?: string;
}

export function sha12(s: string | Uint8Array): string {
  return sha256(s).slice(0, 12);
}

export function ingestLockPath(): string {
  return `${mailControlStateDir()}/ingest.lock`;
}

export function watchLockPath(): string {
  return `${mailControlStateDir()}/watch.lock`;
}

export function cursorPath(): string {
  return `${mailControlStateDir()}/cursor.json`;
}

export function messageMarkerPath(msgSha: string): string {
  return `${mailControlStateDir()}/messages/${msgSha}.json`;
}

export function threadMapPath(threadSha: string): string {
  return `${mailControlStateDir()}/threads/${threadSha}.json`;
}

export function taskFilePath(thread: string, utc: string): string {
  return `${mailControlStateDir()}/tasks/${thread}-${utc}.md`;
}

export function auditPath(): string {
  return `${mailControlStateDir()}/audit.jsonl`;
}

export function controllerSpawnLockPath(): string {
  return `${mailControlStateDir()}/controller/spawn.lock`;
}

export function attentionPath(msgSha: string): string {
  return `${mailControlStateDir()}/controller/attention/${msgSha}.json`;
}

export function attentionDonePath(msgSha: string): string {
  return `${mailControlStateDir()}/controller/attention/done/${msgSha}.json`;
}

export function outboxEmailPendingDir(): string {
  return `${mailControlStateDir()}/outbox-email/pending`;
}

export function outboxEmailSentDir(): string {
  return `${mailControlStateDir()}/outbox-email/sent`;
}

export function outboxEmailDroppedDir(): string {
  return `${mailControlStateDir()}/outbox-email/dropped`;
}

export function mailctlThreadStatePath(thread: string): string {
  return threadMapPath(sha12(thread));
}

export function mailctlMessageMarkerKey(raw: string): string {
  return messageIdentity(raw).key;
}

function rawHeaderBlock(raw: string): string {
  const match = /\r?\n\r?\n/.exec(raw);
  return match ? raw.slice(0, match.index) : raw;
}

function normalizeMessageIdStrict(id: string | null | undefined): string | null {
  if (!id) return null;
  const decoded = decodeHeader(id).trim();
  const angle = decoded.match(/<([^<>\s]+@[^<>\s]+)>/);
  const candidate = angle?.[1] ?? decoded.replace(/^<|>$/g, "");
  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1 || /\s|[<>]/.test(candidate)) return null;
  const local = candidate.slice(0, at);
  const domain = candidate.slice(at + 1).toLowerCase();
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return null;
  return `<${local}@${domain}>`;
}

export function normalizeMessageId(id: string | null | undefined, rawHeaderForFallback = ""): string {
  return normalizeMessageIdStrict(id) ?? sha12(rawHeaderForFallback);
}

function firstMessageId(raw: string): string | null {
  return headerValues(raw, "Message-ID")[0] ?? null;
}

function messageIdentity(raw: string): { messageId: string; key: string; fallback: boolean } {
  const rawHeader = rawHeaderBlock(raw);
  const normalized = normalizeMessageIdStrict(firstMessageId(raw));
  if (normalized) return { messageId: normalized, key: sha12(normalized), fallback: false };
  const fallback = sha12(rawHeader);
  return { messageId: fallback, key: fallback, fallback: true };
}

function normalizedBareAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  return parseAddress(value)[0]?.address.toLowerCase() ?? null;
}

function decodedSubject(raw: string): string {
  return headerValues(raw, "Subject").map(decodeHeader).join(" ");
}

function isAutoPrecedence(value: string): boolean {
  const normalized = decodeHeader(value).trim().toLowerCase().split(/\s+/)[0] ?? "";
  return normalized === "auto" || normalized === "bulk" || normalized === "list";
}

function isSelfGeneratedMessageId(raw: string): boolean {
  const normalized = normalizeMessageIdStrict(firstMessageId(raw));
  if (!normalized) return false;
  const body = normalized.slice(1, -1);
  const at = body.lastIndexOf("@");
  return at > 0 && body.slice(0, at).toLowerCase().startsWith("orch-");
}

function firstBodyLine(text: string): string {
  return text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
}

function singleFromMailbox(raw: string): ParsedAddress | null {
  const fromHeaders = headerValues(raw, "From");
  if (fromHeaders.length !== 1) return null;
  const mailboxes = parseAddress(fromHeaders[0]!);
  return mailboxes.length === 1 ? mailboxes[0]! : null;
}

function parseErrorGateResult(raw: string): GateResult {
  let messageId = "";
  try {
    messageId = sha12(rawHeaderBlock(raw));
  } catch {
    messageId = sha12("");
  }
  return { accepted: false, rejectReason: "parse_error", from: null, bodyText: "", htmlOnly: false, messageId };
}

export function evaluateGate(raw: string, cfg: MailControlConfig, selfAddress: string): GateResult {
  try {
    const fromMailbox = singleFromMailbox(raw);
    const from = fromMailbox?.address.toLowerCase() ?? null;
    const self = normalizedBareAddress(selfAddress) ?? normalizedBareAddress(cfg.account.user);
    const extracted = extractMailText(raw);
    const base = {
      from,
      bodyText: extracted.text,
      htmlOnly: extracted.htmlOnly,
      messageId: messageIdentity(raw).messageId,
    };

    if (!from || !cfg.allowed_senders.map((sender) => sender.toLowerCase()).includes(from)) {
      return { ...base, accepted: false, rejectReason: "sender" };
    }
    if ((self && from === self) || isSelfGeneratedMessageId(raw)) {
      return { ...base, accepted: false, rejectReason: "self" };
    }
    if (headerValues(raw, "Auto-Submitted").length > 0 || headerValues(raw, "Precedence").some(isAutoPrecedence)) {
      return { ...base, accepted: false, rejectReason: "auto" };
    }
    if (firstBodyLine(extracted.text).trimStart().startsWith("[orch:")) {
      return { ...base, accepted: false, rejectReason: "sentinel" };
    }

    let auth: AuthenticationResultsCheck | undefined;
    if (cfg.require_auth_results) {
      auth = parseAuthenticationResults(raw, cfg.trusted_authserv_id, fromMailbox);
      if (!auth.pass) return { ...base, accepted: false, rejectReason: "auth", auth };
    }

    if (cfg.subject_token !== null && !decodedSubject(raw).includes(cfg.subject_token)) {
      return { ...base, accepted: false, rejectReason: "token", auth };
    }
    if (extracted.htmlOnly) return { ...base, accepted: false, rejectReason: "html_only", auth };
    if (extracted.text.trim() === "") return { ...base, accepted: false, auth };
    return { ...base, accepted: true, auth };
  } catch {
    return parseErrorGateResult(raw);
  }
}

export function resolveWorkspace(raw: string, cfg: MailControlConfig): string {
  const subjectWorkspace = decodedSubject(raw).match(/\[ws:([A-Za-z0-9._-]+)\]/i)?.[1];
  if (subjectWorkspace) return subjectWorkspace;

  const bodyWorkspace = extractMailText(raw)
    .text.split(/\r?\n/)
    .map((line) => line.match(/^\s*Workspace\s*:\s*([A-Za-z0-9._-]+)\s*$/i)?.[1])
    .find((workspace): workspace is string => Boolean(workspace));
  return bodyWorkspace ?? cfg.workspace;
}

function knownThreadId(thread: KnownMailThread): string | null {
  return thread.orch_thread ?? thread.thread ?? thread.threadId ?? null;
}

export function mergeThread(raw: string, knownThreads: KnownMailThread[]): MergeThreadResult {
  const references = parseReferences(raw).all;
  for (const reference of references) {
    for (const thread of knownThreads) {
      if (!thread.message_ids.includes(reference)) continue;
      const threadId = knownThreadId(thread);
      if (!threadId) continue;
      const messageId = messageIdentity(raw).messageId;
      return {
        thread: threadId,
        threadId,
        isNew: false,
        messageId,
        rootMessageId: thread.message_ids[0] ?? reference,
        references,
        matchedMessageId: reference,
      };
    }
  }

  const current = messageIdentity(raw);
  const threadId = `em-${current.key}`;
  return {
    thread: threadId,
    threadId,
    isNew: true,
    messageId: current.messageId,
    rootMessageId: current.messageId,
    references,
  };
}

function mailThreadArg(thread: string): string {
  return thread.startsWith("em-") ? thread : `em-${thread}`;
}

function sanitizeControllerText(text: string): string {
  return text
    .replace(/\/Users\/[^\s'"`)]+/g, "[local-path]")
    .replace(/\/home\/[^\s'"`)]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\Users\\[^\s'"`)]+/g, "[local-path]")
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*['"]?)[A-Za-z0-9_\-]{16,}/gi, "$1$2***REDACTED***");
}

export function buildControllerTask(input: BuildControllerTaskInput): string {
  const thread = mailThreadArg(input.thread);
  const notesTail = sanitizeControllerText(input.notesTail?.trim() || "(none)");
  const sentReportSummary = sanitizeControllerText(input.sentReportSummary?.trim() || "(none)");
  const unackedMailText = sanitizeControllerText(input.unackedMailText.trim());

  return [
    "# Mail Controller Task",
    "",
    "## Execution Mode",
    "- You are running HEADLESS and NON-INTERACTIVE. No human will approve anything, and there is no plan-mode approval step.",
    "- Do NOT enter plan mode. Do NOT write a plan and wait. Do NOT call ExitPlanMode.",
    "- Execute your batch of `orch ...` commands directly and immediately, then output the orch.result/controller/v1 JSON.",
    "- Your only tools are Bash for `orch ...` commands plus read-only Read/Grep/Glob/LS.",
    "- You have no Edit/Write. If a step would need a tool you do not have, SKIP it; do not stall or ask.",
    "",
    "## Context",
    `- Thread: ${thread}`,
    `- Workspace: ${input.workspace}`,
    `- Trigger: ${input.triggerReason}`,
    "",
    "## Unacked Mail",
    unackedMailText || "(empty)",
    "",
    "## Previous Controller Summary",
    notesTail,
    "",
    "## Sent Report Summary",
    sentReportSummary,
    "",
    "## Rules",
    "- Finish one batch of work, then exit. Do not run a long-lived watch loop; at most one bounded <=120s wait is allowed.",
    "- You have no Edit/Write; dispatch a worker to change code.",
    `- Orchestrate with orch fanout/cross-review --thread ${thread} --task <file>; choose the narrow worker/reviewer set needed for this batch.`,
    "- Before dispatching with orch fanout/cross-review, check the workspace repo for docs/adr/ and docs/specs/; when a decision or spec is relevant to the batch, inline the relevant excerpts (not just file paths) into the --task file so each task stays self-contained for replay/audit.",
    "- Classify each inbound instruction before acting: ready-for-agent means specific enough to dispatch workers; needs-info means ambiguous, so send ONE clarification reply via orch mailctl reply with numbered questions, each with your recommended answer, noting the recommendations apply if no reply arrives, then ack and exit; ready-for-human means beyond worker capability, so report it as a blocker. Never idle waiting, never guess, and do not cap the number of clarification questions.",
    "- For bug reports, confirm the claim with a read-only orch investigate before dispatching an implementer. If reproduction fails or evidence is insufficient, report that instead of fixing an unverified claim.",
    "- When authoring a debugger-role task, require the worker to build a red-capable reproduction command and paste its run output as evidence in the result tests[] field BEFORE attempting a fix, list 3-5 ranked falsifiable hypotheses first, and tag temporary instrumentation with a unique [DEBUG-xxxx] prefix then grep it away before finishing.",
    "- Decide completed worker runs with orch decision accept|rework after reading their results.",
    `- After consuming an instruction, acknowledge it with orch mailctl ack --thread ${thread} --attention <id>.`,
    "- Report only for milestones, blockers, and final results via orch mailctl reply --report-key <progress:<run_id>|settled:<gen>|reply:<msg_sha>>.",
    "- Each meaningful state change gets at most one report. Reply bodies must not contain local paths or secrets.",
    "- Put any durable cross-batch handoff notes into the summary field of your orch.result/controller/v1 output (you cannot write files).",
    "- Final output must be orch.result/controller/v1 JSON.",
    "",
  ].join("\n");
}

const ROUTER_AGENT = {
  id: "orch-router",
  address: "orch-router@local.orch",
  provider: "router",
  roles: ["router"],
  capabilities: ["decompose", "route", "replan"],
  work_mode: "route",
  provider_session_mode: "ephemeral" as const,
};

class MailctlInjectedFaultError extends Error {
  constructor(public readonly point: PollFault) {
    super(`injected mailctl poll fault: ${point}`);
  }
}

function throwFault(opts: PollOptions, point: PollFault): void {
  if (opts.fault === point) throw new MailctlInjectedFaultError(point);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function nowIso(ctx: MailctlContext): string {
  return new Date(ctx.now()).toISOString();
}

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureMailctlStateDirs(): void {
  for (const dir of [
    `${mailControlStateDir()}/messages`,
    `${mailControlStateDir()}/threads`,
    `${mailControlStateDir()}/tasks`,
    `${mailControlStateDir()}/controller/attention/done`,
    outboxEmailPendingDir(),
    outboxEmailSentDir(),
    outboxEmailDroppedDir(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function appendAudit(type: string, record: Record<string, unknown>): void {
  appendJsonLine(auditPath(), { schema: "orch.mailctl/audit/v1", type, ...record });
}

function defaultTrustedAuthservId(imapHost: string): string {
  const host = imapHost.trim().toLowerCase().replace(/\.$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length > 2 && /^(?:imap\d*|mail|mx\d*|smtp|pop3?)$/.test(labels[0]!)) {
    return labels.slice(1).join(".");
  }
  return host;
}

function parsePasswordCmd(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CliError(`--password-cmd must be a JSON argv array: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new CliError("--password-cmd must be a non-empty JSON string argv array");
  }
  return parsed;
}

function normalizeAllowedSender(value: string): string {
  const parsed = parseAddress(value);
  if (parsed.length !== 1) throw new CliError(`--allow must be a single bare mailbox or address: ${value}`);
  const address = parsed[0]!.address.toLowerCase();
  if (!address || /[<>\s]/.test(address) || !address.includes("@")) {
    throw new CliError(`--allow must be a single bare mailbox or address: ${value}`);
  }
  return address;
}

function optionalPositiveNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagNumber(args, name);
  if (value !== undefined && value <= 0) throw new CliError(`--${name} must be positive`);
  return value;
}

function optionalTcpPort(args: ParsedArgs, name: string, fallback: number): number {
  const value = flagNumber(args, name) ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new CliError(`--${name} must be an integer TCP port in range 1..65535`);
  return value;
}

function seedDefaultMailAgents(now: string): string[] {
  let cfg = readMailAgentsConfig();
  const seeded: string[] = [];
  for (const agent of defaultMailAgents(now)) {
    if (cfg.agents[agent.id]) continue;
    cfg = upsertMailAgent(cfg, agent);
    seeded.push(agent.id);
  }
  if (seeded.length > 0) writeMailAgentsConfig(cfg);
  return seeded;
}

export function mailctlInit(args: ParsedArgs): InitResult {
  assertKnownFlags(args, "mailctl init", [
    "user",
    "imap-host",
    "imap-port",
    "smtp-host",
    "smtp-port",
    "smtp-mode",
    "smtp-from",
    "allow",
    "workspace",
    "password-cmd",
    "trusted-authserv-id",
    "subject-token",
    "no-require-auth-results",
    "reconcile-interval-sec",
    "controller-timeout-sec",
    "max-spawns-per-hour",
    "reports-policy",
    "max-reports-per-hour",
    "max-body-bytes",
    "json",
  ]);
  const user = flagString(args, "user").trim();
  const imapHost = flagString(args, "imap-host").trim().toLowerCase();
  const smtpHost = flagString(args, "smtp-host").trim().toLowerCase();
  const allow = Array.from(new Set(collectFlags(args, "allow").map(normalizeAllowedSender)));
  if (allow.length === 0) throw new CliError("mailctl init requires at least one --allow <sender>");
  const workspace = flagString(args, "workspace").trim();
  const smtpMode = flagString(args, "smtp-mode", "implicit");
  if (smtpMode !== "implicit" && smtpMode !== "starttls") throw new CliError("--smtp-mode must be implicit or starttls");
  const reportsPolicy = flagString(args, "reports-policy", "auto");
  if (reportsPolicy !== "auto" && reportsPolicy !== "always" && reportsPolicy !== "never") {
    throw new CliError("--reports-policy must be auto, always, or never");
  }
  const subjectToken = args.flags.has("subject-token") ? flagString(args, "subject-token") : null;
  if (subjectToken !== null && subjectToken.length === 0) throw new CliError("--subject-token must not be empty");

  const passwordCmd = args.flags.has("password-cmd") ? parsePasswordCmd(flagString(args, "password-cmd")) : undefined;
  const now = new Date().toISOString();
  const cfg: MailControlConfig = {
    version: 1,
    account: passwordCmd ? { user, password_cmd: passwordCmd } : { user },
    imap: { host: imapHost, port: optionalTcpPort(args, "imap-port", 993) },
    smtp: {
      host: smtpHost,
      port: optionalTcpPort(args, "smtp-port", smtpMode === "starttls" ? 587 : 465),
      mode: smtpMode,
      ...(args.flags.has("smtp-from") ? { from: flagString(args, "smtp-from").trim() } : {}),
    },
    allowed_senders: allow,
    trusted_authserv_id: args.flags.has("trusted-authserv-id")
      ? flagString(args, "trusted-authserv-id").trim().toLowerCase()
      : defaultTrustedAuthservId(imapHost),
    workspace,
    reconcile_interval_sec: optionalPositiveNumber(args, "reconcile-interval-sec") ?? 60,
    subject_token: subjectToken,
    require_auth_results: !flagBool(args, "no-require-auth-results"),
    controller: {
      agent: "claude",
      model: null,
      timeout_sec: optionalPositiveNumber(args, "controller-timeout-sec") ?? 1800,
      max_spawns_per_hour: optionalPositiveNumber(args, "max-spawns-per-hour") ?? 6,
    },
    reports: {
      policy: reportsPolicy,
      max_per_hour: optionalPositiveNumber(args, "max-reports-per-hour") ?? 4,
      max_body_bytes: optionalPositiveNumber(args, "max-body-bytes") ?? 16384,
    },
  };
  try {
    validateMailControlConfig(cfg);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
  writeMailControlConfig(cfg);
  const agentsSeeded = seedDefaultMailAgents(now);
  return {
    config_path: mailControlConfigPath(),
    trusted_authserv_id: cfg.trusted_authserv_id,
    agents_seeded: agentsSeeded,
  };
}

function readCursor(): MailCursor | null {
  return readJsonFile<MailCursor | null>(cursorPath(), null);
}

function writeCursor(cursor: MailCursor): void {
  writeJsonAtomic(cursorPath(), cursor);
}

function patchCursor(ctx: MailctlContext, patch: Partial<MailCursor> & Record<string, unknown>): void {
  writeJsonAtomic(cursorPath(), { ...(readCursor() ?? { uidvalidity: null, last_uid: null, last_poll_at: null }), ...patch, updated_at: nowIso(ctx) });
}

function readMarker(msgSha: string): MessageMarker | null {
  return readJsonFile<MessageMarker | null>(messageMarkerPath(msgSha), null);
}

function writeMarkerExclusive(marker: MessageMarker): boolean {
  try {
    writeJsonExclusive(messageMarkerPath(marker.msg_sha), marker);
    return true;
  } catch (error) {
    if (isEexist(error)) return false;
    throw error;
  }
}

function updateMarker(msgSha: string, update: Partial<MessageMarker>, ts: string): void {
  const marker = readMarker(msgSha);
  if (!marker) return;
  writeJsonAtomic(messageMarkerPath(msgSha), { ...marker, ...update, updated_at: ts });
}

function conflictMarkerKey(msgSha: string, raw: string): string {
  return `${msgSha}-conflict-${sha12(raw)}`;
}

function safeJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

const POLL_FAILURE_ALERT_THRESHOLD = 3;
const POLL_FAILURE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const POLL_FAILURE_ALERT_THREAD = "mailctl-alert";

function mailHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function normalizeMailText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

function outboxEmailRecordCount(): number {
  return safeJsonFiles(outboxEmailPendingDir()).length + safeJsonFiles(outboxEmailSentDir()).length + safeJsonFiles(outboxEmailDroppedDir()).length;
}

function shouldQueuePollFailureAlert(ctx: MailctlContext, cursor: MailCursor | null): boolean {
  const failures = safeNumber(cursor?.consecutive_failures) ?? 0;
  if (failures < POLL_FAILURE_ALERT_THRESHOLD) return false;
  if ((safeNumber(cursor?.alerted_streak) ?? 0) > 0) return false;
  if (typeof cursor?.last_alert_at === "string") {
    const lastAlertAt = Date.parse(cursor.last_alert_at);
    if (Number.isFinite(lastAlertAt) && ctx.now() - lastAlertAt < POLL_FAILURE_ALERT_COOLDOWN_MS) return false;
  }
  return true;
}

function buildPollFailureAlert(ctx: MailctlContext, cursor: MailCursor): PendingReplyRecord {
  const ts = nowIso(ctx);
  const failures = safeNumber(cursor.consecutive_failures) ?? 0;
  const from = ctx.config.account.user;
  const to = ctx.config.allowed_senders[0];
  if (!to) throw new Error("mailctl poll alert has no configured recipient");
  const reportKey = `alert:mailctl-poll-failing:${ctx.now().toString(36)}:${outboxEmailRecordCount() + 1}`;
  const messageId = replyMessageId(ctx, POLL_FAILURE_ALERT_THREAD, reportKey);
  const body = [
    `consecutive_failures: ${failures}`,
    `last_error: ${cursor.last_error ? redactHumanText(cursor.last_error) : "none"}`,
    `last_poll_at: ${cursor.last_poll_at ?? "never"}`,
    "Alerts are delivered on the next successful SMTP connection, so this may describe a past outage.",
  ].join("\n");
  const raw = normalizeMailText(
    [
      `From: ${mailHeaderValue(from)}`,
      `To: ${mailHeaderValue(to)}`,
      "Subject: [orch-alert] mailctl poll failing",
      `Date: ${new Date(ctx.now()).toUTCString()}`,
      `Message-ID: ${messageId}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
      "",
    ].join("\r\n"),
  );
  return {
    schema: "orch.mailctl/outbox-email/v1",
    report_key: reportKey,
    thread: POLL_FAILURE_ALERT_THREAD,
    body,
    raw,
    message_id: messageId,
    attempts: 0,
    created_at: ts,
    updated_at: ts,
    next_attempt_at: ts,
    last_error: null,
  };
}

function queuePollFailureAlert(ctx: MailctlContext, cursor: MailCursor): void {
  if (!shouldQueuePollFailureAlert(ctx, cursor)) return;
  ensureMailctlStateDirs();
  const alert = buildPollFailureAlert(ctx, cursor);
  writeJsonExclusive(pendingReplyPath(alert.report_key), alert);
  const ts = nowIso(ctx);
  patchCursor(ctx, { last_alert_at: ts, alerted_streak: cursor.consecutive_failures ?? POLL_FAILURE_ALERT_THRESHOLD });
  appendAudit("alert_queued", { report_key: alert.report_key, message_id: alert.message_id, consecutive_failures: cursor.consecutive_failures ?? null, ts });
}

function recordPollFailureAlertError(ctx: MailctlContext, lastError: string, error: unknown): void {
  const alertError = redactHumanText(errorMessage(error));
  try {
    patchCursor(ctx, { last_error: `${lastError}; alert_queue_error: ${alertError}` });
  } catch {
    // Keep the original poll failure path unchanged even if the diagnostic write fails.
  }
  try {
    appendAudit("alert_queue_failed", { error: alertError, ts: nowIso(ctx) });
  } catch {
    // Best-effort audit only.
  }
}

export function recordMailctlPollFailure(ctx: MailctlContext, error: unknown): void {
  const lastError = redactHumanText(errorMessage(error));
  try {
    const cursor = readCursor();
    const consecutiveFailures = (safeNumber(cursor?.consecutive_failures) ?? 0) + 1;
    patchCursor(ctx, {
      consecutive_failures: consecutiveFailures,
      last_error: lastError,
    });
    try {
      queuePollFailureAlert(ctx, readCursor() ?? { uidvalidity: null, last_uid: null, last_poll_at: null, consecutive_failures: consecutiveFailures, last_error: lastError });
    } catch (alertError) {
      recordPollFailureAlertError(ctx, lastError, alertError);
    }
  } catch (recordError) {
    try {
      appendAudit("poll_failure_record_failed", { error: redactHumanText(errorMessage(recordError)), ts: nowIso(ctx) });
    } catch {
      // The caller must still see the original poll failure.
    }
  }
}

function listThreadStates(): MailctlThreadState[] {
  return safeJsonFiles(`${mailControlStateDir()}/threads`)
    .map((path) => readJsonFile<MailctlThreadState | null>(path, null))
    .filter((state): state is MailctlThreadState => state?.schema === "orch.mailctl/thread/v1" && typeof state.thread === "string");
}

function readThreadState(thread: string): MailctlThreadState | null {
  return readJsonFile<MailctlThreadState | null>(mailctlThreadStatePath(thread), null);
}

function writeThreadState(state: MailctlThreadState): void {
  writeJsonAtomic(mailctlThreadStatePath(state.thread), state);
}

function knownThreadsFromState(): KnownMailThread[] {
  return listThreadStates().map((thread) => ({
    orch_thread: thread.thread,
    thread: thread.thread,
    threadId: thread.threadId,
    message_ids: thread.message_ids,
  }));
}

function workspaceById(id: string): OrchWorkspace {
  const workspace = readOrchConfig().workspaces[id];
  if (!workspace) throw new Error(`mail control workspace not registered: ${id}`);
  return workspace;
}

function appendUnique(values: string[], next: string[]): string[] {
  const seen = new Set(values);
  const out = [...values];
  for (const value of next) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function createThreadState(args: {
  merge: MergeThreadResult;
  raw: string;
  gate: GateResult;
  workspace: OrchWorkspace;
  repoKey: string;
  threadDir: string;
  ts: string;
}): MailctlThreadState {
  return {
    schema: "orch.mailctl/thread/v1",
    thread: args.merge.thread,
    threadId: args.merge.threadId,
    thread_sha: sha12(args.merge.thread),
    status: "active",
    workspace_id: args.workspace.id,
    workspace_path: args.workspace.path,
    repo_key: args.repoKey,
    thread_dir: args.threadDir,
    root_message_id: args.merge.rootMessageId,
    message_ids: appendUnique([], [args.merge.rootMessageId, args.merge.messageId]),
    references: args.merge.references,
    subject: decodedSubject(args.raw),
    reply_to: args.gate.from,
    last_instruction_event_id: null,
    controller: {
      current_run_id: null,
      generations: [],
      last_trigger_fp: null,
    },
    created_at: args.ts,
    updated_at: args.ts,
  };
}

function loadOrCreateThreadState(args: {
  merge: MergeThreadResult;
  raw: string;
  gate: GateResult;
  workspace: OrchWorkspace;
  repoKey: string;
  threadDir: string;
  ts: string;
}): MailctlThreadState {
  const existing = readThreadState(args.merge.thread);
  if (existing) return existing;
  const created = createThreadState(args);
  try {
    writeJsonExclusive(mailctlThreadStatePath(created.thread), created);
    return created;
  } catch (error) {
    if (isEexist(error)) {
      const raced = readThreadState(created.thread);
      if (raced) return raced;
    }
    throw error;
  }
}

function finalizeThreadState(args: {
  state: MailctlThreadState;
  merge: MergeThreadResult;
  raw: string;
  gate: GateResult;
  workspace: OrchWorkspace;
  repoKey: string;
  threadDir: string;
  taskEventId: string;
  ts: string;
}): MailctlThreadState {
  return {
    ...args.state,
    status: "active",
    workspace_id: args.state.workspace_id || args.workspace.id,
    workspace_path: args.state.workspace_path || args.workspace.path,
    repo_key: args.state.repo_key || args.repoKey,
    thread_dir: args.state.thread_dir || args.threadDir,
    root_message_id: args.state.root_message_id || args.merge.rootMessageId,
    message_ids: appendUnique(args.state.message_ids, [args.merge.rootMessageId, args.merge.messageId]),
    references: appendUnique(args.state.references ?? [], args.merge.references),
    subject: args.state.subject || decodedSubject(args.raw),
    reply_to: args.gate.from ?? args.state.reply_to,
    last_instruction_event_id: args.taskEventId,
    updated_at: args.ts,
  };
}

function deliverAndImport(threadDir: string, thread: string, repoKey: string, bus: MaildirBus): void {
  for (const item of deliverLocalMail(threadDir)) {
    const imported = bus.importRaw(readFileSync(item.to, "utf8"), thread, repoKey);
    if (!imported.imported && imported.reason) {
      throw new Error(`mailctl fanout import failed (${imported.reason}): ${imported.quarantine_path ?? item.to}`);
    }
  }
}

async function acquireFanoutLock(threadDir: string, thread: string) {
  return acquirePidfileLockWait(`${threadDir}/fanout.lock`, 5_000, process.pid, `mailctl:${thread}`);
}

function writeAttention(record: AttentionRecord): string {
  const path = attentionPath(record.msg_sha);
  try {
    writeJsonExclusive(path, record);
  } catch (error) {
    if (!isEexist(error)) throw error;
  }
  return path;
}

function listAttentionForThread(thread: string): AttentionRecord[] {
  return safeJsonFiles(`${mailControlStateDir()}/controller/attention`)
    .map((path) => readJsonFile<AttentionRecord | null>(path, null))
    .filter((record): record is AttentionRecord => record?.schema === "orch.mailctl/attention/v1" && record.thread === thread)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.msg_sha.localeCompare(b.msg_sha));
}

function pendingReplyRecords(): PendingReplyRecord[] {
  return safeJsonFiles(outboxEmailPendingDir())
    .map((path) => readJsonFile<PendingReplyRecord | null>(path, null))
    .filter((record): record is PendingReplyRecord => record?.schema === "orch.mailctl/outbox-email/v1");
}

function droppedReplyRecords(): PendingReplyRecord[] {
  return safeJsonFiles(outboxEmailDroppedDir())
    .map((path) => readJsonFile<PendingReplyRecord | null>(path, null))
    .filter((record): record is PendingReplyRecord => record?.schema === "orch.mailctl/outbox-email/v1");
}

function sentFinalReportExists(thread: string): boolean {
  return safeJsonFiles(outboxEmailSentDir())
    .map((path) => readJsonFile<{ thread?: unknown; report_key?: unknown } | null>(path, null))
    .some((record) => record?.thread === thread && typeof record.report_key === "string" && record.report_key.startsWith("settled:"));
}

function settleThreadIfReady(ctx: MailctlContext, thread: string): boolean {
  const state = readThreadState(thread);
  if (!state) return false;
  if (listAttentionForThread(thread).length > 0) return false;
  if (!sentFinalReportExists(thread)) return false;
  if (state.status === "settled" && state.controller.final_report_sent === true) return false;
  writeThreadState({
    ...state,
    status: "settled",
    controller: {
      ...state.controller,
      final_report_sent: true,
    },
    updated_at: nowIso(ctx),
  });
  appendAudit("thread_settled", { thread, reason: "final_report_sent", ts: nowIso(ctx) });
  return true;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rawCursorSummary(): StatusCursorSummary {
  const raw = readJsonFile<Record<string, unknown> | null>(cursorPath(), null);
  return {
    last_uid: safeNumber(raw?.last_uid) ?? null,
    consecutive_failures: safeNumber(raw?.consecutive_failures) ?? 0,
    last_error: typeof raw?.last_error === "string" ? redactHumanText(raw.last_error) : null,
  };
}

function statusGeneration(gen: ControllerGeneration): StatusControllerGeneration {
  return {
    gen: gen.gen,
    run_id: gen.run_id,
    state: readGenerationStatus(gen)?.state ?? null,
    spawned_at: gen.spawned_at,
    trigger_reasons: [...gen.trigger_reasons],
  };
}

export function mailctlStatus(_ctx: MailctlContext, _opts: { json?: boolean } = {}): StatusSummary {
  ensureMailctlStateDirs();
  const pending = pendingReplyRecords();
  const dropped = droppedReplyRecords();
  const threads = listThreadStates()
    .sort((a, b) => a.thread.localeCompare(b.thread))
    .map((state): StatusThreadSummary => ({
      thread: state.thread,
      status: state.status,
      unacked_attention: listAttentionForThread(state.thread).length,
      pending_outbound: pending.filter((record) => record.thread === state.thread).length,
      dropped_outbound: dropped.filter((record) => record.thread === state.thread).length,
      controller: {
        current_run_id: state.controller.current_run_id,
        final_report_sent: state.controller.final_report_sent === true,
        generations: state.controller.generations.map(statusGeneration),
      },
    }));
  return {
    cursor: rawCursorSummary(),
    active_threads: threads.filter((thread) => thread.status === "active").length,
    threads,
    outbound: {
      pending: pending.length,
      dropped: dropped.length,
    },
  };
}

function redactHumanText(text: string): string {
  return sanitizeControllerText(text)
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s]+/gi, "$1$2***REDACTED***")
    .trim();
}

export function renderMailctlStatus(summary: StatusSummary): string {
  const lastError = summary.cursor.last_error ? redactHumanText(summary.cursor.last_error) : "none";
  const rows = [
    "mailctl status",
    `cursor: last_uid=${summary.cursor.last_uid ?? "none"} consecutive_failures=${summary.cursor.consecutive_failures} last_error=${lastError}`,
    `outbound: pending=${summary.outbound.pending} dropped=${summary.outbound.dropped}`,
    `threads: active=${summary.active_threads} total=${summary.threads.length}`,
  ];
  for (const thread of summary.threads) {
    rows.push(
      `  ${thread.thread} ${thread.status} attention=${thread.unacked_attention} generations=${thread.controller.generations.length} current=${thread.controller.current_run_id ?? "none"} final_report_sent=${thread.controller.final_report_sent} pending=${thread.pending_outbound} dropped=${thread.dropped_outbound}`,
    );
  }
  return `${rows.join("\n")}\n`;
}

function readAttentionRecord(path: string): AttentionRecord | null {
  return readJsonFile<AttentionRecord | null>(path, null);
}

function assertAttentionThread(record: AttentionRecord | null, thread: string, attention: string): AttentionRecord {
  if (!record || record.schema !== "orch.mailctl/attention/v1" || record.thread !== thread) {
    throw new Error(`mailctl attention id is unknown for ${thread}: ${attention}`);
  }
  return record;
}

function assertAttentionId(attention: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(attention)) {
    throw new Error("mailctl attention id must contain only letters, numbers, underscore, or dash");
  }
}

export function mailctlAck(ctx: MailctlContext, opts: { thread: string; attention: string }): AckResult {
  ensureMailctlStateDirs();
  assertAttentionId(opts.attention);
  const source = attentionPath(opts.attention);
  const done = attentionDonePath(opts.attention);
  if (existsSync(done) && !existsSync(source)) {
    assertAttentionThread(readAttentionRecord(done), opts.thread, opts.attention);
    settleThreadIfReady(ctx, opts.thread);
    return { thread: opts.thread, attention: opts.attention, acknowledged: false, done: true };
  }
  if (!existsSync(source)) {
    throw new Error(`mailctl attention id is unknown for ${opts.thread}: ${opts.attention}`);
  }
  assertAttentionThread(readAttentionRecord(source), opts.thread, opts.attention);
  mkdirSync(`${mailControlStateDir()}/controller/attention/done`, { recursive: true });
  renameSync(source, done);
  appendAudit("attention_acked", { thread: opts.thread, attention: opts.attention, ts: nowIso(ctx) });
  settleThreadIfReady(ctx, opts.thread);
  return { thread: opts.thread, attention: opts.attention, acknowledged: true, done: true };
}

export function mailctlGuidance(_ctx: MailctlContext, opts: { thread: string; json?: boolean }): GuidanceResult {
  ensureMailctlStateDirs();
  if (!readThreadState(opts.thread)) throw new Error(`mailctl thread not found: ${opts.thread}`);
  return {
    thread: opts.thread,
    instructions: listAttentionForThread(opts.thread).map((record) => ({
      attention: record.msg_sha,
      from: record.from,
      subject: redactHumanText(record.subject),
      body: redactHumanText(record.body),
      parent_event_id: record.parent_event_id,
      task_event_id: record.task_event_id,
      created_at: record.created_at,
    })),
  };
}

export function renderMailctlGuidance(guidance: GuidanceResult): string {
  if (guidance.instructions.length === 0) return `mailctl guidance ${guidance.thread}: no unacked instructions\n`;
  const rows = [`mailctl guidance ${guidance.thread}`];
  for (const item of guidance.instructions) {
    rows.push(`  ${item.attention} from=${item.from} subject=${redactHumanText(item.subject)}`);
    rows.push(redactHumanText(item.body).split(/\r?\n/).map((line) => `    ${line}`).join("\n"));
  }
  return `${rows.join("\n")}\n`;
}

function backfillAcceptedMarker(ctx: MailctlContext, marker: MessageMarker): void {
  if (marker.thread_synced || !marker.thread) return;
  const attention = readJsonFile<AttentionRecord | null>(marker.attention_path ?? attentionPath(marker.msg_sha), null);
  if (!attention) return;
  const state = readThreadState(attention.thread);
  if (!state) return;
  writeThreadState({
    ...state,
    status: "active",
    message_ids: appendUnique(state.message_ids, [attention.message_id]),
    reply_to: attention.from || state.reply_to,
    last_instruction_event_id: attention.task_event_id,
    updated_at: nowIso(ctx),
  });
  updateMarker(marker.msg_sha, { thread_synced: true, task_event_id: attention.task_event_id }, nowIso(ctx));
}

async function markProcessedBestEffort(ctx: MailctlContext, ref: MailMessageRef, msgSha: string): Promise<void> {
  try {
    await ctx.transport.markProcessed(ref);
    updateMarker(msgSha, { flag_synced: true }, nowIso(ctx));
  } catch (error) {
    appendAudit("mark_processed_failed", { msg_sha: msgSha, uid: ref.uid, error: errorMessage(error), ts: nowIso(ctx) });
  }
}

async function publishRouterTask(args: {
  ctx: MailctlContext;
  raw: string;
  ref: MailMessageRef;
  msgSha: string;
  gate: GateResult;
  merge: MergeThreadResult;
  state: MailctlThreadState;
  workspace: OrchWorkspace;
  repoKey: string;
  threadDir: string;
  opts: PollOptions;
}): Promise<{ taskEvent: BusTaskEvent; attentionPath: string }> {
  const taskText = args.gate.bodyText.trim();
  const taskSha = sha256(taskText);
  const parentEventId = args.state.last_instruction_event_id;
  const bus = new MaildirBus(args.threadDir, args.merge.thread, args.repoKey);
  ensureMailDirs(args.threadDir);
  const lock = await acquireFanoutLock(args.threadDir, args.merge.thread);
  let taskEvent: BusTaskEvent | null = null;
  try {
    deliverAndImport(args.threadDir, args.merge.thread, args.repoKey, bus);
    const fingerprint = {
      agent_id: ROUTER_AGENT.id,
      role: "router",
      task_sha: taskSha,
      parent_event_id: parentEventId,
      mr: args.merge.thread,
      workspace: { id: args.workspace.id, path: args.workspace.path },
    };
    const existing = bus.findTask(fingerprint);
    taskEvent = existing?.event ?? null;
    if (!taskEvent) {
      bus.publishTask({
        from: args.gate.from ?? args.ctx.config.account.user,
        taskText,
        role: "router",
        parentEventId,
        mr: args.merge.thread,
        workspace: { id: args.workspace.id, path: args.workspace.path },
        agent: ROUTER_AGENT,
      });
      deliverAndImport(args.threadDir, args.merge.thread, args.repoKey, bus);
      taskEvent = bus.findTask(fingerprint)?.event ?? null;
    }
    if (!taskEvent) throw new Error("mailctl router task was published but not importable");
  } finally {
    lock.release();
  }

  throwFault(args.opts, "publish-before-marker");

  const attention: AttentionRecord = {
    schema: "orch.mailctl/attention/v1",
    thread: args.merge.thread,
    msg_sha: args.msgSha,
    uid: args.ref.uid,
    message_id: args.merge.messageId,
    from: args.gate.from ?? "",
    subject: decodedSubject(args.raw),
    body: taskText,
    parent_event_id: parentEventId,
    task_event_id: taskEvent.event_id,
    workspace_id: args.workspace.id,
    workspace_path: args.workspace.path,
    repo_key: args.repoKey,
    created_at: nowIso(args.ctx),
  };
  return { taskEvent, attentionPath: writeAttention(attention) };
}

async function processAcceptedMessage(args: {
  ctx: MailctlContext;
  ref: MailMessageRef;
  raw: string;
  msgSha: string;
  gate: GateResult;
  opts: PollOptions;
}): Promise<void> {
  const workspaceId = resolveWorkspace(args.raw, args.ctx.config);
  const workspace = workspaceById(workspaceId);
  const repo = await getRepoIdentity(workspace.path);
  const merge = mergeThread(args.raw, knownThreadsFromState());
  const threadDir = mailThreadDir(repo.repo_key, merge.thread);
  const ts = nowIso(args.ctx);
  const state = loadOrCreateThreadState({
    merge,
    raw: args.raw,
    gate: args.gate,
    workspace,
    repoKey: repo.repo_key,
    threadDir,
    ts,
  });
  const published = await publishRouterTask({
    ctx: args.ctx,
    raw: args.raw,
    ref: args.ref,
    msgSha: args.msgSha,
    gate: args.gate,
    merge,
    state,
    workspace,
    repoKey: repo.repo_key,
    threadDir,
    opts: args.opts,
  });

  throwFault(args.opts, "attention-before-marker");

  const marker: MessageMarker = {
    schema: "orch.mailctl/message-marker/v1",
    msg_sha: args.msgSha,
    message_id: merge.messageId,
    raw_sha: sha256(args.raw),
    uid: args.ref.uid,
    status: "accepted",
    thread: merge.thread,
    task_event_id: published.taskEvent.event_id,
    attention_path: published.attentionPath,
    flag_synced: false,
    thread_synced: false,
    created_at: ts,
    updated_at: ts,
  };
  if (!writeMarkerExclusive(marker)) {
    const existing = readMarker(args.msgSha);
    if (existing) backfillAcceptedMarker(args.ctx, existing);
    return;
  }

  throwFault(args.opts, "marker-before-STORE");

  await markProcessedBestEffort(args.ctx, args.ref, args.msgSha);
  const finalState = finalizeThreadState({
    state,
    merge,
    raw: args.raw,
    gate: args.gate,
    workspace,
    repoKey: repo.repo_key,
    threadDir,
    taskEventId: published.taskEvent.event_id,
    ts: nowIso(args.ctx),
  });
  writeThreadState(finalState);
  updateMarker(args.msgSha, { thread_synced: true, task_event_id: published.taskEvent.event_id }, nowIso(args.ctx));
  appendAudit("accepted", {
    msg_sha: args.msgSha,
    uid: args.ref.uid,
    thread: merge.thread,
    task_event_id: published.taskEvent.event_id,
    ts: nowIso(args.ctx),
  });
}

async function processRejectedMessage(ctx: MailctlContext, ref: MailMessageRef, raw: string, msgSha: string, gate: GateResult): Promise<void> {
  const ts = nowIso(ctx);
  writeMarkerExclusive({
    schema: "orch.mailctl/message-marker/v1",
    msg_sha: msgSha,
    message_id: gate.messageId,
    raw_sha: sha256(raw),
    uid: ref.uid,
    status: `rejected_${gate.rejectReason ?? "parse_error"}`,
    thread: null,
    flag_synced: false,
    thread_synced: true,
    created_at: ts,
    updated_at: ts,
  });
  appendAudit("rejected", { msg_sha: msgSha, uid: ref.uid, reason: gate.rejectReason ?? "parse_error", from: gate.from, ts });
  await markProcessedBestEffort(ctx, ref, msgSha);
}

async function processConflictMessage(ctx: MailctlContext, ref: MailMessageRef, raw: string, msgSha: string, marker: MessageMarker): Promise<void> {
  const ts = nowIso(ctx);
  const rawSha = sha256(raw);
  const conflictMsgSha = conflictMarkerKey(msgSha, raw);
  writeMarkerExclusive({
    schema: "orch.mailctl/message-marker/v1",
    msg_sha: conflictMsgSha,
    message_id: messageIdentity(raw).messageId,
    raw_sha: rawSha,
    uid: ref.uid,
    status: "rejected_conflict",
    thread: marker.thread,
    flag_synced: false,
    thread_synced: true,
    created_at: ts,
    updated_at: ts,
  });
  appendAudit("rejected_conflict", {
    msg_sha: conflictMsgSha,
    original_msg_sha: msgSha,
    message_id: marker.message_id,
    raw_sha: rawSha,
    original_raw_sha: marker.raw_sha,
    uid: ref.uid,
    ts,
  });
  await markProcessedBestEffort(ctx, ref, conflictMsgSha);
}

function isTerminalAcceptedMessageError(error: unknown): boolean {
  return errorMessage(error).startsWith("mail control workspace not registered:");
}

async function processAcceptedErrorMessage(
  ctx: MailctlContext,
  ref: MailMessageRef,
  raw: string,
  msgSha: string,
  gate: GateResult,
  error: unknown,
): Promise<void> {
  const ts = nowIso(ctx);
  writeMarkerExclusive({
    schema: "orch.mailctl/message-marker/v1",
    msg_sha: msgSha,
    message_id: gate.messageId,
    raw_sha: sha256(raw),
    uid: ref.uid,
    status: "rejected_error",
    thread: null,
    flag_synced: false,
    thread_synced: true,
    created_at: ts,
    updated_at: ts,
  });
  appendAudit("rejected_error", { msg_sha: msgSha, uid: ref.uid, message_id: gate.messageId, error: errorMessage(error), ts });
  await markProcessedBestEffort(ctx, ref, msgSha);
}

async function processFetchedMessage(
  ctx: MailctlContext,
  ref: MailMessageRef,
  opts: PollOptions,
  result: PollResult,
): Promise<boolean> {
  const raw = await ctx.transport.fetchRaw(ref);
  result.fetched += 1;
  const msgSha = mailctlMessageMarkerKey(raw);
  const marker = readMarker(msgSha);
  if (marker) {
    if (marker.raw_sha !== sha256(raw)) {
      result.rejected += 1;
      await processConflictMessage(ctx, ref, raw, msgSha, marker);
      return true;
    }
    result.duplicate += 1;
    if (!marker.flag_synced) await markProcessedBestEffort(ctx, ref, msgSha);
    backfillAcceptedMarker(ctx, marker);
    return true;
  }

  const gate = evaluateGate(raw, ctx.config, ctx.config.account.user);
  if (!gate.accepted) {
    result.rejected += 1;
    await processRejectedMessage(ctx, ref, raw, msgSha, gate);
    return true;
  }

  try {
    await processAcceptedMessage({ ctx, ref, raw, msgSha, gate, opts });
  } catch (error) {
    if (!isTerminalAcceptedMessageError(error)) throw error;
    result.rejected += 1;
    await processAcceptedErrorMessage(ctx, ref, raw, msgSha, gate, error);
    return true;
  }
  result.accepted += 1;
  return true;
}

async function mailctlPollUnlocked(ctx: MailctlContext, opts: PollOptions): Promise<PollResult> {
  ensureMailctlStateDirs();
  const cursor = readCursor();
  const lastUid = cursor?.last_uid ?? 0;
  const refs = (await ctx.transport.listNew(30, cursor)).sort((a, b) => a.uid - b.uid);
  const result: PollResult = {
    skipped: false,
    listed: refs.length,
    fetched: 0,
    accepted: 0,
    rejected: 0,
    duplicate: 0,
    errors: 0,
    cursor,
  };
  let highWater = lastUid;
  let blockedCursor = false;
  let uidvalidity = cursor?.uidvalidity ?? null;

  for (const ref of refs) {
    if (ref.uidvalidity !== undefined) uidvalidity = ref.uidvalidity;
    if (ref.uid <= lastUid) {
      result.duplicate += 1;
      continue;
    }
    let ok = false;
    try {
      ok = await processFetchedMessage(ctx, ref, opts, result);
    } catch (error) {
      if (error instanceof MailctlInjectedFaultError) throw error;
      result.errors += 1;
      appendAudit("message_error", { uid: ref.uid, error: errorMessage(error), ts: nowIso(ctx) });
    }
    if (ok && !blockedCursor) highWater = ref.uid;
    if (!ok) blockedCursor = true;
  }

  throwFault(opts, "before-cursor");

  const nextCursor: MailCursor = {
    uidvalidity,
    last_uid: highWater,
    last_poll_at: nowIso(ctx),
    consecutive_failures: 0,
    last_error: null,
    last_alert_at: null,
    alerted_streak: null,
  };
  writeCursor(nextCursor);
  result.cursor = nextCursor;
  return result;
}

export async function mailctlPoll(ctx: MailctlContext, opts: PollOptions = {}): Promise<PollResult> {
  let lock;
  try {
    lock = acquirePidfileLock(ingestLockPath(), process.pid, "mailctl-poll");
  } catch (error) {
    if (error instanceof LockHeldError) {
      return {
        skipped: true,
        listed: 0,
        fetched: 0,
        accepted: 0,
        rejected: 0,
        duplicate: 0,
        errors: 0,
        cursor: readCursor(),
      };
    }
    throw error;
  }

  try {
    try {
      const result = await mailctlPollUnlocked(ctx, opts);
      if (opts.reconcile !== false) result.reconciled = await mailctlReconcileUnlocked(ctx);
      return result;
    } catch (error) {
      recordMailctlPollFailure(ctx, error);
      throw error;
    }
  } finally {
    lock.release();
  }
}

interface TriggerSet {
  reasons: string[];
  summary: string;
  fp: string;
  unackedText: string;
}

function threadTriggerSet(state: MailctlThreadState): TriggerSet | null {
  const reasons: string[] = [];
  const attention = listAttentionForThread(state.thread);
  if (attention.length > 0) {
    reasons.push(`T1:unacked-attention:${attention.map((item) => item.msg_sha).join(",")}`);
  }

  for (const run of collectMrRuns(state.repo_key, state.thread)) {
    if (run.role === "controller") continue;
    if (run.stale) reasons.push(`T3:stale-run:${run.run_id}:${run.state}`);
    else if (isTerminal(run.state) && !run.decided) reasons.push(`T2:undecided-terminal:${run.run_id}:${run.state}`);
  }

  if (state.status === "settled" && state.controller.final_report_sent !== true) {
    reasons.push("T4:completed-no-final-report");
  }

  if (reasons.length === 0) return null;
  reasons.sort();
  return {
    reasons,
    summary: reasons.join("; "),
    fp: sha256(reasons.join("\n")),
    unackedText: attention.map((item) => `## ${item.msg_sha}\n${item.body}`).join("\n\n"),
  };
}

function readGenerationStatus(gen: ControllerGeneration): RunStatus | null {
  if (gen.status_path) return readJsonFile<RunStatus | null>(gen.status_path, null);
  if (gen.run_dir) return readJsonFile<RunStatus | null>(`${gen.run_dir}/status.json`, null);
  return null;
}

async function closeTerminalControllerRuns(
  ctx: MailctlContext,
  state: MailctlThreadState,
  result: ReconcileResult,
): Promise<void> {
  for (const gen of state.controller.generations) {
    const status = readGenerationStatus(gen);
    if (!status || !isTerminal(status.state) || !gen.run_dir) continue;
    if (existsSync(`${gen.run_dir}/decision.json`)) continue;
    const argv = [
      ...ctx.orch.orchCommand(),
      "decision",
      "close",
      "--run",
      gen.run_id,
      "--mr",
      `mailctl-${state.thread}`,
      "--worktree",
      state.workspace_path,
      "--reason",
      "mailctl controller terminal",
    ];
    const proc = Bun.spawn(argv, { cwd: state.workspace_path, stdout: "pipe", stderr: "pipe", env: process.env });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) {
      result.closed.push({ thread: state.thread, run_id: gen.run_id });
      continue;
    }
    const message = `${stderr.trim() || stdout.trim() || `decision close failed with exit code ${exitCode}`}`;
    if (!message.includes("already decided")) result.errors.push({ thread: state.thread, error: message });
  }
}

function recentControllerGenerations(state: MailctlThreadState, nowMs: number): number {
  const cutoff = nowMs - 60 * 60 * 1000;
  return state.controller.generations.filter((gen) => Date.parse(gen.spawned_at) >= cutoff).length;
}

function previousControllerSummary(ctx: MailctlContext, state: MailctlThreadState): string {
  const previous = state.controller.generations.at(-1);
  if (!previous) return "(none)";
  try {
    const mr = `mailctl-${state.thread}`;
    const located = ctx.orch.locateRun(state.repo_key, previous.run_id, mr);
    const { result } = ctx.orch.readMirrorResult(`${mrStateDir(state.repo_key, located.mr)}/runs`, located.run_id);
    const summary = result.schema === "orch.result/controller/v1" ? result.summary.trim() : "";
    return summary ? summary.slice(-4000) : "(none)";
  } catch {
    return "(none)";
  }
}

function sentReportSummary(thread: string): string {
  const rows = safeJsonFiles(outboxEmailSentDir())
    .map((path) => readJsonFile<{ thread?: unknown; report_key?: unknown; sent_at?: unknown } | null>(path, null))
    .filter((row) => row?.thread === thread)
    .map((row) => `${String(row?.sent_at ?? "unknown")} ${String(row?.report_key ?? "unknown")}`);
  return rows.slice(-20).join("\n");
}

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

async function spawnController(
  ctx: MailctlContext,
  state: MailctlThreadState,
  trigger: TriggerSet,
): Promise<ControllerGeneration> {
  const gen = state.controller.generations.length;
  const idempotencyKey = `ctrl:${state.thread}:${gen}`;
  const taskPath = taskFilePath(state.thread, `${utcStamp(ctx.now())}-g${gen}`);
  writeTextAtomic(
    taskPath,
    buildControllerTask({
      thread: state.thread,
      workspace: state.workspace_id,
      triggerReason: trigger.summary,
      unackedMailText: trigger.unackedText || trigger.summary,
      notesTail: previousControllerSummary(ctx, state),
      sentReportSummary: sentReportSummary(state.thread),
    }),
  );
  const argv = [
    ...ctx.orch.orchCommand(),
    "run",
    "create",
    "--mr",
    `mailctl-${state.thread}`,
    "--role",
    "controller",
    "--agent",
    "claude",
    "--tag",
    "mailctl",
    "--worktree",
    state.workspace_path,
    "--task",
    taskPath,
    "--idempotency-key",
    idempotencyKey,
    "--timeout-sec",
    String(ctx.config.controller.timeout_sec),
    "--json",
  ];
  const proc = Bun.spawn(argv, { cwd: state.workspace_path, stdout: "pipe", stderr: "pipe", env: process.env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `controller run create failed with exit code ${exitCode}`);
  const payload = JSON.parse(stdout) as unknown;
  const runId = payloadString(payload, "run_id");
  if (!runId) throw new Error("controller run create did not return run_id");
  return {
    gen,
    idempotency_key: idempotencyKey,
    trigger_fp: trigger.fp,
    trigger_reasons: trigger.reasons,
    task_path: taskPath,
    run_id: runId,
    run_dir: payloadString(payload, "run_dir"),
    status_path: payloadString(payload, "status_path"),
    spawned_at: nowIso(ctx),
    payload,
  };
}

async function reconcileThread(ctx: MailctlContext, initialState: MailctlThreadState, result: ReconcileResult): Promise<void> {
  const lock = await acquirePidfileLockWait(controllerSpawnLockPath(), 5_000, process.pid, `mailctl-controller:${initialState.thread}`);
  try {
    const state = readThreadState(initialState.thread) ?? initialState;
    await closeTerminalControllerRuns(ctx, state, result);
    const trigger = threadTriggerSet(state);
    if (!trigger) return;

    const latest = state.controller.generations.at(-1);
    if (latest) {
      const status = readGenerationStatus(latest);
      if (!status) {
        result.live.push({ thread: state.thread, run_id: latest.run_id, state: "unknown" });
        return;
      }
      if (!isTerminal(status.state)) {
        if (!looksStale(status)) {
          result.live.push({ thread: state.thread, run_id: latest.run_id, state: status.state });
          return;
        }
      } else if (status.state === "done" && latest.trigger_fp === trigger.fp) {
        return;
      }
    }

    if (recentControllerGenerations(state, ctx.now()) >= ctx.config.controller.max_spawns_per_hour) {
      const updated: MailctlThreadState = {
        ...state,
        controller: {
          ...state.controller,
          last_trigger_fp: trigger.fp,
          throttled_at: nowIso(ctx),
          throttled_reason: "max_spawns_per_hour",
        },
        updated_at: nowIso(ctx),
      };
      writeThreadState(updated);
      result.throttled.push({ thread: state.thread, trigger_fp: trigger.fp });
      appendAudit("controller_throttled", { thread: state.thread, trigger_fp: trigger.fp, ts: nowIso(ctx) });
      return;
    }

    const generation = await spawnController(ctx, state, trigger);
    const updated: MailctlThreadState = {
      ...state,
      controller: {
        ...state.controller,
        current_run_id: generation.run_id,
        generations: [...state.controller.generations, generation],
        last_trigger_fp: trigger.fp,
      },
      updated_at: nowIso(ctx),
    };
    writeThreadState(updated);
    result.spawned.push({ thread: state.thread, gen: generation.gen, run_id: generation.run_id, trigger_fp: trigger.fp });
    appendAudit("controller_spawned", { thread: state.thread, gen: generation.gen, run_id: generation.run_id, trigger_fp: trigger.fp, ts: nowIso(ctx) });
  } finally {
    lock.release();
  }
}

async function mailctlReconcileUnlocked(ctx: MailctlContext): Promise<ReconcileResult> {
  ensureMailctlStateDirs();
  const activeThreads = listThreadStates().filter(
    (state) => state.status === "active" || (state.status === "settled" && state.controller.final_report_sent !== true),
  );
  const result: ReconcileResult = {
    skipped: false,
    active_threads: activeThreads.length,
    spawned: [],
    live: [],
    throttled: [],
    closed: [],
    retried_reports: 0,
    errors: [],
  };

  for (const state of activeThreads) {
    try {
      await reconcileThread(ctx, state, result);
    } catch (error) {
      result.errors.push({ thread: state.thread, error: errorMessage(error) });
    }
  }

  result.retried_reports = await retryDuePendingReplies(ctx);
  return result;
}

export async function mailctlReconcile(ctx: MailctlContext): Promise<ReconcileResult> {
  let lock;
  try {
    lock = acquirePidfileLock(ingestLockPath(), process.pid, "mailctl-reconcile");
  } catch (error) {
    if (error instanceof LockHeldError) {
      return { skipped: true, active_threads: 0, spawned: [], live: [], throttled: [], closed: [], retried_reports: 0, errors: [] };
    }
    throw error;
  }
  try {
    return await mailctlReconcileUnlocked(ctx);
  } finally {
    lock.release();
  }
}

function reportFileName(reportKey: string): string {
  return `${statePathSegment(reportKey, "report")}-${sha12(reportKey)}.json`;
}

function pendingReplyPath(reportKey: string): string {
  return `${outboxEmailPendingDir()}/${reportFileName(reportKey)}`;
}

function sentReplyPath(reportKey: string): string {
  return `${outboxEmailSentDir()}/${reportFileName(reportKey)}`;
}

function droppedReplyPath(reportKey: string): string {
  return `${outboxEmailDroppedDir()}/${reportFileName(reportKey)}`;
}

function assertMailReplyPolicy(ctx: MailctlContext, body: string): void {
  if (Buffer.byteLength(body, "utf8") > ctx.config.reports.max_body_bytes) {
    throw new Error(`mail reply body exceeds max_body_bytes (${ctx.config.reports.max_body_bytes})`);
  }
  if (process.env.ORCH_MAILCTL_ALLOW_PRIVATE === "1") return;

  const previousMirrorAllow = process.env.ORCH_MIRROR_ALLOW_PRIVATE;
  try {
    delete process.env.ORCH_MIRROR_ALLOW_PRIVATE;
    assertNoPrivateLeak(body);
  } finally {
    if (previousMirrorAllow === undefined) delete process.env.ORCH_MIRROR_ALLOW_PRIVATE;
    else process.env.ORCH_MIRROR_ALLOW_PRIVATE = previousMirrorAllow;
  }

  const secretPatterns: Array<[RegExp, string]> = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
    [/\b(?:ghp|github_pat|sk-[A-Za-z0-9_-]*|xox[baprs]-)[A-Za-z0-9_=-]{12,}\b/, "token"],
    [/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{16,}/i, "secret assignment"],
  ];
  for (const [pattern, label] of secretPatterns) {
    if (pattern.test(body)) throw new Error(`refusing to send mail reply: detected ${label}`);
  }
}

function assertSafeReportKey(reportKey: string): void {
  if (!/^(?:progress|settled|reply):[A-Za-z0-9:._-]+$/.test(reportKey)) {
    throw new Error("mail reply report key must be progress:<run_id>, settled:<gen>, or reply:<msg_sha> using only [A-Za-z0-9:._-]");
  }
}

function replyWireBody(reportKey: string, body: string): string {
  return `[orch:${reportKey}]\n\n${body}`.replace(/\s+$/g, "");
}

function sentInLastHour(nowMs: number): number {
  const cutoff = nowMs - 60 * 60 * 1000;
  return safeJsonFiles(outboxEmailSentDir())
    .map((path) => readJsonFile<{ sent_at?: unknown } | null>(path, null))
    .filter((record) => typeof record?.sent_at === "string" && Date.parse(record.sent_at) >= cutoff).length;
}

function replyMessageId(ctx: MailctlContext, thread: string, reportKey: string): string {
  const from = ctx.config.smtp.from ?? ctx.config.account.user;
  const domain = from.includes("@") ? from.slice(from.lastIndexOf("@") + 1) : "localhost";
  return `<orch-${ctx.now().toString(36)}-${sha12(`${thread}:${reportKey}`)}@${domain}>`;
}

function writeSelfMessageMarker(messageId: string, ts: string): void {
  const normalized = normalizeMessageId(messageId);
  const msgSha = sha12(normalized);
  writeMarkerExclusive({
    schema: "orch.mailctl/message-marker/v1",
    msg_sha: msgSha,
    message_id: normalized,
    raw_sha: sha256(normalized),
    uid: 0,
    status: "self",
    thread: null,
    flag_synced: true,
    thread_synced: true,
    created_at: ts,
    updated_at: ts,
  });
}

function nextBackoffMs(attempts: number): number {
  const minutes = attempts <= 1 ? 1 : attempts === 2 ? 5 : 25;
  return Math.min(minutes * 60 * 1000, 60 * 60 * 1000);
}

function writeSentReply(record: PendingReplyRecord, ts: string): string {
  const path = sentReplyPath(record.report_key);
  writeJsonExclusive(path, {
    schema: "orch.mailctl/outbox-email-sent/v1",
    report_key: record.report_key,
    thread: record.thread,
    message_id: record.message_id,
    sent_at: ts,
    raw: record.raw,
    attempts: record.attempts,
  });
  writeSelfMessageMarker(record.message_id, ts);
  return path;
}

async function retryDuePendingReplies(ctx: MailctlContext): Promise<number> {
  let retried = 0;
  for (const path of safeJsonFiles(outboxEmailPendingDir())) {
    const record = readJsonFile<PendingReplyRecord | null>(path, null);
    if (!record || record.schema !== "orch.mailctl/outbox-email/v1") continue;
    if (record.dropped_at || Date.parse(record.next_attempt_at) > ctx.now()) continue;
    if (record.attempts >= 8) {
      writeJsonAtomic(droppedReplyPath(record.report_key), { ...record, dropped_at: nowIso(ctx), updated_at: nowIso(ctx) });
      rmSync(path, { force: true });
      continue;
    }
    try {
      await ctx.transport.sendReply(record.raw);
      const sentPath = writeSentReply(record, nowIso(ctx));
      rmSync(path, { force: true });
      appendAudit("reply_retry_sent", { report_key: record.report_key, sent_path: sentPath, ts: nowIso(ctx) });
      retried += 1;
    } catch (error) {
      const attempts = record.attempts + 1;
      const next = new Date(ctx.now() + nextBackoffMs(attempts)).toISOString();
      writeJsonAtomic(path, {
        ...record,
        attempts,
        updated_at: nowIso(ctx),
        next_attempt_at: next,
        last_error: errorMessage(error),
      });
      appendAudit("reply_retry_failed", { report_key: record.report_key, attempts, error: errorMessage(error), ts: nowIso(ctx) });
    }
  }
  return retried;
}

export async function mailctlReply(ctx: MailctlContext, opts: ReplyOptions): Promise<ReplyResult> {
  ensureMailctlStateDirs();
  const state = readThreadState(opts.thread);
  if (!state) throw new Error(`mailctl thread not found: ${opts.thread}`);
  assertSafeReportKey(opts.reportKey);
  assertMailReplyPolicy(ctx, replyWireBody(opts.reportKey, opts.body));

  const pendingPath = pendingReplyPath(opts.reportKey);
  const sentPath = sentReplyPath(opts.reportKey);
  if (existsSync(sentPath) || existsSync(pendingPath)) {
    if (existsSync(sentPath) && opts.reportKey.startsWith("settled:")) settleThreadIfReady(ctx, state.thread);
    return { dryRun: Boolean(opts.dryRun), duplicate: true, sent: existsSync(sentPath), pending: existsSync(pendingPath), sentPath, pendingPath };
  }
  if (sentInLastHour(ctx.now()) >= ctx.config.reports.max_per_hour) {
    throw new Error(`mail reply rate limit exceeded (${ctx.config.reports.max_per_hour}/hour)`);
  }

  const to = state.reply_to ?? ctx.config.allowed_senders[0];
  if (!to) throw new Error("mailctl reply has no recipient");
  const built = buildReplyMessage({
    from: ctx.config.smtp.from ?? ctx.config.account.user,
    to,
    subject: state.subject || `orch ${state.thread}`,
    body: opts.body,
    reportKey: opts.reportKey,
    inReplyTo: state.message_ids.at(-1) ?? null,
    references: state.message_ids,
    messageId: replyMessageId(ctx, state.thread, opts.reportKey),
    date: new Date(ctx.now()),
  });
  if (opts.dryRun) {
    return { dryRun: true, duplicate: false, sent: false, pending: false, rawMessage: built.raw, messageId: built.messageId };
  }

  const ts = nowIso(ctx);
  const pending: PendingReplyRecord = {
    schema: "orch.mailctl/outbox-email/v1",
    report_key: opts.reportKey,
    thread: state.thread,
    body: opts.body,
    raw: built.raw,
    message_id: built.messageId,
    attempts: 0,
    created_at: ts,
    updated_at: ts,
    next_attempt_at: ts,
    last_error: null,
  };
  try {
    writeJsonExclusive(pendingPath, pending);
  } catch (error) {
    if (isEexist(error)) return { dryRun: false, duplicate: true, sent: false, pending: true, pendingPath };
    throw error;
  }

  try {
    await ctx.transport.sendReply(built.raw);
    const finalPending = readJsonFile<PendingReplyRecord>(pendingPath, pending);
    const finalSentPath = writeSentReply(finalPending, nowIso(ctx));
    rmSync(pendingPath, { force: true });
    if (opts.reportKey.startsWith("settled:")) settleThreadIfReady(ctx, state.thread);
    appendAudit("reply_sent", { report_key: opts.reportKey, thread: state.thread, sent_path: finalSentPath, ts: nowIso(ctx) });
    return {
      dryRun: false,
      duplicate: false,
      sent: true,
      pending: false,
      rawMessage: built.raw,
      messageId: built.messageId,
      sentPath: finalSentPath,
    };
  } catch (error) {
    const attempts = 1;
    const nextAttemptAt = new Date(ctx.now() + nextBackoffMs(attempts)).toISOString();
    writeJsonAtomic(pendingPath, {
      ...pending,
      attempts,
      updated_at: nowIso(ctx),
      next_attempt_at: nextAttemptAt,
      last_error: errorMessage(error),
    });
    appendAudit("reply_pending", { report_key: opts.reportKey, thread: state.thread, error: errorMessage(error), next_attempt_at: nextAttemptAt, ts: nowIso(ctx) });
    return {
      dryRun: false,
      duplicate: false,
      sent: false,
      pending: true,
      rawMessage: built.raw,
      messageId: built.messageId,
      pendingPath,
      nextAttemptAt,
    };
  }
}

export async function mailctlWatch(ctx: MailctlContext, opts: WatchOptions = {}): Promise<{ iterations: number; stopped: boolean }> {
  ensureMailctlStateDirs();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  let iterations = 0;
  let failures = 0;
  try {
    while (!stopped && !opts.signal?.aborted && (opts.iterations === undefined || iterations < opts.iterations)) {
      await mailctlPoll(ctx);
      if (stopped || opts.signal?.aborted) break;

      let lock;
      try {
        lock = acquirePidfileLock(watchLockPath(), process.pid, "mailctl-watch");
      } catch (error) {
        if (!(error instanceof LockHeldError)) throw error;
        const timeoutMs = Math.max(1, ctx.config.reconcile_interval_sec) * 1000;
        await sleep(timeoutMs);
        iterations += 1;
        continue;
      }
      try {
        const timeoutMs = Math.max(1, ctx.config.reconcile_interval_sec) * 1000;
        if (ctx.transport.idleOnce) await ctx.transport.idleOnce(timeoutMs, readCursor());
        else await sleep(timeoutMs);
        failures = 0;
      } catch (error) {
        failures += 1;
        const backoffSec = Math.min(900, Math.max(1, ctx.config.reconcile_interval_sec) * 2 ** Math.min(failures - 1, 10));
        patchCursor(ctx, { last_error: errorMessage(error), next_watch_retry_at: new Date(ctx.now() + backoffSec * 1000).toISOString() });
        await sleep(backoffSec * 1000);
      } finally {
        lock.release();
      }
      iterations += 1;
    }
  } finally {
    process.off("SIGINT", stop);
  }
  return { iterations, stopped: stopped || Boolean(opts.signal?.aborted) };
}

export function createMailTransport(cfg: MailControlConfig): MailTransport {
  return new ImapSmtpMailTransport(cfg);
}

class ImapSmtpMailTransport implements MailTransport {
  private passwordPromise: Promise<string> | null = null;

  constructor(private readonly cfg: MailControlConfig) {}

  private password(): Promise<string> {
    this.passwordPromise ??= resolveMailPassword(this.cfg);
    return this.passwordPromise;
  }

  private async withImap<T>(fn: (client: ImapClient) => Promise<T>): Promise<T> {
    const client = await ImapClient.connect({ host: this.cfg.imap.host, port: this.cfg.imap.port });
    try {
      await client.login(this.cfg.account.user, await this.password());
      await client.select("INBOX");
      return await fn(client);
    } finally {
      try {
        await client.logout();
      } catch {
        // Best-effort logout only; callers care about the operation result.
      }
    }
  }

  async listNew(sinceDays: number, cursor: MailCursor | null): Promise<MailMessageRef[]> {
    return this.withImap(async (client) => {
      const selected = await client.select("INBOX");
      const storedLastUid = cursor?.last_uid ?? 0;
      const plan = planUidScan({
        storedUidValidity: cursor?.uidvalidity ?? null,
        selectedUidValidity: selected.uidValidity,
        lastUid: storedLastUid,
      });
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      const uids = filterNewUids(await client.uidSearchSince(since), plan.effectiveLastUid);
      return uids.map((uid) => ({ uid, mailbox: selected.mailbox, uidvalidity: selected.uidValidity }));
    });
  }

  async fetchRaw(ref: MailMessageRef): Promise<string> {
    return this.withImap(async (client) => {
      const raw = await client.uidFetchRaw(ref.uid);
      if (raw === null) throw new Error(`IMAP message not found for UID ${ref.uid}`);
      return raw;
    });
  }

  async markProcessed(ref: MailMessageRef): Promise<void> {
    await this.withImap(async (client) => {
      const ok = await client.markProcessed(ref.uid);
      if (!ok) throw new Error(`IMAP STORE $OrchProcessed failed for UID ${ref.uid}`);
    });
  }

  async idleOnce(timeoutMs: number): Promise<void> {
    await this.withImap(async (client) => {
      await client.idleOnce(() => sleep(timeoutMs));
    });
  }

  async sendReply(rfc822: string): Promise<void> {
    const to = headerValues(rfc822, "To")
      .flatMap((value) => parseAddress(value))
      .map((address) => address.address);
    if (to.length === 0) throw new Error("SMTP reply has no To recipient");
    await submitSmtpMessage({
      host: this.cfg.smtp.host,
      port: this.cfg.smtp.port,
      mode: this.cfg.smtp.mode,
      username: this.cfg.account.user,
      password: await this.password(),
      from: this.cfg.smtp.from ?? this.cfg.account.user,
      to,
      message: rfc822,
    });
  }
}
