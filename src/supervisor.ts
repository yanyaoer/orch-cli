import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { OrchEvent, RunSpec, RunState, RunStatus } from "./types.ts";
import { writeRoles } from "./types.ts";
import { acquirePidfileLock, LockHeldError, type PidfileLock } from "./locks.ts";
import { countLines, appendJsonLine, readJsonFile, writeJsonAtomic } from "./json.ts";
import { fallbackResult, validateRoleResult } from "./schema.ts";
import { lockPathForWorktree } from "./paths.ts";
import { providerResumeIdFromNativeText } from "./native-events.ts";
import { buildWorkerEnv } from "../drivers/driver-common.ts";
import { sandboxPosture } from "../drivers/sandbox.ts";
import { jjWorkspaceRoot, vcsHead, vcsKind } from "./vcs.ts";

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
    provider_session_name: spec.provider_session_name,
    provider_session_id: spec.provider_session_id,
    provider_session_mode: spec.provider_session_mode,
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
    // Engine comes from the immutable spec, posture from the immutable role;
    // the driver's recorded plan (sandbox.json) later confirms both and adds
    // the profile hash via sandboxStatus().
    ...(spec.sandbox_engine ? { sandbox_engine: spec.sandbox_engine, sandbox_posture: sandboxPosture(spec.role) } : {}),
  };
}

// The driver records the execution plan it actually used in sandbox.json;
// folding it into status.json keeps the effective sandbox auditable without
// the driver ever writing status.json itself (one file, one writer).
function sandboxStatus(runDir: string): Partial<RunStatus> {
  const value = readJsonFile<Record<string, unknown> | null>(runDirFile(runDir, "sandbox.json"), null);
  if (!value) return {};
  const patch: Partial<RunStatus> = {};
  if (value.sandbox_engine === "none" || value.sandbox_engine === "seatbelt-v1") patch.sandbox_engine = value.sandbox_engine;
  if (value.sandbox_posture === "read-only" || value.sandbox_posture === "project-write") patch.sandbox_posture = value.sandbox_posture;
  if (typeof value.sandbox_profile_sha256 === "string" || value.sandbox_profile_sha256 === null) {
    patch.sandbox_profile_sha256 = value.sandbox_profile_sha256 as string | null;
  }
  if (typeof value.provider_native_sandbox === "boolean") patch.provider_native_sandbox = value.provider_native_sandbox;
  return patch;
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
    ...sandboxStatus(runDir),
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

async function worktreeHead(worktree: string): Promise<string | null> {
  try {
    return await vcsHead(worktree);
  } catch {
    return null;
  }
}

async function writeEvidence(runDir: string, spec: RunSpec): Promise<void> {
  try {
    const baseSha = typeof spec.base_sha === "string" ? spec.base_sha.trim() : "";
    if (!writeRoles.has(spec.role) || !baseSha) return;
    const artifactsDir = runDirFile(runDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    // VCS output is redirected straight to the artifact files so a large or
    // binary diff never transits JS memory. No timeout: these are read-only
    // commands and the whole block is best-effort diagnostics.
    if (vcsKind(spec.worktree) === "jj") {
      // cwd must be the workspace root: jj prints cwd-relative paths and
      // changed-files.txt consumers expect root-relative ones. The base is
      // @'s snapshot at run creation; jj keeps it addressable even after the
      // working copy amended past it, so --from shows exactly the run's edits.
      const root = jjWorkspaceRoot(spec.worktree) ?? spec.worktree;
      await Bun.$`jj status > ${`${artifactsDir}/git-status.txt`}`.cwd(root).quiet();
      await Bun.$`jj diff --from ${baseSha} --git > ${`${artifactsDir}/diff.patch`}`.cwd(root).quiet();
      await Bun.$`jj diff --from ${baseSha} --name-only > ${`${artifactsDir}/changed-files.txt`}`.cwd(root).quiet();
    } else {
      // --untracked-files=all: the default collapses an untracked subtree to
      // one "dir/" entry, hiding what a worker actually created — consumers
      // (prewalk's handoff gate) need per-file evidence.
      await Bun.$`git -C ${spec.worktree} status --porcelain=v1 --untracked-files=all > ${`${artifactsDir}/git-status.txt`}`.quiet();

      // Diffing the base SHA against the worktree captures uncommitted tracked
      // edits. Untracked files are intentionally visible only in git-status.txt.
      await Bun.$`git -C ${spec.worktree} diff --binary ${baseSha} -- . > ${`${artifactsDir}/diff.patch`}`.quiet();

      await Bun.$`git -C ${spec.worktree} diff --name-only ${baseSha} -- . > ${`${artifactsDir}/changed-files.txt`}`.quiet();
    }
  } catch {
    // Evidence is diagnostic only; collection must not change the run outcome.
  }
}

function readProviderResumeId(runDir: string): string | null {
  try {
    return providerResumeIdFromNativeText(readFileSync(runDirFile(runDir, "native.jsonl"), "utf8"));
  } catch {
    return null;
  }
}

function ensureResult(runDir: string, spec: RunSpec, reason: string): void {
  const resultPath = runDirFile(runDir, "result.json");
  if (!existsSync(resultPath)) {
    // `orch run cancel` drops canceled.json before signaling the driver; the
    // fallback summary then names the cancellation instead of a bare exit code.
    const canceled = readJsonFile<{ reason?: unknown } | null>(runDirFile(runDir, "canceled.json"), null);
    writeJsonAtomic(
      resultPath,
      fallbackResult({
        role: spec.role,
        run_id: spec.run_id,
        base_sha: spec.base_sha,
        head_sha: spec.base_sha,
        summary: canceled ? `canceled: ${typeof canceled.reason === "string" ? canceled.reason : reason}` : reason,
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

// Minimal stand-in when spec.json is missing or corrupt, so the run can still
// be driven to a failed terminal state instead of hanging in `created` forever.
function fallbackSpec(runDir: string): RunSpec {
  return {
    version: 1,
    run_id: runDir.split("/").filter(Boolean).pop() ?? "unknown",
    mr: "unknown",
    role: "reviewer",
    agent: "codex",
    model: null,
    tag: "unknown",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: "unknown",
    repo_key: "unknown",
    // The run dir is not a VCS worktree, so worktreeHead resolves to null instead
    // of picking up whatever repo the supervisor process happens to run in.
    worktree: runDir,
    task_path: null,
    task_text: "",
    task_sha: "",
    base_sha: "",
    timeout_sec: 0,
    created_at: now(),
  };
}

export async function runSupervisor(runDir: string, orchCommand: string[]): Promise<number> {
  const specPath = runDirFile(runDir, "spec.json");
  let loadedSpec: RunSpec | null = null;
  let worktreeLock: PidfileLock | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let pgid: number | null = null;

  try {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as RunSpec;
    loadedSpec = spec;
    if (writeRoles.has(spec.role)) {
      worktreeLock = acquirePidfileLock(lockPathForWorktree(spec.worktree), process.pid, spec.run_id);
    }

    const startedAt = now();
    updateStatus(runDir, spec, { state: "starting", started_at: startedAt });
    appendEvent(runDir, {
      type: "starting",
      seq: nextSeq(runDir),
      ts: startedAt,
      // Sandbox contract is auditable from the event stream too, not only
      // from spec/status.
      ...(spec.sandbox_engine
        ? { message: `sandbox_engine=${spec.sandbox_engine} sandbox_posture=${sandboxPosture(spec.role)}` }
        : {}),
    });

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
        env: buildWorkerEnv(),
      },
    );
    pgid = proc.pid;

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
    timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(proc.pid, "SIGTERM");
      setTimeout(() => killProcessGroup(proc.pid, "SIGKILL"), 5_000).unref();
    }, spec.timeout_sec * 1000);
    timeout.unref();

    heartbeat = setInterval(() => {
      appendEvent(runDir, { type: "heartbeat", seq: nextSeq(runDir), ts: now() });
      updateStatus(runDir, spec, { state: "running", last_event_seq: nextSeq(runDir) - 1 });
    }, 10_000);
    heartbeat.unref();

    let exitCode = await proc.exited;
    clearTimeout(timeout);
    timeout = null;
    clearInterval(heartbeat);
    heartbeat = null;
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
    await writeEvidence(runDir, spec);
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
      head_sha: await worktreeHead(spec.worktree),
    });

    return finalState === "done" ? 0 : exitCode || 1;
  } catch (error) {
    const exitCode = error instanceof LockHeldError ? 75 : 1;
    const message = error instanceof Error ? error.message : String(error);
    if (pgid !== null) killProcessGroup(pgid, "SIGTERM");
    const spec = loadedSpec ?? fallbackSpec(runDir);
    ensureResult(runDir, spec, message);
    await writeEvidence(runDir, spec);
    appendEvent(runDir, { type: "failed", seq: nextSeq(runDir), ts: now(), message });
    updateStatus(runDir, spec, {
      state: "failed",
      exit_code: exitCode,
      last_event_seq: nextSeq(runDir) - 1,
      provider_resume_id: readProviderResumeId(runDir),
      head_sha: await worktreeHead(spec.worktree),
    });
    return exitCode;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (heartbeat) clearInterval(heartbeat);
    worktreeLock?.release();
  }
}
