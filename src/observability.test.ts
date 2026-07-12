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
import type { ControllerResult, ImplementerResult, ReviewerResult, RoleResult, RunStatus } from "./types.ts";

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
  const pi = `#!/usr/bin/env bun
${common}
const args = Bun.argv.slice(2);
const expected = ["--model", "openai-codex/gpt-5.6-sol", "--thinking", "xhigh", "-p", "--mode", "json", "--no-session"];
if (JSON.stringify(args) !== JSON.stringify(expected)) {
  console.error("unexpected pi argv: " + JSON.stringify(args));
  process.exit(13);
}
const prompt = await Bun.stdin.text();
const runId = runIdFromPrompt(prompt);
console.log(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", text: "ignored" },
      { type: "text", text: JSON.stringify(result(runId, "pi")) },
    ],
  },
}));
`;
  const codexPath = join(binDir, "codex");
  const claudePath = join(binDir, "claude");
  const piPath = join(binDir, "pi");
  writeFileSync(codexPath, codex, "utf8");
  writeFileSync(claudePath, claude, "utf8");
  writeFileSync(piPath, pi, "utf8");
  chmodSync(codexPath, 0o755);
  chmodSync(claudePath, 0o755);
  chmodSync(piPath, 0o755);
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
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
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
      mr,
      role: "implementer",
      agent: "codex",
      tag: "impl-a",
      state: "done",
      started_at: "2026-06-19T12:00:00.000Z",
      exit_code: 0,
      stale: false,
    },
  ]);

  const table = await runOrch(["run", "list", "--mr", mr, "--worktree", worktree], env);
  expect(table).toMatchObject({ exitCode: 0, stderr: "" });
  expect(table.stdout).toContain("run_id");
  expect(table.stdout).toContain(runId);

  const events = await runOrch(["events", "tail", "--run", runId, "--worktree", worktree, "-n", "1"], env);
  expect(events).toMatchObject({ exitCode: 0, stderr: "" });
  expect(events.stdout).toBe("{\"type\":\"done\",\"seq\":1}\n");

  // --native renders normalized provider events (noise lines dropped, session
  // deduped), and -n slices the rendered events, not the raw file lines.
  writeFileSync(
    join(runDir, "native.jsonl"),
    [
      '{"type":"reasoning_delta","delta":"noise"}',
      '{"type":"system","session_id":"sess-observe"}',
      '{"type":"assistant","session_id":"sess-observe","message":{"role":"assistant","content":[{"type":"text","text":"inspecting"}]}}',
      '{"type":"result","result":"done","session_id":"sess-observe"}',
      "",
    ].join("\n"),
    "utf8",
  );
  const native = await runOrch(["events", "tail", "--run", runId, "--worktree", worktree, "--native"], env);
  expect(native).toMatchObject({ exitCode: 0, stderr: "" });
  expect(native.stdout).toBe(
    [
      '{"kind":"session","format":"claude","session_id":"sess-observe"}',
      '{"kind":"assistant","format":"claude","text":"inspecting"}',
      '{"kind":"final","format":"claude","text":"done"}',
      "",
    ].join("\n"),
  );
  const nativeTail = await runOrch(["events", "tail", "--run", runId, "--worktree", worktree, "--native", "-n", "2"], env);
  expect(nativeTail).toMatchObject({ exitCode: 0, stderr: "" });
  expect(nativeTail.stdout).toBe(
    ['{"kind":"assistant","format":"claude","text":"inspecting"}', '{"kind":"final","format":"claude","text":"done"}', ""].join("\n"),
  );

  const jsonResult = await runOrch(["result", "--run", runId, "--mr", mr, "--worktree", worktree, "--json"], env);
  expect(jsonResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(jsonResult.stdout).toBe(`${rawResult}\n`);

  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "git-status.txt"), " M src/orch.ts\n", "utf8");
  writeFileSync(join(artifactsDir, "diff.patch"), "diff --git a/src/orch.ts b/src/orch.ts\n", "utf8");
  writeFileSync(join(artifactsDir, "changed-files.txt"), "src/orch.ts\n", "utf8");

  const humanResult = await runOrch(["result", "--run", runId, "--worktree", worktree], env);
  expect(humanResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(humanResult.stdout).toContain("schema: orch.result/implementer/v1");
  expect(humanResult.stdout).toContain("changed_files:");
  expect(humanResult.stdout).toContain("bun test (exit 0): passed");
  expect(humanResult.stdout).toContain("evidence:");
  expect(humanResult.stdout).toContain(join(artifactsDir, "git-status.txt"));
  expect(humanResult.stdout).toContain(join(artifactsDir, "diff.patch"));
  expect(humanResult.stdout).toContain(join(artifactsDir, "changed-files.txt"));
});

test("result text renderer handles controller results", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-controller-result-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const repoKey = repoKeyFromRemote(worktree, worktree);
  const mr = "controller-result";
  const runId = "control-a-20260704T061044-05c5c9";
  const runDir = join(stateHome, "orch", repoKey, "mrs", mr, "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const status: RunStatus = {
    run_id: runId,
    mr,
    role: "controller",
    agent: "claude",
    tag: "mailctl",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    state: "done",
    pid: null,
    pgid: null,
    started_at: "2026-07-04T06:10:44.000Z",
    updated_at: "2026-07-04T06:11:44.000Z",
    exit_code: 0,
    timeout_sec: 1800,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree,
    base_sha: "base",
    head_sha: "head",
  };
  const result: ControllerResult = {
    schema: "orch.result/controller/v1",
    run_id: runId,
    verdict: "completed",
    summary: "dispatched and settled worker runs",
    actions: ["spawned implementer run", "recorded decision accept"],
  };
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const rendered = await runOrch(["result", "--run", runId, "--mr", mr, "--worktree", worktree], { XDG_STATE_HOME: stateHome });
  expect(rendered).toMatchObject({ exitCode: 0, stderr: "" });
  expect(rendered.stdout).toContain("schema: orch.result/controller/v1");
  expect(rendered.stdout).toContain("verdict: completed");
  expect(rendered.stdout).toContain("summary: dispatched and settled worker runs");
  expect(rendered.stdout).toContain("actions:");
  expect(rendered.stdout).toContain("spawned implementer run");
  expect(rendered.stdout).toContain("recorded decision accept");
  expect(rendered.stdout).not.toContain("changed_files:");
});

test("run create dry-run resolves plans without writing state", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-dry-run-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskText = "inspect only\n";
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, taskText, "utf8");

  const result = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "789",
      "--role",
      "implementer",
      "--agent",
      "codex",
      "--tag",
      "dry-run",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--timeout-sec",
      "12",
      "--dry-run",
      "--json",
    ],
    { XDG_STATE_HOME: stateHome },
  );

  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(result.stdout) as {
    dry_run: boolean;
    repo: { repo_root: string };
    mr_dir: string;
    task_sha: string;
    idempotency_key: string;
    run_id: string;
    run_id_preview: string;
    run_dir: string;
    model: string | null;
    provider_session_name: string | null;
    provider_session_id: string | null;
    provider_session_mode: string;
    status_path: string;
    worktree_lock: string;
    dirty: boolean;
    base_sha: string;
    timeout_sec: number;
    supervisor_plan: { argv: string[]; spawn: boolean };
    driver_plan: { argv: string[]; spawn: boolean };
    provider_plan: { argv: string[]; spawn: boolean };
  };
  const taskSha = sha256(taskText);
  expect(payload.dry_run).toBe(true);
  expect(payload.repo.repo_root).toBe(worktree);
  expect(payload.mr_dir).toContain(join(stateHome, "orch"));
  expect(payload.task_sha).toBe(taskSha);
  expect(payload.idempotency_key.startsWith(`mr789:dry-run:${taskSha}:session-`)).toBe(true);
  expect(payload.run_id_preview.startsWith("dry-run-")).toBe(true);
  expect(payload.run_id).toBe(payload.run_id_preview);
  expect(payload.worktree_lock.startsWith(join(stateHome, "orch", "worktree-locks"))).toBe(true);
  expect(payload.dirty).toBe(false);
  expect(payload.base_sha).toHaveLength(40);
  expect(payload.model).toBeNull();
  expect(payload.provider_session_name).toBeNull();
  expect(payload.provider_session_id).toBeNull();
  expect(payload.provider_session_mode).toBe("fresh_persistent");
  expect(payload.timeout_sec).toBe(12);
  expect(payload.supervisor_plan).toMatchObject({ spawn: false });
  expect(payload.supervisor_plan.argv).toContain("__supervisor");
  expect(payload.driver_plan).toMatchObject({ spawn: false });
  expect(payload.driver_plan.argv).toContain("__driver-codex");
  expect(payload.provider_plan).toMatchObject({ spawn: false });
  expect(payload.provider_plan.argv).toContain("codex");
  expect(payload.provider_plan.argv).not.toContain("resume");
  expect(payload.provider_plan.argv).not.toContain("--last");
  expect(existsSync(payload.run_dir)).toBe(false);
  expect(existsSync(payload.status_path)).toBe(false);

  const human = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "790",
      "--role",
      "reviewer",
      "--agent",
      "claude",
      "--tag",
      "review-dry",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--session-name",
      "review-dry-session",
      "--dry-run",
    ],
    { XDG_STATE_HOME: stateHome },
  );
  expect(human).toMatchObject({ exitCode: 0, stderr: "" });
  expect(human.stdout).toContain("dry-run: orch run create review-dry-");
  expect(human.stdout).toContain("supervisor:");
  expect(human.stdout).toContain("__driver-claude");
  expect(human.stdout).toContain("provider_session_name: review-dry-session");
  expect(human.stdout).toContain("provider:");
  expect(human.stdout).toContain("--name review-dry-session");
  expect(existsSync(stateHome)).toBe(false);
});

test("run create dry-run passes explicit model to the pi provider plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-pi-model-dry-run-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "review with selected pi model\n", "utf8");
  const model = "zenmux-anthropic/anthropic/claude-fable-5";

  const result = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "pi-model",
      "--role",
      "reviewer",
      "--agent",
      "pi",
      "--model",
      model,
      "--tag",
      "pi-model",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--dry-run",
      "--json",
    ],
    { XDG_STATE_HOME: stateHome },
  );

  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(result.stdout) as {
    model: string | null;
    provider_session_mode: string;
    provider_plan: { argv: string[]; spawn: boolean };
  };
  expect(payload.model).toBe(model);
  expect(payload.provider_session_mode).toBe("ephemeral");
  expect(payload.provider_plan).toMatchObject({ spawn: false });
  expect(payload.provider_plan.argv).toEqual([
    "pi",
    "--model",
    model,
    "--thinking",
    "xhigh",
    "-p",
    "--mode",
    "json",
    "--tools",
    "read,grep,find,ls",
    "--no-session",
  ]);
  expect(existsSync(stateHome)).toBe(false);
});

test("run create resolves an omitted --mr from the task text, then the branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mr-resolve-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const env = { XDG_STATE_HOME: stateHome };
  const base = ["run", "create", "--role", "reviewer", "--agent", "codex", "--worktree", worktree, "--dry-run", "--json"];

  // 1. A GitLab merge-request URL anywhere in the task text wins over the branch.
  const urlTask = join(root, "url-task.md");
  writeFileSync(urlTask, "Review https://git.example.com/group/repo/-/merge_requests/3358 for races.\n", "utf8");
  const fromUrl = await runOrch([...base, "--task", urlTask], env);
  expect(fromUrl).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(fromUrl.stdout)).toMatchObject({ mr: "3358", mr_source: "task" });

  // 2. An explicit "MR:" header line wins, including URL values.
  const headerTask = join(root, "header-task.md");
  writeFileSync(headerTask, "MR: https://github.com/o/r/pull/77\nGoal: review\n", "utf8");
  const fromHeader = await runOrch([...base, "--task", headerTask], env);
  expect(JSON.parse(fromHeader.stdout)).toMatchObject({ mr: "77", mr_source: "task" });

  // 3. No reference in the task → current branch name.
  const branchProc = Bun.spawn(["git", "-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe" });
  const branch = (await new Response(branchProc.stdout).text()).trim();
  const plainTask = join(root, "plain-task.md");
  writeFileSync(plainTask, "Review the pending diff.\n", "utf8");
  const fromBranch = await runOrch([...base, "--task", plainTask], env);
  expect(JSON.parse(fromBranch.stdout)).toMatchObject({ mr: branch, mr_source: "branch" });

  // 4. Explicit --mr still wins over everything.
  const explicit = await runOrch([...base, "--task", urlTask, "--mr", "manual"], env);
  expect(JSON.parse(explicit.stdout)).toMatchObject({ mr: "manual", mr_source: "flag" });

  // 5. An "MR:" line outside the leading header block (after a blank line) is
  // quoted prose, not metadata — it must not hijack the resolution.
  const proseTask = join(root, "prose-task.md");
  writeFileSync(proseTask, "Goal: review\n\nSomeone wrote:\nMR: 999\n", "utf8");
  const fromProse = await runOrch([...base, "--task", proseTask], env);
  expect(JSON.parse(fromProse.stdout)).toMatchObject({ mr_source: "branch" });
});

test("branch-derived mr keeps its raw value through run list and decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mr-raw-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  await runCmd(["git", "-C", worktree, "checkout", "-b", "feat/slash-branch"], worktree);
  const env = { XDG_STATE_HOME: stateHome, ORCH_DRIVER_FAKE_RESULT: "1" };
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "Review the pending diff.\n", "utf8");

  const created = await runOrch(
    ["run", "create", "--role", "reviewer", "--agent", "codex", "--tag", "raw", "--worktree", worktree, "--task", taskPath],
    env,
  );
  expect(created).toMatchObject({ exitCode: 0 });
  const payload = JSON.parse(created.stdout) as { mr: string; run_id: string; status_path: string; mr_dir: string };
  expect(payload.mr).toBe("feat/slash-branch");
  expect(payload.mr_dir.endsWith("feat_slash-branch")).toBe(true); // sanitized on disk
  await waitForRunDone(payload.status_path);

  // The aggregate views and the scan-based decision must report the raw value,
  // not the sanitized directory name.
  const list = await runOrch(["run", "list", "--worktree", worktree, "--json"], env);
  expect(JSON.parse(list.stdout)).toMatchObject([{ run_id: payload.run_id, mr: "feat/slash-branch" }]);

  const decided = await runOrch(["decision", "accept", "--run", payload.run_id, "--worktree", worktree, "--reason", "ok"], env);
  expect(decided).toMatchObject({ exitCode: 0, stderr: "" });
  const pendingDir = join(payload.mr_dir, "outbox", "pending");
  const outboxFiles = readdirSync(pendingDir).filter((name) => name.endsWith(".json"));
  expect(outboxFiles.length).toBe(1);
  const outbox = JSON.parse(readFileSync(join(pendingDir, outboxFiles[0]!), "utf8")) as { mr: string };
  expect(outbox.mr).toBe("feat/slash-branch");
});

test("run create rejects the removed agy agent and accepts omp for any result role", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-omp-role-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);

  const rejected = await runOrch(
    ["run", "create", "--mr", "omp-role", "--role", "reviewer", "--agent", "agy", "--tag", "agy-review", "--worktree", worktree, "--dry-run"],
    { XDG_STATE_HOME: stateHome },
  );
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stderr).toContain("unsupported agent: agy");
  // CliError prints the message only, not a stack trace.
  expect(rejected.stderr).not.toContain("    at ");
  expect(existsSync(stateHome)).toBe(false);

  for (const role of ["implementer", "reviewer", "verifier"]) {
    const allowed = await runOrch(
      ["run", "create", "--mr", "omp-role", "--role", role, "--agent", "omp", "--tag", `omp-${role}`, "--worktree", worktree, "--dry-run"],
      { XDG_STATE_HOME: stateHome },
    );
    expect(allowed).toMatchObject({ exitCode: 0, stderr: "" });
  }
});

test("run create supports claude controller runs and rejects other controller providers", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-controller-role-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  writeFileSync(join(worktree, "dirty-controller.txt"), "dirty\n", "utf8");
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "orchestrate mail thread\n", "utf8");

  const rejected = await runOrch(
    ["run", "create", "--mr", "controller-role", "--role", "controller", "--agent", "codex", "--tag", "ctrl", "--worktree", worktree, "--dry-run"],
    { XDG_STATE_HOME: stateHome },
  );
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stderr).toContain("controller role only supports the claude agent");

  const dryRun = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "controller-role",
      "--role",
      "controller",
      "--agent",
      "claude",
      "--tag",
      "ctrl",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--dry-run",
      "--json",
    ],
    { XDG_STATE_HOME: stateHome },
  );
  expect(dryRun).toMatchObject({ exitCode: 0, stderr: "" });
  const dryRunPayload = JSON.parse(dryRun.stdout) as {
    provider_plan: { argv: string[] };
  };
  expect(dryRunPayload.provider_plan.argv).toContain("--allowedTools");
  const allowedTools = dryRunPayload.provider_plan.argv[dryRunPayload.provider_plan.argv.indexOf("--allowedTools") + 1];
  expect(allowedTools).toContain("Bash(orch *)");
  expect(allowedTools).not.toMatch(/\b(?:Edit|Write|MultiEdit)\b/);

  const created = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "controller-role",
      "--role",
      "controller",
      "--agent",
      "claude",
      "--tag",
      "ctrl",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "controller-role-test",
      "--timeout-sec",
      "10",
    ],
    { XDG_STATE_HOME: stateHome, ORCH_DRIVER_FAKE_RESULT: "1", ORCH_DRIVER_FAKE_SLEEP_MS: "1000" },
  );
  expect(created).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(created.stdout) as { run_id: string; run_dir: string; status_path: string };
  const running = await waitForRunState(payload.status_path, ["running"]);
  expect(running.role).toBe("controller");

  const implementer = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "controller-role",
      "--role",
      "implementer",
      "--agent",
      "codex",
      "--tag",
      "impl-during-ctrl",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "controller-role-implementer-test",
      "--timeout-sec",
      "10",
      "--allow-dirty",
    ],
    { XDG_STATE_HOME: stateHome, ORCH_DRIVER_FAKE_RESULT: "1" },
  );
  expect(implementer).toMatchObject({ exitCode: 0, stderr: "" });
  const implementerPayload = JSON.parse(implementer.stdout) as { status_path: string };
  const implementerStatus = await waitForRunDone(implementerPayload.status_path);
  expect(implementerStatus.role).toBe("implementer");

  await waitForRunDone(payload.status_path);
  const result = readResult(join(payload.run_dir, "result.json"));
  expect(result).toMatchObject({
    schema: "orch.result/controller/v1",
    run_id: payload.run_id,
    verdict: "completed",
    actions: [],
  });
});

test("run create rejects unsafe provider session combinations", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-session-validation-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);

  const codexNamed = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "session-validation",
      "--role",
      "reviewer",
      "--agent",
      "codex",
      "--tag",
      "named-codex",
      "--worktree",
      worktree,
      "--session-name",
      "not-supported",
      "--dry-run",
    ],
    { XDG_STATE_HOME: stateHome },
  );
  expect(codexNamed.exitCode).toBe(1);
  expect(codexNamed.stderr).toContain("codex does not support --session-name");
  expect(existsSync(stateHome)).toBe(false);

  const claudeFreshId = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "session-validation",
      "--role",
      "reviewer",
      "--agent",
      "claude",
      "--tag",
      "fresh-id",
      "--worktree",
      worktree,
      "--session-id",
      "123e4567-e89b-12d3-a456-426614174000",
      "--dry-run",
    ],
    { XDG_STATE_HOME: stateHome },
  );
  expect(claudeFreshId.exitCode).toBe(1);
  expect(claudeFreshId.stderr).toContain("--session-id requires --session-mode resume_exact");
  expect(existsSync(stateHome)).toBe(false);

  const piFreshId = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "session-validation",
      "--role",
      "reviewer",
      "--agent",
      "pi",
      "--tag",
      "pi-fresh-id",
      "--worktree",
      worktree,
      "--session-mode",
      "fresh_persistent",
      "--session-id",
      "pi-session",
      "--dry-run",
    ],
    { XDG_STATE_HOME: stateHome },
  );
  expect(piFreshId.exitCode).toBe(1);
  expect(piFreshId.stderr).toContain("--session-id requires --session-mode resume_exact");
  expect(existsSync(stateHome)).toBe(false);

  const claudeBadId = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "session-validation",
      "--role",
      "reviewer",
      "--agent",
      "claude",
      "--tag",
      "bad-claude",
      "--worktree",
      worktree,
      "--session-mode",
      "resume_exact",
      "--session-id",
      "latest",
      "--dry-run",
    ],
    { XDG_STATE_HOME: stateHome },
  );
  expect(claudeBadId.exitCode).toBe(1);
  expect(claudeBadId.stderr).toContain("requires a UUID");
});

test("run create dry-run previews idempotent reuse without spawn plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-dry-run-idem-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "reuse me\n", "utf8");
  const env = { XDG_STATE_HOME: stateHome, ORCH_DRIVER_FAKE_RESULT: "1" };

  const created = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "791",
      "--role",
      "implementer",
      "--agent",
      "codex",
      "--tag",
      "idem-dry",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "idem-dry-run",
      "--timeout-sec",
      "10",
    ],
    env,
  );
  expect(created).toMatchObject({ exitCode: 0, stderr: "" });
  const createdPayload = JSON.parse(created.stdout) as { run_id: string; run_dir: string; status_path: string };
  await waitForRunDone(createdPayload.status_path);

  const preview = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "791",
      "--role",
      "implementer",
      "--agent",
      "codex",
      "--tag",
      "idem-dry",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "idem-dry-run",
      "--timeout-sec",
      "10",
      "--dry-run",
      "--json",
    ],
    env,
  );
  expect(preview).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(preview.stdout) as {
    idempotent: boolean;
    existing_run_id: string | null;
    state: string;
    run_id: string;
    run_id_preview: string | null;
    run_dir: string;
    status_path: string;
    result_path: string;
    events_path: string | null;
    supervisor_plan: null | { argv: string[] };
    driver_plan: null | { argv: string[] };
  };
  expect(payload).toMatchObject({
    idempotent: true,
    existing_run_id: createdPayload.run_id,
    state: "done",
    run_id: createdPayload.run_id,
    run_id_preview: null,
    run_dir: createdPayload.run_dir,
    status_path: createdPayload.status_path,
    result_path: join(createdPayload.run_dir, "result.json"),
    events_path: null,
    supervisor_plan: null,
    driver_plan: null,
  });

  const retryPreview = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "791",
      "--role",
      "implementer",
      "--agent",
      "codex",
      "--tag",
      "idem-dry",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "idem-dry-run",
      "--retry",
      "--timeout-sec",
      "10",
      "--dry-run",
      "--json",
    ],
    env,
  );
  expect(retryPreview).toMatchObject({ exitCode: 0, stderr: "" });
  const retryPayload = JSON.parse(retryPreview.stdout) as {
    idempotent: boolean;
    existing_run_id: string | null;
    run_id: string;
    run_id_preview: string | null;
    run_dir: string;
    supervisor_plan: { spawn: boolean };
    driver_plan: { spawn: boolean };
  };
  expect(retryPayload.idempotent).toBe(false);
  expect(retryPayload.existing_run_id).toBe(createdPayload.run_id);
  expect(retryPayload.run_id).not.toBe(createdPayload.run_id);
  expect(retryPayload.run_id_preview).toBe(retryPayload.run_id);

  expect(retryPayload.supervisor_plan).toMatchObject({ spawn: false });
  expect(retryPayload.driver_plan).toMatchObject({ spawn: false });
  expect(existsSync(retryPayload.run_dir)).toBe(false);
  expect(readdirSync(join(stateHome, "orch", repoKeyFromRemote(worktree, worktree), "mrs", "791", "runs"))).toHaveLength(1);
});

test("run create rejects idempotent reuse with different provider session/model settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-session-idem-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "same task\n", "utf8");
  const env = { XDG_STATE_HOME: stateHome, ORCH_DRIVER_FAKE_RESULT: "1" };

  const created = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "session-idem",
      "--role",
      "reviewer",
      "--agent",
      "claude",
      "--tag",
      "review-session",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "same-key",
      "--timeout-sec",
      "10",
    ],
    env,
  );
  expect(created).toMatchObject({ exitCode: 0, stderr: "" });
  const createdPayload = JSON.parse(created.stdout) as { status_path: string };
  await waitForRunDone(createdPayload.status_path);

  const mismatch = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "session-idem",
      "--role",
      "reviewer",
      "--agent",
      "claude",
      "--tag",
      "review-session",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "same-key",
      "--session-mode",
      "resume_exact",
      "--session-id",
      "123e4567-e89b-12d3-a456-426614174000",
      "--dry-run",
      "--json",
    ],
    env,
  );
  expect(mismatch.exitCode).toBe(1);
  expect(mismatch.stderr).toContain("idempotent run already exists with different provider session/model settings");

  const modelMismatch = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "session-idem",
      "--role",
      "reviewer",
      "--agent",
      "claude",
      "--tag",
      "review-session",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "same-key",
      "--model",
      "claude-fable-5",
      "--dry-run",
      "--json",
    ],
    env,
  );
  expect(modelMismatch.exitCode).toBe(1);
  expect(modelMismatch.stderr).toContain("idempotent run already exists with different provider session/model settings");

  const retry = await runOrch(
    [
      "run",
      "create",
      "--mr",
      "session-idem",
      "--role",
      "reviewer",
      "--agent",
      "claude",
      "--tag",
      "review-session",
      "--worktree",
      worktree,
      "--task",
      taskPath,
      "--idempotency-key",
      "same-key",
      "--session-mode",
      "resume_exact",
      "--session-id",
      "123e4567-e89b-12d3-a456-426614174000",
      "--retry",
      "--dry-run",
      "--json",
    ],
    env,
  );
  expect(retry).toMatchObject({ exitCode: 0, stderr: "" });
  const retryPayload = JSON.parse(retry.stdout) as { idempotent: boolean; provider_session_mode: string; provider_session_id: string | null; provider_plan: { argv: string[] } };
  expect(retryPayload.idempotent).toBe(false);
  expect(retryPayload.provider_session_mode).toBe("resume_exact");
  expect(retryPayload.provider_session_id).toBe("123e4567-e89b-12d3-a456-426614174000");
  expect(retryPayload.provider_plan.argv).toContain("--resume");
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
      "--model",
      "codex-test-model",
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
  const storedSpec = JSON.parse(specBytes) as {
    model: string | null;
    provider_session_name: string | null;
    provider_session_id: string | null;
    provider_session_mode: string;
  };
  expect(storedSpec).toMatchObject({
    model: "codex-test-model",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
  });
  expect(firstStatus.provider_session_mode).toBe("fresh_persistent");
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
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
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
  expect(outboxPayload.body).toContain("exit=0 `bun test` — passed");
  expect(outboxPayload.body).toContain("outbox: pass — pending payload written");

  const sync = await runOrch(["mirror", "sync", "--mr", mr, "--worktree", worktree], env);
  expect(sync).toMatchObject({ exitCode: 0, stderr: "" });
  expect(sync.stdout).toContain("gh pr comment 123 --body");
  expect(readdirSync(pendingDir).filter((file) => file.endsWith(".json"))).toHaveLength(1);
  expect(readdirSync(sentDir).filter((file) => file.endsWith(".json"))).toHaveLength(0);
});

test("reviewer decision mirrors full findings detail and caps oversized bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-decision-findings-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", remote], worktree);

  const repoKey = repoKeyFromRemote(remote, worktree);
  const mr = "77";
  const runId = "rev-a-20260619T120000Z-def456";
  const mrDir = join(stateHome, "orch", repoKey, "mrs", mr);
  const runDir = join(mrDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const status: RunStatus = {
    run_id: runId,
    mr,
    role: "reviewer",
    agent: "claude",
    tag: "rev-a",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
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
  const result: ReviewerResult = {
    schema: "orch.result/reviewer/v1",
    run_id: runId,
    verdict: "request_changes",
    reviews_run_id: "impl-a",
    blocking_findings: [
      { id: "B1", severity: "high", file: "src/rerank.kt:59", body: "no relocation ready await\n\nsecond paragraph with detail" },
      { id: "B2", severity: "high", file: "src/rerank.kt:211", body: "x".repeat(70_000) },
    ],
    non_blocking_findings: [{ id: "NB1", body: "nested timeout duplication" }],
    suggested_tests: ["cover empty docs response"],
  };
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const decision = await runOrch(
    ["decision", "rework", "--mr", mr, "--run", runId, "--worktree", worktree, "--reason", "blocking findings"],
    { XDG_STATE_HOME: stateHome },
  );
  expect(decision).toMatchObject({ exitCode: 0, stderr: "" });

  const pendingDir = join(mrDir, "outbox", "pending");
  const pending = readdirSync(pendingDir).filter((file) => file.endsWith(".json"));
  expect(pending).toHaveLength(1);
  const body = JSON.parse(readFileSync(join(pendingDir, pending[0]!), "utf8")).body as string;

  expect(body).toContain("Blocking findings (2):");
  expect(body).toContain("**[high | B1 | src/rerank.kt:59]**");
  expect(body).toContain("second paragraph with detail");
  expect(body).toContain("…(finding truncated)");
  expect(body).toContain("Non-blocking findings (1):");
  expect(body).toContain("**[NB1]**");
  expect(body).toContain("Suggested tests (1):");
  expect(body).toContain("- cover empty docs response");
  expect(body.length).toBeLessThanOrEqual(60_000 + 200);
});

test("decision refuses unsafe mirror body before writing outbox payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-decision-leak-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", remote], worktree);

  const repoKey = repoKeyFromRemote(remote, worktree);
  const mr = "124";
  const runId = "impl-a-20260619T120000Z-def456";
  const mrDir = join(stateHome, "orch", repoKey, "mrs", mr);
  const runDir = join(mrDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const status: RunStatus = {
    run_id: runId,
    mr,
    role: "implementer",
    agent: "codex",
    tag: "impl-a",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
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
    summary: "safe summary",
    base_sha: "base",
    head_sha: "head",
    changed_files: ["src/orch.ts"],
    tests: [],
    acceptance: [],
    risks: [],
    rollback: "revert",
  };
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const decision = await runOrch(
    [
      "decision",
      "accept",
      "--mr",
      mr,
      "--run",
      runId,
      "--worktree",
      worktree,
      "--reason",
      "reviewed in .claude/settings.json",
    ],
    { XDG_STATE_HOME: stateHome },
  );

  expect(decision.exitCode).toBe(1);
  expect(decision.stdout).toBe("");
  expect(decision.stderr).toContain("refusing to mirror comment body");
  expect(decision.stderr).toContain("ORCH_MIRROR_ALLOW_PRIVATE=1");
  expect(existsSync(join(runDir, "decision.json"))).toBe(false);
  expect(readdirSync(join(mrDir, "outbox", "pending")).filter((file) => file.endsWith(".json"))).toHaveLength(0);
});

test("mirror dry-run refuses unsafe body before posting", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mirror-leak-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", remote], worktree);

  const repoKey = repoKeyFromRemote(remote, worktree);
  const mr = "125";
  const runId = "impl-a-20260619T120000Z-ghi789";
  const runDir = join(stateHome, "orch", repoKey, "mrs", mr, "runs", runId);
  mkdirSync(runDir, { recursive: true });

  const status: RunStatus = {
    run_id: runId,
    mr,
    role: "implementer",
    agent: "codex",
    tag: "impl-a",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
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
    summary: "wrote files under /Users/alice/project",
    base_sha: "base",
    head_sha: "head",
    changed_files: ["src/orch.ts"],
    tests: [],
    acceptance: [],
    risks: [],
    rollback: "revert",
  };
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const mirrored = await runOrch(["mirror", "--mr", mr, "--run", runId, "--worktree", worktree], {
    XDG_STATE_HOME: stateHome,
  });

  expect(mirrored.exitCode).toBe(1);
  expect(mirrored.stdout).toBe("");
  expect(mirrored.stderr).toContain("refusing to mirror comment body");
  expect(mirrored.stderr).toContain("ORCH_MIRROR_ALLOW_PRIVATE=1");
  expect(mirrored.stderr).not.toContain("gh pr comment");
});

test("mirror sync dry-run refuses unsafe queued payload before posting", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mirror-sync-leak-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", remote], worktree);

  const repoKey = repoKeyFromRemote(remote, worktree);
  const mr = "126";
  const mrDir = join(stateHome, "orch", repoKey, "mrs", mr);
  const pendingDir = join(mrDir, "outbox", "pending");
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(
    join(pendingDir, "unsafe.json"),
    `${JSON.stringify(
      {
        kind: "comment",
        mr,
        body: "state lives in .local/state/orch/example",
        created_at: "2026-06-19T12:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const sync = await runOrch(["mirror", "sync", "--mr", mr, "--worktree", worktree], { XDG_STATE_HOME: stateHome });

  expect(sync.exitCode).toBe(1);
  expect(sync.stderr).toBe("");
  expect(sync.stdout).toContain("refusing to mirror comment body");
  expect(sync.stdout).toContain("ORCH_MIRROR_ALLOW_PRIVATE=1");
  expect(sync.stdout).not.toContain("gh pr comment");
  expect(readdirSync(pendingDir).filter((file) => file.endsWith(".json"))).toHaveLength(1);
  expect(readdirSync(join(mrDir, "outbox", "sent")).filter((file) => file.endsWith(".json"))).toHaveLength(0);
});

test("write-role worktree lock is shared within an MR and across MRs", async () => {
  await expectOneDoneOneLockHeld({ firstMr: "same-mr", secondMr: "same-mr" });
  await expectOneDoneOneLockHeld({ firstMr: "mr-a", secondMr: "mr-b" });
});

test("run cancel signals the driver group and the supervisor finalizes with a canceled result", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-cancel-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "run long enough to be canceled\n", "utf8");
  const env = { XDG_STATE_HOME: stateHome };
  const mr = "cancel-mr";

  const run = await createWriteRun({
    mr,
    key: "cancel-first",
    stateHome,
    worktree,
    taskPath,
    extraEnv: { ORCH_DRIVER_FAKE_RESULT: "1", ORCH_DRIVER_FAKE_SLEEP_MS: "15000" },
  });
  await waitForRunState(run.status_path, ["running"]);

  const cancel = await runOrch(
    ["run", "cancel", "--run", run.run_id, "--mr", mr, "--worktree", worktree, "--reason", "direction changed"],
    env,
  );
  expect(cancel).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(cancel.stdout)).toMatchObject({ canceled: true, run_id: run.run_id, mr, signal: "SIGTERM" });

  const finalStatus = await waitForRunFinal(run.status_path);
  expect(finalStatus.state).toBe("failed");
  expect(existsSync(join(run.run_dir, "canceled.json"))).toBe(true);
  expect(JSON.stringify(readResult(run.result_path))).toContain("canceled: direction changed");

  const again = await runOrch(["run", "cancel", "--run", run.run_id, "--mr", mr, "--worktree", worktree], env);
  expect(again.exitCode).toBe(0);
  expect(JSON.parse(again.stdout)).toMatchObject({ canceled: false, reason: "already terminal" });
});

test("run cancel rejects unstarted runs and reports gone process groups", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-cancel-edge-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const repoKey = repoKeyFromRemote(worktree, worktree);
  const mr = "cancel-edge";
  const env = { XDG_STATE_HOME: stateHome };
  const baseStatus = (runId: string, patch: Partial<RunStatus>): RunStatus => ({
    run_id: runId,
    mr,
    role: "implementer",
    agent: "codex",
    tag: "impl",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    state: "running",
    pid: null,
    pgid: null,
    started_at: "2026-07-13T12:00:00.000Z",
    updated_at: new Date().toISOString(),
    exit_code: null,
    timeout_sec: 3600,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree,
    base_sha: "base",
    head_sha: null,
    ...patch,
  });
  const writeRun = (runId: string, patch: Partial<RunStatus>): void => {
    const runDir = join(stateHome, "orch", repoKey, "mrs", mr, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "status.json"), `${JSON.stringify(baseStatus(runId, patch))}\n`, "utf8");
  };

  // No process group yet: refuse with a retry/reap hint.
  const unstartedId = "impl-unstarted-20260713T120000-aaaaaa";
  writeRun(unstartedId, { state: "created" });
  const unstarted = await runOrch(["run", "cancel", "--run", unstartedId, "--mr", mr, "--worktree", worktree], env);
  expect(unstarted.exitCode).toBe(1);
  expect(unstarted.stderr).toContain("no process group yet");

  // Recorded pgid no longer exists: report it and point at reap.
  const deadProc = Bun.spawn(["true"], { stdout: "ignore" });
  await deadProc.exited;
  const goneId = "impl-gone-20260713T120000-bbbbbb";
  writeRun(goneId, { pid: deadProc.pid, pgid: deadProc.pid });
  const gone = await runOrch(["run", "cancel", "--run", goneId, "--mr", mr, "--worktree", worktree], env);
  expect(gone.exitCode).toBe(1);
  const payload = JSON.parse(gone.stdout) as { canceled: boolean; reason: string };
  expect(payload.canceled).toBe(false);
  expect(payload.reason).toContain("orch run reap");
});

test("stale runs are flagged and reaped, result --wait returns, reviewer findings render", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-lifecycle-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const repoKey = repoKeyFromRemote(worktree, worktree);
  const mr = "lifecycle";
  const env = { XDG_STATE_HOME: stateHome };
  const baseStatus = (runId: string): RunStatus => ({
    run_id: runId,
    mr,
    role: "reviewer",
    agent: "claude",
    tag: "review",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    state: "done",
    pid: null,
    pgid: null,
    started_at: "2026-07-03T12:00:00.000Z",
    updated_at: "2026-07-03T12:01:00.000Z",
    exit_code: 0,
    timeout_sec: 3600,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree,
    base_sha: "base",
    head_sha: "head",
  });

  // A run stuck in `running` whose pid is dead: flagged on read, persisted by reap.
  const deadProc = Bun.spawn(["true"], { stdout: "ignore" });
  await deadProc.exited;
  const staleId = "review-stale-20260703T120000-aaaaaa";
  const staleDir = join(stateHome, "orch", repoKey, "mrs", mr, "runs", staleId);
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(
    join(staleDir, "status.json"),
    `${JSON.stringify({ ...baseStatus(staleId), state: "running", pid: deadProc.pid, pgid: deadProc.pid, exit_code: null })}\n`,
    "utf8",
  );
  writeFileSync(join(staleDir, "events.jsonl"), '{"type":"running","seq":0,"ts":"2026-07-03T12:00:00.000Z"}\n', "utf8");

  const list = await runOrch(["run", "list", "--mr", mr, "--worktree", worktree], env);
  expect(list.stdout).toContain("running (stale?)");

  const reap = await runOrch(["run", "reap", "--mr", mr, "--worktree", worktree], env);
  expect(reap).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(reap.stdout)).toMatchObject({ reaped: [{ mr, run_id: staleId }], still_running: [] });
  const reapedStatus = JSON.parse(readFileSync(join(staleDir, "status.json"), "utf8")) as RunStatus;
  expect(reapedStatus.state).toBe("stale");
  expect(readFileSync(join(staleDir, "events.jsonl"), "utf8")).toContain('"type":"stale"');
  const reapAgain = await runOrch(["run", "reap", "--mr", mr, "--worktree", worktree], env);
  expect(JSON.parse(reapAgain.stdout)).toMatchObject({ reaped: [] });

  // A finished reviewer run: --wait returns immediately and findings render.
  const doneId = "review-done-20260703T120000-bbbbbb";
  const doneDir = join(stateHome, "orch", repoKey, "mrs", mr, "runs", doneId);
  mkdirSync(doneDir, { recursive: true });
  writeFileSync(join(doneDir, "status.json"), `${JSON.stringify(baseStatus(doneId))}\n`, "utf8");
  writeFileSync(
    join(doneDir, "result.json"),
    `${JSON.stringify({
      schema: "orch.result/reviewer/v1",
      run_id: doneId,
      verdict: "request_changes",
      reviews_run_id: "impl-a",
      blocking_findings: [{ id: "b1", severity: "major", file: "src/a.ts", body: "race in claim path" }],
      non_blocking_findings: [{ id: "nb1", body: "naming nit" }],
      suggested_tests: ["bun test claims"],
    })}\n`,
    "utf8",
  );
  const rendered = await runOrch(["result", "--run", doneId, "--mr", mr, "--worktree", worktree, "--wait"], env);
  expect(rendered).toMatchObject({ exitCode: 0, stderr: "" });
  expect(rendered.stdout).toContain("blocking_findings:");
  expect(rendered.stdout).toContain("major | b1 | src/a.ts");
  expect(rendered.stdout).toContain("race in claim path");
  expect(rendered.stdout).toContain("naming nit");
  expect(rendered.stdout).toContain("bun test claims");

  // --wait on the reaped run does not hang: stale is terminal, and the missing
  // result.json surfaces as a clean CliError.
  const waitStale = await runOrch(["result", "--run", staleId, "--mr", mr, "--worktree", worktree, "--wait"], env);
  expect(waitStale.exitCode).toBe(1);
  expect(waitStale.stderr).toContain("result.json not found");
  expect(waitStale.stderr).not.toContain("    at ");
});

test("a provider that exits 0 with no output fails the run instead of quietly succeeding", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-silent-provider-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "review something\n", "utf8");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { XDG_STATE_HOME: stateHome, PATH: `${binDir}:${process.env.PATH ?? ""}` };

  const created = await runOrch(
    ["run", "create", "--mr", "silent", "--role", "reviewer", "--agent", "claude", "--tag", "silent", "--worktree", worktree, "--task", taskPath, "--timeout-sec", "10"],
    env,
  );
  expect(created).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(created.stdout) as { run_dir: string; status_path: string };
  const finalStatus = await waitForRunFinal(payload.status_path);
  expect(finalStatus.state).toBe("failed");
  const result = readResult(join(payload.run_dir, "result.json"));
  expect(JSON.stringify(result)).toContain("produced no output");
});

test("codex, claude, and pi drivers can complete from provider-native output without fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-provider-e2e-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "return a valid orch implementer result\n", "utf8");
  const binDir = join(root, "bin");
  writeProviderShims(binDir);
  const env = { XDG_STATE_HOME: stateHome, PATH: `${binDir}:${process.env.PATH ?? ""}` };

  for (const provider of ["codex", "claude", "pi"] as const) {
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

test("run create --resume-from inherits agent/role/mr/session from the prior run", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-resume-from-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "Implement the feature.\n", "utf8");
  const env = { XDG_STATE_HOME: stateHome, ORCH_DRIVER_FAKE_RESULT: "1" };

  const created = await runOrch(
    ["run", "create", "--mr", "9", "--role", "implementer", "--agent", "claude", "--worktree", worktree, "--task", taskPath, "--timeout-sec", "10"],
    env,
  );
  expect(created).toMatchObject({ exitCode: 0 });
  const payload = JSON.parse(created.stdout) as { run_id: string; status_path: string };
  const status = await waitForRunDone(payload.status_path);
  // the fake driver's native stream carries a session id; the supervisor backfills it
  expect(status.provider_resume_id).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

  const reworkTask = join(root, "rework.md");
  writeFileSync(reworkTask, "Fix the blocking findings.\n", "utf8");
  const dry = await runOrch(
    ["run", "create", "--resume-from", payload.run_id, "--worktree", worktree, "--task", reworkTask, "--dry-run", "--json"],
    env,
  );
  expect(dry).toMatchObject({ exitCode: 0, stderr: "" });
  const plan = JSON.parse(dry.stdout) as {
    mr: string;
    provider_session_mode: string;
    provider_session_id: string;
    driver_plan: { argv: string[] };
    provider_plan: { argv: string[] };
  };
  expect(plan.mr).toBe("9"); // inherited from the prior run, no --mr passed
  expect(plan.provider_session_mode).toBe("resume_exact");
  expect(plan.provider_session_id).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
  expect(plan.driver_plan.argv.join(" ")).toContain("__driver-claude"); // agent inherited
  expect(plan.provider_plan.argv.join(" ")).toContain("--resume eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

  // conflicts and misuse are rejected early
  const withMode = await runOrch(
    ["run", "create", "--resume-from", payload.run_id, "--session-mode", "ephemeral", "--worktree", worktree, "--task", reworkTask],
    env,
  );
  expect(withMode.exitCode).not.toBe(0);
  expect(withMode.stderr).toContain("--session-mode conflicts with --resume-from");

  const withAgent = await runOrch(
    ["run", "create", "--resume-from", payload.run_id, "--agent", "codex", "--worktree", worktree, "--task", reworkTask],
    env,
  );
  expect(withAgent.exitCode).not.toBe(0);
  expect(withAgent.stderr).toContain("sessions are not portable");

  const unknown = await runOrch(["run", "create", "--resume-from", "no-such-run", "--worktree", worktree, "--task", reworkTask], env);
  expect(unknown.exitCode).not.toBe(0);
  expect(unknown.stderr).toContain("run not found");
});

test("run create --resume-from refuses ephemeral prior runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-resume-eph-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initGitWorktree(worktree);
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "Review it.\n", "utf8");
  const env = { XDG_STATE_HOME: stateHome, ORCH_DRIVER_FAKE_RESULT: "1" };

  const created = await runOrch(
    ["run", "create", "--mr", "9", "--role", "reviewer", "--agent", "claude", "--session-mode", "ephemeral", "--worktree", worktree, "--task", taskPath, "--timeout-sec", "10"],
    env,
  );
  expect(created).toMatchObject({ exitCode: 0 });
  const payload = JSON.parse(created.stdout) as { run_id: string; status_path: string };
  await waitForRunDone(payload.status_path);

  const resumed = await runOrch(["run", "create", "--resume-from", payload.run_id, "--worktree", worktree, "--task", taskPath], env);
  expect(resumed.exitCode).not.toBe(0);
  expect(resumed.stderr).toContain("ephemeral");
});
