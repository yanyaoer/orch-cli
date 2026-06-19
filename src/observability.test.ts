import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./hash.ts";
import { repoKeyFromRemote } from "./paths.ts";
import type { ImplementerResult, RunStatus } from "./types.ts";

async function runOrch(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runCmd(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (${exitCode})\n${stdout}${stderr}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunDone(statusPath: string): Promise<RunStatus> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as RunStatus;
      if (status.state === "done") return status;
      if (status.state === "failed" || status.state === "timeout") {
        throw new Error(`run ended unexpectedly: ${JSON.stringify(status)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("run ended unexpectedly")) throw error;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${statusPath}`);
}

async function initGitWorktree(worktree: string): Promise<void> {
  await runCmd(["git", "init"], worktree);
  writeFileSync(join(worktree, "README.md"), "initial\n", "utf8");
  await runCmd(["git", "add", "README.md"], worktree);
  await runCmd(
    ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test User", "commit", "-m", "initial"],
    worktree,
  );
}

test("observability commands read local run state", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-observe-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const repoKey = repoKeyFromRemote(worktree, worktree);
  const mr = "123";
  const runId = "impl-a-20260619T120000Z-abc123";
  const runDir = join(stateHome, "orch", repoKey, "mrs", mr, "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const status: RunStatus = {
    run_id: runId,
    mr,
    role: "implementer",
    agent: "codex",
    tag: "impl-a",
    state: "done",
    pid: null,
    pgid: null,
    started_at: "2026-06-19T12:00:00.000Z",
    updated_at: "2026-06-19T12:01:00.000Z",
    exit_code: 0,
    timeout_sec: 3600,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree,
    base_sha: "base",
    head_sha: "head",
  };
  const result: ImplementerResult = {
    schema: "orch.result/implementer/v1",
    run_id: runId,
    verdict: "completed",
    summary: "implemented observability commands",
    base_sha: "base",
    head_sha: "head",
    changed_files: ["src/orch.ts", "src/help.ts"],
    tests: [{ cmd: "bun test", exit_code: 0, summary: "passed" }],
    acceptance: [{ id: "read-only", status: "pass", evidence: "commands only read files" }],
    risks: [],
    rollback: "revert the CLI changes",
  };
  const rawResult = JSON.stringify(result);
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "events.jsonl"), "{\"type\":\"created\",\"seq\":0}\n{\"type\":\"done\",\"seq\":1}\n", "utf8");
  writeFileSync(join(runDir, "result.json"), rawResult, "utf8");

  const env = { XDG_STATE_HOME: stateHome };
  const list = await runOrch(["run", "list", "--mr", mr, "--worktree", worktree, "--json"], env);
  expect(list).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(list.stdout)).toEqual([
    {
      run_id: runId,
      role: "implementer",
      agent: "codex",
      tag: "impl-a",
      state: "done",
      started_at: "2026-06-19T12:00:00.000Z",
      exit_code: 0,
    },
  ]);

  const table = await runOrch(["run", "list", "--mr", mr, "--worktree", worktree], env);
  expect(table).toMatchObject({ exitCode: 0, stderr: "" });
  expect(table.stdout).toContain("run_id");
  expect(table.stdout).toContain(runId);

  const events = await runOrch(["events", "tail", "--run", runId, "--worktree", worktree, "-n", "1"], env);
  expect(events).toMatchObject({ exitCode: 0, stderr: "" });
  expect(events.stdout).toBe("{\"type\":\"done\",\"seq\":1}\n");

  const jsonResult = await runOrch(["result", "--run", runId, "--mr", mr, "--worktree", worktree, "--json"], env);
  expect(jsonResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(jsonResult.stdout).toBe(`${rawResult}\n`);

  const humanResult = await runOrch(["result", "--run", runId, "--worktree", worktree], env);
  expect(humanResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(humanResult.stdout).toContain("schema: orch.result/implementer/v1");
  expect(humanResult.stdout).toContain("changed_files:");
  expect(humanResult.stdout).toContain("bun test (exit 0): passed");
});

test("run create writes spec.json, hashes landed bytes, warns on dirty write-role, and preserves retry history", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-create-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  writeFileSync(join(worktree, "dirty.txt"), "dirty\n", "utf8");
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "do fake work\n", "utf8");

  const env = { XDG_STATE_HOME: stateHome, ORCH_DRIVER_FAKE_RESULT: "1" };
  const first = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "456",
      "--role",
      "implementer",
      "--agent",
      "codex",
      "--tag",
      "impl-test",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "idem-create-test",
      "--timeout-sec",
      "10",
    ],
    env,
  );
  expect(first.exitCode).toBe(0);
  expect(first.stderr).toContain("warn: worktree has uncommitted changes");
  const firstPayload = JSON.parse(first.stdout) as { run_id: string; run_dir: string; status_path: string };
  const firstStatus = await waitForRunDone(firstPayload.status_path);
  expect(firstStatus.run_id).toBe(firstPayload.run_id);
  expect(existsSync(join(firstPayload.run_dir, "spec.json"))).toBe(true);
  expect(existsSync(join(firstPayload.run_dir, "spec.yml"))).toBe(false);
  const specBytes = readFileSync(join(firstPayload.run_dir, "spec.json"), "utf8");
  const specSha = JSON.parse(readFileSync(join(firstPayload.run_dir, "spec.sha256"), "utf8")) as { sha256: string };
  expect(specSha.sha256).toBe(sha256(specBytes));

  const second = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "456",
      "--role",
      "implementer",
      "--agent",
      "codex",
      "--tag",
      "impl-test",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "idem-create-test",
      "--retry",
      "--allow-dirty",
      "--timeout-sec",
      "10",
    ],
    env,
  );
  expect(second.exitCode).toBe(0);
  expect(second.stderr).toBe("");
  const secondPayload = JSON.parse(second.stdout) as { run_id: string; run_dir: string; status_path: string };
  await waitForRunDone(secondPayload.status_path);
  expect(secondPayload.run_id).not.toBe(firstPayload.run_id);

  const idempotencyPath = join(stateHome, "orch", repoKeyFromRemote(worktree, worktree), "mrs", "456", "idempotency.json");
  const idempotency = JSON.parse(readFileSync(idempotencyPath, "utf8")) as Record<
    string,
    { run_id: string; previous?: Array<{ run_id: string }> }
  >;
  expect(idempotency["idem-create-test"]?.run_id).toBe(secondPayload.run_id);
  expect(idempotency["idem-create-test"]?.previous?.map((item) => item.run_id)).toEqual([firstPayload.run_id]);
});

test("decision records local verdict and queues mirror outbox payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-decision-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", remote], worktree);

  const repoKey = repoKeyFromRemote(remote, worktree);
  const mr = "123";
  const runId = "impl-a-20260619T120000Z-abc123";
  const mrDir = join(stateHome, "orch", repoKey, "mrs", mr);
  const runDir = join(mrDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const status: RunStatus = {
    run_id: runId,
    mr,
    role: "implementer",
    agent: "codex",
    tag: "impl-a",
    state: "done",
    pid: null,
    pgid: null,
    started_at: "2026-06-19T12:00:00.000Z",
    updated_at: "2026-06-19T12:01:00.000Z",
    exit_code: 0,
    timeout_sec: 3600,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree,
    base_sha: "base",
    head_sha: "head",
  };
  const result: ImplementerResult = {
    schema: "orch.result/implementer/v1",
    run_id: runId,
    verdict: "completed",
    summary: "implemented P3 outbox flow",
    base_sha: "base",
    head_sha: "head",
    changed_files: ["src/orch.ts", "src/help.ts"],
    tests: [{ cmd: "bun test", exit_code: 0, summary: "passed" }],
    acceptance: [{ id: "outbox", status: "pass", evidence: "pending payload written" }],
    risks: [],
    rollback: "revert the CLI changes",
  };
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const env = { XDG_STATE_HOME: stateHome };
  const decision = await runOrch(
    ["decision", "accept", "--mr", mr, "--run", runId, "--worktree", worktree, "--reason", "reviewed"],
    env,
  );
  expect(decision).toMatchObject({ exitCode: 0, stderr: "" });
  const decisionPayload = JSON.parse(readFileSync(join(runDir, "decision.json"), "utf8"));
  expect(decisionPayload).toMatchObject({ verdict: "accept", run_id: runId, reason: "reviewed" });

  const pendingDir = join(mrDir, "outbox", "pending");
  const sentDir = join(mrDir, "outbox", "sent");
  const pending = readdirSync(pendingDir).filter((file) => file.endsWith(".json"));
  expect(pending).toHaveLength(1);
  expect(existsSync(sentDir)).toBe(true);
  const outboxPayload = JSON.parse(readFileSync(join(pendingDir, pending[0]!), "utf8"));
  expect(outboxPayload).toMatchObject({ kind: "comment", mr });
  expect(outboxPayload.body).toContain("### orch decision");
  expect(outboxPayload.body).toContain("Decision: accept");
  expect(outboxPayload.body).toContain("implemented P3 outbox flow");

  const sync = await runOrch(["mirror", "sync", "--mr", mr, "--worktree", worktree], env);
  expect(sync).toMatchObject({ exitCode: 0, stderr: "" });
  expect(sync.stdout).toContain("gh pr comment 123 --body");
  expect(readdirSync(pendingDir).filter((file) => file.endsWith(".json"))).toHaveLength(1);
  expect(readdirSync(sentDir).filter((file) => file.endsWith(".json"))).toHaveLength(0);
});
