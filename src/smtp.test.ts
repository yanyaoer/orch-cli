import { describe, expect, it } from "bun:test";
import {
  buildReplyMessage,
  parseSmtpReplies,
  prepareSmtpDataBlock,
  submitSmtpMessage,
  type SmtpConnection,
} from "./smtp.ts";

class FakeSmtpConnection implements SmtpConnection {
  readonly writes: string[] = [];
  startTlsCalls = 0;

  constructor(private readonly lines: string[]) {}

  async readLine(): Promise<string> {
    const line = this.lines.shift();
    if (line === undefined) throw new Error("fake SMTP server has no more replies");
    return line;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  async startTls(): Promise<void> {
    this.startTlsCalls += 1;
  }
}

describe("prepareSmtpDataBlock", () => {
  it("dot-stuffs leading dots and terminates DATA with CRLF dot CRLF", () => {
    const data = prepareSmtpDataBlock("first\n.leading\n..already\r\nlast");
    expect(data).toBe("first\r\n..leading\r\n...already\r\nlast\r\n.\r\n");
    expect(data.endsWith("\r\n.\r\n")).toBe(true);
    expect(data).not.toContain("\n.leading");
  });

  it("normalizes mixed line endings before DATA submission", () => {
    expect(prepareSmtpDataBlock("a\rb\r\nc\nd")).toBe("a\r\nb\r\nc\r\nd\r\n.\r\n");
  });
});

describe("parseSmtpReplies", () => {
  it("parses multi-line SMTP replies", () => {
    expect(parseSmtpReplies("220-mail.example ESMTP\r\n220 Ready\r\n250-AUTH PLAIN\r\n250 SIZE 100\r\n")).toEqual([
      { code: 220, lines: ["mail.example ESMTP", "Ready"], raw: "220-mail.example ESMTP\r\n220 Ready" },
      { code: 250, lines: ["AUTH PLAIN", "SIZE 100"], raw: "250-AUTH PLAIN\r\n250 SIZE 100" },
    ]);
  });
});

describe("submitSmtpMessage", () => {
  it("performs STARTTLS, re-EHLO, AUTH PLAIN, DATA, and QUIT in order", async () => {
    const fake = new FakeSmtpConnection([
      "220-mail.example ESMTP",
      "220 Ready",
      "250-mail.example",
      "250 STARTTLS",
      "220 Go ahead",
      "250-mail.example",
      "250 AUTH PLAIN",
      "235 Authenticated",
      "250 Sender ok",
      "250 Recipient ok",
      "354-Go ahead",
      "354 End data with <CR><LF>.<CR><LF>",
      "250 Queued",
      "221 Bye",
    ]);
    const result = await submitSmtpMessage({
      host: "mail.example",
      port: 587,
      mode: "starttls",
      heloName: "orch.local",
      username: "user@example.com",
      password: "secret",
      from: "orch@example.com",
      to: ["owner@example.com"],
      message: "Subject: Test\n\n.leading body",
      connector: async () => fake,
    });

    const auth = Buffer.from("\0user@example.com\0secret", "utf8").toString("base64");
    expect(fake.startTlsCalls).toBe(1);
    expect(fake.writes).toEqual([
      "EHLO orch.local\r\n",
      "STARTTLS\r\n",
      "EHLO orch.local\r\n",
      `AUTH PLAIN ${auth}\r\n`,
      "MAIL FROM:<orch@example.com>\r\n",
      "RCPT TO:<owner@example.com>\r\n",
      "DATA\r\n",
      "Subject: Test\r\n\r\n..leading body\r\n.\r\n",
      "QUIT\r\n",
    ]);
    expect(result.replies.map((reply) => reply.code)).toEqual([220, 250, 220, 250, 235, 250, 250, 354, 250, 221]);
  });

  it("dry-run returns the message and does not touch the network connector", async () => {
    const result = await submitSmtpMessage({
      host: "mail.example",
      port: 465,
      mode: "implicit",
      from: "orch@example.com",
      to: ["owner@example.com"],
      message: "Subject: Dry\n\nbody",
      dryRun: true,
      connector: async () => {
        throw new Error("network should not be touched");
      },
    });
    expect(result).toMatchObject({ dryRun: true, clientWrites: [], replies: [] });
    expect(result.rawMessage).toBe("Subject: Dry\r\n\r\nbody");
  });
});

describe("buildReplyMessage", () => {
  it("assembles thread reply headers with a deduped Re prefix and first-line sentinel", () => {
    const reply = buildReplyMessage({
      from: "orch@example.com",
      to: "owner@example.com",
      subject: "Re: re: Implement mailctl",
      reportKey: "progress:abc",
      body: "done",
      inReplyTo: "<last@Example.COM>",
      references: ["<root@example.com>", "<last@Example.COM>"],
      messageId: "<fixed@orch.example>",
      date: new Date("2026-07-04T06:00:00.000Z"),
    });
    expect(reply.messageId).toBe("<fixed@orch.example>");
    expect(reply.raw).toContain("Subject: Re: Implement mailctl\r\n");
    expect(reply.raw).toContain("In-Reply-To: <last@Example.COM>\r\n");
    expect(reply.raw).toContain("References: <root@example.com> <last@Example.COM>\r\n");
    expect(reply.raw.slice(reply.raw.indexOf("\r\n\r\n") + 4).startsWith("[orch:progress:abc]\r\n\r\ndone")).toBe(true);
  });
});
