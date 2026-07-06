import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
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
