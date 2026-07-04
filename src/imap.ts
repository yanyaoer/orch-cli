export const IMAP_IDLE_REISSUE_MS = 29 * 60 * 1000;

export interface ImapResponse {
  kind: "untagged" | "tagged" | "continuation";
  tag: string | null;
  status: string | null;
  text: string;
  literals: string[];
  raw: string;
}

export interface ImapFetchedMessage {
  uid: number;
  raw: string;
}

export interface ImapSelectResult {
  mailbox: string;
  uidValidity: number | null;
  responses: ImapResponse[];
}

export interface ImapConnection {
  readLine(): Promise<string>;
  readBytes(byteCount: number): Promise<string>;
  write(data: string): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  tls?: boolean;
}

export type ImapConnector = (options: ImapConnectOptions) => Promise<ImapConnection>;

export interface UidScanPlan {
  uidValidityChanged: boolean;
  effectiveLastUid: number;
  useSinceWindow: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function rawToBinaryString(raw: string | Uint8Array): string {
  return typeof raw === "string" ? raw : Buffer.from(raw).toString("latin1");
}

function readTranscriptLine(transcript: string, offset: number): { line: string; next: number; raw: string } | null {
  if (offset >= transcript.length) return null;
  const lf = transcript.indexOf("\n", offset);
  if (lf < 0) return { line: transcript.slice(offset).replace(/\r$/, ""), next: transcript.length, raw: transcript.slice(offset) };
  const raw = transcript.slice(offset, lf + 1);
  return { line: raw.replace(/\r?\n$/, ""), next: lf + 1, raw };
}

function literalLength(line: string): number | null {
  const match = line.match(/\{(\d+)\+?\}$/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function classifyImapResponse(text: string, raw: string, literals: string[]): ImapResponse {
  if (text.startsWith("+")) return { kind: "continuation", tag: null, status: null, text, literals, raw };
  if (text.startsWith("*")) return { kind: "untagged", tag: null, status: null, text, literals, raw };
  const match = text.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/);
  return {
    kind: "tagged",
    tag: match?.[1] ?? null,
    status: match?.[2]?.toUpperCase() ?? null,
    text,
    literals,
    raw,
  };
}

export function parseImapTranscript(rawTranscript: string | Uint8Array): ImapResponse[] {
  const transcript = rawToBinaryString(rawTranscript);
  const responses: ImapResponse[] = [];
  let offset = 0;
  while (offset < transcript.length) {
    const first = readTranscriptLine(transcript, offset);
    if (!first) break;
    offset = first.next;
    if (first.line === "") continue;
    let text = first.line;
    let raw = first.raw;
    const literals: string[] = [];
    let line = first.line;
    for (;;) {
      const length = literalLength(line);
      if (length === null) break;
      const literal = transcript.slice(offset, offset + length);
      literals.push(literal);
      raw += literal;
      offset += length;
      const tail = readTranscriptLine(transcript, offset);
      if (!tail) break;
      offset = tail.next;
      line = tail.line;
      text += line;
      raw += tail.raw;
    }
    responses.push(classifyImapResponse(text, raw, literals));
  }
  return responses;
}

export function parseUidSearchUids(transcript: string | Uint8Array): number[] {
  const uids: number[] = [];
  for (const response of parseImapTranscript(transcript)) {
    const match = response.text.match(/^\*\s+SEARCH(?:\s+(.+))?$/i);
    if (!match) continue;
    for (const token of (match[1] ?? "").trim().split(/\s+/)) {
      if (/^\d+$/.test(token)) uids.push(Number.parseInt(token, 10));
    }
  }
  return uids;
}

export function parseSelectUidValidity(transcript: string | Uint8Array): number | null {
  for (const response of parseImapTranscript(transcript)) {
    const match = response.text.match(/\[UIDVALIDITY\s+(\d+)\]/i);
    if (match) return Number.parseInt(match[1]!, 10);
  }
  return null;
}

export function parseUidFetchResponses(transcript: string | Uint8Array): ImapFetchedMessage[] {
  const messages: ImapFetchedMessage[] = [];
  for (const response of parseImapTranscript(transcript)) {
    if (response.kind !== "untagged" || !/\bFETCH\b/i.test(response.text)) continue;
    const uid = response.text.match(/\bUID\s+(\d+)\b/i);
    const raw = response.literals.at(-1);
    if (!uid || raw === undefined) continue;
    messages.push({ uid: Number.parseInt(uid[1]!, 10), raw });
  }
  return messages.sort((a, b) => a.uid - b.uid);
}

export function filterNewUids(uids: number[], lastUid: number): number[] {
  return [...new Set(uids)].filter((uid) => uid > lastUid).sort((a, b) => a - b);
}

export function planUidScan(args: { storedUidValidity: number | null; selectedUidValidity: number | null; lastUid: number }): UidScanPlan {
  const uidValidityChanged =
    args.storedUidValidity !== null && args.selectedUidValidity !== null && args.storedUidValidity !== args.selectedUidValidity;
  return {
    uidValidityChanged,
    effectiveLastUid: uidValidityChanged ? 0 : args.lastUid,
    useSinceWindow: uidValidityChanged || args.lastUid <= 0,
  };
}

function markerKeyFromRaw(raw: string): string | null {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerText = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
  const lines = headerText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!/^message-id:/i.test(line)) continue;
    let value = line.slice(line.indexOf(":") + 1);
    for (let j = i + 1; j < lines.length && /^[ \t]/.test(lines[j]!); j += 1) value += ` ${lines[j]!.trim()}`;
    const match = value.match(/<([^<>@\s]+@[^<>\s]+)>/);
    if (!match) return null;
    const id = match[1]!;
    const at = id.lastIndexOf("@");
    return `${id.slice(0, at)}@${id.slice(at + 1).toLowerCase()}`;
  }
  return null;
}

export function filterFetchedMessages(
  messages: ImapFetchedMessage[],
  options: { lastUid: number; uidValidityChanged: boolean; processedMessageKeys?: Set<string> },
): ImapFetchedMessage[] {
  return messages
    .filter((message) => options.uidValidityChanged || message.uid > options.lastUid)
    .filter((message) => {
      const markerKey = markerKeyFromRaw(message.raw);
      return !markerKey || !options.processedMessageKeys?.has(markerKey);
    })
    .sort((a, b) => a.uid - b.uid);
}

function quoteImapString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatImapDate(date: Date): string {
  return `${String(date.getUTCDate()).padStart(2, "0")}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

async function readImapResponse(connection: ImapConnection): Promise<ImapResponse> {
  const firstLine = await connection.readLine();
  let text = firstLine;
  let raw = `${firstLine}\r\n`;
  let line = firstLine;
  const literals: string[] = [];
  for (;;) {
    const length = literalLength(line);
    if (length === null) break;
    const literal = await connection.readBytes(length);
    literals.push(literal);
    raw += literal;
    line = await connection.readLine();
    text += line;
    raw += `${line}\r\n`;
  }
  return classifyImapResponse(text, raw, literals);
}

export class ImapClient {
  private tagCounter = 1;

  constructor(private readonly connection: ImapConnection) {}

  static async connect(options: ImapConnectOptions, connector: ImapConnector = createBunImapConnection): Promise<ImapClient> {
    return new ImapClient(await connector(options));
  }

  private nextTag(): string {
    const tag = `A${String(this.tagCounter).padStart(4, "0")}`;
    this.tagCounter += 1;
    return tag;
  }

  private async command(command: string): Promise<ImapResponse[]> {
    const tag = this.nextTag();
    await this.connection.write(`${tag} ${command}\r\n`);
    const responses: ImapResponse[] = [];
    for (;;) {
      const response = await readImapResponse(this.connection);
      responses.push(response);
      if (response.kind === "tagged" && response.tag === tag) {
        if (response.status !== "OK") throw new Error(`IMAP ${command} failed: ${response.text}`);
        return responses;
      }
    }
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(`LOGIN ${quoteImapString(user)} ${quoteImapString(password)}`);
  }

  async select(mailbox = "INBOX"): Promise<ImapSelectResult> {
    const responses = await this.command(`SELECT ${quoteImapString(mailbox)}`);
    const uidValidity = parseSelectUidValidity(responses.map((response) => response.raw).join(""));
    return { mailbox, uidValidity, responses };
  }

  async uidSearchSince(date: Date): Promise<number[]> {
    const responses = await this.command(`UID SEARCH SINCE ${formatImapDate(date)}`);
    return parseUidSearchUids(responses.map((response) => response.raw).join(""));
  }

  async uidFetchRaw(uid: number): Promise<string | null> {
    const responses = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    return parseUidFetchResponses(responses.map((response) => response.raw).join(""))[0]?.raw ?? null;
  }

  async markProcessed(uid: number): Promise<boolean> {
    const tag = this.nextTag();
    await this.connection.write(`${tag} UID STORE ${uid} +FLAGS ($OrchProcessed)\r\n`);
    const responses: ImapResponse[] = [];
    for (;;) {
      const response = await readImapResponse(this.connection);
      responses.push(response);
      if (response.kind === "tagged" && response.tag === tag) return response.status === "OK";
    }
  }

  async idleOnce(duringIdle: () => Promise<void> = async () => undefined): Promise<ImapResponse[]> {
    const tag = this.nextTag();
    await this.connection.write(`${tag} IDLE\r\n`);
    const continuation = await readImapResponse(this.connection);
    if (continuation.kind !== "continuation") throw new Error(`IMAP IDLE expected continuation, got ${continuation.text}`);
    await duringIdle();
    await this.connection.write("DONE\r\n");
    const responses = [continuation];
    for (;;) {
      const response = await readImapResponse(this.connection);
      responses.push(response);
      if (response.kind === "tagged" && response.tag === tag) return responses;
    }
  }

  async logout(): Promise<void> {
    await this.command("LOGOUT");
    await this.connection.close?.();
  }
}

class BunImapConnection implements ImapConnection {
  private socket: Bun.Socket<undefined> | null = null;
  private buffer = "";
  private waiters: Array<() => void> = [];
  private error: Error | null = null;

  static async connect(options: ImapConnectOptions): Promise<BunImapConnection> {
    const connection = new BunImapConnection();
    connection.socket = await Bun.connect({
      hostname: options.host,
      port: options.port,
      tls: options.tls === false ? false : { serverName: options.host },
      socket: connection.socketHandler(),
    });
    return connection;
  }

  private socketHandler(): Bun.SocketHandler<undefined> {
    return {
      data: (_socket, data) => {
        this.buffer += Buffer.from(data).toString("latin1");
        this.wake();
      },
      close: (_socket, error) => {
        this.error = error ?? new Error("IMAP socket closed");
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

  async readBytes(byteCount: number): Promise<string> {
    for (;;) {
      if (this.buffer.length >= byteCount) {
        const bytes = this.buffer.slice(0, byteCount);
        this.buffer = this.buffer.slice(byteCount);
        return bytes;
      }
      if (this.error) throw this.error;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  write(data: string): void {
    if (!this.socket) throw new Error("IMAP socket is not connected");
    this.socket.write(data);
  }

  close(): void {
    this.socket?.close();
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

export function createBunImapConnection(options: ImapConnectOptions): Promise<ImapConnection> {
  return BunImapConnection.connect(options);
}
