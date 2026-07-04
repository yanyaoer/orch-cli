export interface ParsedHeaderBlock {
  headers: Map<string, string[]>;
  body: string;
}

export interface ParsedAddress {
  displayName: string | null;
  address: string;
  local: string;
  domain: string;
}

export interface ParsedReferences {
  inReplyTo: string[];
  references: string[];
  all: string[];
}

export interface AuthenticationResultsCheck {
  pass: boolean;
  reason: string;
  trustedAuthservId: string;
  evaluated: number;
  fromDomain: string | null;
  dkimDomain?: string;
  dmarcDomain?: string;
}

export interface ExtractedMailText {
  text: string;
  htmlOnly: boolean;
}

interface MimeTextParts {
  plain: string[];
  html: string[];
}

interface ParsedHeaderValue {
  value: string;
  params: Map<string, string>;
}

const textEncoder = new TextEncoder();

function rawToBinaryString(raw: string | Uint8Array): string {
  if (typeof raw === "string") return raw;
  let output = "";
  for (let i = 0; i < raw.length; i += 8192) {
    output += String.fromCharCode(...raw.slice(i, i + 8192));
  }
  return output;
}

export function parseHeaderBlock(raw: string | Uint8Array): ParsedHeaderBlock {
  const text = rawToBinaryString(raw);
  const match = /\r?\n\r?\n/.exec(text);
  const headerText = match ? text.slice(0, match.index) : text;
  const body = match ? text.slice(match.index + match[0].length) : "";
  const headers = new Map<string, string[]>();
  let currentName: string | null = null;
  let currentValue = "";

  function commit(): void {
    if (!currentName) return;
    const existing = headers.get(currentName) ?? [];
    existing.push(currentValue);
    headers.set(currentName, existing);
  }

  for (const line of headerText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && currentName) {
      currentValue += `\r\n${line}`;
      continue;
    }
    commit();
    const colon = line.indexOf(":");
    if (colon < 0) {
      currentName = null;
      currentValue = "";
      continue;
    }
    currentName = line.slice(0, colon).trim().toLowerCase();
    currentValue = line.slice(colon + 1).trim();
  }
  commit();
  return { headers, body };
}

export function headerValues(raw: string | Uint8Array, name: string): string[] {
  return parseHeaderBlock(raw).headers.get(name.toLowerCase()) ?? [];
}

function unfoldHeader(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, " ");
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

function splitHeaderParameters(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let commentDepth = 0;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = quoted || commentDepth > 0;
      continue;
    }
    if (quoted) {
      current += char;
      if (char === "\"") quoted = false;
      continue;
    }
    if (commentDepth > 0) {
      current += char;
      if (char === "(") commentDepth += 1;
      if (char === ")") commentDepth -= 1;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      current += char;
      continue;
    }
    if (char === "(") {
      commentDepth = 1;
      current += char;
      continue;
    }
    if (char === ";") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function parseParameterizedHeader(value: string | null | undefined, fallback: string): ParsedHeaderValue {
  const parts = splitHeaderParameters(unfoldHeader(value ?? ""));
  const main = (parts.shift() ?? fallback).trim().toLowerCase() || fallback;
  const params = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const key = part.slice(0, equals).trim().toLowerCase();
    const rawValue = part.slice(equals + 1).trim();
    if (key) params.set(key, decodeHeader(stripOuterQuotes(rawValue)));
  }
  return { value: main, params };
}

function decodeBytes(bytes: Uint8Array, declaredCharset: string | null | undefined): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const label = declaredCharset?.trim().toLowerCase();
    if (label && label !== "utf-8" && label !== "utf8") {
      try {
        return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0], { fatal: false }).decode(bytes);
      } catch {
        // Fall through to replacement UTF-8 below.
      }
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeQuotedPrintableBytes(value: string, rfc2047Q: boolean): Uint8Array {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bytes: number[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (rfc2047Q && char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=") {
      const next = normalized[i + 1];
      if (!rfc2047Q && next === "\n") {
        i += 1;
        continue;
      }
      const hex = normalized.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const code = char.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
    else bytes.push(...textEncoder.encode(char));
  }
  return Uint8Array.from(bytes);
}

function decodeTransferBody(body: string, encoding: string | null | undefined): Uint8Array {
  const normalized = (encoding ?? "7bit").trim().toLowerCase();
  if (normalized === "quoted-printable") return decodeQuotedPrintableBytes(body, false);
  if (normalized === "base64") {
    const compact = body.replace(/[^A-Za-z0-9+/=]/g, "");
    return Uint8Array.from(Buffer.from(compact, "base64"));
  }
  const bytes: number[] = [];
  for (const char of body) {
    const code = char.charCodeAt(0);
    if (code <= 0xff) bytes.push(code);
    else bytes.push(...textEncoder.encode(char));
  }
  return Uint8Array.from(bytes);
}

function decodeEncodedWord(charset: string, mode: string, encoded: string): string {
  const bytes =
    mode.toUpperCase() === "B"
      ? Uint8Array.from(Buffer.from(encoded.replace(/\s+/g, ""), "base64"))
      : decodeQuotedPrintableBytes(encoded, true);
  return decodeBytes(bytes, charset);
}

export function decodeHeader(value: string): string {
  const unfolded = unfoldHeader(value);
  const encodedWord = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;
  let output = "";
  let index = 0;
  let previousWasEncoded = false;
  for (;;) {
    const match = encodedWord.exec(unfolded);
    if (!match) break;
    const between = unfolded.slice(index, match.index);
    if (!(previousWasEncoded && /^[ \t]*$/.test(between))) output += between;
    output += decodeEncodedWord(match[1]!, match[2]!, match[3]!);
    previousWasEncoded = true;
    index = match.index + match[0].length;
  }
  output += unfolded.slice(index);
  return output;
}

function splitMultipartBody(body: string, boundary: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const marker = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === marker || line === `${marker}--`) {
      if (current) parts.push(current.join("\n"));
      current = line === `${marker}--` ? null : [];
      if (line === `${marker}--`) break;
      continue;
    }
    if (current) current.push(line);
  }
  return parts;
}

function decodeNumericHtmlEntity(entity: string, digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

export function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/g, (entity, body: string) => {
    if (body.startsWith("#x")) return decodeNumericHtmlEntity(entity, body.slice(2), 16);
    if (body.startsWith("#")) return decodeNumericHtmlEntity(entity, body.slice(1), 10);
    return named[body.toLowerCase()] ?? entity;
  });
}

interface HtmlTagToken {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: string;
}

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HTML_RAW_TEXT_ELEMENTS = "script|style|title|textarea|noscript";
const CSS_ZERO_FONT_SIZE =
  /font-size\s*:\s*[+-]?(?:0+(?:\.0+)?|\.[0]+)\s*(?:px|em|rem|pt|pc|ex|ch|vw|vh|%)?\s*(?:!important)?(?=\s*(?:;|$))/;

const HTML_BLOCK_END_ELEMENTS = new Set(["p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);

interface HtmlTagPrefix {
  closing: boolean;
  name: string;
  attrsStart: number;
}

function isAsciiLetter(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isHtmlNameChar(char: string | undefined): boolean {
  if (!char) return false;
  return isAsciiLetter(char) || /[0-9:-]/.test(char);
}

function readHtmlTagPrefix(html: string, start: number): HtmlTagPrefix | null {
  if (html[start] !== "<") return null;
  let index = start + 1;
  const closing = html[index] === "/";
  if (closing) index += 1;
  if (!isAsciiLetter(html[index])) return null;
  const nameStart = index;
  index += 1;
  while (isHtmlNameChar(html[index])) index += 1;
  return { closing, name: html.slice(nameStart, index).toLowerCase(), attrsStart: index };
}

function readHtmlTag(html: string, start: number): HtmlTagToken | null {
  const prefix = readHtmlTagPrefix(html, start);
  if (!prefix) return null;
  let quote: string | null = null;
  let end = start + 1;
  for (; end < html.length; end += 1) {
    const char = html[end]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") break;
  }
  if (end >= html.length) {
    const attrs = prefix.closing ? "" : html.slice(prefix.attrsStart).replace(/\/\s*$/, "");
    return {
      start,
      end: html.length,
      name: prefix.name,
      closing: prefix.closing,
      selfClosing: !prefix.closing && HTML_VOID_ELEMENTS.has(prefix.name),
      attrs,
    };
  }

  const raw = html.slice(start, end + 1);
  const match = raw.match(/^<(\/?)([A-Za-z][A-Za-z0-9:-]*)([\s/][\s\S]*?)?>$/);
  if (!match) return null;
  const closing = match[1] === "/";
  const name = match[2]!.toLowerCase();
  const selfClosing = !closing && HTML_VOID_ELEMENTS.has(name);
  const attrs = closing ? "" : (match[3] ?? "").replace(/\/\s*$/, "");
  return { start, end: end + 1, name, closing, selfClosing, attrs };
}

function nextHtmlTag(html: string, offset: number): HtmlTagToken | null {
  let start = html.indexOf("<", offset);
  while (start >= 0) {
    const tag = readHtmlTag(html, start);
    if (tag) return tag;
    start = html.indexOf("<", start + 1);
  }
  return null;
}

function parseHtmlAttributes(value: string): Map<string, string | null> {
  const attrs = new Map<string, string | null>();
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s/]/.test(value[index]!)) index += 1;
    const nameStart = index;
    while (index < value.length && !/[\s=/>]/.test(value[index]!)) index += 1;
    if (index === nameStart) break;
    const name = value.slice(nameStart, index).toLowerCase();
    while (index < value.length && /\s/.test(value[index]!)) index += 1;
    let attrValue: string | null = null;
    if (value[index] === "=") {
      index += 1;
      while (index < value.length && /\s/.test(value[index]!)) index += 1;
      const quote = value[index] === "\"" || value[index] === "'" ? value[index] : null;
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < value.length && value[index] !== quote) index += 1;
        attrValue = value.slice(valueStart, index);
        if (value[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < value.length && !/[\s>]/.test(value[index]!)) index += 1;
        attrValue = value.slice(valueStart, index).replace(/\/$/, "");
      }
    }
    attrs.set(name, attrValue);
  }
  return attrs;
}

function normalizedAttribute(attrs: Map<string, string | null>, name: string): string | null {
  const value = attrs.get(name);
  return value === undefined || value === null ? null : decodeHtmlEntities(value).trim().toLowerCase();
}

function normalizedCssStyle(value: string): string {
  return value.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "").replace(/\s+/g, " ").trim();
}

function isHiddenOrQuotedHtmlRoot(tag: HtmlTagToken): boolean {
  if (tag.name === "blockquote") return true;
  const attrs = parseHtmlAttributes(tag.attrs);
  if (attrs.has("hidden")) return true;
  if (normalizedAttribute(attrs, "aria-hidden") === "true") return true;
  const className = normalizedAttribute(attrs, "class");
  const classes = className?.split(/\s+/).filter(Boolean) ?? [];
  if (classes.includes("gmail_quote") || classes.includes("yahoo_quoted")) return true;
  const rawStyle = normalizedAttribute(attrs, "style");
  const style = rawStyle ? normalizedCssStyle(rawStyle) : null;
  return Boolean(
    style &&
      (/display\s*:\s*none\b/.test(style) ||
        /visibility\s*:\s*hidden\b/.test(style) ||
        /mso-hide\s*:\s*all\b/.test(style) ||
        CSS_ZERO_FONT_SIZE.test(style)),
  );
}

function htmlSubtreeEnd(html: string, root: HtmlTagToken): number {
  if (root.selfClosing) return root.end;
  const stack = [root.name];
  let offset = root.end;
  for (;;) {
    const tag = nextHtmlTag(html, offset);
    // This is best-effort display/logging cleanup only. The security boundary is
    // extractMailText().htmlOnly plus the rule that task text comes only from a
    // real non-empty text/plain part; M4 refuses htmlOnly mail.
    if (!tag) return html.length;
    offset = tag.end;
    if (tag.closing) {
      if (stack.at(-1) !== tag.name) return html.length;
      stack.pop();
      if (stack.length === 0) return tag.end;
    } else if (!tag.selfClosing && !HTML_VOID_ELEMENTS.has(tag.name)) {
      stack.push(tag.name);
    }
  }
}

function removeHiddenHtmlBlocks(html: string): string {
  let output = "";
  let cursor = 0;
  let scan = 0;
  for (;;) {
    const tag = nextHtmlTag(html, scan);
    if (!tag) break;
    if (tag.start < cursor) {
      scan = tag.end;
      continue;
    }
    if (!tag.closing && isHiddenOrQuotedHtmlRoot(tag)) {
      output += html.slice(cursor, tag.start);
      output += "\n";
      cursor = htmlSubtreeEnd(html, tag);
      scan = cursor;
      continue;
    }
    scan = tag.end;
  }
  return output + html.slice(cursor);
}

function stripRemainingHtmlTags(html: string): string {
  let output = "";
  let cursor = 0;
  let scan = 0;
  for (;;) {
    const tag = nextHtmlTag(html, scan);
    if (!tag) break;
    if (tag.start < cursor) {
      scan = tag.end;
      continue;
    }
    output += html.slice(cursor, tag.start);
    if ((!tag.closing && (tag.name === "br" || tag.name === "li")) || (tag.closing && HTML_BLOCK_END_ELEMENTS.has(tag.name))) {
      output += "\n";
    } else {
      output += " ";
    }
    cursor = tag.end;
    scan = tag.end;
  }
  return output + html.slice(cursor);
}

function stripHtmlScannerUnsafeContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|--!>|$)/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, " ")
    .replace(new RegExp(`<\\s*(${HTML_RAW_TEXT_ELEMENTS})\\b[^>]*>[\\s\\S]*?(?:<\\/\\1(?:\\s[^>]*)?>|$)`, "gi"), " ")
    .replace(/<![^>]*(?:>|$)/g, " ");
}

function htmlToText(html: string): string {
  // Best-effort DISPLAY/LOGGING ONLY HTML stripping. Do not treat this as the
  // security boundary or chase every CSS hiding/vector variant here; command
  // text is accepted only from text/plain, and HTML-only mail is flagged.
  const cleaned = stripHtmlScannerUnsafeContent(html);
  return decodeHtmlEntities(
    stripRemainingHtmlTags(removeHiddenHtmlBlocks(cleaned).replace(/<\s*head\b[\s\S]*?<\/\s*head\s*>/gi, " "))
  );
}

function cleanExtractedText(text: string): string {
  const output: string[] = [];
  for (const rawLine of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const line = rawLine.replace(/[ \t]+$/g, "");
    const trimmed = line.trim();
    if (/^>/.test(trimmed)) continue;
    if (/^On .{0,300}\bwrote:$/i.test(trimmed)) break;
    if (/^-{2,}\s*Forwarded message\s*-{2,}$/i.test(trimmed)) break;
    if (/^Begin forwarded message:$/i.test(trimmed)) break;
    output.push(line);
  }
  return output.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseMimePart(raw: string, depth: number): MimeTextParts {
  if (depth > 20) return { plain: [], html: [] };
  const { headers, body } = parseHeaderBlock(raw);
  const contentDisposition = parseParameterizedHeader(headers.get("content-disposition")?.[0], "");
  if (contentDisposition.value === "attachment") return { plain: [], html: [] };
  const contentType = parseParameterizedHeader(headers.get("content-type")?.[0], "text/plain");
  if (contentType.value.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary");
    if (!boundary) return { plain: [], html: [] };
    const parts = splitMultipartBody(body, boundary);
    return parts.reduce<MimeTextParts>(
      (acc, part) => {
        const parsed = parseMimePart(part, depth + 1);
        acc.plain.push(...parsed.plain);
        acc.html.push(...parsed.html);
        return acc;
      },
      { plain: [], html: [] },
    );
  }

  const transferEncoding = headers.get("content-transfer-encoding")?.[0];
  const decoded = decodeBytes(decodeTransferBody(body, transferEncoding), contentType.params.get("charset"));
  if (contentType.value.toLowerCase() === "text/plain") return { plain: [cleanExtractedText(decoded)].filter(Boolean), html: [] };
  if (contentType.value.toLowerCase() === "text/html") {
    return { plain: [], html: decoded.trim() ? [cleanExtractedText(htmlToText(decoded))] : [] };
  }
  return { plain: [], html: [] };
}

export function extractMailText(raw: string | Uint8Array): ExtractedMailText {
  const text = rawToBinaryString(raw);
  const parts = parseMimePart(text, 0);
  if (parts.plain.length > 0) return { text: parts.plain.join("\n\n").trim(), htmlOnly: false };
  if (parts.html.length > 0) return { text: parts.html.join("\n\n").trim(), htmlOnly: true };
  return { text: "", htmlOnly: false };
}

export function extractPlainText(raw: string | Uint8Array): string {
  return extractMailText(raw).text;
}

function splitAddressList(value: string): string[] {
  const addresses: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  let commentDepth = 0;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = quoted || commentDepth > 0;
      continue;
    }
    if (quoted) {
      current += char;
      if (char === "\"") quoted = false;
      continue;
    }
    if (commentDepth > 0) {
      current += char;
      if (char === "(") commentDepth += 1;
      if (char === ")") commentDepth -= 1;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      current += char;
      continue;
    }
    if (char === "(") {
      commentDepth = 1;
      current += char;
      continue;
    }
    if (char === "<") angleDepth += 1;
    if (char === ">" && angleDepth > 0) angleDepth -= 1;
    if (char === "," && angleDepth === 0) {
      if (current.trim()) addresses.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) addresses.push(current.trim());
  return addresses;
}

function stripComments(value: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (const char of value) {
    if (escaped) {
      if (depth === 0) output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (depth === 0) output += char;
      escaped = quoted || depth > 0;
      continue;
    }
    if (quoted) {
      output += char;
      if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") {
      output += char;
      quoted = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) output += char;
  }
  return output;
}

function normalizeAddress(addr: string): ParsedAddress | null {
  const trimmed = stripOuterQuotes(addr).replace(/\s+/g, "");
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at).replace(/^"|"$/g, "");
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+$/.test(local) && !addr.trim().startsWith("\"")) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return null;
  return { displayName: null, address: `${local}@${domain}`, local, domain };
}

export function parseAddress(value: string): ParsedAddress[] {
  return splitAddressList(unfoldHeader(value)).flatMap((entry) => {
    const withoutComments = stripComments(entry).trim();
    const angle = withoutComments.match(/^(.*)<([^<>]+)>\s*$/);
    if (angle) {
      const parsed = normalizeAddress(angle[2]!);
      if (!parsed) return [];
      const display = decodeHeader(stripOuterQuotes(angle[1]!.trim().replace(/^,|,$/g, ""))).trim();
      return [{ ...parsed, displayName: display || null }];
    }
    const token = withoutComments.match(/[^\s<>(),;:]+@[^\s<>(),;:]+/);
    const parsed = token ? normalizeAddress(token[0]) : normalizeAddress(withoutComments);
    return parsed ? [parsed] : [];
  });
}

function normalizeDomain(value: string): string {
  return stripOuterQuotes(value).trim().replace(/[<>]/g, "").toLowerCase();
}

function normalizeHostnameDomain(value: string): string | null {
  const domain = normalizeDomain(value);
  if (domain.length === 0 || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
  }
  return domain;
}

function normalizeHeaderIdentityDomain(value: string): string | null {
  const identity = stripOuterQuotes(value).trim().replace(/[<>]/g, "");
  const at = identity.lastIndexOf("@");
  if (at < 0 || at === identity.length - 1) return null;
  return normalizeHostnameDomain(identity.slice(at + 1));
}

function domainsAlign(left: string, right: string): boolean {
  const a = normalizeHostnameDomain(left);
  const b = normalizeHostnameDomain(right);
  if (!a || !b) return false;
  // No public-suffix awareness: this only checks same-domain/subdomain alignment.
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function stripAuthComments(value: string): string {
  return stripComments(value).replace(/\s+/g, " ").trim();
}

function splitAuthResults(value: string): string[] {
  return splitHeaderParameters(unfoldHeader(value));
}

function parseAuthProperties(value: string): Map<string, string> {
  const props = new Map<string, string>();
  const cleaned = stripAuthComments(value);
  const propPattern = /(?:^|\s)([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)?)=("[^"]*"|[^\s;]+)/g;
  for (;;) {
    const match = propPattern.exec(cleaned);
    if (!match) break;
    props.set(match[1]!.toLowerCase(), stripOuterQuotes(match[2]!));
  }
  return props;
}

function methodResult(value: string, method: string): string | null {
  const match = stripAuthComments(value).match(new RegExp(`^${method}\\s*=\\s*([A-Za-z0-9_.-]+)`, "i"));
  return match?.[1]?.toLowerCase() ?? null;
}

export function parseAuthenticationResults(
  raw: string,
  trustedAuthservId: string,
  fromMailbox?: ParsedAddress | null,
): AuthenticationResultsCheck {
  const trusted = trustedAuthservId.trim().toLowerCase();
  if (!trusted) {
    return { pass: false, reason: "empty trusted authserv-id", trustedAuthservId: trusted, evaluated: 0, fromDomain: null };
  }
  const from =
    fromMailbox ??
    (() => {
      const fromHeaders = headerValues(raw, "From");
      if (fromHeaders.length !== 1) return null;
      const mailboxes = parseAddress(fromHeaders[0]!);
      return mailboxes.length === 1 ? mailboxes[0]! : null;
    })();
  const fromDomain = from?.domain ?? null;
  if (!fromDomain) {
    return { pass: false, reason: "missing From domain", trustedAuthservId: trusted, evaluated: 0, fromDomain: null };
  }

  for (const value of headerValues(raw, "Authentication-Results")) {
    const parts = splitAuthResults(value);
    const authservId = stripAuthComments(parts.shift() ?? "").split(/\s+/)[0]?.toLowerCase() ?? "";
    if (authservId !== trusted) continue;
    const evaluated = 1;

    let dkimDomain: string | null = null;
    let dmarcDomain: string | null = null;
    let dkimPass = false;
    let dmarcPass = false;
    let malformedAuthDomain: string | null = null;

    for (const part of parts) {
      const dkim = methodResult(part, "dkim");
      if (dkim) {
        const props = parseAuthProperties(part);
        dkimPass = dkim === "pass";
        const headerD = props.get("header.d");
        if (headerD !== undefined) {
          dkimDomain = normalizeHostnameDomain(headerD);
          if (!dkimDomain) malformedAuthDomain ??= `dkim header.d ${headerD || "(empty)"}`;
        }
        const headerI = props.get("header.i");
        if (headerI !== undefined) {
          const headerIDomain = normalizeHeaderIdentityDomain(headerI);
          if (!headerIDomain) malformedAuthDomain ??= `dkim header.i ${headerI || "(empty)"}`;
          if (!dkimDomain && headerD === undefined) dkimDomain = headerIDomain;
        }
      }
      const dmarc = methodResult(part, "dmarc");
      if (dmarc) {
        const props = parseAuthProperties(part);
        dmarcPass = dmarc === "pass";
        const rawDmarcDomain = props.get("header.from") ?? props.get("policy.header_from") ?? props.get("from");
        if (rawDmarcDomain !== undefined) {
          dmarcDomain = normalizeHostnameDomain(rawDmarcDomain);
          if (!dmarcDomain) malformedAuthDomain ??= `dmarc header.from ${rawDmarcDomain || "(empty)"}`;
        }
      }
    }

    if (!dkimPass) {
      return {
        pass: false,
        reason: `trusted authserv-id ${trusted} did not report dkim=pass`,
        trustedAuthservId: trusted,
        evaluated,
        fromDomain,
      };
    }
    if (!dmarcPass) {
      return {
        pass: false,
        reason: `trusted authserv-id ${trusted} did not report dmarc=pass`,
        trustedAuthservId: trusted,
        evaluated,
        fromDomain,
      };
    }
    if (malformedAuthDomain) {
      return {
        pass: false,
        reason: `${malformedAuthDomain} is malformed`,
        trustedAuthservId: trusted,
        evaluated,
        fromDomain,
      };
    }
    if (!dkimDomain || !domainsAlign(dkimDomain, fromDomain)) {
      return {
        pass: false,
        reason: `dkim domain ${dkimDomain ?? "(missing)"} is not aligned with From ${fromDomain}`,
        trustedAuthservId: trusted,
        evaluated,
        fromDomain,
      };
    }
    if (!dmarcDomain || !domainsAlign(dmarcDomain, fromDomain)) {
      return {
        pass: false,
        reason: `dmarc domain ${dmarcDomain ?? "(missing)"} is not aligned with From ${fromDomain}`,
        trustedAuthservId: trusted,
        evaluated,
        fromDomain,
      };
    }
    return {
      pass: true,
      reason: "trusted Authentication-Results dkim/dmarc pass and align",
      trustedAuthservId: trusted,
      evaluated,
      fromDomain,
      dkimDomain: normalizeDomain(dkimDomain),
      dmarcDomain: normalizeDomain(dmarcDomain),
    };
  }

  return { pass: false, reason: "no trusted Authentication-Results header", trustedAuthservId: trusted, evaluated: 0, fromDomain };
}

function normalizeMessageId(id: string): string | null {
  const cleaned = id.trim().replace(/^<|>$/g, "");
  const at = cleaned.lastIndexOf("@");
  if (at <= 0 || at === cleaned.length - 1 || /\s/.test(cleaned)) return null;
  return `<${cleaned.slice(0, at)}@${cleaned.slice(at + 1).toLowerCase()}>`;
}

function extractMessageIds(values: string[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    const decoded = decodeHeader(unfoldHeader(value));
    for (const match of decoded.matchAll(/<([^<>]+@[^<>\s]+)>/g)) {
      const normalized = normalizeMessageId(match[1]!);
      if (normalized) ids.push(normalized);
    }
  }
  return ids;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function parseReferences(raw: string): ParsedReferences {
  const references = unique(extractMessageIds(headerValues(raw, "References")));
  const inReplyTo = unique(extractMessageIds(headerValues(raw, "In-Reply-To")));
  return { references, inReplyTo, all: unique([...references, ...inReplyTo]) };
}
