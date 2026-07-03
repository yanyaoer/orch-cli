import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export class LockHeldError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holderPid: number | null,
    public readonly holderRunId: string | null = null,
  ) {
    super(
      `lock held: ${lockPath}${holderPid ? ` by pid ${holderPid}` : ""}${holderRunId ? ` run_id ${holderRunId}` : ""}`,
    );
  }
}

export interface PidfileLock {
  path: string;
  pid: number;
  release(): void;
}

interface PidfileRecord {
  pid: number | null;
  run_id: string | null;
  ts: string | null;
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

function readPidfile(path: string): PidfileRecord {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; run_id?: unknown; ts?: unknown };
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      run_id: typeof parsed.run_id === "string" ? parsed.run_id : null,
      ts: typeof parsed.ts === "string" ? parsed.ts : null,
    };
  } catch {
    return { pid: null, run_id: null, ts: null };
  }
}

function readPid(path: string): number | null {
  return readPidfile(path).pid;
}

export function isPidAlive(pid: number): boolean {
  return processExists(pid);
}

export function acquirePidfileLock(path: string, pid = process.pid, runId?: string): PidfileLock {
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(
        fd,
        `${JSON.stringify({ pid, run_id: runId ?? null, ts: new Date().toISOString() })}\n`,
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
      const holder = readPidfile(path);
      const holderPid = holder.pid;
      if (holderPid === null || !processExists(holderPid)) {
        rmSync(path, { force: true });
        continue;
      }
      throw new LockHeldError(path, holderPid, holder.run_id);
    }
  }

  if (existsSync(path)) {
    const holder = readPidfile(path);
    throw new LockHeldError(path, holder.pid, holder.run_id);
  }
  throw new Error(`failed to acquire lock: ${path}`);
}

// Bounded-wait variant for locks that guard short critical sections (mr lock,
// mail route/fanout locks): a live contender is expected to release within
// milliseconds, so waiting briefly beats failing the whole command.
export async function acquirePidfileLockWait(
  path: string,
  waitMs: number,
  pid = process.pid,
  runId?: string,
): Promise<PidfileLock> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return acquirePidfileLock(path, pid, runId);
    } catch (error) {
      if (!(error instanceof LockHeldError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
