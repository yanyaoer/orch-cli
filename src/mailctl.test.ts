import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailControlConfig } from "./config.ts";
import {
  auditPath,
  buildControllerTask,
  cursorPath,
  evaluateGate,
  ingestLockPath,
  mergeThread,
  messageMarkerPath,
  normalizeMessageId,
  resolveWorkspace,
  sha12,
  taskFilePath,
  threadMapPath,
  watchLockPath,
} from "./mailctl.ts";

type ConfigOverrides = Partial<MailControlConfig> & {
  account?: Partial<MailControlConfig["account"]>;
  imap?: Partial<MailControlConfig["imap"]>;
  smtp?: Partial<MailControlConfig["smtp"]>;
  controller?: Partial<MailControlConfig["controller"]>;
  reports?: Partial<MailControlConfig["reports"]>;
};

const previousStateHome = process.env.XDG_STATE_HOME;

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
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

    expect(task).toContain("You have no Edit/Write; dispatch a worker to change code");
    expect(task).toContain("orch fanout/cross-review --thread em-abc123 --task <file>");
    expect(task).toContain("orch decision accept|rework");
    expect(task).toContain("orch mailctl ack --thread em-abc123");
    expect(task).toContain("orch mailctl reply --report-key");
    expect(task).toContain("Please implement the parser");
    expect(task).not.toContain("/Users/example/project");
    expect(task).not.toContain("ABCDEFGHIJKLMNOPQRST");
  });
});
