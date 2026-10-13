import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
import { acquirePidfileLock } from "./locks.ts";
import { lockPathForWorktree } from "./paths.ts";
import { dirname } from "node:path";
import type { ReviewerResult, RunSpec, RunStatus } from "./types.ts";

async function runCmd(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed (${exitCode})\n${stdout}${stderr}`);
  return stdout;
}

async function initGitWorktree(worktree: string): Promise<string> {
  await runCmd(["git", "init"], worktree);
  writeFileSync(join(worktree, "README.md"), "initial\n", "utf8");
  await runCmd(["git", "add", "README.md"], worktree);
  await runCmd(
    ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test User", "-c", "commit.gpgsign=false", "commit", "-m", "initial"],
    worktree,
  );
  return (await runCmd(["git", "rev-parse", "HEAD"], worktree)).trim();
}

function testSpec(args: { runId: string; role: RunSpec["role"]; worktree: string; baseSha: string }): RunSpec {
  return {
    version: 1,
    run_id: args.runId,
    mr: args.runId,
    role: args.role,
    agent: "codex",
    model: null,
    tag: "test",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: args.runId,
    repo_key: "local/repo",
    worktree: args.worktree,
    task_path: null,
    task_text: "test",
    task_sha: "sha",
    base_sha: args.baseSha,
    timeout_sec: 5,
    created_at: "2026-06-25T00:00:00.000Z",
  };
}

function writeSpec(runDir: string, spec: RunSpec): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  writeInitialRunFiles(runDir, spec);
}

function writeFakeDriver(root: string): string {
  const path = join(root, "fake-driver.js");
  writeFileSync(
    path,
    String.raw`
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const specPath = process.argv[process.argv.indexOf("--spec") + 1];
const runDir = process.argv[process.argv.indexOf("--run-dir") + 1];
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const result = spec.role === "reviewer"
  ? {
      schema: "orch.result/reviewer/v1",
      run_id: spec.run_id,
      verdict: "approve",
      reviews_run_id: spec.run_id,
      blocking_findings: [],
      non_blocking_findings: [],
      suggested_tests: [],
    }
  : spec.role === "verifier"
  ? {
      schema: "orch.result/verifier/v1",
      run_id: spec.run_id,
      verdict: "pass",
      verifies_run_id: spec.run_id,
      commands: [{ cmd: "fake check", exit_code: 0, status: "passed", summary: "ok" }],
      acceptance: [{ id: "fake", status: "pass" }],
    }
  : {
      schema: "orch.result/implementer/v1",
      run_id: spec.run_id,
      verdict: "completed",
      summary: "fake driver completed",
      base_sha: spec.base_sha,
      head_sha: spec.base_sha,
      changed_files: [],
      tests: [],
      acceptance: [{ id: "fake", status: "pass" }],
      risks: [],
      rollback: "none",
    };
writeFileSync(join(runDir, "result.json"), JSON.stringify(result), "utf8");
`,
    "utf8",
  );
  return path;
}

async function runSupervisorWithState(runDir: string, orchCommand: string[], stateHome: string): Promise<number> {
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    return await runSupervisor(runDir, orchCommand);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
}

test("supervisor records terminal failure when driver spawn throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-"));
  const runDir = join(root, "run");
  const missingWorktree = join(root, "missing-worktree");
  const spec: RunSpec = {
    version: 1,
    run_id: "review-spawn-failure",
    mr: "spawn-failure",
    role: "reviewer",
    agent: "codex",
    model: null,
    tag: "review",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: "spawn-failure",
    repo_key: "local/repo",
    worktree: missingWorktree,
    task_path: null,
    task_text: "review",
    task_sha: "sha",
    base_sha: "base",
    timeout_sec: 5,
    created_at: "2026-06-25T00:00:00.000Z",
  };
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  writeInitialRunFiles(runDir, spec);

  const exitCode = await runSupervisor(runDir, [process.execPath, "src/orch.ts"]);
  expect(exitCode).toBe(1);
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
  expect(status).toMatchObject({ state: "failed", exit_code: 1, head_sha: null });
  const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as ReviewerResult;
  expect(result).toMatchObject({ schema: "orch.result/reviewer/v1", verdict: "request_changes" });
  expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain("\"type\":\"failed\"");
});

test("supervisor records terminal failure when spec.json is corrupt", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-"));
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "spec.json"), "{not json", "utf8");

  const exitCode = await runSupervisor(runDir, [process.execPath, "src/orch.ts"]);
  expect(exitCode).toBe(1);
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
  expect(status).toMatchObject({ state: "failed", exit_code: 1 });
  const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as ReviewerResult;
  expect(result.schema).toBe("orch.result/reviewer/v1");
  expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain("\"type\":\"failed\"");
});

test("supervisor writes evidence artifacts for write-role runs with uncommitted edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-evidence-"));
  const runDir = join(root, "run");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const baseSha = await initGitWorktree(worktree);
  writeFileSync(join(worktree, "README.md"), "initial\nchanged\n", "utf8");
  const spec = testSpec({ runId: "impl-evidence", role: "implementer", worktree, baseSha });
  writeSpec(runDir, spec);

  const exitCode = await runSupervisorWithState(runDir, [process.execPath, writeFakeDriver(root)], join(root, "state"));

  expect(exitCode).toBe(0);
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
  expect(status).toMatchObject({ state: "done", exit_code: 0 });
  expect(readFileSync(join(runDir, "artifacts", "git-status.txt"), "utf8")).toContain(" M README.md");
  const diff = readFileSync(join(runDir, "artifacts", "diff.patch"), "utf8");
  expect(diff).toContain("diff --git a/README.md b/README.md");
  expect(diff).toContain("+changed");
  expect(readFileSync(join(runDir, "artifacts", "changed-files.txt"), "utf8")).toBe("README.md\n");
});

// F4: verifier has project-write posture (real build/test commands + claude
// Edit/Write), so it must behave like a write role — collect its diff evidence.
test("supervisor writes evidence artifacts for verifier runs (F4 write role)", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-verifier-"));
  const runDir = join(root, "run");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const baseSha = await initGitWorktree(worktree);
  writeFileSync(join(worktree, "README.md"), "initial\nverifier build artifact\n", "utf8");
  const spec = testSpec({ runId: "verify-evidence", role: "verifier", worktree, baseSha });
  writeSpec(runDir, spec);

  const exitCode = await runSupervisorWithState(runDir, [process.execPath, writeFakeDriver(root)], join(root, "state"));

  expect(exitCode).toBe(0);
  expect(readFileSync(join(runDir, "artifacts", "git-status.txt"), "utf8")).toContain(" M README.md");
  expect(existsSync(join(runDir, "artifacts", "diff.patch"))).toBe(true);
});

// F4: two project-write runs (implementer + verifier) must not write the same
// worktree concurrently lock-free. The verifier now takes the worktree lock, so
// it fails closed (exit 75) while an implementer holds it, rather than racing.
test("a verifier fails closed when another project-write run holds the worktree lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-verifier-lock-"));
  const stateHome = join(root, "state");
  const runDir = join(root, "run");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const baseSha = await initGitWorktree(worktree);
  const spec = testSpec({ runId: "verify-blocked", role: "verifier", worktree, baseSha });
  writeSpec(runDir, spec);

  // Simulate a running implementer holding the worktree lock (same state home
  // the supervisor will use, so the lock paths coincide).
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const lockPath = lockPathForWorktree(worktree);
  mkdirSync(dirname(lockPath), { recursive: true });
  const held = acquirePidfileLock(lockPath, process.pid, "impl-holding");
  try {
    const exitCode = await runSupervisorWithState(runDir, [process.execPath, writeFakeDriver(root)], stateHome);
    expect(exitCode).toBe(75); // LockHeldError → the verifier does not run
    const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
    expect(status.state).toBe("failed");
  } finally {
    held.release();
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
});

test("supervisor does not write evidence artifacts for read-only runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-evidence-"));
  const runDir = join(root, "run");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const baseSha = await initGitWorktree(worktree);
  writeFileSync(join(worktree, "README.md"), "initial\nreview-only dirty edit\n", "utf8");
  const spec = testSpec({ runId: "review-no-evidence", role: "reviewer", worktree, baseSha });
  writeSpec(runDir, spec);

  const exitCode = await runSupervisorWithState(runDir, [process.execPath, writeFakeDriver(root)], join(root, "state"));

  expect(exitCode).toBe(0);
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
  expect(status).toMatchObject({ state: "done", exit_code: 0 });
  expect(existsSync(join(runDir, "artifacts", "git-status.txt"))).toBe(false);
  expect(existsSync(join(runDir, "artifacts", "diff.patch"))).toBe(false);
  expect(existsSync(join(runDir, "artifacts", "changed-files.txt"))).toBe(false);
});

test("supervisor evidence git failures do not change the terminal state", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-evidence-"));
  const runDir = join(root, "run");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const spec = testSpec({ runId: "impl-evidence-git-failure", role: "implementer", worktree, baseSha: "bogus-base-sha" });
  writeSpec(runDir, spec);

  const exitCode = await runSupervisorWithState(runDir, [process.execPath, writeFakeDriver(root)], join(root, "state"));

  expect(exitCode).toBe(0);
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
  expect(status).toMatchObject({ state: "done", exit_code: 0 });
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  expect(events).toContain("\"type\":\"done\"");
  expect(events).not.toContain("\"type\":\"failed\"");
});

async function snapshotOf(worktree: string) {
  const { vcsSnapshot } = await import("./vcs.ts");
  return vcsSnapshot(worktree);
}

function readStatus(runDir: string): RunStatus {
  return JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
}

test("reviewer evidence is bound to the start/end snapshot it actually saw", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-snapshot-"));
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const baseSha = await initGitWorktree(worktree);
  const runDir = join(root, "run");
  writeSpec(runDir, { ...testSpec({ runId: "review-bound", role: "reviewer", worktree, baseSha }), snapshot: await snapshotOf(worktree), pinned_head: baseSha });

  expect(await runSupervisorWithState(runDir, [process.execPath, writeFakeDriver(root)], join(root, "state"))).toBe(0);
  const status = readStatus(runDir);
  expect(status.state).toBe("done");
  expect(status.start_snapshot).toEqual({ vcs: "git", head: baseSha, dirty: false, content_sha: baseSha });
  expect(status.end_snapshot).toEqual(status.start_snapshot);
  expect(status.snapshot_error).toBeNull();
});

test("a reviewer refuses to start when the checkout moved after run create or off its pinned head", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-predrift-"));
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const baseSha = await initGitWorktree(worktree);
  const created = await snapshotOf(worktree);
  // An outside (non-orch) edit lands between create and start.
  writeFileSync(join(worktree, "README.md"), "edited outside orch\n", "utf8");
  const runDir = join(root, "run");
  writeSpec(runDir, { ...testSpec({ runId: "review-predrift", role: "reviewer", worktree, baseSha }), snapshot: created });
  expect(await runSupervisorWithState(runDir, [process.execPath, writeFakeDriver(root)], join(root, "state"))).toBe(1);
  const status = readStatus(runDir);
  expect(status.state).toBe("failed");
  expect(status.snapshot_error).toContain("worktree changed between run create");
  // The worker never ran: the result is the fallback, not an approve.
  expect(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).verdict).toBe("request_changes");

  const pinnedDir = join(root, "run-pinned");
  writeSpec(pinnedDir, { ...testSpec({ runId: "review-pinned", role: "reviewer", worktree, baseSha }), pinned_head: "f".repeat(40) });
  expect(await runSupervisorWithState(pinnedDir, [process.execPath, writeFakeDriver(root)], join(root, "state"))).toBe(1);
  expect(readStatus(pinnedDir).snapshot_error).toContain("pinned head ffffffffffff");
});

test("a reviewer whose checkout changes while it runs fails closed with the drift recorded", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-drift-"));
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const baseSha = await initGitWorktree(worktree);
  const driver = join(root, "drifting-driver.js");
  // Approves, but the checkout changes underneath it (an external editor).
  writeFileSync(
    driver,
    String.raw`
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const spec = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--spec") + 1], "utf8"));
const runDir = process.argv[process.argv.indexOf("--run-dir") + 1];
appendFileSync(join(spec.worktree, "README.md"), "changed mid-review\n");
writeFileSync(join(runDir, "result.json"), JSON.stringify({ schema: "orch.result/reviewer/v1", run_id: spec.run_id, verdict: "approve", reviews_run_id: "", blocking_findings: [], non_blocking_findings: [], suggested_tests: [] }));
`,
    "utf8",
  );
  const runDir = join(root, "run");
  writeSpec(runDir, { ...testSpec({ runId: "review-drift", role: "reviewer", worktree, baseSha }), snapshot: await snapshotOf(worktree) });
  expect(await runSupervisorWithState(runDir, [process.execPath, driver], join(root, "state"))).toBe(1);
  const status = readStatus(runDir);
  expect(status.state).toBe("failed");
  expect(status.snapshot_error).toContain("worktree drifted during run");
  expect(status.end_snapshot?.dirty).toBe(true);
});

test("reviewers share the worktree lock with each other but not with a writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-shared-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const baseSha = await initGitWorktree(worktree);
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const { acquireWorktreeLock } = await import("./locks.ts");
  const lockPath = lockPathForWorktree(worktree);
  try {
    // Another reviewer is reading: this reviewer still runs.
    const otherReader = acquireWorktreeLock(lockPath, "shared", "review-other", 1);
    const okDir = join(root, "run-ok");
    writeSpec(okDir, testSpec({ runId: "review-parallel", role: "reviewer", worktree, baseSha }));
    expect(await runSupervisorWithState(okDir, [process.execPath, writeFakeDriver(root)], stateHome)).toBe(0);
    // ...but an implementer must wait for readers.
    const implDir = join(root, "run-impl");
    writeSpec(implDir, testSpec({ runId: "impl-blocked", role: "implementer", worktree, baseSha }));
    expect(await runSupervisorWithState(implDir, [process.execPath, writeFakeDriver(root)], stateHome)).toBe(75);
    otherReader.release();

    // A writer holds the checkout: a reviewer fails closed (exit 75).
    const held = acquirePidfileLock(lockPath, process.pid, "impl-holding");
    const blockedDir = join(root, "run-blocked");
    writeSpec(blockedDir, testSpec({ runId: "review-blocked", role: "reviewer", worktree, baseSha }));
    expect(await runSupervisorWithState(blockedDir, [process.execPath, writeFakeDriver(root)], stateHome)).toBe(75);
    held.release();

    // controller takes no worktree lock: it must not block its own workers.
    const writer = acquirePidfileLock(lockPath, process.pid, "impl-running");
    const ctrlDir = join(root, "run-ctrl");
    writeSpec(ctrlDir, testSpec({ runId: "ctrl", role: "controller", worktree, baseSha }));
    await runSupervisorWithState(ctrlDir, [process.execPath, writeFakeDriver(root)], stateHome);
    expect(readStatus(ctrlDir).snapshot_error ?? null).toBeNull();
    expect(readFileSync(join(ctrlDir, "events.jsonl"), "utf8")).not.toContain("lock held");
    writer.release();
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
});
