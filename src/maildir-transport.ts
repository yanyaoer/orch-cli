// Maildir transport for orch mailctl: an external fetcher (mbsync, getmail,
// fdm, an Email-Routing worker dropping files) owns IMAP, an external
// submitter (msmtp -t) owns SMTP, and orch reads and writes a directory.
// Nothing here holds a socket, so the half-open-connection class of incidents
// cannot happen inside orch, and the two commands are the whole protocol
// surface a human has to debug.
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { MailCursor, MailMessageRef, MailTransport } from "./mailctl.ts";

export interface MaildirTransportConfig {
  kind: "maildir";
  path: string; // Maildir root: <path>/{new,cur,tmp}
  sync_cmd?: string[]; // run before every listing (e.g. ["mbsync", "orch"])
  send_cmd?: string[]; // rfc822 on stdin (e.g. ["msmtp", "-t", "--read-envelope-from"]); absent = SMTP fallback
}

// mailctl's cursor skips uids at or below the last processed one, so uids
// must grow with delivery. mbsync writes its own per-store UID into the
// filename (",U=<n>", monotonic for that Maildir; not the server UID — a
// fresh store starts at 1 whatever UIDNEXT is); other fetchers get the
// Maildir timestamp prefix plus its per-second sequence, which grows with
// delivery time. Switching mailboxes therefore needs the cursor re-seeded
// to the new store's highest local uid: a cursor above the store's range
// skips every message forever (all "duplicate", no error), one below it
// re-ingests everything above it.
export function maildirUid(name: string): number {
  const imapUid = name.match(/,U=(\d+)/);
  if (imapUid) return Number(imapUid[1]);
  const stamp = name.match(/^(\d+)(?:\.[^_.]*_(\d+))?/);
  if (!stamp) return 0;
  return Number(stamp[1]) * 1000 + Math.min(999, Number(stamp[2] ?? 0));
}

async function runCommand(argv: string[], stdin: string | null, what: string): Promise<void> {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  if (stdin !== null) proc.stdin.write(stdin);
  proc.stdin.end();
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${what} (${argv[0]}) exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`);
}

export class MaildirMailTransport implements MailTransport {
  constructor(
    private readonly maildir: MaildirTransportConfig,
    // Used when no send_cmd is configured: the built-in SMTP submission.
    private readonly smtpFallback: (rfc822: string) => Promise<void>,
  ) {}

  private dir(kind: "new" | "cur"): string {
    return join(this.maildir.path, kind);
  }

  async listNew(_sinceDays: number, _cursor: MailCursor | null): Promise<MailMessageRef[]> {
    if (this.maildir.sync_cmd) await runCommand(this.maildir.sync_cmd, null, "maildir sync_cmd");
    const dir = this.dir("new");
    if (!existsSync(dir)) throw new Error(`maildir has no new/ directory: ${this.maildir.path}`);
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => ({ uid: maildirUid(name), key: name, uidvalidity: null }));
  }

  async fetchRaw(ref: MailMessageRef): Promise<string> {
    if (!ref.key) throw new Error(`maildir ref without key (uid ${ref.uid})`);
    const fresh = join(this.dir("new"), ref.key);
    if (existsSync(fresh)) return readFileSync(fresh, "utf8");
    // Already moved by a crashed earlier pass: cur/ keeps the name plus flags.
    const moved = readdirSync(this.dir("cur")).find((name) => name === ref.key || name.startsWith(`${ref.key}:`));
    if (!moved) throw new Error(`maildir message not found: ${ref.key}`);
    return readFileSync(join(this.dir("cur"), moved), "utf8");
  }

  // new/<name> -> cur/<name>:2,S: seen, which a two-way sync propagates to the
  // server as the read flag (the Maildir counterpart of $OrchProcessed).
  async markProcessed(ref: MailMessageRef): Promise<void> {
    if (!ref.key) throw new Error(`maildir ref without key (uid ${ref.uid})`);
    const source = join(this.dir("new"), ref.key);
    if (!existsSync(source)) return; // already moved
    const base = ref.key.replace(/:2,.*$/, "");
    renameSync(source, join(this.dir("cur"), `${base}:2,S`));
  }

  // No push channel: the watch loop sleeps, then the next listing runs
  // sync_cmd. Latency is the watch interval, unless something external
  // (an IMAP IDLE notifier) triggers `orch mailctl poll` sooner.
  async idleOnce(timeoutMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  async sendReply(rfc822: string): Promise<void> {
    if (!this.maildir.send_cmd) return this.smtpFallback(rfc822);
    await runCommand(this.maildir.send_cmd, rfc822, "maildir send_cmd");
  }
}
