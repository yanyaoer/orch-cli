import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, jsonBytes(value));
}

// O_EXCL create-or-fail: for files whose existence is itself the protocol
// (e.g. decision.json as a run's atomic ack). Throws the raw EEXIST error;
// callers translate it into their own "already done" message.
export function writeJsonExclusive(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o644);
  try {
    writeFileSync(fd, jsonBytes(value), "utf8");
  } finally {
    closeSync(fd);
  }
}

export function writeTextAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, value, "utf8");
  renameSync(tmp, path);
}

export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

export function countLines(path: string): number {
  try {
    const text = readFileSync(path, "utf8");
    if (!text) return 0;
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

// Incremental reader for an append-only jsonl file: each drain() returns the
// complete lines appended since the previous call, buffering a trailing
// half-written line until its newline arrives. A missing file drains empty
// (a follower may start before the writer creates the file); a shrunken file
// is treated as rewritten and re-read from the top.
export function createFileFollower(path: string, offset = 0): { drain(): string[]; sawFile(): boolean } {
  let position = offset;
  let pending = Buffer.alloc(0);
  let seen = false;
  const drain = (): string[] => {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return [];
    }
    seen = true;
    let chunk: Buffer;
    try {
      const size = fstatSync(fd).size;
      if (size < position) {
        position = 0;
        pending = Buffer.alloc(0);
      }
      if (size === position) return [];
      const buffer = Buffer.alloc(size - position);
      const read = readSync(fd, buffer, 0, buffer.length, position);
      chunk = buffer.subarray(0, read);
      position += read;
    } finally {
      closeSync(fd);
    }
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, start);
      if (nl < 0) break;
      lines.push(pending.subarray(start, nl).toString("utf8"));
      start = nl + 1;
    }
    if (start > 0) pending = pending.subarray(start);
    return lines;
  };
  return { drain, sawFile: () => seen };
}
