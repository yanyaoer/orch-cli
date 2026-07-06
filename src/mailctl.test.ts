import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mailControlConfigPath,
  readMailAgentsConfig,
  readMailControlConfig,
  writeOrchConfig,
  type MailControlConfig,
} from "./config.ts";
import { readJsonFile, writeJsonAtomic } from "./json.ts";
import { acquirePidfileLock } from "./locks.ts";
import { mailEventsPath } from "./mail.ts";
import {
  attentionDonePath,
  attentionPath,
  auditPath,
  buildControllerTask,
  cursorPath,
  evaluateGate,
  ingestLockPath,
  mailctlAck,
  mailctlGuidance,
  mailctlInit,
  mailctlPoll,
  mailctlReconcile,
  mailctlReply,
  mailctlStatus,
  mailctlThreadStatePath,
  mailctlWatch,
  mergeThread,
  messageMarkerPath,
  normalizeMessageId,
  outboxEmailPendingDir,
  outboxEmailSentDir,
  renderMailctlGuidance,
  renderMailctlStatus,
  resolveWorkspace,
  sha12,
  taskFilePath,
  threadMapPath,
  watchLockPath,
  type MailCursor,
  type MailMessageRef,
  type MailTransport,
  type MailctlContext,
  type PollFault,
} from "./mailctl.ts";
import type { MailCliContext } from "./mail-cli.ts";
import { parseArgs } from "./cli.ts";

type ConfigOverrides = Partial<MailControlConfig> & {
  account?: Partial<MailControlConfig["account"]>;
  imap?: Partial<MailControlConfig["imap"]>;
  smtp?: Partial<MailControlConfig["smtp"]>;
  controller?: Partial<MailControlConfig["controller"]>;
  reports?: Partial<MailControlConfig["reports"]>;
};

const previousStateHome = process.env.XDG_STATE_HOME;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousMirrorAllow = process.env.ORCH_MIRROR_ALLOW_PRIVATE;
const previousFakeResult = process.env.ORCH_DRIVER_FAKE_RESULT;
const previousFakeOrchState = process.env.FAKE_ORCH_STATE;
const previousFakeOrchStatus = process.env.FAKE_ORCH_STATUS;

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousMirrorAllow === undefined) delete process.env.ORCH_MIRROR_ALLOW_PRIVATE;
  else process.env.ORCH_MIRROR_ALLOW_PRIVATE = previousMirrorAllow;
  if (previousFakeResult === undefined) delete process.env.ORCH_DRIVER_FAKE_RESULT;
  else process.env.ORCH_DRIVER_FAKE_RESULT = previousFakeResult;
  if (previousFakeOrchState === undefined) delete process.env.FAKE_ORCH_STATE;
  else process.env.FAKE_ORCH_STATE = previousFakeOrchState;
  if (previousFakeOrchStatus === undefined) delete process.env.FAKE_ORCH_STATUS;
  else process.env.FAKE_ORCH_STATUS = previousFakeOrchStatus;
});

function config(overrides: ConfigOverrides = {}): MailControlConfig {
  const base: MailControlConfig = {
    version: 1,
    account: { user: "bot@example.com" },
    imap: { host: "imap.example.com", port: 993 },
    smtp: { host: "smtp.example.com", port: 465, mode: "implicit" },
    allowed_senders: ["owner@example.com"],
    trusted_authserv_id: "mx.trusted.example",
    workspace: "default-ws",
    reconcile_interval_sec: 60,
    subject_token: null,
    require_auth_results: true,
    controller: { agent: "claude", model: null, timeout_sec: 1800, max_spawns_per_hour: 6 },
    reports: { policy: "auto", max_per_hour: 4, max_body_bytes: 16384 },
  };
  return {
    ...base,
    ...overrides,
    account: { ...base.account, ...overrides.account },
    imap: { ...base.imap, ...overrides.imap },
    smtp: { ...base.smtp, ...overrides.smtp },
    controller: { ...base.controller, ...overrides.controller },
    reports: { ...base.reports, ...overrides.reports },
  };
}

function authPass(domain = "example.com"): string {
  return `Authentication-Results: mx.trusted.example; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
}

function textMail(options: {
  from?: string;
  subject?: string;
  body?: string;
  headers?: string[];
  messageId?: string | null;
  contentType?: string;
} = {}): string {
  const headers = [
    `From: ${options.from ?? "Owner <owner@example.com>"}`,
    `Subject: ${options.subject ?? "Task"}`,
    ...(options.messageId === null ? [] : [`Message-ID: ${options.messageId ?? "<task@example.com>"}`]),
    ...(options.headers ?? [authPass()]),
    `Content-Type: ${options.contentType ?? "text/plain; charset=utf-8"}`,
  ];
  return [...headers, "", options.body ?? "Do the work"].join("\r\n");
}

class FakeTransport implements MailTransport {
  marks: number[] = [];
  sent: string[] = [];
  failList: Error | null = null;
  failSend = false;
  idleCalls = 0;
  listCalls = 0;

  constructor(public messages: Array<{ ref: MailMessageRef; raw: string }> = []) {}

  async listNew(_sinceDays: number, _cursor: MailCursor | null): Promise<MailMessageRef[]> {
    this.listCalls += 1;
    if (this.failList) throw this.failList;
    return this.messages.map((message) => message.ref);
  }

  async fetchRaw(ref: MailMessageRef): Promise<string> {
    const message = this.messages.find((item) => item.ref.uid === ref.uid);
    if (!message) throw new Error(`missing fake message ${ref.uid}`);
    return message.raw;
  }

  async markProcessed(ref: MailMessageRef): Promise<void> {
    this.marks.push(ref.uid);
  }

  async sendReply(rfc822: string): Promise<void> {
    if (this.failSend) throw new Error("fake smtp failure");
    this.sent.push(rfc822);
  }

  async idleOnce(): Promise<void> {
    this.idleCalls += 1;
  }
}

function setupMailctl(overrides: ConfigOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "orch-mailctl-state-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  writeOrchConfig({
    version: 1,
    workspaces: {
      "default-ws": { id: "default-ws", path: workspace, added_at: "2026-07-04T00:00:00.000Z" },
      "other-ws": { id: "other-ws", path: workspace, added_at: "2026-07-04T00:00:00.000Z" },
    },
  });
  return { root, workspace, cfg: config({ require_auth_results: false, ...overrides }) };
}

function fakeContext(args: {
  cfg?: MailControlConfig;
  transport: FakeTransport;
  now?: number;
  orch?: MailCliContext;
}): MailctlContext {
  return {
    config: args.cfg ?? config({ require_auth_results: false }),
    transport: args.transport,
    now: () => args.now ?? Date.parse("2026-07-04T08:56:28.000Z"),
    orch:
      args.orch ??
      ({
        orchCommand: () => [process.execPath, join(process.cwd(), "src/orch.ts")],
        locateRun: () => {
          throw new Error("unused");
        },
        readMirrorResult: () => {
          throw new Error("unused");
        },
      } satisfies MailCliContext),
  };
}

function message(uid: number, messageId: string, body = `Do task ${uid}`, headers: string[] = []): { ref: MailMessageRef; raw: string } {
  return {
    ref: { uid },
    raw: textMail({ messageId, body, headers }),
  };
}

function stateFiles(): string[] {
  const dir = join(process.env.XDG_STATE_HOME!, "orch", "mail-control", "threads");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => join(dir, name)).sort();
}

function firstThreadState(): any {
  const file = stateFiles()[0];
  if (!file) throw new Error("missing thread state");
  return JSON.parse(readFileSync(file, "utf8"));
}

function markerFiles(): string[] {
  const dir = join(process.env.XDG_STATE_HOME!, "orch", "mail-control", "messages");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => join(dir, name)).sort();
}

function attentionFiles(): string[] {
  const dir = join(process.env.XDG_STATE_HOME!, "orch", "mail-control", "controller", "attention");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => join(dir, name)).sort();
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => join(dir, name)).sort();
}

function auditRows(): any[] {
  if (!existsSync(auditPath())) return [];
  return readFileSync(auditPath(), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function busEvents(state = firstThreadState()): any[] {
  return readFileSync(mailEventsPath(state.thread_dir), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runOrch(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function writeFakeOrch(root: string): MailCliContext {
  const script = join(root, "fake-orch.ts");
  writeFileSync(
    script,
    `
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateRoot = process.env.FAKE_ORCH_STATE!;
function flag(name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || args[index + 1] === undefined) throw new Error("missing " + name);
  return args[index + 1]!;
}
function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

if (args[0] === "run" && args[1] === "create") {
  const key = flag("--idempotency-key");
  const runId = "run-" + safe(key);
  const runDir = join(stateRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const status = {
    run_id: runId,
    mr: flag("--mr"),
    role: flag("--role"),
    agent: flag("--agent"),
    tag: flag("--tag"),
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    state: process.env.FAKE_ORCH_STATUS ?? "created",
    pid: null,
    pgid: null,
    started_at: null,
    updated_at: new Date().toISOString(),
    exit_code: null,
    timeout_sec: Number(flag("--timeout-sec")),
    last_event_seq: 0,
    native_event_count: 0,
    provider_resume_id: null,
    worktree: flag("--worktree"),
    base_sha: "base",
    head_sha: null
  };
  writeFileSync(join(runDir, "status.json"), JSON.stringify(status, null, 2) + "\\n");
  console.log(JSON.stringify({ run_id: runId, run_dir: runDir, status_path: join(runDir, "status.json"), state: status.state }));
  process.exit(0);
}

if (args[0] === "decision" && args[1] === "close") {
  const runId = flag("--run");
  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name !== runId) continue;
    writeFileSync(join(stateRoot, entry.name, "decision.json"), JSON.stringify({ verdict: "close", run_id: runId, reason: "fake", ts: new Date().toISOString() }, null, 2) + "\\n");
    console.log(JSON.stringify({ decision: "close", run_id: runId }));
    process.exit(0);
  }
  console.error("run not found");
  process.exit(1);
}

console.error("unexpected fake orch argv " + args.join(" "));
process.exit(1);
`,
    "utf8",
  );
  const fakeState = join(root, "fake-orch-state");
  mkdirSync(fakeState, { recursive: true });
  process.env.FAKE_ORCH_STATE = fakeState;
  return {
    orchCommand: () => [process.execPath, script],
    locateRun: () => {
      throw new Error("unused");
    },
    readMirrorResult: () => {
      throw new Error("unused");
    },
  };
}

describe("mailctl state layout", () => {
  it("builds mail-control state paths and normalizes message ids", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-mailctl-paths-"));
    process.env.XDG_STATE_HOME = join(root, "state");
    const dir = join(root, "state", "orch", "mail-control");

    expect(ingestLockPath()).toBe(join(dir, "ingest.lock"));
    expect(watchLockPath()).toBe(join(dir, "watch.lock"));
    expect(cursorPath()).toBe(join(dir, "cursor.json"));
    expect(messageMarkerPath("abc123")).toBe(join(dir, "messages", "abc123.json"));
    expect(threadMapPath("thread123")).toBe(join(dir, "threads", "thread123.json"));
    expect(taskFilePath("em-thread123", "20260704T083031Z")).toBe(join(dir, "tasks", "em-thread123-20260704T083031Z.md"));
    expect(auditPath()).toBe(join(dir, "audit.jsonl"));
    expect(sha12("hello")).toHaveLength(12);
    expect(normalizeMessageId("<Local.Part@Example.COM>")).toBe("<Local.Part@example.com>");
    expect(normalizeMessageId("not a message id", "Message-ID: not a message id")).toBe(sha12("Message-ID: not a message id"));
  });
});

describe("mailctlInit", () => {
  it("writes a 0600 config, seeds default agents, and rejects invalid flags", () => {
    const root = mkdtempSync(join(tmpdir(), "orch-mailctl-init-"));
    process.env.XDG_CONFIG_HOME = join(root, "config");
    const result = mailctlInit(
      parseArgs([
        "mailctl",
        "init",
        "--user",
        "bot@example.com",
        "--imap-host",
        "imap.example.com",
        "--smtp-host",
        "smtp.example.com",
        "--allow",
        "Owner <OWNER@example.com>",
        "--workspace",
        "default-ws",
        "--password-cmd",
        '["printf","secret"]',
        "--subject-token",
        "[orch-control]",
      ]),
    );

    expect(result.config_path).toBe(mailControlConfigPath());
    expect(result.trusted_authserv_id).toBe("example.com");
    expect(result.agents_seeded).toContain("orch-router");
    expect(statSync(mailControlConfigPath()).mode & 0o777).toBe(0o600);
    expect(readMailControlConfig()).toMatchObject({
      account: { user: "bot@example.com", password_cmd: ["printf", "secret"] },
      imap: { host: "imap.example.com", port: 993 },
      smtp: { host: "smtp.example.com", port: 465, mode: "implicit" },
      allowed_senders: ["owner@example.com"],
      trusted_authserv_id: "example.com",
      subject_token: "[orch-control]",
    });
    expect(readMailAgentsConfig().agents["codex-implementer"]).toBeDefined();

    expect(() =>
      mailctlInit(parseArgs(["mailctl", "init", "--user", "bot@example.com", "--imap-host", "imap.example.com", "--smtp-host", "smtp.example.com", "--workspace", "default-ws"])),
    ).toThrow("--allow");
    expect(() =>
      mailctlInit(
        parseArgs([
          "mailctl",
          "init",
          "--user",
          "bot@example.com",
          "--imap-host",
          "imap.example.com",
          "--smtp-host",
          "smtp.example.com",
          "--allow",
          "owner@example.com",
          "--workspace",
          "default-ws",
          "--password-cmd",
          "{}",
        ]),
      ),
    ).toThrow("--password-cmd");
  });
});

describe("evaluateGate", () => {
  it("requires exactly one From header with exactly one mailbox", () => {
    const multiMailbox = textMail({ from: "Owner <owner@example.com>, Attacker <attacker@evil.example>" });
    expect(evaluateGate(multiMailbox, config(), "bot@example.com")).toMatchObject({
      accepted: false,
      rejectReason: "sender",
      from: null,
    });

    const duplicateFrom = textMail({ headers: ["From: Attacker <attacker@evil.example>", authPass()] });
    expect(evaluateGate(duplicateFrom, config(), "bot@example.com")).toMatchObject({
      accepted: false,
      rejectReason: "sender",
      from: null,
    });

    expect(evaluateGate(textMail(), config(), "bot@example.com")).toMatchObject({ accepted: true, from: "owner@example.com" });
  });

  it("rejects self-loop mail and accepts a clean allowlisted authenticated message", () => {
    const noAuth = config({ require_auth_results: false });

    expect(
      evaluateGate(
        textMail({ from: "Bot <bot@example.com>", headers: [], body: "work" }),
        config({ allowed_senders: ["bot@example.com"], require_auth_results: false }),
        "bot@example.com",
      ).rejectReason,
    ).toBe("self");
    expect(evaluateGate(textMail({ headers: ["Auto-Submitted: auto-replied"], body: "work" }), noAuth, "bot@example.com").rejectReason).toBe("auto");
    expect(evaluateGate(textMail({ headers: ["Precedence: bulk"], body: "work" }), noAuth, "bot@example.com").rejectReason).toBe("auto");
    expect(evaluateGate(textMail({ headers: [], body: "[orch:progress:abc]\nDone" }), noAuth, "bot@example.com").rejectReason).toBe("sentinel");
    expect(evaluateGate(textMail({ headers: [], messageId: "<orch-self@localhost>", body: "work" }), noAuth, "bot@example.com").rejectReason).toBe("self");
    expect(evaluateGate(textMail(), config(), "bot@example.com")).toMatchObject({ accepted: true });
  });

  it("rejects spoofed Authentication-Results and accepts trusted aligned pass", () => {
    const spoofed = textMail({
      headers: [
        "Authentication-Results: attacker.invalid; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
        "Authentication-Results: mx.trusted.example; dkim=fail header.d=example.com; dmarc=fail header.from=example.com",
      ],
    });
    expect(evaluateGate(spoofed, config(), "bot@example.com")).toMatchObject({ accepted: false, rejectReason: "auth" });

    const trusted = textMail({
      headers: [authPass()],
      contentType: 'multipart/alternative; boundary="alt"',
      body: ["--alt", "Content-Type: text/plain; charset=utf-8", "", "plain task", "--alt--", ""].join("\r\n"),
    });
    expect(evaluateGate(trusted, config(), "bot@example.com")).toMatchObject({ accepted: true, bodyText: "plain task" });
  });

  it("rejects HTML-only mail and ignores text/plain attachments as instruction text", () => {
    const htmlOnly = textMail({
      contentType: "text/html; charset=utf-8",
      body: "<p>Do the work</p>",
    });
    expect(evaluateGate(htmlOnly, config(), "bot@example.com")).toMatchObject({ accepted: false, rejectReason: "html_only" });

    const htmlWithPlainAttachment = textMail({
      contentType: 'multipart/mixed; boundary="mix"',
      body: [
        "--mix",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>HTML instruction</p>",
        "--mix",
        "Content-Type: text/plain; charset=utf-8",
        'Content-Disposition: attachment; filename="task.txt"',
        "",
        "attachment instruction",
        "--mix--",
        "",
      ].join("\r\n"),
    });
    expect(evaluateGate(htmlWithPlainAttachment, config(), "bot@example.com")).toMatchObject({
      accepted: false,
      rejectReason: "html_only",
      bodyText: "HTML instruction",
    });
  });

  it("rejects parse exceptions and does not throw on out-of-range HTML entities", () => {
    const htmlWithInvalidEntity = textMail({
      contentType: "text/html; charset=utf-8",
      body: "<p>&#999999999999999999999999;</p>",
    });
    expect(() => evaluateGate(htmlWithInvalidEntity, config(), "bot@example.com")).not.toThrow();
    expect(evaluateGate(htmlWithInvalidEntity, config(), "bot@example.com")).toMatchObject({
      accepted: false,
      rejectReason: "html_only",
    });

    const fromCodePoint = String.fromCodePoint;
    try {
      String.fromCodePoint = (() => {
        throw new RangeError("parser failed");
      }) as typeof String.fromCodePoint;
      const parserFailure = textMail({
        contentType: "text/html; charset=utf-8",
        body: "<p>&#65;</p>",
      });
      expect(evaluateGate(parserFailure, config(), "bot@example.com")).toMatchObject({
        accepted: false,
        rejectReason: "parse_error",
      });
    } finally {
      String.fromCodePoint = fromCodePoint;
    }
  });
});

describe("resolveWorkspace", () => {
  it("prefers subject workspace tag over body line over config default", () => {
    const cfg = config({ workspace: "default-id" });
    expect(resolveWorkspace(textMail({ subject: "[ws:subject-id] Task", body: "Workspace: body-id\nDo it" }), cfg)).toBe("subject-id");
    expect(resolveWorkspace(textMail({ subject: "Task", body: "Workspace: body-id\nDo it" }), cfg)).toBe("body-id");
    expect(resolveWorkspace(textMail({ subject: "Task", body: "Do it" }), cfg)).toBe("default-id");
  });

  it("accepts only safe subject workspace ids", () => {
    const cfg = config({ workspace: "default-id" });
    expect(resolveWorkspace(textMail({ subject: "[ws:../x] Task", body: "Do it" }), cfg)).toBe("default-id");
    expect(resolveWorkspace(textMail({ subject: "[ws:my_ws-1] Task", body: "Do it" }), cfg)).toBe("my_ws-1");
  });
});

describe("mergeThread", () => {
  it("merges by References hits, does not merge by subject alone, and uses fallback keys without Message-ID", () => {
    const knownThreads = [{ orch_thread: "em-known", message_ids: ["<root@example.com>"] }];
    const reply = textMail({
      subject: "Same subject",
      messageId: "<reply@example.com>",
      headers: [authPass(), "References: <root@Example.COM>"],
    });
    expect(mergeThread(reply, knownThreads)).toMatchObject({
      thread: "em-known",
      isNew: false,
      matchedMessageId: "<root@example.com>",
    });

    const sameSubjectOnly = textMail({ subject: "Same subject", messageId: "<new@example.com>" });
    const sameSubjectResult = mergeThread(sameSubjectOnly, knownThreads);
    expect(sameSubjectResult.isNew).toBe(true);
    expect(sameSubjectResult.thread).not.toBe("em-known");

    const missingMessageId = textMail({ subject: "No id", messageId: null });
    const missingResult = mergeThread(missingMessageId, []);
    expect(missingResult.isNew).toBe(true);
    expect(missingResult.messageId).toHaveLength(12);
    expect(missingResult.thread).toBe(`em-${missingResult.messageId}`);
  });
});

describe("buildControllerTask", () => {
  it("includes controller constraints, orchestration commands, and unacked mail text", () => {
    const task = buildControllerTask({
      thread: "abc123",
      workspace: "default-ws",
      triggerReason: "T1 unacked attention",
      unackedMailText: "Please implement the parser\npassword=ABCDEFGHIJKLMNOPQRST\nSee /Users/example/project",
      notesTail: "previous note",
      sentReportSummary: "none yet",
    });

    expect(task.toLowerCase()).toContain("headless");
    expect(task.toLowerCase()).toContain("non-interactive");
    expect(task).toContain("Do NOT enter plan mode");
    expect(task).toContain("Do NOT call ExitPlanMode");
    expect(task).toContain("If a step would need a tool you do not have, SKIP it");
    expect(task).toContain("You have no Edit/Write; dispatch a worker to change code");
    expect(task).toContain("Your only tools are Bash for `orch ...` commands plus read-only Read/Grep/Glob/LS");
    expect(task).toContain("orch fanout/cross-review --thread em-abc123 --task <file>");
    expect(task).toContain("check the workspace repo for docs/adr/ and docs/specs/");
    expect(task).toContain("inline the relevant excerpts (not just file paths) into the --task file");
    expect(task).toContain("Classify each inbound instruction before acting");
    expect(task).toContain("ready-for-agent");
    expect(task).toContain("needs-info");
    expect(task).toContain("ready-for-human");
    expect(task).toContain("numbered questions");
    expect(task).toContain("recommended answer");
    expect(task).toContain("recommendations apply if no reply arrives");
    expect(task).toContain("do not cap the number of clarification questions");
    expect(task).toContain("confirm the claim with a read-only orch investigate before dispatching an implementer");
    expect(task).toContain("report that instead of fixing an unverified claim");
    expect(task).toContain("When authoring a debugger-role task");
    expect(task).toContain("red-capable reproduction command");
    expect(task).toContain("result tests[] field BEFORE attempting a fix");
    expect(task).toContain("3-5 ranked falsifiable hypotheses");
    expect(task).toContain("[DEBUG-xxxx]");
    expect(task).toContain("grep it away before finishing");
    expect(task).toContain("orch decision accept|rework");
    expect(task).toContain("orch mailctl ack --thread em-abc123");
    expect(task).toContain("orch mailctl reply --report-key");
    expect(task).toContain("summary field");
    expect(task).toContain("Please implement the parser");
    expect(task).not.toContain("notes.md");
    expect(task).not.toContain("/Users/example/project");
    expect(task).not.toContain("ABCDEFGHIJKLMNOPQRST");
  });
});

describe("mailctlPoll stateful cycle", () => {
  it("closes poll crash windows without duplicating router tasks", async () => {
    const faults: PollFault[] = ["publish-before-marker", "attention-before-marker", "marker-before-STORE", "before-cursor"];
    for (const fault of faults) {
      const { cfg } = setupMailctl();
      const transport = new FakeTransport([message(1, `<${fault}@example.com>`)]);
      const ctx = fakeContext({ cfg, transport });

      await expect(mailctlPoll(ctx, { fault, reconcile: false })).rejects.toThrow("injected mailctl poll fault");
      const second = await mailctlPoll(ctx, { reconcile: false });
      const third = await mailctlPoll(ctx, { reconcile: false });

      expect(second.errors).toBe(0);
      expect(third.fetched).toBe(0);
      expect(markerFiles()).toHaveLength(1);
      expect(attentionFiles()).toHaveLength(1);
      const events = busEvents();
      expect(events.filter((event) => event.type === "task.requested" && event.role === "router")).toHaveLength(1);
      expect(events.filter((event) => event.type === "task.requested" && event.role === "implementer")).toHaveLength(0);
      const state = firstThreadState();
      expect(state.last_instruction_event_id).toBe(events[0].event_id);
      expect(state.status).toBe("active");
      expect(transport.marks).toContain(1);
    }
  });

  it("silently skips when ingest.lock is held and then processes once", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([message(1, "<locked@example.com>")]);
    const ctx = fakeContext({ cfg, transport });
    const lock = acquirePidfileLock(ingestLockPath(), process.pid, "test-lock");
    try {
      const skipped = await mailctlPoll(ctx, { reconcile: false });
      expect(skipped.skipped).toBe(true);
      expect(markerFiles()).toHaveLength(0);
    } finally {
      lock.release();
    }

    const processed = await mailctlPoll(ctx, { reconcile: false });
    expect(processed.accepted).toBe(1);
    expect(markerFiles()).toHaveLength(1);
    expect(attentionFiles()).toHaveLength(1);
    expect(busEvents().filter((event) => event.type === "task.requested")).toHaveLength(1);
  });

  it("rejects a reused Message-ID when raw_sha differs", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([
      message(1, "<conflict@example.com>", "First task"),
      message(2, "<conflict@example.com>", "Different task under reused Message-ID"),
    ]);
    const ctx = fakeContext({ cfg, transport });

    const result = await mailctlPoll(ctx, { reconcile: false });
    const markers = markerFiles().map((path) => readJsonFile<any>(path, null));
    const conflict = markers.find((marker) => marker.status === "rejected_conflict");

    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.duplicate).toBe(0);
    expect(markers.map((marker) => marker.status).sort()).toEqual(["accepted", "rejected_conflict"]);
    expect(conflict).toMatchObject({ message_id: "<conflict@example.com>", uid: 2, thread_synced: true, flag_synced: true });
    expect(transport.marks).toEqual([1, 2]);
    expect(busEvents().filter((event) => event.type === "task.requested" && event.role === "router")).toHaveLength(1);
    expect(auditRows().some((row) => row.type === "rejected_conflict" && row.message_id === "<conflict@example.com>")).toBe(true);
  });

  it("terminally rejects accepted mail whose workspace cannot resolve", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([
      {
        ref: { uid: 1 },
        raw: textMail({ subject: "[ws:missing-ws] Task", messageId: "<missing-ws@example.com>", body: "Do task" }),
      },
    ]);
    const ctx = fakeContext({ cfg, transport });

    const result = await mailctlPoll(ctx, { reconcile: false });
    const markers = markerFiles().map((path) => readJsonFile<any>(path, null));
    const cursor = readJsonFile<any>(cursorPath(), null);
    const retry = await mailctlPoll(ctx, { reconcile: false });

    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.errors).toBe(0);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ status: "rejected_error", message_id: "<missing-ws@example.com>", uid: 1, flag_synced: true });
    expect(cursor.last_uid).toBe(1);
    expect(transport.marks).toEqual([1]);
    expect(retry.fetched).toBe(0);
    expect(retry.duplicate).toBe(1);
    expect(auditRows().some((row) => row.type === "rejected_error" && String(row.error).includes("missing-ws"))).toBe(true);
  });

  it("rejects self-loop and automated mail before task publication", async () => {
    const { cfg } = setupMailctl({ allowed_senders: ["owner@example.com", "bot@example.com"] });
    const transport = new FakeTransport([
      { ref: { uid: 1 }, raw: textMail({ from: "Bot <bot@example.com>", headers: [], messageId: "<self-from@example.com>" }) },
      { ref: { uid: 2 }, raw: textMail({ headers: ["Auto-Submitted: auto-replied"], messageId: "<auto@example.com>" }) },
      { ref: { uid: 3 }, raw: textMail({ headers: ["Precedence: list"], messageId: "<list@example.com>" }) },
      { ref: { uid: 4 }, raw: textMail({ headers: [], body: "[orch:reply]\nbody", messageId: "<sentinel@example.com>" }) },
      { ref: { uid: 5 }, raw: textMail({ headers: [], messageId: "<orch-generated@localhost>" }) },
    ]);
    const result = await mailctlPoll(fakeContext({ cfg, transport }), { reconcile: false });

    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(5);
    expect(stateFiles()).toHaveLength(0);
    expect(attentionFiles()).toHaveLength(0);
    expect(markerFiles()).toHaveLength(5);
  });

  it("reopens a settled thread and preserves decision bytes", async () => {
    const { cfg } = setupMailctl();
    const rootMail = message(1, "<root-reopen@example.com>", "First task");
    const transport = new FakeTransport([rootMail]);
    const ctx = fakeContext({ cfg, transport });
    await mailctlPoll(ctx, { reconcile: false });
    const state = firstThreadState();
    const decision = { verdict: "completed", note: "keep me byte-identical" };
    writeJsonAtomic(mailctlThreadStatePath(state.thread), { ...state, status: "settled", decision });
    const before = JSON.stringify(readJsonFile<any>(mailctlThreadStatePath(state.thread), null).decision);

    transport.messages = [
      rootMail,
      {
        ref: { uid: 2 },
        raw: textMail({
          subject: "Re: Task",
          messageId: "<reply-reopen@example.com>",
          headers: [`References: <root-reopen@example.com>`],
          body: "Follow up",
        }),
      },
    ];
    await mailctlPoll(ctx, { reconcile: false });
    const reopened = readJsonFile<any>(mailctlThreadStatePath(state.thread), null);
    const events = busEvents(reopened);

    expect(reopened.status).toBe("active");
    expect(JSON.stringify(reopened.decision)).toBe(before);
    expect(events.filter((event) => event.type === "task.requested" && event.role === "router")).toHaveLength(2);
    expect(events[1].parent_event_id).toBe(events[0].event_id);
    expect(reopened.last_instruction_event_id).toBe(events[1].event_id);
  });

  it("publishes only a router event and spawns generation-keyed controllers with liveness checks", async () => {
    const { root, cfg } = setupMailctl();
    process.env.ORCH_DRIVER_FAKE_RESULT = "1";
    const orch = writeFakeOrch(root);
    const transport = new FakeTransport([message(1, "<controller@example.com>")]);
    const ctx = fakeContext({ cfg, transport, orch });

    const polled = await mailctlPoll(ctx);
    const state = firstThreadState();
    const events = busEvents(state);
    expect(events.filter((event) => event.type === "task.requested" && event.role === "router")).toHaveLength(1);
    expect(events.filter((event) => event.type === "task.requested" && event.role === "implementer")).toHaveLength(0);
    expect(polled.reconciled?.spawned).toHaveLength(1);
    const firstSpawn = polled.reconciled?.spawned[0];
    expect(firstSpawn).toBeDefined();
    expect(firstSpawn!.gen).toBe(0);

    const live = await mailctlReconcile(ctx);
    expect(live.spawned).toHaveLength(0);
    expect(live.live).toHaveLength(1);

    const afterLive = readJsonFile<any>(mailctlThreadStatePath(state.thread), null);
    const gen0 = afterLive.controller.generations[0];
    const status = readJsonFile<any>(gen0.status_path, null);
    writeJsonAtomic(gen0.status_path, { ...status, state: "failed", updated_at: new Date(Date.now() - 2_000).toISOString() });

    const retry = await mailctlReconcile(ctx);
    expect(retry.closed.map((item) => item.run_id)).toContain(gen0.run_id);
    expect(retry.spawned).toHaveLength(1);
    const retrySpawn = retry.spawned[0];
    expect(retrySpawn).toBeDefined();
    expect(retrySpawn!.gen).toBe(1);
    const afterRetry = readJsonFile<any>(mailctlThreadStatePath(state.thread), null);
    expect(afterRetry.controller.generations).toHaveLength(2);
    expect(afterRetry.controller.generations[1].idempotency_key).toBe(`ctrl:${state.thread}:1`);
  });

  it("feeds second-generation controller tasks from the prior controller result summary", async () => {
    const { root, cfg } = setupMailctl();
    const baseOrch = writeFakeOrch(root);
    const priorSummary = "handoff: ack attention before sending the final report";
    const locatedRuns: string[] = [];
    const readRuns: string[] = [];
    const orch: MailCliContext = {
      ...baseOrch,
      locateRun: (repoKey, runId, mr) => {
        locatedRuns.push(`${repoKey}:${runId}:${mr ?? ""}`);
        return { mr: mr ?? "mailctl-unknown", run_id: runId, run_dir: join(process.env.FAKE_ORCH_STATE!, runId) };
      },
      readMirrorResult: (runsRoot, runId) => {
        readRuns.push(`${runsRoot}:${runId}`);
        return {
          result: {
            schema: "orch.result/controller/v1",
            run_id: runId,
            verdict: "completed",
            summary: priorSummary,
            actions: ["orch mailctl ack --thread em-x --attention msg"],
          },
          status: null,
        };
      },
    };
    const transport = new FakeTransport([message(1, "<controller-summary@example.com>")]);
    const ctx = fakeContext({ cfg, transport, orch });

    await mailctlPoll(ctx);
    const state = firstThreadState();
    const gen0 = state.controller.generations[0];
    const status = readJsonFile<any>(gen0.status_path, null);
    writeJsonAtomic(gen0.status_path, { ...status, state: "failed", exit_code: 1, updated_at: "2026-07-04T08:56:29.000Z" });

    const retry = await mailctlReconcile(ctx);
    expect(retry.spawned).toHaveLength(1);
    const afterRetry = readJsonFile<any>(mailctlThreadStatePath(state.thread), null);
    const gen1 = afterRetry.controller.generations[1];
    const task = readFileSync(gen1.task_path, "utf8");

    expect(task).toContain("## Previous Controller Summary");
    expect(task).toContain(priorSummary);
    expect(task).not.toContain("notes.md");
    expect(locatedRuns).toEqual([`${state.repo_key}:${gen0.run_id}:mailctl-${state.thread}`]);
    expect(readRuns).toHaveLength(1);
  });

  it("sleeps instead of tight-looping when watch.lock is held", async () => {
    const { cfg } = setupMailctl({ reconcile_interval_sec: 1 });
    const transport = new FakeTransport([]);
    const ctx = fakeContext({ cfg, transport });
    const lock = acquirePidfileLock(watchLockPath(), process.pid, "test-watch-lock");
    const originalSetTimeout = globalThis.setTimeout;
    const sleeps: number[] = [];
    globalThis.setTimeout = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
      sleeps.push(Number(timeout ?? 0));
      queueMicrotask(() => handler(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      const result = await mailctlWatch(ctx, { iterations: 2 });
      expect(result).toEqual({ iterations: 2, stopped: false });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      lock.release();
    }

    expect(sleeps).toEqual([1000, 1000]);
    expect(transport.listCalls).toBe(2);
    expect(transport.idleCalls).toBe(0);
  });
});

describe("mailctlPoll failure alerting", () => {
  function pendingOutboxRecords(): any[] {
    return jsonFiles(outboxEmailPendingDir()).map((path) => readJsonFile<any>(path, null));
  }

  it("queues exactly one alert on the third consecutive failure and suppresses the fourth within cooldown", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([]);
    transport.failList = new Error("imap failed under /Users/me/project with token=ABCDEFGHIJKLMNOPQRST");
    const ctx = fakeContext({ cfg, transport });
    writeJsonAtomic(cursorPath(), {
      uidvalidity: null,
      last_uid: 7,
      last_poll_at: "2026-07-04T07:00:00.000Z",
      consecutive_failures: 0,
      last_error: null,
    });

    await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap failed");
    await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap failed");
    await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap failed");

    const pending = pendingOutboxRecords();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      schema: "orch.mailctl/outbox-email/v1",
      thread: "mailctl-alert",
      attempts: 0,
      last_error: null,
    });
    expect(pending[0].raw).toContain("From: bot@example.com\r\n");
    expect(pending[0].raw).toContain("To: owner@example.com\r\n");
    expect(pending[0].raw).toContain("Subject: [orch-alert] mailctl poll failing\r\n");
    expect(pending[0].body).toContain("consecutive_failures: 3");
    expect(pending[0].body).toContain("last_poll_at: 2026-07-04T07:00:00.000Z");
    expect(pending[0].body).toContain("Alerts are delivered on the next successful SMTP connection");
    expect(pending[0].body).not.toContain("/Users/me/project");
    expect(pending[0].body).not.toContain("ABCDEFGHIJKLMNOPQRST");
    expect(auditRows().filter((row) => row.type === "alert_queued")).toHaveLength(1);

    await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap failed");

    const cursor = readJsonFile<any>(cursorPath(), null);
    expect(pendingOutboxRecords()).toHaveLength(1);
    expect(cursor).toMatchObject({ consecutive_failures: 4, alerted_streak: 3 });
  });

  it("queues a new alert after recovery starts a new failure streak", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([]);
    transport.failList = new Error("imap down");
    const ctx = fakeContext({ cfg, transport });

    for (let i = 0; i < 3; i += 1) {
      await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap down");
    }
    expect(pendingOutboxRecords()).toHaveLength(1);

    transport.failList = null;
    await expect(mailctlPoll(ctx, { reconcile: false })).resolves.toMatchObject({ skipped: false, errors: 0 });
    expect(readJsonFile<any>(cursorPath(), null)).toMatchObject({
      consecutive_failures: 0,
      last_error: null,
      last_alert_at: null,
      alerted_streak: null,
    });

    transport.failList = new Error("imap down again");
    for (let i = 0; i < 3; i += 1) {
      await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap down again");
    }

    expect(pendingOutboxRecords()).toHaveLength(2);
    expect(auditRows().filter((row) => row.type === "alert_queued")).toHaveLength(2);
  });

  it("keeps the original poll failure when alert queueing fails", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([]);
    transport.failList = new Error("imap unavailable");
    const ctx = fakeContext({ cfg, transport });

    await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap unavailable");
    await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap unavailable");
    chmodSync(outboxEmailPendingDir(), 0o500);
    try {
      await expect(mailctlPoll(ctx, { reconcile: false })).rejects.toThrow("imap unavailable");
    } finally {
      chmodSync(outboxEmailPendingDir(), 0o700);
    }

    const cursor = readJsonFile<any>(cursorPath(), null);
    expect(cursor.consecutive_failures).toBe(3);
    expect(cursor.last_error).toContain("imap unavailable");
    expect(cursor.last_error).toContain("alert_queue_error");
    expect(auditRows().some((row) => row.type === "alert_queue_failed")).toBe(true);
  });
});

describe("mailctlAck, status, and guidance", () => {
  it("acks attention atomically, clears the T1 trigger, and settles after final report", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([message(1, "<ack@example.com>")]);
    const ctx = fakeContext({ cfg, transport });
    await mailctlPoll(ctx, { reconcile: false });
    const state = firstThreadState();
    const attention = readJsonFile<any>(attentionFiles()[0]!, null);

    const acked = mailctlAck(ctx, { thread: state.thread, attention: attention.msg_sha });
    expect(acked).toMatchObject({ thread: state.thread, attention: attention.msg_sha, acknowledged: true, done: true });
    expect(existsSync(attentionPath(attention.msg_sha))).toBe(false);
    expect(existsSync(attentionDonePath(attention.msg_sha))).toBe(true);

    const again = mailctlAck(ctx, { thread: state.thread, attention: attention.msg_sha });
    expect(again.acknowledged).toBe(false);
    expect(() => mailctlAck(ctx, { thread: state.thread, attention: "missing" })).toThrow("unknown");
    expect(() => mailctlAck(ctx, { thread: state.thread, attention: "../escape" })).toThrow("attention id");

    const reconciled = await mailctlReconcile(ctx);
    expect(reconciled.spawned).toHaveLength(0);
    expect(reconciled.live).toHaveLength(0);

    const sent = await mailctlReply(ctx, { thread: state.thread, reportKey: "settled:0", body: "final report" });
    expect(sent.sent).toBe(true);
    const settled = readJsonFile<any>(mailctlThreadStatePath(state.thread), null);
    expect(settled.status).toBe("settled");
    expect(settled.controller.final_report_sent).toBe(true);
    expect((await mailctlReconcile(ctx)).active_threads).toBe(0);
  });

  it("summarizes status and guidance and redacts human output", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([
      {
        ref: { uid: 1 },
        raw: textMail({
          messageId: "<guidance@example.com>",
          subject: "Inspect /Users/me/project token=ABCDEFGHIJKLMNOPQRST",
          body: "Inspect /Users/me/project\ntoken=ABCDEFGHIJKLMNOPQRST",
        }),
      },
    ]);
    const ctx = fakeContext({ cfg, transport });
    await mailctlPoll(ctx, { reconcile: false });
    const state = firstThreadState();
    writeJsonAtomic(cursorPath(), {
      uidvalidity: null,
      last_uid: 1,
      last_poll_at: "2026-07-04T08:56:28.000Z",
      consecutive_failures: 3,
      last_error: "failed under /Users/me/project with token=ABCDEFGHIJKLMNOPQRST",
    });

    const status = mailctlStatus(ctx, {});
    expect(status.cursor).toMatchObject({ last_uid: 1, consecutive_failures: 3 });
    expect(status.cursor.last_error).not.toContain("/Users/me/project");
    expect(status.cursor.last_error).not.toContain("ABCDEFGHIJKLMNOPQRST");
    expect(status.threads[0]).toMatchObject({ thread: state.thread, status: "active", unacked_attention: 1 });
    const renderedStatus = renderMailctlStatus(status);
    expect(renderedStatus).not.toContain("/Users/me/project");
    expect(renderedStatus).not.toContain("ABCDEFGHIJKLMNOPQRST");

    const guidance = mailctlGuidance(ctx, { thread: state.thread });
    expect(guidance.instructions).toHaveLength(1);
    expect(guidance.instructions[0]!.subject).not.toContain("/Users/me/project");
    expect(guidance.instructions[0]!.subject).not.toContain("ABCDEFGHIJKLMNOPQRST");
    expect(guidance.instructions[0]!.body).not.toContain("/Users/me/project");
    expect(guidance.instructions[0]!.body).not.toContain("ABCDEFGHIJKLMNOPQRST");
    const renderedGuidance = renderMailctlGuidance(guidance);
    expect(renderedGuidance).not.toContain("/Users/me/project");
    expect(renderedGuidance).not.toContain("ABCDEFGHIJKLMNOPQRST");
  });
});

describe("orch mailctl CLI dispatch", () => {
  it("routes subcommands without network when using dry-run or bounded watch", async () => {
    setupMailctl();
    const env = {
      XDG_STATE_HOME: process.env.XDG_STATE_HOME!,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!,
    };

    const init = await runOrch(
      [
        "mailctl",
        "init",
        "--user",
        "bot@example.com",
        "--imap-host",
        "imap.example.com",
        "--smtp-host",
        "smtp.example.com",
        "--allow",
        "owner@example.com",
        "--workspace",
        "default-ws",
        "--no-require-auth-results",
        "--json",
      ],
      env,
    );
    expect(init.exitCode).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ mailctl: "init", trusted_authserv_id: "example.com" });

    const cfg = readMailControlConfig();
    const transport = new FakeTransport([
      {
        ref: { uid: 1 },
        raw: textMail({
          messageId: "<cli-dispatch@example.com>",
          subject: "CLI /Users/me/project token=ABCDEFGHIJKLMNOPQRST",
          body: "CLI task under /Users/me/project\ntoken=ABCDEFGHIJKLMNOPQRST",
        }),
      },
    ]);
    const ctx = fakeContext({ cfg, transport });
    await mailctlPoll(ctx, { reconcile: false });
    const state = firstThreadState();
    const attention = readJsonFile<any>(attentionFiles()[0]!, null).msg_sha;

    const poll = await runOrch(["mailctl", "poll", "--dry-run", "--json"], env);
    expect(poll.exitCode).toBe(0);
    expect(JSON.parse(poll.stdout)).toMatchObject({ skipped: false, listed: 0 });
    writeJsonAtomic(cursorPath(), {
      uidvalidity: null,
      last_uid: 1,
      last_poll_at: "2026-07-04T08:56:28.000Z",
      consecutive_failures: 3,
      last_error: "failed under /Users/me/project with token=ABCDEFGHIJKLMNOPQRST",
    });

    const status = await runOrch(["mailctl", "status", "--json"], env);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toContain("/Users/me/project");
    expect(status.stdout).not.toContain("ABCDEFGHIJKLMNOPQRST");
    expect(JSON.parse(status.stdout).cursor).toMatchObject({ last_uid: 1, consecutive_failures: 3 });
    expect(JSON.parse(status.stdout).threads[0]).toMatchObject({ thread: state.thread, unacked_attention: 1 });

    const guidance = await runOrch(["mailctl", "guidance", "--thread", state.thread, "--json"], env);
    expect(guidance.exitCode).toBe(0);
    expect(guidance.stdout).not.toContain("/Users/me/project");
    expect(guidance.stdout).not.toContain("ABCDEFGHIJKLMNOPQRST");
    expect(JSON.parse(guidance.stdout).instructions[0]).toMatchObject({
      attention,
      subject: "CLI [local-path] token=***REDACTED***",
      body: "CLI task under [local-path]\ntoken=***REDACTED***",
    });

    const reply = await runOrch(["mailctl", "reply", "--thread", state.thread, "--report-key", "progress:cli", "--body", "progress body", "--dry-run"], env);
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toContain("[orch:progress:cli]");
    expect(reply.stdout).toContain("progress body");

    const ack = await runOrch(["mailctl", "ack", "--thread", state.thread, "--attention", attention, "--json"], env);
    expect(ack.exitCode).toBe(0);
    expect(JSON.parse(ack.stdout)).toMatchObject({ mailctl: "ack", acknowledged: true, done: true });

    const watch = await runOrch(["mailctl", "watch", "--iterations", "0", "--json"], env);
    expect(watch.exitCode).toBe(0);
    expect(JSON.parse(watch.stdout)).toMatchObject({ mailctl: "watch", iterations: 0 });

    const unknown = await runOrch(["mailctl", "unknown"], env);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("usage: orch mailctl");
  });
});

describe("mailctlReply outbound policy", () => {
  it("dedupes report keys, enforces mail-only leak checks, and queues failed sends", async () => {
    const { cfg } = setupMailctl({ reports: { policy: "auto", max_per_hour: 10, max_body_bytes: 64 } });
    const transport = new FakeTransport([message(1, "<reply-policy@example.com>")]);
    const ctx = fakeContext({ cfg, transport });
    await mailctlPoll(ctx, { reconcile: false });
    const thread = firstThreadState().thread;

    process.env.ORCH_MIRROR_ALLOW_PRIVATE = "1";
    await expect(mailctlReply(ctx, { thread, reportKey: "progress:leak", body: "see /Users/me/project" })).rejects.toThrow("private local path");
    await expect(mailctlReply(ctx, { thread, reportKey: "reply:secret", body: "token=abcdefghijklmnop" })).rejects.toThrow("secret assignment");
    await expect(mailctlReply(ctx, { thread, reportKey: "progress:long", body: "x".repeat(65) })).rejects.toThrow("max_body_bytes");

    const dryRun = await mailctlReply(ctx, { thread, reportKey: "progress:dry", body: "dry body", dryRun: true });
    expect(dryRun.rawMessage).toContain("[orch:progress:dry]");
    expect(transport.sent).toHaveLength(0);

    const sent = await mailctlReply(ctx, { thread, reportKey: "settled:1", body: "safe body" });
    expect(sent.sent).toBe(true);
    expect(transport.sent).toHaveLength(1);
    const duplicate = await mailctlReply(ctx, { thread, reportKey: "settled:1", body: "safe body" });
    expect(duplicate.duplicate).toBe(true);

    transport.failSend = true;
    const pending = await mailctlReply(ctx, { thread, reportKey: "reply:pending", body: "safe later" });
    expect(pending.pending).toBe(true);
    expect(existsSync(pending.pendingPath!)).toBe(true);
    const pendingFiles = jsonFiles(outboxEmailPendingDir());
    expect(pendingFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects unsafe report keys before sending or touching outbox state", async () => {
    const { cfg } = setupMailctl();
    const transport = new FakeTransport([message(1, "<reply-key-policy@example.com>")]);
    const ctx = fakeContext({ cfg, transport });
    await mailctlPoll(ctx, { reconcile: false });
    const thread = firstThreadState().thread;
    const beforePending = jsonFiles(outboxEmailPendingDir());
    const beforeSent = jsonFiles(outboxEmailSentDir());

    await expect(mailctlReply(ctx, { thread, reportKey: "progress:/Users/me/.ssh/id_rsa", body: "safe body" })).rejects.toThrow("report key");
    await expect(mailctlReply(ctx, { thread, reportKey: "reply:token=abcdefghijklmnop", body: "safe body" })).rejects.toThrow("report key");
    await expect(mailctlReply(ctx, { thread, reportKey: "reply:token:abcdefghijklmnop", body: "safe body" })).rejects.toThrow("secret assignment");

    expect(transport.sent).toHaveLength(0);
    expect(jsonFiles(outboxEmailPendingDir())).toEqual(beforePending);
    expect(jsonFiles(outboxEmailSentDir())).toEqual(beforeSent);
  });
});
