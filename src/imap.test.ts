import { describe, expect, it } from "bun:test";
import {
  ImapClient,
  filterFetchedMessages,
  filterNewUids,
  formatImapDate,
  parseImapTranscript,
  parseSelectUidValidity,
  parseUidFetchResponses,
  parseUidSearchUids,
  planUidScan,
  type ImapConnection,
} from "./imap.ts";

function binaryString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

class FakeImapConnection implements ImapConnection {
  readonly writes: string[] = [];

  constructor(private transcript: string) {}

  async readLine(): Promise<string> {
    const lf = this.transcript.indexOf("\n");
    if (lf < 0) {
      const line = this.transcript.replace(/\r$/, "");
      this.transcript = "";
      if (line === "") throw new Error("fake IMAP server has no more lines");
      return line;
    }
    const raw = this.transcript.slice(0, lf + 1);
    this.transcript = this.transcript.slice(lf + 1);
    return raw.replace(/\r?\n$/, "");
  }

  async readBytes(byteCount: number): Promise<string> {
    const bytes = this.transcript.slice(0, byteCount);
    if (bytes.length !== byteCount) throw new Error(`wanted ${byteCount} bytes, got ${bytes.length}`);
    this.transcript = this.transcript.slice(byteCount);
    return bytes;
  }

  write(data: string): void {
    this.writes.push(data);
  }
}

describe("parseImapTranscript", () => {
  it("parses literals, non-sync literals, and continuations from a transcript", () => {
    const transcript = [
      "* 1 FETCH (UID 42 BODY[] {12}\r\nHello World!)",
      "+ Ready for literal",
      "A001 APPEND done {5+}",
      "abcde",
      "A001 OK APPEND completed",
      "",
    ].join("\r\n");
    const responses = parseImapTranscript(transcript);
    expect(responses).toHaveLength(4);
    expect(responses[0]).toMatchObject({ kind: "untagged", literals: ["Hello World!"] });
    expect(responses[1]).toMatchObject({ kind: "continuation", text: "+ Ready for literal" });
    expect(responses[2]).toMatchObject({ kind: "tagged", tag: "A001", literals: ["abcde"] });
    expect(responses[3]).toMatchObject({ kind: "tagged", tag: "A001", status: "OK" });
  });

  it("extracts UID SEARCH, SELECT UIDVALIDITY, and UID FETCH raw messages", () => {
    const rawMessage = "Message-ID: <m1@Example.COM>\r\nSubject: hello\r\n\r\nbody";
    const transcript = [
      "* OK [UIDVALIDITY 777] UIDs valid",
      "* SEARCH 10 11 12",
      `* 3 FETCH (UID 12 BODY[] {${rawMessage.length}}\r\n${rawMessage})`,
      "A002 OK done",
      "",
    ].join("\r\n");
    expect(parseSelectUidValidity(transcript)).toBe(777);
    expect(parseUidSearchUids(transcript)).toEqual([10, 11, 12]);
    expect(parseUidFetchResponses(transcript)).toEqual([{ uid: 12, raw: rawMessage }]);
  });

  it("counts literals by octets and preserves UTF-8 raw bytes", () => {
    const literal = Buffer.from("éé", "utf8");
    const transcript = Buffer.concat([
      Buffer.from(`* 1 FETCH (UID 9 BODY[] {${literal.length}}\r\n`, "ascii"),
      literal,
      Buffer.from(")\r\nA001 OK done\r\n", "ascii"),
    ]);
    const expectedLiteral = binaryString(literal);
    const responses = parseImapTranscript(transcript);

    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ kind: "untagged", literals: [expectedLiteral] });
    expect(Buffer.from(responses[0]!.literals[0]!, "latin1").toString("utf8")).toBe("éé");
    expect(responses[0]!.text).toBe("* 1 FETCH (UID 9 BODY[] {4})");
    expect(responses[0]!.raw.endsWith(")\r\n")).toBe(true);
    expect(responses[1]).toMatchObject({ kind: "tagged", tag: "A001", status: "OK" });
    expect(parseUidFetchResponses(transcript)).toEqual([{ uid: 9, raw: expectedLiteral }]);
  });
});

describe("UID cursor helpers", () => {
  it("discards UID n:* fallback messages that are not newer than last_uid", () => {
    expect(filterNewUids([100], 150)).toEqual([]);
    expect(filterFetchedMessages([{ uid: 100, raw: "Message-ID: <old@example.com>\r\n\r\nold" }], { lastUid: 150, uidValidityChanged: false })).toEqual([]);
  });

  it("resets last_uid on UIDVALIDITY change and lets message markers prevent reprocessing", () => {
    const plan = planUidScan({ storedUidValidity: 10, selectedUidValidity: 20, lastUid: 150 });
    expect(plan).toEqual({ uidValidityChanged: true, effectiveLastUid: 0, useSinceWindow: true });
    const filtered = filterFetchedMessages(
      [
        { uid: 10, raw: "Message-ID: <seen@Example.COM>\r\n\r\nold" },
        { uid: 11, raw: "Message-ID: <fresh@Example.COM>\r\n\r\nnew" },
      ],
      { lastUid: 150, uidValidityChanged: true, processedMessageKeys: new Set(["seen@example.com"]) },
    );
    expect(filtered).toEqual([{ uid: 11, raw: "Message-ID: <fresh@Example.COM>\r\n\r\nnew" }]);
  });

  it("formats IMAP SINCE dates in IMAP4rev1 form", () => {
    expect(formatImapDate(new Date("2026-07-04T23:59:59.000Z"))).toBe("04-Jul-2026");
  });
});

describe("ImapClient", () => {
  it("sends LOGIN, SELECT, UID SEARCH, UID FETCH, STORE, IDLE, DONE, and LOGOUT commands", async () => {
    const raw = "Message-ID: <new@example.com>\r\n\r\nhello";
    const connection = new FakeImapConnection(
      [
        "* CAPABILITY IMAP4rev1 IDLE",
        "A0001 OK logged in",
        "* FLAGS (\\Seen)",
        "* OK [UIDVALIDITY 999] valid",
        "A0002 OK selected",
        "* SEARCH 5 6",
        "A0003 OK search done",
        `* 1 FETCH (UID 6 BODY[] {${raw.length}}`,
        raw,
        ")",
        "A0004 OK fetch done",
        "A0005 NO unknown keyword",
        "+ idling",
        "* 7 EXISTS",
        "A0006 OK idle done",
        "* BYE logging out",
        "A0007 OK logout done",
        "",
      ].join("\r\n"),
    );
    const client = new ImapClient(connection);
    await client.login("user@example.com", "pw");
    expect(await client.select()).toMatchObject({ mailbox: "INBOX", uidValidity: 999 });
    expect(await client.uidSearchSince(new Date("2026-07-04T00:00:00.000Z"))).toEqual([5, 6]);
    expect(await client.uidFetchRaw(6)).toBe(raw);
    expect(await client.markProcessed(6)).toBe(false);
    const idle = await client.idleOnce();
    expect(idle.map((response) => response.text)).toEqual(["+ idling", "* 7 EXISTS", "A0006 OK idle done"]);
    await client.logout();
    expect(connection.writes).toEqual([
      "A0001 LOGIN \"user@example.com\" \"pw\"\r\n",
      "A0002 SELECT \"INBOX\"\r\n",
      "A0003 UID SEARCH SINCE 04-Jul-2026\r\n",
      "A0004 UID FETCH 6 (BODY.PEEK[])\r\n",
      "A0005 UID STORE 6 +FLAGS ($OrchProcessed)\r\n",
      "A0006 IDLE\r\n",
      "DONE\r\n",
      "A0007 LOGOUT\r\n",
    ]);
  });

  it("consumes the untagged server greeting on connect before the first command", async () => {
    const connection = new FakeImapConnection(
      ["* OK Gimap ready for requests", "A0001 OK logged in", ""].join("\r\n"),
    );
    const client = await ImapClient.connect({ host: "imap.example.com", port: 993 }, async () => connection);
    await client.login("user@example.com", "pw");
    // The greeting was read by connect(), so LOGIN is the very first client write
    // and its tagged response is read directly (not offset by the greeting).
    expect(connection.writes).toEqual(["A0001 LOGIN \"user@example.com\" \"pw\"\r\n"]);
  });

  it("rejects a * BYE greeting on connect", async () => {
    const connection = new FakeImapConnection("* BYE server unavailable\r\n");
    await expect(
      ImapClient.connect({ host: "imap.example.com", port: 993 }, async () => connection),
    ).rejects.toThrow(/refused/i);
  });
});
