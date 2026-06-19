import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export class LockHeldError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holderPid: number | null,
  ) {
    super(`lock held: ${lockPath}${holderPid ? ` by pid ${holderPid}` : ""}`);
  }
}

export interface PidfileLock {
  path: string;
  pid: number;
  release(): void;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function readPid(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  return processExists(pid);
}

export function acquirePidfileLock(path: string, pid = process.pid): PidfileLock {
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(
        fd,
        `${JSON.stringify({ pid, ts: new Date().toISOString() })}\n`,
        "utf8",
      );
      closeSync(fd);
      let released = false;
      return {
        path,
        pid,
        release() {
          if (released) return;
          released = true;
          try {
            const holder = readPid(path);
            if (holder === pid || holder === null) rmSync(path, { force: true });
          } catch {
            // Best effort cleanup only.
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const holderPid = readPid(path);
      if (holderPid === null || !processExists(holderPid)) {
        rmSync(path, { force: true });
        continue;
      }
      throw new LockHeldError(path, holderPid);
    }
  }

  if (existsSync(path)) throw new LockHeldError(path, readPid(path));
  throw new Error(`failed to acquire lock: ${path}`);
}

