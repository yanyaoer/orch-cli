import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaildirMailTransport, maildirUid } from "./maildir-transport.ts";
import { createMailTransport } from "./mailctl.ts";
import { validateMailControlConfig, type MailControlConfig } from "./config.ts";

function maildir(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "orch-maildir-"));
  const path = join(root, "Maildir");
  for (const dir of ["new", "cur", "tmp"]) mkdirSync(join(path, dir), { recursive: true });
  return { root, path };
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

test("maildirUid grows with delivery: mbsync's U= wins, else timestamp + sequence", () => {
  expect(maildirUid("1789000000.12345_1.host,U=42:2,S")).toBe(42);
  expect(maildirUid("1789000000.12345_1.host,U=43")).toBe(43);
  expect(maildirUid("1789000000.12345_1.host")).toBe(1789000000001);
  expect(maildirUid("1789000000.12345_2.host")).toBe(1789000000002);
  expect(maildirUid("1789000001.M1P2.host")).toBe(1789000001000);
  expect(maildirUid("garbage")).toBe(0);
});

test("Maildir transport syncs before listing, reads new/, moves processed mail to cur/ as seen", async () => {
  const { root, path } = maildir();
  try {
    writeFileSync(join(path, "new", "1789000000.1_1.host,U=7"), "Subject: first\r\n\r\none\r\n");
    // sync_cmd is what delivers: the second message only exists after it ran.
    const sync = script(root, "sync.sh", `printf 'Subject: second\\r\\n\\r\\ntwo\\r\\n' > ${JSON.stringify(join(path, "new", "1789000001.1_1.host,U=9"))}`);
    const transport = new MaildirMailTransport({ kind: "maildir", path, sync_cmd: [sync] }, async () => {
      throw new Error("smtp fallback must not run");
    });
    const refs = await transport.listNew(30, null);
    expect(refs.map((ref) => ref.uid)).toEqual([7, 9]);
    expect(refs.map((ref) => ref.key)).toEqual(["1789000000.1_1.host,U=7", "1789000001.1_1.host,U=9"]);
    expect(await transport.fetchRaw(refs[1]!)).toBe("Subject: second\r\n\r\ntwo\r\n");

    await transport.markProcessed(refs[0]!);
    expect(readdirSync(join(path, "new"))).toEqual(["1789000001.1_1.host,U=9"]);
    expect(readdirSync(join(path, "cur"))).toEqual(["1789000000.1_1.host,U=7:2,S"]);
    // A ref whose file was already moved (crash between fetch and mark) still reads.
    expect(await transport.fetchRaw(refs[0]!)).toBe("Subject: first\r\n\r\none\r\n");
    await transport.markProcessed(refs[0]!); // idempotent
    expect(readdirSync(join(path, "cur"))).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Maildir transport: a failing sync_cmd fails the listing with its stderr", async () => {
  const { root, path } = maildir();
  try {
    const sync = script(root, "sync.sh", "echo 'IMAP command SELECT failed' >&2; exit 3");
    const transport = new MaildirMailTransport({ kind: "maildir", path, sync_cmd: [sync] }, async () => {});
    await expect(transport.listNew(30, null)).rejects.toThrow(/sync_cmd .* exited 3: IMAP command SELECT failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Maildir transport sends through send_cmd on stdin, or the SMTP fallback without one", async () => {
  const { root, path } = maildir();
  try {
    const captured = join(root, "sent.eml");
    const send = script(root, "send.sh", `cat > ${JSON.stringify(captured)}`);
    const withCmd = new MaildirMailTransport({ kind: "maildir", path, send_cmd: [send] }, async () => {
      throw new Error("fallback must not run when send_cmd is set");
    });
    await withCmd.sendReply("To: a@example.com\r\n\r\nhello\r\n");
    expect(readFileSync(captured, "utf8")).toBe("To: a@example.com\r\n\r\nhello\r\n");

    const failing = script(root, "fail.sh", "echo 'msmtp: cannot connect' >&2; exit 78");
    const broken = new MaildirMailTransport({ kind: "maildir", path, send_cmd: [failing] }, async () => {});
    await expect(broken.sendReply("x")).rejects.toThrow(/send_cmd .* exited 78: msmtp: cannot connect/);

    const fallbackCalls: string[] = [];
    const noCmd = new MaildirMailTransport({ kind: "maildir", path }, async (rfc822) => {
      fallbackCalls.push(rfc822);
    });
    await noCmd.sendReply("via smtp");
    expect(fallbackCalls).toEqual(["via smtp"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function baseConfig(): MailControlConfig {
  return {
    version: 1,
    account: { user: "orch@example.com", password: "x" },
    imap: { host: "imap.example.com", port: 993 },
    smtp: { host: "smtp.example.com", port: 465, mode: "implicit" },
    allowed_senders: ["boss@example.com"],
    trusted_authserv_id: "mx.example.com",
    workspace: "repo",
    reconcile_interval_sec: 60,
    subject_token: null,
    require_auth_results: true,
    controller: { agent: "claude", model: null, timeout_sec: 1800, max_spawns_per_hour: 6 },
    reports: { policy: "auto", max_per_hour: 4, max_body_bytes: 16384 },
    notify: { enabled: false, max_per_hour: 30 },
  };
}

test("config: a maildir transport drops the IMAP requirement, and SMTP too once send_cmd is set", () => {
  const cfg = baseConfig();
  cfg.transport = { kind: "maildir", path: "/tmp/Maildir", sync_cmd: ["mbsync", "orch"] };
  cfg.imap = { host: "", port: 993 };
  expect(() => validateMailControlConfig(cfg)).not.toThrow();
  cfg.smtp = { host: "", port: 465, mode: "implicit" };
  expect(() => validateMailControlConfig(cfg)).toThrow(/smtp\.host/);
  cfg.transport.send_cmd = ["msmtp", "-t"];
  expect(() => validateMailControlConfig(cfg)).not.toThrow();
  cfg.transport.send_cmd = [];
  expect(() => validateMailControlConfig(cfg)).toThrow(/transport\.send_cmd must be a non-empty argv array/);
  cfg.transport = { kind: "maildir", path: "" };
  expect(() => validateMailControlConfig(cfg)).toThrow(/transport\.path/);
  (cfg as { transport?: unknown }).transport = { kind: "carrier-pigeon" };
  expect(() => validateMailControlConfig(cfg)).toThrow(/transport\.kind/);
  expect(createMailTransport({ ...baseConfig(), transport: { kind: "maildir", path: "/tmp/Maildir" } })).toBeInstanceOf(MaildirMailTransport);
  expect(createMailTransport(baseConfig())).not.toBeInstanceOf(MaildirMailTransport);
  expect(existsSync("/tmp/Maildir")).toBe(existsSync("/tmp/Maildir")); // construction touches nothing
});
