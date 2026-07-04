import { randomUUID } from "node:crypto";

export type SmtpMode = "implicit" | "starttls";

export interface SmtpReply {
  code: number;
  lines: string[];
  raw: string;
}

export interface SmtpConnection {
  readLine(): Promise<string>;
  write(data: string): void | Promise<void>;
  startTls?(): Promise<void>;
  close?(): void | Promise<void>;
}

export interface SmtpConnectOptions {
  host: string;
  port: number;
  mode: SmtpMode;
}

export type SmtpConnector = (options: SmtpConnectOptions) => Promise<SmtpConnection>;

export interface SmtpSubmitOptions extends SmtpConnectOptions {
  heloName?: string;
  username?: string;
  password?: string;
  from: string;
  to: string[];
  message: string;
  dryRun?: boolean;
  connector?: SmtpConnector;
}

export interface SmtpSubmitResult {
  dryRun: boolean;
  rawMessage: string;
  clientWrites: string[];
  replies: SmtpReply[];
}

export interface BuildReplyMessageOptions {
  from: string;
  to: string;
  subject: string;
  body: string;
  reportKey: string;
  inReplyTo?: string | null;
  references?: string[];
  messageId?: string;
  messageIdDomain?: string;
  date?: Date;
}

function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function normalizeCrlf(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
}

export function prepareSmtpDataBlock(message: string): string {
  const normalized = normalizeCrlf(message);
  const content = normalized.endsWith("\r\n") ? normalized.slice(0, -2) : normalized;
  const stuffed = content
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  return `${stuffed}\r\n.\r\n`;
}

export function parseSmtpReplies(transcript: string): SmtpReply[] {
  const replies: SmtpReply[] = [];
  let pending: { code: number; lines: string[]; raw: string[] } | null = null;
  for (const line of transcript.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const match = line.match(/^(\d{3})([ -])(.*)$/);
    if (!match) continue;
    const code = Number.parseInt(match[1]!, 10);
    const separator = match[2]!;
    const text = match[3]!;
    if (!pending || pending.code !== code) pending = { code, lines: [], raw: [] };
    pending.lines.push(text);
    pending.raw.push(line);
    if (separator === " ") {
      replies.push({ code, lines: pending.lines, raw: pending.raw.join("\r\n") });
      pending = null;
    }
  }
  return replies;
}

async function readSmtpReply(connection: SmtpConnection): Promise<SmtpReply> {
  const lines: string[] = [];
  const raw: string[] = [];
  let code: number | null = null;
  for (;;) {
    const line = await connection.readLine();
    const match = line.match(/^(\d{3})([ -])(.*)$/);
    if (!match) throw new Error(`invalid SMTP reply line: ${line}`);
    const lineCode = Number.parseInt(match[1]!, 10);
    if (code === null) code = lineCode;
    if (lineCode !== code) throw new Error(`mixed SMTP reply code ${lineCode}; expected ${code}`);
    lines.push(match[3]!);
    raw.push(line);
    if (match[2] === " ") return { code, lines, raw: raw.join("\r\n") };
  }
}

function expectReply(reply: SmtpReply, allowed: number[], stage: string): void {
  if (!allowed.includes(reply.code)) {
    throw new Error(`SMTP ${stage} failed: expected ${allowed.join("|")}, got ${reply.code} ${reply.lines.join(" / ")}`);
  }
}

async function writeLine(connection: SmtpConnection, writes: string[], line: string): Promise<void> {
  writes.push(`${line}\r\n`);
  await connection.write(`${line}\r\n`);
}

async function writeRaw(connection: SmtpConnection, writes: string[], data: string): Promise<void> {
  writes.push(data);
  await connection.write(data);
}

function authPlain(username: string, password: string): string {
  return Buffer.from(`\0${username}\0${password}`, "utf8").toString("base64");
}

function mailbox(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed}>`;
}

export async function submitSmtpMessage(options: SmtpSubmitOptions): Promise<SmtpSubmitResult> {
  const rawMessage = normalizeCrlf(options.message);
  if (options.dryRun) return { dryRun: true, rawMessage, clientWrites: [], replies: [] };

  const connector = options.connector ?? createBunSmtpConnection;
  const connection = await connector({ host: options.host, port: options.port, mode: options.mode });
  const replies: SmtpReply[] = [];
  const clientWrites: string[] = [];
  try {
    const greeting = await readSmtpReply(connection);
    replies.push(greeting);
    expectReply(greeting, [220], "greeting");

    await writeLine(connection, clientWrites, `EHLO ${options.heloName ?? "localhost"}`);
    const ehlo = await readSmtpReply(connection);
    replies.push(ehlo);
    expectReply(ehlo, [250], "EHLO");

    if (options.mode === "starttls") {
      await writeLine(connection, clientWrites, "STARTTLS");
      const starttls = await readSmtpReply(connection);
      replies.push(starttls);
      expectReply(starttls, [220], "STARTTLS");
      if (!connection.startTls) throw new Error("SMTP connection does not support STARTTLS");
      await connection.startTls();
      await writeLine(connection, clientWrites, `EHLO ${options.heloName ?? "localhost"}`);
      const postTlsEhlo = await readSmtpReply(connection);
      replies.push(postTlsEhlo);
      expectReply(postTlsEhlo, [250], "post-STARTTLS EHLO");
    }

    if (options.username !== undefined || options.password !== undefined) {
      if (!options.username || options.password === undefined) throw new Error("SMTP AUTH PLAIN requires username and password");
      await writeLine(connection, clientWrites, `AUTH PLAIN ${authPlain(options.username, options.password)}`);
      const auth = await readSmtpReply(connection);
      replies.push(auth);
      expectReply(auth, [235], "AUTH PLAIN");
    }

    await writeLine(connection, clientWrites, `MAIL FROM:${mailbox(options.from)}`);
    const mailFrom = await readSmtpReply(connection);
    replies.push(mailFrom);
    expectReply(mailFrom, [250], "MAIL FROM");

    for (const recipient of options.to) {
      await writeLine(connection, clientWrites, `RCPT TO:${mailbox(recipient)}`);
      const rcpt = await readSmtpReply(connection);
      replies.push(rcpt);
      expectReply(rcpt, [250, 251], "RCPT TO");
    }

    await writeLine(connection, clientWrites, "DATA");
    const dataReady = await readSmtpReply(connection);
    replies.push(dataReady);
    expectReply(dataReady, [354], "DATA");

    await writeRaw(connection, clientWrites, prepareSmtpDataBlock(rawMessage));
    const accepted = await readSmtpReply(connection);
    replies.push(accepted);
    expectReply(accepted, [250], "message body");

    await writeLine(connection, clientWrites, "QUIT");
    const quit = await readSmtpReply(connection);
    replies.push(quit);
    expectReply(quit, [221], "QUIT");
    return { dryRun: false, rawMessage, clientWrites, replies };
  } finally {
    await connection.close?.();
  }
}

function normalizeMessageId(value: string): string {
  const trimmed = stripCrlf(value);
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, "")}>`;
}

function dedupeReferences(references: string[], inReplyTo: string | null | undefined): string[] {
  const chain: string[] = [];
  for (const ref of references) {
    const normalized = normalizeMessageId(ref);
    if (!chain.includes(normalized)) chain.push(normalized);
  }
  if (inReplyTo) {
    const normalized = normalizeMessageId(inReplyTo);
    if (!chain.includes(normalized)) chain.push(normalized);
  }
  return chain;
}

function replySubject(subject: string): string {
  const base = stripCrlf(subject).replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
  return `Re: ${base || "(no subject)"}`;
}

export function buildReplyMessage(options: BuildReplyMessageOptions): { raw: string; messageId: string } {
  const messageId =
    options.messageId ??
    `<orch-${Date.now().toString(36)}-${randomUUID().replace(/-/g, "")}@${stripCrlf(options.messageIdDomain ?? "localhost")}>`;
  const headers = [
    `From: ${stripCrlf(options.from)}`,
    `To: ${stripCrlf(options.to)}`,
    `Subject: ${replySubject(options.subject)}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${normalizeMessageId(messageId)}`,
  ];
  if (options.inReplyTo) headers.push(`In-Reply-To: ${normalizeMessageId(options.inReplyTo)}`);
  const references = dedupeReferences(options.references ?? [], options.inReplyTo);
  if (references.length > 0) headers.push(`References: ${references.join(" ")}`);
  headers.push("MIME-Version: 1.0");
  headers.push("Content-Type: text/plain; charset=utf-8");
  headers.push("Content-Transfer-Encoding: 8bit");

  const body = `[orch:${options.reportKey}]\n\n${options.body}`.replace(/\s+$/g, "");
  return { raw: normalizeCrlf(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`), messageId: normalizeMessageId(messageId) };
}

class BunSmtpConnection implements SmtpConnection {
  private socket: Bun.Socket<undefined> | null = null;
  private buffer = "";
  private waiters: Array<() => void> = [];
  private error: Error | null = null;

  private constructor(private readonly host: string) {}

  static async connect(options: SmtpConnectOptions): Promise<BunSmtpConnection> {
    const connection = new BunSmtpConnection(options.host);
    connection.socket = await Bun.connect({
      hostname: options.host,
      port: options.port,
      tls: options.mode === "implicit" ? { serverName: options.host } : false,
      socket: connection.socketHandler(),
    });
    return connection;
  }

  private socketHandler(): Bun.SocketHandler<undefined> {
    return {
      data: (_socket, data) => {
        this.buffer += Buffer.from(data).toString("utf8");
        this.wake();
      },
      close: (_socket, error) => {
        this.error = error ?? new Error("SMTP socket closed");
        this.wake();
      },
      error: (_socket, error) => {
        this.error = error;
        this.wake();
      },
    };
  }

  async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      if (this.error) throw this.error;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  write(data: string): void {
    if (!this.socket) throw new Error("SMTP socket is not connected");
    this.socket.write(data);
  }

  async startTls(): Promise<void> {
    if (!this.socket) throw new Error("SMTP socket is not connected");
    const [, tls] = this.socket.upgradeTLS({
      tls: { serverName: this.host },
      socket: this.socketHandler(),
    });
    this.socket = tls;
  }

  close(): void {
    this.socket?.close();
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

export function createBunSmtpConnection(options: SmtpConnectOptions): Promise<SmtpConnection> {
  return BunSmtpConnection.connect(options);
}
