import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { orchStateRoot } from "./paths.ts";
import { appendJsonLine, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./json.ts";
import { randomHex, sha256 } from "./hash.ts";
import type { RoleResult, RunStatus } from "./types.ts";

export interface MailIdentity {
  key_id: string;
  public_key_pem: string;
  private_key_pem: string;
}

export interface MailSignature {
  alg: "ed25519";
  key_id: string;
  sig: string;
}

export interface MailEventBase {
  schema: "orch.mail/event/v1";
  event_id: string;
  created_at: string;
  repo_key: string;
  thread_id: string;
  mr?: string;
  parent_event_id?: string | null;
}

export interface DecisionRecordedMailEvent extends MailEventBase {
  type: "decision.recorded";
  mr: string;
  run_id: string;
  decision: {
    verdict: string;
    reason: string | null;
    ts: string;
  };
  result: {
    schema: string;
    verdict: string;
    summary: string;
  };
  status: {
    state: string;
    base_sha: string;
    head_sha: string | null;
  };
}

export interface TaskRequestedMailEvent extends MailEventBase {
  type: "task.requested";
  role: string;
  task: {
    body: string;
    sha256: string;
  };
  workspace?: {
    id: string;
    path: string;
  };
  assigned_agent: {
    id: string;
    address: string;
    provider: string;
    roles: string[];
    capabilities: string[];
    work_mode?: string;
    provider_session_mode?: string;
  };
}

export interface ResultSubmittedMailEvent extends MailEventBase {
  type: "result.submitted";
  run_id: string;
  result: {
    schema: string;
    verdict: string;
    summary: string;
  };
  from_agent: {
    id: string;
    address: string;
    provider: string;
  };
}

export type OrchMailEvent = DecisionRecordedMailEvent | TaskRequestedMailEvent | ResultSubmittedMailEvent;

export interface SignedMailEvent {
  schema: "orch.mail/signed-event/v1";
  event: OrchMailEvent;
  signature: MailSignature;
}

export interface ComposeDecisionMailArgs {
  threadDir: string;
  threadId: string;
  repoKey: string;
  mr: string;
  runId: string;
  from: string;
  to: string;
  decision: { verdict: string; reason: string | null; ts: string };
  result: RoleResult;
  status: RunStatus | null;
  parentEventId?: string | null;
}

export interface ComposeTaskMailArgs {
  threadDir: string;
  threadId: string;
  repoKey: string;
  from: string;
  taskText: string;
  role: string;
  parentEventId?: string | null;
  mr?: string | null;
  workspace?: { id: string; path: string } | null;
  agent: {
    id: string;
    address: string;
    provider: string;
    roles: string[];
    capabilities: string[];
    work_mode?: string;
    provider_session_mode?: string;
  };
}

export interface ComposeResultMailArgs {
  threadDir: string;
  threadId: string;
  repoKey: string;
  parentEventId?: string | null;
  mr?: string | null;
  from: {
    id: string;
    address: string;
    provider: string;
  };
  to: string;
  runId: string;
  result: RoleResult;
}

export interface ComposeMailResult {
  eml_path: string;
  meta_path: string;
  event_id: string;
  message_id: string;
  event_sha256: string;
}

export type ComposeTaskMailResult = ComposeMailResult;
export type ComposeDecisionMailResult = ComposeMailResult;
export type ComposeResultMailResult = ComposeMailResult;

export interface ImportMailResult {
  imported: boolean;
  raw_path: string;
  event_path?: string;
  quarantine_path?: string;
  event_id?: string;
  reason?: string;
}

export interface AutoImportMailResult extends ImportMailResult {
  repo_key?: string;
  thread_id?: string;
}

export interface NeomuttMailbox {
  thread_id: string;
  thread_dir: string;
  worktree: string;
  workspace_id?: string;
}

export interface NeomuttConfigResult {
  rc_path: string;
  maildir: string;
  events_path?: string;
  mailboxes: Array<{ thread_id: string; maildir: string; worktree: string; workspace_id?: string }>;
  launch: string;
}

function mailRoot(): string {
  return `${orchStateRoot()}/mail`;
}

function identityPath(): string {
  return `${mailRoot()}/identity.json`;
}

export function mailThreadDir(repoKey: string, threadId: string): string {
  if (repoKey.startsWith("/") || repoKey.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("mail repo key must be a relative path without dot segments");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(threadId)) {
    throw new Error("mail thread id must start with an alphanumeric character and contain only letters, digits, dot, underscore, or dash");
  }
  return `${orchStateRoot()}/${repoKey}/mail/threads/${threadId}`;
}

export function ensureMailIdentity(): MailIdentity {
  const existing = readJsonFile<MailIdentity | null>(identityPath(), null);
  if (existing?.key_id && existing.public_key_pem && existing.private_key_pem) return existing;

  const pair = generateKeyPairSync("ed25519");
  const identity: MailIdentity = {
    key_id: `local-${randomHex(8)}`,
    public_key_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key_pem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  writeJsonAtomic(identityPath(), identity);
  chmodSync(identityPath(), 0o600);
  return identity;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function signEvent(event: OrchMailEvent, identity: MailIdentity): SignedMailEvent {
  const payload = Buffer.from(canonicalJson(event), "utf8");
  return {
    schema: "orch.mail/signed-event/v1",
    event,
    signature: {
      alg: "ed25519",
      key_id: identity.key_id,
      sig: sign(null, payload, identity.private_key_pem).toString("base64"),
    },
  };
}

function verifySignedEvent(signed: SignedMailEvent, identity: MailIdentity): boolean {
  if (signed.schema !== "orch.mail/signed-event/v1") return false;
  if (signed.signature?.alg !== "ed25519") return false;
  if (signed.signature.key_id !== identity.key_id) return false;
  return verify(
    null,
    Buffer.from(canonicalJson(signed.event), "utf8"),
    identity.public_key_pem,
    Buffer.from(signed.signature.sig, "base64"),
  );
}

function resultVerdict(result: RoleResult): string {
  return "verdict" in result && typeof result.verdict === "string" ? result.verdict : "unknown";
}

function resultSummary(result: RoleResult): string {
  if ("summary" in result && typeof result.summary === "string") return result.summary;
  if (result.schema === "orch.result/reviewer/v1") {
    return `${result.blocking_findings.length} blocking finding(s), ${result.non_blocking_findings.length} non-blocking finding(s).`;
  }
  if (result.schema === "orch.result/verifier/v1") {
    return `${result.commands.length} command(s), ${result.acceptance.length} acceptance item(s).`;
  }
  return "No summary in result.json.";
}

function normalizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeSubject(value: string): string {
  return normalizeHeaderValue(value).replace(/[\x00-\x1f\x7f]/g, " ");
}

function pendingMailDir(threadDir: string): string {
  return `${threadDir}/outbox/pending`;
}

function sentMailDir(threadDir: string): string {
  return `${threadDir}/outbox/sent`;
}

function inboxRawDir(threadDir: string): string {
  return `${threadDir}/inbox/raw`;
}

function inboxEventsDir(threadDir: string): string {
  return `${threadDir}/inbox/events`;
}

function quarantineDir(threadDir: string): string {
  return `${threadDir}/inbox/quarantine`;
}

function maildirDir(threadDir: string): string {
  return `${threadDir}/maildir`;
}

export function maildirPath(threadDir: string): string {
  return maildirDir(threadDir);
}

function neomuttDir(threadDir: string): string {
  return `${threadDir}/neomutt`;
}

function neomuttRcPath(threadDir: string): string {
  return `${neomuttDir(threadDir)}/orch-mail.neomuttrc`;
}

export function mailEventsPath(threadDir: string): string {
  return `${inboxEventsDir(threadDir)}/mail-events.jsonl`;
}

export function ensureMailDirs(threadDir: string): void {
  for (const dir of [
    pendingMailDir(threadDir),
    sentMailDir(threadDir),
    inboxRawDir(threadDir),
    inboxEventsDir(threadDir),
    quarantineDir(threadDir),
    `${maildirDir(threadDir)}/cur`,
    `${maildirDir(threadDir)}/new`,
    `${maildirDir(threadDir)}/tmp`,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function neomuttQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function writeNeomuttConfig(args: { threadDir?: string; threadId?: string; worktree?: string; command?: string; mailboxes?: NeomuttMailbox[] }): NeomuttConfigResult {
  const command = args.command ?? "orch";
  const mailboxes =
    args.mailboxes ??
    (args.threadDir && args.threadId && args.worktree
      ? [{ thread_id: args.threadId, thread_dir: args.threadDir, worktree: args.worktree }]
      : []);
  for (const box of mailboxes) ensureMailDirs(box.thread_dir);

  const fallbackMaildir = `${orchStateRoot()}/mail/neomutt/maildir`;
  if (mailboxes.length === 0) {
    for (const dir of [`${fallbackMaildir}/cur`, `${fallbackMaildir}/new`, `${fallbackMaildir}/tmp`]) mkdirSync(dir, { recursive: true });
  }

  const primaryMaildir = mailboxes.length > 0 ? maildirPath(mailboxes[0]!.thread_dir) : fallbackMaildir;
  const primaryEventsPath = mailboxes.length > 0 ? mailEventsPath(mailboxes[0]!.thread_dir) : undefined;
  const commonArgs = (box: NeomuttMailbox): string => `--thread ${shellQuote(box.thread_id)} --worktree ${shellQuote(box.worktree)}`;
  const threadCommand = (box: NeomuttMailbox, subcommand: string): string => `${command} mail ${subcommand} ${commonArgs(box)}`;
  const noMailboxes = `printf 'No orch mail threads found. Run orch mail submit/assign first.\\n'`;
  const deliver = mailboxes.length > 0 ? mailboxes.map((box) => threadCommand(box, "deliver-local")).join(" && ") : noMailboxes;
  const importSelected = args.threadDir && args.threadId && args.worktree ? `${command} mail import ${commonArgs(mailboxes[0]!)} --file -` : `${command} mail import --file -`;
  const route = mailboxes.length > 0 ? mailboxes.map((box) => `${threadCommand(box, "route")} && ${threadCommand(box, "deliver-local")}`).join(" && ") : noMailboxes;
  const list = mailboxes.length > 0 ? mailboxes.map((box) => threadCommand(box, "list")).join(" && ") : noMailboxes;
  const path = mailboxes.length > 0 ? mailboxes.map((box) => threadCommand(box, "path")).join(" && ") : noMailboxes;
  const sendmail = args.threadDir && args.threadId && args.worktree ? `${command} mail sendmail ${commonArgs(mailboxes[0]!)}` : `${command} mail sendmail`;
  const assign =
    args.threadDir && args.threadId && args.worktree
      ? `printf 'role: '; read role; printf 'task file: '; read task; printf 'to-agent (blank auto): '; read to_agent; if [ -n "$to_agent" ]; then ${command} mail assign ${commonArgs(mailboxes[0]!)} --role "$role" --task "$task" --to-agent "$to_agent"; else ${command} mail assign ${commonArgs(mailboxes[0]!)} --role "$role" --task "$task"; fi && ${threadCommand(mailboxes[0]!, "deliver-local")}`
      : `printf 'workspace id (blank cwd): '; read workspace; printf 'thread: '; read thread; printf 'role: '; read role; printf 'task file: '; read task; printf 'to-agent (blank auto): '; read to_agent; scope="--thread $thread"; if [ -n "$workspace" ]; then scope="$scope --workspace $workspace"; fi; if [ -n "$to_agent" ]; then ${command} mail assign $scope --role "$role" --task "$task" --to-agent "$to_agent"; else ${command} mail assign $scope --role "$role" --task "$task"; fi && ${command} mail deliver-local $scope`;
  const replyResult =
    args.threadDir && args.threadId && args.worktree
      ? `printf 'run id: '; read run_id; printf 'from-agent: '; read from_agent; printf 'parent event (blank none): '; read parent_event; if [ -n "$parent_event" ]; then ${command} mail reply result ${commonArgs(mailboxes[0]!)} --run "$run_id" --from-agent "$from_agent" --parent-event "$parent_event"; else ${command} mail reply result ${commonArgs(mailboxes[0]!)} --run "$run_id" --from-agent "$from_agent"; fi && ${threadCommand(mailboxes[0]!, "deliver-local")}`
      : `printf 'workspace id (blank cwd): '; read workspace; printf 'thread: '; read thread; printf 'run id: '; read run_id; printf 'from-agent: '; read from_agent; printf 'parent event (blank none): '; read parent_event; scope="--thread $thread"; if [ -n "$workspace" ]; then scope="$scope --workspace $workspace"; fi; if [ -n "$parent_event" ]; then ${command} mail reply result $scope --run "$run_id" --from-agent "$from_agent" --parent-event "$parent_event"; else ${command} mail reply result $scope --run "$run_id" --from-agent "$from_agent"; fi && ${command} mail deliver-local $scope`;
  const mailboxLine = mailboxes.length > 0 ? mailboxes.map((box) => neomuttQuote(maildirPath(box.thread_dir))).join(" ") : neomuttQuote(primaryMaildir);
  const macro = (key: string, action: string, description: string) => `macro index,pager ${key} ${neomuttQuote(action)} ${neomuttQuote(description)}`;
  const rc = [
    "# Generated by orch mail neomutt. Re-run after changing workspaces, --thread, or --worktree.",
    `set folder=${neomuttQuote(primaryMaildir)}`,
    `set spoolfile=${neomuttQuote(primaryMaildir)}`,
    `set sendmail=${neomuttQuote(sendmail)}`,
    `mailboxes ${mailboxLine}`,
    macro("<F5>", `<shell-escape>${deliver}<enter><sync-mailbox>`, "orch: deliver queued local mail"),
    macro("<F6>", `<pipe-message>${importSelected}<enter>`, "orch: import selected message into thread events"),
    macro("<F7>", `<shell-escape>${route}<enter><sync-mailbox>`, "orch: route imported router tasks and deliver"),
    macro("<F8>", `<shell-escape>${list}<enter>`, "orch: list pending outgoing mail"),
    macro("<F9>", `<shell-escape>${path}<enter>`, "orch: print thread paths"),
    macro("<F10>", `<shell-escape>${assign}<enter><sync-mailbox>`, "orch: assign a prompted task file to agents and deliver"),
    macro("<F11>", `<shell-escape>${replyResult}<enter><sync-mailbox>`, "orch: reply with a prompted run result and deliver"),
    "",
  ].join("\n");
  const rcPath = args.threadDir ? neomuttRcPath(args.threadDir) : `${orchStateRoot()}/mail/neomutt/orch-mail.neomuttrc`;
  writeTextAtomic(rcPath, rc);
  return {
    rc_path: rcPath,
    maildir: primaryMaildir,
    events_path: primaryEventsPath,
    mailboxes: mailboxes.map((box) => ({ thread_id: box.thread_id, maildir: maildirPath(box.thread_dir), worktree: box.worktree, workspace_id: box.workspace_id })),
    launch: `neomutt -F ${shellQuote(rcPath)} -f ${shellQuote(primaryMaildir)}`,
  };
}

function writeMailAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, value, "utf8");
  renameSync(tmp, path);
}

interface SignedMailBuildContext {
  createdAt: string;
  eventId: string;
  messageId: string;
}

interface SignedMailParts {
  event: OrchMailEvent;
  from: string;
  to: string;
  subject: string;
  text: string;
  headersBeforeDate?: string[];
  protocolHeaders: (eventSha: string) => string[];
  metadata: Record<string, unknown>;
}

function writeSignedMailEvent(args: {
  threadDir: string;
  build: (context: SignedMailBuildContext) => SignedMailParts;
}): ComposeMailResult {
  ensureMailDirs(args.threadDir);
  const identity = ensureMailIdentity();
  const createdAt = new Date().toISOString();
  const eventId = `evt_${randomHex(16)}`;
  const messageId = `<orch.${eventId}@local.orch>`;
  const parts = args.build({ createdAt, eventId, messageId });
  const signed = signEvent(parts.event, identity);
  const signedJson = `${JSON.stringify(signed, null, 2)}\n`;
  const eventSha = sha256(signedJson);
  const boundary = `orch-${randomHex(12)}`;
  const eml = [
    `From: ${normalizeHeaderValue(parts.from)}`,
    `To: ${normalizeHeaderValue(parts.to)}`,
    `Subject: ${encodeSubject(parts.subject)}`,
    `Message-ID: ${messageId}`,
    ...(parts.headersBeforeDate ?? []),
    `Date: ${new Date(createdAt).toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ...parts.protocolHeaders(eventSha),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    parts.text,
    `--${boundary}`,
    "Content-Type: application/vnd.orch.signed-event+json; charset=utf-8",
    "Content-Disposition: attachment; filename=orch-event.json",
    "",
    signedJson.trimEnd(),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const base = `${createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${eventId}`;
  const emlPath = `${pendingMailDir(args.threadDir)}/${base}.eml`;
  const metaPath = `${pendingMailDir(args.threadDir)}/${base}.json`;
  writeMailAtomic(emlPath, eml);
  writeJsonAtomic(metaPath, {
    kind: "mail",
    protocol: "orch.mail/v1",
    thread_id: parts.event.thread_id,
    ...parts.metadata,
    event_id: eventId,
    message_id: messageId,
    eml_path: emlPath,
    event_sha256: eventSha,
    created_at: createdAt,
  });
  return { eml_path: emlPath, meta_path: metaPath, event_id: eventId, message_id: messageId, event_sha256: eventSha };
}

export function composeDecisionMail(args: ComposeDecisionMailArgs): ComposeDecisionMailResult {
  return writeSignedMailEvent({
    threadDir: args.threadDir,
    build: ({ createdAt, eventId }) => {
      const event: DecisionRecordedMailEvent = {
        schema: "orch.mail/event/v1",
        type: "decision.recorded",
        event_id: eventId,
        created_at: createdAt,
        repo_key: args.repoKey,
        thread_id: args.threadId,
        parent_event_id: args.parentEventId ?? null,
        mr: args.mr,
        run_id: args.runId,
        decision: args.decision,
        result: {
          schema: args.result.schema,
          verdict: resultVerdict(args.result),
          summary: resultSummary(args.result),
        },
        status: {
          state: args.status?.state ?? "unknown",
          base_sha: args.status?.base_sha ?? "unknown",
          head_sha: args.status?.head_sha ?? null,
        },
      };
      return {
        event,
        from: args.from,
        to: args.to,
        subject: `[orch][thread:${args.threadId}][decision] ${args.decision.verdict} ${args.runId}`,
        text: [
          "orch decision event",
          "",
          `Thread: ${args.threadId}`,
          `Run: ${args.runId}`,
          `Decision: ${args.decision.verdict}`,
          `Reason: ${args.decision.reason ?? "none"}`,
          `Event: ${eventId}`,
        ].join("\n"),
        protocolHeaders: (eventSha) => [
          "X-Orch-Protocol: orch.mail/v1",
          `X-Orch-Repo-Key: ${normalizeHeaderValue(args.repoKey)}`,
          `X-Orch-MR: ${normalizeHeaderValue(args.mr)}`,
          `X-Orch-Thread-ID: ${normalizeHeaderValue(args.threadId)}`,
          `X-Orch-Run-ID: ${normalizeHeaderValue(args.runId)}`,
          `X-Orch-Event-ID: ${eventId}`,
          "X-Orch-Event-Type: decision.recorded",
          `X-Orch-Artifact-SHA256: ${eventSha}`,
        ],
        metadata: {
          mr: args.mr,
          run_id: args.runId,
        },
      };
    },
  });
}

export function composeTaskMail(args: ComposeTaskMailArgs): ComposeTaskMailResult {
  return writeSignedMailEvent({
    threadDir: args.threadDir,
    build: ({ createdAt, eventId }) => {
      const taskSha = sha256(args.taskText);
      const event: TaskRequestedMailEvent = {
        schema: "orch.mail/event/v1",
        type: "task.requested",
        event_id: eventId,
        created_at: createdAt,
        repo_key: args.repoKey,
        thread_id: args.threadId,
        parent_event_id: args.parentEventId ?? null,
        mr: args.mr ?? undefined,
        role: args.role,
        task: {
          body: args.taskText,
          sha256: taskSha,
        },
        workspace: args.workspace ?? undefined,
        assigned_agent: {
          id: args.agent.id,
          address: args.agent.address,
          provider: args.agent.provider,
          roles: args.agent.roles,
          capabilities: args.agent.capabilities,
          work_mode: args.agent.work_mode,
          provider_session_mode: args.agent.provider_session_mode,
        },
      };
      return {
        event,
        from: args.from,
        to: args.agent.address,
        subject: `[orch][thread:${args.threadId}][task:${args.role}] ${args.agent.id}`,
        text: [
          "orch task request",
          "",
          `Thread: ${args.threadId}`,
          `Role: ${args.role}`,
          `Agent: ${args.agent.id}`,
          `Provider: ${args.agent.provider}`,
          args.workspace ? `Workspace: ${args.workspace.id} (${args.workspace.path})` : "Workspace: none",
          `Event: ${eventId}`,
          "",
          args.taskText,
        ].join("\n"),
        protocolHeaders: (eventSha) => [
          "X-Orch-Protocol: orch.mail/v1",
          `X-Orch-Repo-Key: ${normalizeHeaderValue(args.repoKey)}`,
          `X-Orch-Thread-ID: ${normalizeHeaderValue(args.threadId)}`,
          `X-Orch-Agent-ID: ${normalizeHeaderValue(args.agent.id)}`,
          `X-Orch-Role: ${normalizeHeaderValue(args.role)}`,
          ...(args.mr ? [`X-Orch-MR: ${normalizeHeaderValue(args.mr)}`] : []),
          ...(args.parentEventId ? [`X-Orch-Parent-Event-ID: ${normalizeHeaderValue(args.parentEventId)}`] : []),
          `X-Orch-Event-ID: ${eventId}`,
          "X-Orch-Event-Type: task.requested",
          `X-Orch-Artifact-SHA256: ${eventSha}`,
        ],
        metadata: {
          role: args.role,
          agent_id: args.agent.id,
          task_sha256: taskSha,
          parent_event_id: args.parentEventId ?? null,
          mr: args.mr ?? null,
          workspace: args.workspace ?? null,
        },
      };
    },
  });
}

export function composeResultMail(args: ComposeResultMailArgs): ComposeResultMailResult {
  return writeSignedMailEvent({
    threadDir: args.threadDir,
    build: ({ createdAt, eventId }) => {
      const event: ResultSubmittedMailEvent = {
        schema: "orch.mail/event/v1",
        type: "result.submitted",
        event_id: eventId,
        created_at: createdAt,
        repo_key: args.repoKey,
        thread_id: args.threadId,
        parent_event_id: args.parentEventId ?? null,
        mr: args.mr ?? undefined,
        run_id: args.runId,
        result: {
          schema: args.result.schema,
          verdict: resultVerdict(args.result),
          summary: resultSummary(args.result),
        },
        from_agent: args.from,
      };
      return {
        event,
        from: args.from.address,
        to: args.to,
        subject: `[orch][thread:${args.threadId}][result] ${args.runId}`,
        headersBeforeDate: args.parentEventId ? [`In-Reply-To: <orch.${normalizeHeaderValue(args.parentEventId)}@local.orch>`] : [],
        text: [
          "orch result reply",
          "",
          `Thread: ${args.threadId}`,
          `Run: ${args.runId}`,
          `From-Agent: ${args.from.id}`,
          `Parent-Event: ${args.parentEventId ?? "none"}`,
          `Verdict: ${resultVerdict(args.result)}`,
          "",
          resultSummary(args.result),
        ].join("\n"),
        protocolHeaders: (eventSha) => [
          "X-Orch-Protocol: orch.mail/v1",
          `X-Orch-Repo-Key: ${normalizeHeaderValue(args.repoKey)}`,
          `X-Orch-Thread-ID: ${normalizeHeaderValue(args.threadId)}`,
          `X-Orch-Run-ID: ${normalizeHeaderValue(args.runId)}`,
          ...(args.mr ? [`X-Orch-MR: ${normalizeHeaderValue(args.mr)}`] : []),
          ...(args.parentEventId ? [`X-Orch-Parent-Event-ID: ${normalizeHeaderValue(args.parentEventId)}`] : []),
          `X-Orch-Event-ID: ${eventId}`,
          "X-Orch-Event-Type: result.submitted",
          `X-Orch-Artifact-SHA256: ${eventSha}`,
        ],
        metadata: {
          parent_event_id: args.parentEventId ?? null,
          mr: args.mr ?? null,
          run_id: args.runId,
        },
      };
    },
  });
}

function extractSignedEvent(raw: string): SignedMailEvent | null {
  const marker = "Content-Type: application/vnd.orch.signed-event+json";
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) return null;
  const bodyStart = raw.indexOf("\r\n\r\n", markerIndex);
  const altBodyStart = raw.indexOf("\n\n", markerIndex);
  const start = bodyStart >= 0 ? bodyStart + 4 : altBodyStart >= 0 ? altBodyStart + 2 : -1;
  if (start < 0) return null;
  const rest = raw.slice(start);
  const endCrLf = rest.indexOf("\r\n--");
  const endLf = rest.indexOf("\n--");
  const end = endCrLf >= 0 ? endCrLf : endLf >= 0 ? endLf : rest.length;
  try {
    return JSON.parse(rest.slice(0, end).trim()) as SignedMailEvent;
  } catch {
    return null;
  }
}

function importedEventIds(eventsPath: string): Set<string> {
  if (!existsSync(eventsPath)) return new Set();
  const ids = new Set<string>();
  for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { event_id?: unknown };
      if (typeof event.event_id === "string") ids.add(event.event_id);
    } catch {
      // Ignore corrupt old lines; import should not destroy the append-only log.
    }
  }
  return ids;
}

function globalQuarantine(raw: string, reason: string): AutoImportMailResult {
  const rawHash = sha256(raw);
  const dir = `${orchStateRoot()}/mail/quarantine`;
  mkdirSync(dir, { recursive: true });
  const rawPath = `${dir}/${rawHash}.eml`;
  const quarantinePath = `${dir}/${rawHash}.json`;
  writeTextAtomic(rawPath, raw);
  writeJsonAtomic(quarantinePath, { raw_path: rawPath, reason, quarantined_at: new Date().toISOString() });
  return { imported: false, raw_path: rawPath, quarantine_path: quarantinePath, reason };
}

export function importMailAuto(raw: string): AutoImportMailResult {
  const signed = extractSignedEvent(raw);
  const identity = ensureMailIdentity();
  if (!signed) return globalQuarantine(raw, "missing signed orch event");
  if (!verifySignedEvent(signed, identity)) return globalQuarantine(raw, "invalid orch event signature");
  const threadDir = mailThreadDir(signed.event.repo_key, signed.event.thread_id);
  return {
    ...importMailRaw(threadDir, raw, signed.event.thread_id, signed.event.repo_key),
    repo_key: signed.event.repo_key,
    thread_id: signed.event.thread_id,
  };
}
export function importMailFile(threadDir: string, file: string, expectedThreadId?: string, expectedRepoKey?: string): ImportMailResult {
  return importMailRaw(threadDir, readFileSync(file, "utf8"), expectedThreadId, expectedRepoKey);
}

export function importMailRaw(threadDir: string, raw: string, expectedThreadId?: string, expectedRepoKey?: string): ImportMailResult {
  ensureMailDirs(threadDir);
  const rawHash = sha256(raw);
  const rawPath = `${inboxRawDir(threadDir)}/${rawHash}.eml`;
  writeTextAtomic(rawPath, raw);

  const signed = extractSignedEvent(raw);
  const identity = ensureMailIdentity();
  if (!signed) return quarantine(threadDir, rawPath, rawHash, "missing signed orch event");
  if (!verifySignedEvent(signed, identity)) return quarantine(threadDir, rawPath, rawHash, "invalid orch event signature");
  if (expectedThreadId && signed.event.thread_id !== expectedThreadId) return quarantine(threadDir, rawPath, rawHash, "orch event thread mismatch");
  if (expectedRepoKey && signed.event.repo_key !== expectedRepoKey) return quarantine(threadDir, rawPath, rawHash, "orch event repo mismatch");

  const eventsPath = `${inboxEventsDir(threadDir)}/mail-events.jsonl`;
  const seen = importedEventIds(eventsPath);
  if (!seen.has(signed.event.event_id)) appendJsonLine(eventsPath, signed.event);
  return {
    imported: !seen.has(signed.event.event_id),
    raw_path: rawPath,
    event_path: eventsPath,
    event_id: signed.event.event_id,
  };
}

function quarantine(threadDir: string, rawPath: string, rawHash: string, reason: string): ImportMailResult {
  const quarantinePath = `${quarantineDir(threadDir)}/${rawHash}.json`;
  writeJsonAtomic(quarantinePath, { raw_path: rawPath, reason, quarantined_at: new Date().toISOString() });
  return { imported: false, raw_path: rawPath, quarantine_path: quarantinePath, reason };
}

export function pendingLocalMailFiles(threadDir: string): string[] {
  const dir = pendingMailDir(threadDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".eml"))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

export function deliverLocalMail(threadDir: string): Array<{ from: string; to: string; maildir: string }> {
  ensureMailDirs(threadDir);
  const delivered: Array<{ from: string; to: string; maildir: string }> = [];
  for (const from of pendingLocalMailFiles(threadDir)) {
    const file = from.split("/").pop()!;
    const raw = readFileSync(from, "utf8");
    const to = `${inboxRawDir(threadDir)}/${file}`;
    const maildirTmp = `${maildirDir(threadDir)}/tmp/${file}`;
    const maildirNew = `${maildirDir(threadDir)}/new/${file}`;
    writeTextAtomic(to, raw);
    writeFileSync(maildirTmp, raw, "utf8");
    renameSync(maildirTmp, maildirNew);
    renameSync(from, `${sentMailDir(threadDir)}/${file}`);
    const meta = from.replace(/\.eml$/, ".json");
    if (existsSync(meta)) renameSync(meta, `${sentMailDir(threadDir)}/${file.replace(/\.eml$/, ".json")}`);
    delivered.push({ from, to, maildir: maildirNew });
  }
  return delivered;
}
