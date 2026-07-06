import { describe, expect, it } from "bun:test";
import {
  decodeHeader,
  decodeHtmlEntities,
  extractMailAttachments,
  extractMailText,
  extractPlainText,
  parseAddress,
  parseAuthenticationResults,
  parseReferences,
} from "./mime.ts";

function htmlMessage(html: string): string {
  return ["Content-Type: text/html; charset=utf-8", "", html].join("\r\n");
}

function multipartAlternativeMessage(plain: string, html: string): string {
  return [
    "Content-Type: multipart/alternative; boundary=\"alt\"",
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    plain,
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    "--alt--",
    "",
  ].join("\r\n");
}

function authenticationResultsMessage(authenticationResults: string): string {
  return ["From: User <user@example.com>", `Authentication-Results: ${authenticationResults}`, "", "body"].join("\r\n");
}

describe("decodeHeader", () => {
  it("drops linear whitespace between adjacent RFC2047 encoded words", () => {
    expect(decodeHeader("=?UTF-8?B?5L2g5aW9?= \r\n =?UTF-8?B?5LiW55WM?=")).toBe("你好世界");
  });

  it("decodes encoded subjects without corrupting workspace tokens", () => {
    const encoded = Buffer.from("[ws:alpha-1] 调整实现", "utf8").toString("base64");
    const subject = decodeHeader(`=?UTF-8?B?${encoded}?=`);
    expect(subject.match(/\[ws:([^\]]+)\]/)?.[1]).toBe("alpha-1");
  });
});

describe("decodeHtmlEntities", () => {
  it("leaves out-of-range numeric character references literal instead of throwing", () => {
    expect(() => decodeHtmlEntities("a &#999999999999999999999999; b")).not.toThrow();
    expect(() => decodeHtmlEntities("a &#xFFFFFFFF; b")).not.toThrow();
    expect(decodeHtmlEntities("a &#999999999999999999999999; b")).toBe("a &#999999999999999999999999; b");
    expect(decodeHtmlEntities("a &#xFFFFFFFF; b")).toBe("a &#xFFFFFFFF; b");
  });
});

describe("extractMailText", () => {
  it("uses non-empty text/plain as task text and ignores HTML alternatives", () => {
    const html = [
      "<div>html task</div>",
      '<span style="font-size:0mm">FONT_MM_EVIL</span>',
      '<span style="display:n\\6fne">DISPLAY_ESCAPE_EVIL</span>',
      '<span title="</div>ATTR_EVIL',
    ].join("");
    const result = extractMailText(multipartAlternativeMessage("plain task", html));
    expect(result).toEqual({ text: "plain task", htmlOnly: false });
  });

  it("flags HTML-only hidden CSS-obfuscated mail for M4 rejection", () => {
    const payloads = [
      '<div>Ship</div><span style="font-size:0mm">FONT_MM_EVIL</span>',
      '<div>Ship</div><span style="display:n\\6fne">DISPLAY_ESCAPE_EVIL</span>',
      '<div>Ship</div><div style="display:none"><span title="</div>ATTR_EVIL',
    ];

    for (const payload of payloads) {
      const result = extractMailText(htmlMessage(payload));
      expect(result.htmlOnly).toBe(true);
    }
  });

  it("flags multipart mail with an empty text/plain part as HTML-only fallback", () => {
    const result = extractMailText(
      multipartAlternativeMessage("", '<div>Ship</div><span style="font-size:0mm">FONT_MM_EVIL</span>'),
    );
    expect(result.htmlOnly).toBe(true);
    expect(result.text).toContain("Ship");
  });

  it("returns text/plain-only task text without htmlOnly", () => {
    const raw = ["Content-Type: text/plain; charset=utf-8", "", "Do the work"].join("\r\n");
    expect(extractMailText(raw)).toEqual({ text: "Do the work", htmlOnly: false });
  });

  it("ignores text/plain attachments when collecting authoritative body text", () => {
    const raw = [
      "Content-Type: multipart/mixed; boundary=\"mix\"",
      "",
      "--mix",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML instruction</p>",
      "--mix",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Disposition: attachment; filename=\"task.txt\"",
      "",
      "attachment instruction",
      "--mix--",
      "",
    ].join("\r\n");
    expect(extractMailText(raw)).toEqual({ text: "HTML instruction", htmlOnly: true });
  });

  it("returns an empty non-htmlOnly result for an empty message", () => {
    expect(extractMailText("")).toEqual({ text: "", htmlOnly: false });
  });

  it("uses flagged HTML text only as best-effort display fallback", () => {
    const result = extractMailText(htmlMessage("<div>a < b</div><p>Keep this task</p>"));
    expect(result.htmlOnly).toBe(true);
    expect(result.text).toContain("a < b");
    expect(result.text).toContain("Keep this task");
  });

  it("decodes quoted-printable soft line breaks on text/plain", () => {
    const raw = [
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Please imple=",
      "ment this",
    ].join("\r\n");
    expect(extractMailText(raw)).toEqual({ text: "Please implement this", htmlOnly: false });
  });

  it("decodes base64 text/plain bodies", () => {
    const body = Buffer.from("base64 task body", "utf8").toString("base64");
    const raw = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
    expect(extractMailText(raw)).toEqual({ text: "base64 task body", htmlOnly: false });
  });

  it("transcodes non-UTF-8 text/plain bodies", () => {
    const raw = [
      "Content-Type: text/plain; charset=iso-8859-1",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "caf=E9 task",
    ].join("\r\n");
    expect(extractMailText(raw)).toEqual({ text: "café task", htmlOnly: false });
  });

  it("preserves raw bytes when transcoding Uint8Array text/plain messages", () => {
    const header = Buffer.from("Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n", "ascii");
    const body = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(extractMailText(Buffer.concat([header, body]))).toEqual({ text: "café", htmlOnly: false });
  });

  it("removes quoted tails and forwarded blocks from text/plain task text", () => {
    const raw = [
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Do the new work",
      "> old quoted command",
      "On Tue, Someone wrote:",
      "old tail",
      "----- Forwarded message -----",
      "forwarded command",
    ].join("\r\n");
    const result = extractMailText(raw);
    expect(result.htmlOnly).toBe(false);
    expect(result.text).toBe("Do the new work");
    expect(result.text).not.toContain("old quoted");
    expect(result.text).not.toContain("forwarded");
  });

  it("removes standalone forwarded blocks from text/plain task text", () => {
    const raw = [
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Do the new work",
      "----- Forwarded message -----",
      "forwarded command",
      "On Tue, Someone wrote:",
      "old tail",
    ].join("\r\n");
    const result = extractMailText(raw);
    expect(result.htmlOnly).toBe(false);
    expect(result.text).toBe("Do the new work");
    expect(result.text).not.toContain("forwarded");
    expect(result.text).not.toContain("old tail");
  });
});

describe("extractPlainText", () => {
  it("returns the text from extractMailText for compatibility", () => {
    const raw = multipartAlternativeMessage("plain task", "<p>html task</p>");
    expect(extractPlainText(raw)).toBe(extractMailText(raw).text);
  });
});

describe("parseAuthenticationResults", () => {
  it("fails closed when trusted authserv-id is empty", () => {
    const raw = [
      "From: User <user@example.com>",
      "Authentication-Results: ; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      "",
      "body",
    ].join("\r\n");
    const result = parseAuthenticationResults(raw, " ");
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("empty trusted authserv-id");
    expect(result.evaluated).toBe(0);
  });

  it("fails when only an untrusted forged Authentication-Results header passes", () => {
    const raw = [
      "From: Attacker <attacker@example.com>",
      "Authentication-Results: mx.trusted.example; dkim=fail header.d=example.com; dmarc=fail header.from=example.com",
      "Authentication-Results: attacker.invalid; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      "",
      "body",
    ].join("\r\n");
    const result = parseAuthenticationResults(raw, "mx.trusted.example");
    expect(result.pass).toBe(false);
    expect(result.evaluated).toBe(1);
    expect(result.reason).toContain("dkim=pass");
  });

  it("evaluates only the first trusted Authentication-Results header", () => {
    const raw = [
      "From: Boss <boss@example.com>",
      "Authentication-Results: mx.trusted.example; dkim=fail header.d=example.com; dmarc=fail header.from=example.com",
      "Authentication-Results: mx.trusted.example; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      "",
      "body",
    ].join("\r\n");
    const result = parseAuthenticationResults(raw, "mx.trusted.example");
    expect(result.pass).toBe(false);
    expect(result.evaluated).toBe(1);
    expect(result.reason).toContain("dkim=pass");
  });

  it("fails closed when the trusted Authentication-Results header is absent", () => {
    const raw = [
      "From: User <user@example.com>",
      "Authentication-Results: attacker.invalid; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      "",
      "body",
    ].join("\r\n");
    const result = parseAuthenticationResults(raw, "mx.trusted.example");
    expect(result.pass).toBe(false);
    expect(result.evaluated).toBe(0);
  });

  it("does not use smtp.mailfrom as the DKIM signing domain", () => {
    const raw = [
      "From: User <user@example.com>",
      "Authentication-Results: mx.trusted.example; dkim=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
      "",
      "body",
    ].join("\r\n");
    const result = parseAuthenticationResults(raw, "mx.trusted.example");
    expect(result.pass).toBe(false);
    expect(result.evaluated).toBe(1);
    expect(result.reason).toContain("dkim domain (missing)");
  });

  it("passes only for the configured authserv-id with aligned DKIM and DMARC domains", () => {
    const raw = [
      "From: =?UTF-8?B?5Li757u0?= <boss@team.example.com>",
      "Authentication-Results: other.example; dkim=pass header.d=evil.example; dmarc=pass header.from=evil.example",
      "Authentication-Results: mx.trusted.example;",
      " dkim=pass header.i=@example.com header.d=example.com;",
      " dmarc=pass header.from=team.example.com",
      "",
      "body",
    ].join("\r\n");
    const result = parseAuthenticationResults(raw, "mx.trusted.example");
    expect(result).toMatchObject({
      pass: true,
      fromDomain: "team.example.com",
      dkimDomain: "example.com",
      dmarcDomain: "team.example.com",
    });
  });

  it("fails when a trusted pass is not aligned with the From domain", () => {
    const raw = [
      "From: User <user@example.com>",
      "Authentication-Results: mx.trusted.example; dkim=pass header.d=attacker.test; dmarc=pass header.from=example.com",
      "",
      "body",
    ].join("\r\n");
    expect(parseAuthenticationResults(raw, "mx.trusted.example").pass).toBe(false);
  });

  it("fails closed when trusted Authentication-Results domains are malformed", () => {
    const cases = [
      "mx.trusted.example; dkim=pass header.i=@.example.com; dmarc=pass header.from=example.com",
      "mx.trusted.example; dkim=pass header.d=evil..example.com; dmarc=pass header.from=example.com",
      'mx.trusted.example; dkim=pass header.d=""; dmarc=pass header.from=example.com',
      "mx.trusted.example; dkim=pass header.d=.example.com; dmarc=pass header.from=example.com",
      "mx.trusted.example; dkim=pass header.d=exa_mple.com; dmarc=pass header.from=example.com",
      "mx.trusted.example; dkim=pass header.d=example.com; dmarc=pass header.from=evil..example.com",
    ];

    for (const authenticationResults of cases) {
      const result = parseAuthenticationResults(authenticationResultsMessage(authenticationResults), "mx.trusted.example");
      expect(result.pass).toBe(false);
      expect(result.reason).toContain("malformed");
    }
  });
});

describe("parseAddress", () => {
  it("parses encoded display names, comments, multiple addresses, and mixed-case domains", () => {
    const addresses = parseAddress("=?UTF-8?B?5byA5Y+R6ICF?= (lead) <Boss@Sub.Example.COM>, Other (comment) <other@Example.ORG>");
    expect(addresses).toHaveLength(2);
    expect(addresses[0]).toMatchObject({
      displayName: "开发者",
      address: "Boss@sub.example.com",
      local: "Boss",
      domain: "sub.example.com",
    });
    expect(addresses[1]!.address).toBe("other@example.org");
  });

  it("uses the parsed From identity independently from Reply-To", () => {
    const from = parseAddress("Project Owner <owner@Example.COM>")[0]!;
    const replyTo = parseAddress("Reply Bot <bot@reply.example.com>")[0]!;
    expect(from.address).toBe("owner@example.com");
    expect(replyTo.address).toBe("bot@reply.example.com");
  });

  it("resolves the actual address domain instead of display-name or local-part spoofs", () => {
    const displaySpoof = parseAddress('"victim@trusted.example" <attacker@evil.example>')[0]!;
    const doubleAt = parseAddress("a@trusted.example@evil.example")[0]!;
    expect(displaySpoof.domain).toBe("evil.example");
    expect(doubleAt.domain).toBe("evil.example");
  });
});

describe("parseReferences", () => {
  it("extracts References and In-Reply-To message ids with normalized domains", () => {
    const raw = [
      "References: <root@Example.COM> <mid@Sub.Example.COM>",
      "In-Reply-To: <leaf@Example.COM>",
      "",
      "body",
    ].join("\r\n");
    expect(parseReferences(raw)).toEqual({
      references: ["<root@example.com>", "<mid@sub.example.com>"],
      inReplyTo: ["<leaf@example.com>"],
      all: ["<root@example.com>", "<mid@sub.example.com>", "<leaf@example.com>"],
    });
  });
});

describe("extractMailAttachments", () => {
  it("collects disposition and filename-bearing parts with decoded bytes, skipping body text", () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="mix"',
      "",
      "--mix",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Fix the bug, log attached",
      "--mix",
      'Content-Type: text/plain; charset=utf-8; name="crash.log"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="crash.log"',
      "",
      Buffer.from("line1\nline2\n").toString("base64"),
      "--mix",
      'Content-Type: image/png; name="=?UTF-8?B?5oiq5Zu+?=.png"',
      "Content-Transfer-Encoding: base64",
      "Content-Disposition: inline",
      "",
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      "--mix--",
      "",
    ].join("\r\n");

    const attachments = extractMailAttachments(raw);
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({ filename: "crash.log", contentType: "text/plain" });
    expect(new TextDecoder().decode(attachments[0]!.bytes)).toBe("line1\nline2\n");
    expect(attachments[1]).toMatchObject({ filename: "截图.png", contentType: "image/png" });
    expect([...attachments[1]!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(extractMailText(raw)).toEqual({ text: "Fix the bug, log attached", htmlOnly: false });
  });

  it("returns nothing for plain text and multipart/alternative mail", () => {
    expect(extractMailAttachments(["Content-Type: text/plain", "", "body"].join("\r\n"))).toEqual([]);
    expect(extractMailAttachments(multipartAlternativeMessage("plain", "<p>html</p>"))).toEqual([]);
  });
});
