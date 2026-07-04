import type { MailControlConfig } from "./config.ts";
import { sha256 } from "./hash.ts";
import type { MailCliContext } from "./mail-cli.ts";
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
import { mailControlStateDir } from "./paths.ts";

export interface MailCursor {
  uidvalidity: number | null;
  last_uid: number | null;
  last_poll_at: string | null;
}

export interface MailMessageRef {
  uid: number;
  mailbox?: string;
  message_id?: string;
}

export interface MailTransport {
  listNew(sinceDays: number, cursor: MailCursor | null): Promise<MailMessageRef[]>;
  fetchRaw(ref: MailMessageRef): Promise<string>;
  markProcessed(ref: MailMessageRef): Promise<void>;
  sendReply(rfc822: string): Promise<void>;
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
    "## Context",
    `- Thread: ${thread}`,
    `- Workspace: ${input.workspace}`,
    `- Trigger: ${input.triggerReason}`,
    "",
    "## Unacked Mail",
    unackedMailText || "(empty)",
    "",
    "## Controller Notes Tail",
    notesTail,
    "",
    "## Sent Report Summary",
    sentReportSummary,
    "",
    "## Rules",
    "- Finish one batch of work, then exit. Do not run a long-lived watch loop; at most one bounded <=120s wait is allowed.",
    "- You have no Edit/Write; dispatch a worker to change code.",
    `- Orchestrate with orch fanout/cross-review --thread ${thread} --task <file>; choose the narrow worker/reviewer set needed for this batch.`,
    "- Decide completed worker runs with orch decision accept|rework after reading their results.",
    `- After consuming an instruction, acknowledge it with orch mailctl ack --thread ${thread} --attention <id>.`,
    "- Report only for milestones, blockers, and final results via orch mailctl reply --report-key <progress:<run_id>|settled:<gen>|reply:<msg_sha>>.",
    "- Each meaningful state change gets at most one report. Reply bodies must not contain local paths or secrets.",
    "- Append any durable handoff notes to notes.md before exit.",
    "- Final output must be orch.result/controller/v1 JSON.",
    "",
  ].join("\n");
}
