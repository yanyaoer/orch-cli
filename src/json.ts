import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
