import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./hash.ts";
import { repoKeyFromRemote } from "./paths.ts";
import type { RunSpec } from "./types.ts";

const tempDirs: string[] = [];

const initialPlan = `## Destination
Ship the selected cache policy.

## Out of scope
None.

## Tasks (now)
### implement-cache
- Role: implementer
- After: none
- Spec: Implement the selected cache policy.
- Acceptance:
  - cache tests pass

## Later (not yet specified)
None.
`;

const resolvedPlan = initialPlan.replace("selected cache policy", "LRU cache policy").replace("selected cache policy", "LRU cache policy");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-new-"));
  tempDirs.push(dir);
  return dir;
}

async function runOrch(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
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
  if ((await proc.exited) !== 0) throw new Error(`${args.join(" ")} failed`);
}

async function initRepo(worktree: string, remote: string): Promise<void> {
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", remote], worktree);
  await runCmd(
    ["git", "-c", "user.email=orch@example.com", "-c", "user.name=orch", "commit", "--allow-empty", "-m", "init"],
    worktree,
  );
}

test("orch new --yes plans as researcher then rejects a controller's false zero-dispatch completion", async () => {
  const root = tempDir();
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome, ORCH_DRIVER_FAKE_RESULT: "1" };

  const out = await runOrch(["new", "add a rate limiter", "--worktree", worktree, "--mr", "new-x", "--yes"], env);
  expect(out.exitCode).toBe(1);
  const payload = JSON.parse(out.stdout) as {
    new: string;
    state: string;
    plan_runs: string[];
    exec_run: string;
    exec_verdict: string;
    workers: { total: number };
  };
  expect(payload).toMatchObject({ new: "new-x", state: "needs_attention", exec_verdict: "completed", workers: { total: 0 } });
  expect(payload.plan_runs).toHaveLength(1);
  expect(payload.plan_runs[0]).toContain("plan-");
  expect(payload.exec_run).toContain("exec-");

  const runsDir = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", "new-x", "runs");
  const planSpec = JSON.parse(readFileSync(join(runsDir, payload.plan_runs[0]!, "spec.json"), "utf8")) as RunSpec;
  expect(planSpec).toMatchObject({ role: "researcher", agent: "claude", model: "fable", provider_session_mode: "fresh_persistent" });
  expect(planSpec.task_text).toContain("## Destination");
  expect(planSpec.task_text).toContain("## Later (not yet specified)");
  const execSpec = JSON.parse(readFileSync(join(runsDir, payload.exec_run, "spec.json"), "utf8")) as RunSpec;
  expect(execSpec).toMatchObject({ role: "controller", agent: "claude", model: "fable", provider_session_mode: "resume_exact" });
  // The exec controller resumes the plan session and is taught the inline-task dispatch pattern.
  expect(execSpec.provider_session_id).toBe(planSpec.provider_session_id ?? execSpec.provider_session_id);
  expect(execSpec.task_text).toContain("--task - <<'EOF'");
  expect(execSpec.task_text).toContain("orch wait --thread new-x");
  expect(execSpec.task_text).toContain("--tag");
  expect(execSpec.task_text).toContain("## Tasks (now)");
}, 30_000);

test("orch new --yes refuses an invalid plan before controller dispatch", async () => {
  const root = tempDir();
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const out = await runOrch(
    ["new", "add a cache", "--worktree", worktree, "--mr", "invalid-plan", "--yes"],
    {
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: configHome,
      ORCH_DRIVER_FAKE_RESULT: "1",
      ORCH_DRIVER_FAKE_RESEARCH_RECOMMENDATION: "not a plan",
    },
  );
  expect(out.exitCode).toBe(1);
  expect(out.stderr).toContain("invalid orch new plan");
  const runsDir = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", "invalid-plan", "runs");
  expect(readdirSync(runsDir).filter((entry) => entry.startsWith("exec-"))).toHaveLength(0);
}, 30_000);

test("orch new --yes resolves recommended defaults into the sole exec plan", async () => {
  const root = tempDir();
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const out = await runOrch(
    ["new", "add a cache", "--worktree", worktree, "--mr", "resolved-default", "--yes"],
    {
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: configHome,
      ORCH_DRIVER_FAKE_RESULT: "1",
      ORCH_DRIVER_FAKE_RESEARCH_RECOMMENDATION: initialPlan,
      ORCH_DRIVER_FAKE_RESEARCH_OPEN_QUESTIONS: JSON.stringify(["Which policy? — recommended: LRU"]),
      ORCH_DRIVER_FAKE_RESEARCH_REVISION_RECOMMENDATION: resolvedPlan,
      ORCH_DRIVER_FAKE_RESEARCH_REVISION_OPEN_QUESTIONS: "[]",
    },
  );
  expect(out.exitCode).toBe(1); // fake controller dispatches no worker; persisted-state gate rejects completion
  const payload = JSON.parse(out.stdout) as { plan_runs: string[]; exec_run: string };
  expect(payload.plan_runs).toHaveLength(2);
  const runsDir = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", "resolved-default", "runs");
  const execSpec = JSON.parse(readFileSync(join(runsDir, payload.exec_run, "spec.json"), "utf8")) as RunSpec;
  expect(execSpec.task_text).toContain("LRU cache policy");
  expect(execSpec.task_text).not.toContain("Which policy?");
  expect(execSpec.task_text).not.toContain("Human clarifications");
}, 30_000);

test("orch new --yes refuses blocking questions", async () => {
  const root = tempDir();
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initRepo(worktree, "git@github.com:example/repo.git");
  const out = await runOrch(
    ["new", "deploy production", "--worktree", worktree, "--mr", "blocking-plan", "--yes"],
    {
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      ORCH_DRIVER_FAKE_RESULT: "1",
      ORCH_DRIVER_FAKE_RESEARCH_RECOMMENDATION: initialPlan,
      ORCH_DRIVER_FAKE_RESEARCH_OPEN_QUESTIONS: JSON.stringify(["Which production account? — blocking: no safe default"]),
    },
  );
  expect(out.exitCode).toBe(1);
  expect(out.stderr).toContain("cannot answer blocking plan questions");
}, 30_000);

test("orch new without a TTY requires --yes", async () => {
  const root = tempDir();
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initRepo(worktree, "git@github.com:example/repo.git");
  const out = await runOrch(
    ["new", "do something", "--worktree", worktree],
    { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") },
    "",
  );
  expect(out.exitCode).not.toBe(0);
  expect(out.stderr).toContain("interactive");
});

test("run create --task - reads the task text from stdin", async () => {
  const root = tempDir();
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initRepo(worktree, "git@github.com:example/repo.git");
  const env = { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
  const taskText = "inline task body\nwith a second line\n";

  const dry = await runOrch(
    ["run", "create", "--mr", "77", "--role", "implementer", "--agent", "codex", "--worktree", worktree, "--task", "-", "--dry-run", "--json"],
    env,
    taskText,
  );
  expect(dry.exitCode).toBe(0);
  const payload = JSON.parse(dry.stdout) as { task_sha: string; task_path: string | null };
  expect(payload.task_sha).toBe(sha256(taskText));
  expect(payload.task_path).toBeNull();

  const empty = await runOrch(
    ["run", "create", "--mr", "77", "--role", "implementer", "--agent", "codex", "--worktree", worktree, "--task", "-", "--dry-run"],
    env,
    "   ",
  );
  expect(empty.exitCode).not.toBe(0);
  expect(empty.stderr).toContain("--task - received empty stdin");
});

test("run create falls back to config.json defaults.agents when --agent is omitted", async () => {
  const root = tempDir();
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initRepo(worktree, "git@github.com:example/repo.git");
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "orch"), { recursive: true });
  writeFileSync(
    join(configHome, "orch", "config.json"),
    JSON.stringify({ version: 1, workspaces: {}, defaults: { agents: { implementer: "pi" } } }),
  );
  const env = { XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: configHome };

  const dry = await runOrch(
    ["run", "create", "--mr", "88", "--role", "implementer", "--worktree", worktree, "--dry-run", "--json"],
    env,
  );
  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ agent: "pi" });

  // Explicit --agent still wins over the configured default.
  const explicit = await runOrch(
    ["run", "create", "--mr", "88", "--role", "implementer", "--agent", "codex", "--worktree", worktree, "--dry-run", "--json"],
    env,
  );
  expect(JSON.parse(explicit.stdout)).toMatchObject({ agent: "codex" });

  // A role without a configured default keeps the required-flag error.
  const missing = await runOrch(
    ["run", "create", "--mr", "88", "--role", "reviewer", "--worktree", worktree, "--dry-run"],
    env,
  );
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr).toContain("missing --agent");
});
