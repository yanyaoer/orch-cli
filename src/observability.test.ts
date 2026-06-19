import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./hash.ts";
import { repoKeyFromRemote } from "./paths.ts";
import type { ImplementerResult, RoleResult, RunStatus } from "./types.ts";

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

async function waitForRunState(statusPath: string, states: RunStatus["state"][]): Promise<RunStatus> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as RunStatus;
      if (states.includes(status.state)) return status;
      if (!states.includes(status.state) && (status.state === "failed" || status.state === "timeout")) {
        throw new Error(`run ended unexpectedly: ${JSON.stringify(status)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("run ended unexpectedly")) throw error;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${statusPath}`);
}

async function waitForRunDone(statusPath: string): Promise<RunStatus> {
  return waitForRunState(statusPath, ["done"]);
}

async function waitForRunFinal(statusPath: string): Promise<RunStatus> {
  return waitForRunState(statusPath, ["done", "failed", "timeout"]);
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

function readResult(path: string): RoleResult {
  return JSON.parse(readFileSync(path, "utf8")) as RoleResult;
}

async function createWriteRun(args: {
  mr: string;
  key: string;
  stateHome: string;
  worktree: string;
  taskPath: string;
  extraEnv?: Record<string, string>;
}): Promise<{ run_id: string; run_dir: string; status_path: string; result_path: string; worktree_lock: string }> {
  const result = await runOrch(
    [
      "run",
      "create",
      "--mr",
      args.mr,
      "--role",
      "implementer",
      "--agent",
      "codex",
      "--tag",
      "impl-lock",
      "--worktree",
      args.worktree,
      "--task",
      args.taskPath,
      "--idempotency-key",
      args.key,
      "--timeout-sec",
      "10",
    ],
    { XDG_STATE_HOME: args.stateHome, ...(args.extraEnv ?? {}) },
  );
  expect(result).toMatchObject({ exitCode: 0 });
  const payload = JSON.parse(result.stdout) as {
    run_id: string;
    run_dir: string;
    status_path: string;
    worktree_lock: string;
  };
  return { ...payload, result_path: join(payload.run_dir, "result.json") };
}

async function expectOneDoneOneLockHeld(args: { firstMr: string; secondMr: string }): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "orch-lock-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "hold the write lock briefly\n", "utf8");
  const extraEnv = { ORCH_DRIVER_FAKE_RESULT: "1", ORCH_DRIVER_FAKE_SLEEP_MS: "1000" };

  const first = await createWriteRun({
    mr: args.firstMr,
    key: `${args.firstMr}-first`,
    stateHome,
    worktree,
    taskPath,
    extraEnv,
  });
  expect(first.worktree_lock.startsWith(join(stateHome, "orch", "worktree-locks"))).toBe(true);
  expect(first.worktree_lock).not.toContain(`${join("mrs", args.firstMr)}`);
  await waitForRunState(first.status_path, ["running"]);

  const second = await createWriteRun({
    mr: args.secondMr,
    key: `${args.secondMr}-second`,
    stateHome,
    worktree,
    taskPath,
    extraEnv,
  });
  expect(second.worktree_lock).toBe(first.worktree_lock);

  const finals = await Promise.all([waitForRunFinal(first.status_path), waitForRunFinal(second.status_path)]);
  expect(finals.map((status) => status.state).sort()).toEqual(["done", "failed"]);

  const failedIndex = finals.findIndex((status) => status.state === "failed");
  expect(failedIndex).toBeGreaterThanOrEqual(0);
  const failedRun = failedIndex === 0 ? first : second;
  const failedStatus = finals[failedIndex]!;
  const failedResult = readResult(failedRun.result_path);
  expect(failedStatus.exit_code).toBe(75);
  expect(JSON.stringify(failedResult)).toContain("lock held:");
}

function providerResult(runId: string, provider: string): ImplementerResult {
  return {
    schema: "orch.result/implementer/v1",
    run_id: runId,
    verdict: "completed",
    summary: `${provider} native completed`,
    base_sha: "base",
    head_sha: "head",
    changed_files: [`${provider}.txt`],
    tests: [{ cmd: `${provider} native`, exit_code: 0, summary: "emitted native result" }],
    acceptance: [{ id: `${provider}-native`, status: "pass" }],
    risks: [],
    rollback: `revert ${provider} native output`,
  };
}

function writeProviderShims(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const common = String.raw`
function runIdFromPrompt(prompt) {
  return prompt.match(/^Run id: (.+)$/m)?.[1]?.trim() ?? "unknown-run";
}
function result(runId, provider) {
  return {
    schema: "orch.result/implementer/v1",
    run_id: runId,
    verdict: "completed",
    summary: provider + " native completed",
    base_sha: "base",
    head_sha: "head",
    changed_files: [provider + ".txt"],
    tests: [{ cmd: provider + " native", exit_code: 0, summary: "emitted native result" }],
    acceptance: [{ id: provider + "-native", status: "pass" }],
    risks: [],
    rollback: "revert " + provider + " native output",
  };
}
`;
  const codex = `#!/usr/bin/env bun
${common}
const prompt = await Bun.stdin.text();
const runId = runIdFromPrompt(prompt);
let lastMessagePath = null;
for (let i = 0; i < Bun.argv.length; i += 1) {
  if (Bun.argv[i] === "--output-last-message") lastMessagePath = Bun.argv[i + 1] ?? null;
}
const text = JSON.stringify(result(runId, "codex"));
if (lastMessagePath) await Bun.write(lastMessagePath, text);
console.log(JSON.stringify({ item: { type: "agent_message", text } }));
`;
  const claude = `#!/usr/bin/env bun
${common}
const prompt = await Bun.stdin.text();
const runId = runIdFromPrompt(prompt);
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }));
console.log(JSON.stringify({ type: "result", result: JSON.stringify(result(runId, "claude")) }));
`;
  const codexPath = join(binDir, "codex");
  const claudePath = join(binDir, "claude");
  writeFileSync(codexPath, codex, "utf8");
  writeFileSync(claudePath, claude, "utf8");
  chmodSync(codexPath, 0o755);
  chmodSync(claudePath, 0o755);
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

test("write-role worktree lock is shared within an MR and across MRs", async () => {
  await expectOneDoneOneLockHeld({ firstMr: "same-mr", secondMr: "same-mr" });
  await expectOneDoneOneLockHeld({ firstMr: "mr-a", secondMr: "mr-b" });
});

test("codex and claude drivers can complete from provider-native output without fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-provider-e2e-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "return a valid orch implementer result\n", "utf8");
  const binDir = join(root, "bin");
  writeProviderShims(binDir);
  const env = { XDG_STATE_HOME: stateHome, PATH: `${binDir}:${process.env.PATH ?? ""}` };

  for (const provider of ["codex", "claude"] as const) {
    const created = await runOrch(
      [
        "run",
        "create",
        "--mr",
        `provider-${provider}`,
        "--role",
        "implementer",
        "--agent",
        provider,
        "--tag",
        provider,
        "--worktree",
        worktree,
        "--task",
        taskPath,
        "--idempotency-key",
        `provider-${provider}`,
        "--timeout-sec",
        "10",
      ],
      env,
    );
    expect(created).toMatchObject({ exitCode: 0, stderr: "" });
    const payload = JSON.parse(created.stdout) as { run_dir: string; status_path: string };
    await waitForRunDone(payload.status_path);

    const result = readResult(join(payload.run_dir, "result.json"));
    expect(result).toEqual(providerResult(result.run_id, provider));
    expect(JSON.stringify(result)).not.toContain(`${provider} did not return a valid orch result JSON`);
    expect(result.schema).toBe("orch.result/implementer/v1");
    expect("verdict" in result ? result.verdict : "").toBe("completed");
  }
});
