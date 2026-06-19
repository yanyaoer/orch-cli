import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

