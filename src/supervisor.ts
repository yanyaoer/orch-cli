import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { OrchEvent, RunSpec, RunState, RunStatus } from "./types.ts";
import { writeRoles } from "./types.ts";
import { acquirePidfileLock, LockHeldError, type PidfileLock } from "./locks.ts";
import { countLines, appendJsonLine, readJsonFile, writeJsonAtomic } from "./json.ts";
import { fallbackResult, validateRoleResult } from "./schema.ts";
import { lockPathForWorktree, mrStateDir } from "./paths.ts";

function now(): string {
  return new Date().toISOString();
}

function runDirFile(runDir: string, name: string): string {
  return `${runDir}/${name}`;
}

function initialStatus(spec: RunSpec): RunStatus {
  return {
    run_id: spec.run_id,
    mr: spec.mr,
    role: spec.role,
    agent: spec.agent,
    tag: spec.tag,
    state: "created",
    pid: null,
    pgid: null,
    started_at: null,
    updated_at: now(),
    exit_code: null,
    timeout_sec: spec.timeout_sec,
    last_event_seq: 0,
    native_event_count: 0,
    provider_resume_id: null,
    worktree: spec.worktree,
    base_sha: spec.base_sha,
    head_sha: null,
  };
}

export function writeInitialRunFiles(runDir: string, spec: RunSpec): void {
  mkdirSync(`${runDir}/artifacts`, { recursive: true });
  writeJsonAtomic(runDirFile(runDir, "status.json"), initialStatus(spec));
  appendEvent(runDir, { type: "created", seq: 0, ts: now() });
}

function readStatus(runDir: string, spec: RunSpec): RunStatus {
  return readJsonFile(runDirFile(runDir, "status.json"), initialStatus(spec));
}

function updateStatus(runDir: string, spec: RunSpec, patch: Partial<RunStatus>): RunStatus {
  const prev = readStatus(runDir, spec);
  const next = {
    ...prev,
    ...patch,
    updated_at: now(),
    native_event_count: countLines(runDirFile(runDir, "native.jsonl")),
  } satisfies RunStatus;
  writeJsonAtomic(runDirFile(runDir, "status.json"), next);
  return next;
}

function appendEvent(runDir: string, event: OrchEvent): void {
  appendJsonLine(runDirFile(runDir, "events.jsonl"), event);
}

function nextSeq(runDir: string): number {
  return countLines(runDirFile(runDir, "events.jsonl"));
}

function appendStream(stream: ReadableStream<Uint8Array> | null, path: string): Promise<void> {
  if (!stream) return Promise.resolve();
  mkdirSync(dirname(path), { recursive: true });
  return (async () => {
    const fd = openSync(path, "w");
    try {
      const reader = stream.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        writeSync(fd, chunk.value);
      }
    } finally {
      closeSync(fd);
    }
  })();
}

async function gitHead(worktree: string): Promise<string | null> {
  try {
    return (await Bun.$`git -C ${worktree} rev-parse HEAD`.quiet().text()).trim();
  } catch {
    return null;
  }
}

function readProviderResumeId(runDir: string): string | null {
  try {
    const lines = readFileSync(runDirFile(runDir, "native.jsonl"), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        for (const key of ["session_id", "conversation_id", "provider_resume_id", "thread_id"]) {
          if (typeof obj[key] === "string" && obj[key]) return obj[key] as string;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function ensureResult(runDir: string, spec: RunSpec, reason: string): void {
  const resultPath = runDirFile(runDir, "result.json");
  if (!existsSync(resultPath)) {
    writeJsonAtomic(
      resultPath,
      fallbackResult({
        role: spec.role,
        run_id: spec.run_id,
        base_sha: spec.base_sha,
        head_sha: spec.base_sha,
        summary: reason,
      }),
    );
  }
}

function validateResultFile(runDir: string, spec: RunSpec): string[] {
  const value = readJsonFile<unknown>(runDirFile(runDir, "result.json"), null);
  return validateRoleResult(spec.role, value).errors;
}

function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

export async function runSupervisor(runDir: string, orchCommand: string[]): Promise<number> {
  const specPath = runDirFile(runDir, "spec.yml");
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as RunSpec;
  const mrDir = mrStateDir(spec.repo_key, spec.mr);
  let worktreeLock: PidfileLock | null = null;

  try {
    if (writeRoles.has(spec.role)) {
      worktreeLock = acquirePidfileLock(lockPathForWorktree(mrDir, spec.worktree), process.pid);
    }
  } catch (error) {
    const message = error instanceof LockHeldError ? error.message : String(error);
    ensureResult(runDir, spec, message);
    appendEvent(runDir, { type: "failed", seq: nextSeq(runDir), ts: now(), message });
    updateStatus(runDir, spec, { state: "failed", exit_code: 75, last_event_seq: nextSeq(runDir) - 1 });
    return 75;
  }

  const startedAt = now();
  updateStatus(runDir, spec, { state: "starting", started_at: startedAt });
  appendEvent(runDir, { type: "starting", seq: nextSeq(runDir), ts: startedAt });

  const proc = Bun.spawn(
    [
      ...orchCommand,
      `__driver-${spec.agent}`,
      "--spec",
      specPath,
      "--run-dir",
      runDir,
      "--worktree",
      spec.worktree,
    ],
    {
      cwd: spec.worktree,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  );

  updateStatus(runDir, spec, {
    state: "running",
    pid: proc.pid,
    pgid: proc.pid,
    started_at: startedAt,
    last_event_seq: nextSeq(runDir),
  });
  appendEvent(runDir, { type: "running", seq: nextSeq(runDir), ts: now() });

  const stdoutPath = runDirFile(runDir, "stdout.log");
  const stderrPath = runDirFile(runDir, "stderr.log");
  const drain = Promise.all([appendStream(proc.stdout, stdoutPath), appendStream(proc.stderr, stderrPath)]);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup(proc.pid, "SIGTERM");
    setTimeout(() => killProcessGroup(proc.pid, "SIGKILL"), 5_000).unref();
  }, spec.timeout_sec * 1000);
  timeout.unref();

  const heartbeat = setInterval(() => {
    appendEvent(runDir, { type: "heartbeat", seq: nextSeq(runDir), ts: now() });
    updateStatus(runDir, spec, { state: "running", last_event_seq: nextSeq(runDir) - 1 });
  }, 10_000);
  heartbeat.unref();

  let exitCode = await proc.exited;
  clearTimeout(timeout);
  clearInterval(heartbeat);
  await drain;

  if (timedOut) exitCode = 124;
  const exitPath = runDirFile(runDir, "exit_code");
  if (!existsSync(exitPath)) writeFileSync(exitPath, `${exitCode}\n`, "utf8");

  ensureResult(runDir, spec, exitCode === 0 ? "driver did not produce result.json" : `driver exited ${exitCode}`);
  const resultErrors = validateResultFile(runDir, spec);
  const finalState: RunState = timedOut ? "timeout" : exitCode === 0 && resultErrors.length === 0 ? "done" : "failed";
  if (resultErrors.length > 0) {
    writeFileSync(runDirFile(runDir, "schema.errors.log"), `${resultErrors.join("\n")}\n`, "utf8");
  }
  appendEvent(runDir, {
    type: finalState === "done" ? "done" : finalState === "timeout" ? "timeout" : "failed",
    seq: nextSeq(runDir),
    ts: now(),
    message: resultErrors.length ? resultErrors.join("; ") : undefined,
  });

  updateStatus(runDir, spec, {
    state: finalState,
    exit_code: exitCode,
    last_event_seq: nextSeq(runDir) - 1,
    provider_resume_id: readProviderResumeId(runDir),
    head_sha: await gitHead(spec.worktree),
  });

  worktreeLock?.release();
  return finalState === "done" ? 0 : exitCode || 1;
}
