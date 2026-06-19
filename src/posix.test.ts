import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidfileLock, isPidAlive, LockHeldError } from "./locks.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-posix-"));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      await sleep(20);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function psState(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

test("detached Bun.spawn creates a process group killable with negative pgid", async () => {
  const dir = tempDir();
  const childPidFile = join(dir, "grandchild.pid");
  const script = [
    `sleep 60 &`,
    `echo $! > ${JSON.stringify(childPidFile)}`,
    "wait",
  ].join("\n");

  const proc = Bun.spawn(["sh", "-c", script], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  const grandchildPid = Number(await waitForFile(childPidFile));
  expect(Number.isInteger(proc.pid)).toBe(true);
  expect(isPidAlive(grandchildPid)).toBe(true);

  process.kill(-proc.pid, "SIGTERM");
  const exitCode = await proc.exited;
  expect(exitCode).not.toBe(0);

  for (let i = 0; i < 50 && isPidAlive(grandchildPid); i += 1) await sleep(20);
  expect(isPidAlive(grandchildPid)).toBe(false);
  const procState = psState(proc.pid);
  const grandchildState = psState(grandchildPid);
  if (procState !== null) expect(procState).not.toContain("Z");
  if (grandchildState !== null) expect(grandchildState).not.toContain("Z");
});

test("O_EXCL pidfile lock is mutually exclusive and recovers stale pidfiles", () => {
  const dir = tempDir();
  const lockPath = join(dir, "resource.lock");
  const lock = acquirePidfileLock(lockPath, process.pid);

  try {
    expect(() => acquirePidfileLock(lockPath, process.pid)).toThrow(LockHeldError);
  } finally {
    lock.release();
  }

  const reacquired = acquirePidfileLock(lockPath, process.pid);
  reacquired.release();

  writeFileSync(lockPath, `${JSON.stringify({ pid: 9_999_999, ts: new Date().toISOString() })}\n`);
  const staleRecovered = acquirePidfileLock(lockPath, process.pid);
  staleRecovered.release();
});
