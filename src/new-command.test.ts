import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./hash.ts";
import { repoKeyFromRemote } from "./paths.ts";
import type { RunSpec } from "./types.ts";

const tempDirs: string[] = [];

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

test("orch new --yes plans as researcher then executes as controller in the same session", async () => {
  const root = tempDir();
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome, ORCH_DRIVER_FAKE_RESULT: "1" };

  const out = await runOrch(["new", "add a rate limiter", "--worktree", worktree, "--mr", "new-x", "--yes"], env);
  expect(out.exitCode).toBe(0);
  const payload = JSON.parse(out.stdout) as {
    new: string;
    state: string;
    plan_runs: string[];
    exec_run: string;
    exec_verdict: string;
  };
  expect(payload).toMatchObject({ new: "new-x", state: "completed", exec_verdict: "completed" });
  expect(payload.plan_runs).toHaveLength(1);
  expect(payload.plan_runs[0]).toContain("plan-");
  expect(payload.exec_run).toContain("exec-");

  const runsDir = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", "new-x", "runs");
  const planSpec = JSON.parse(readFileSync(join(runsDir, payload.plan_runs[0]!, "spec.json"), "utf8")) as RunSpec;
  expect(planSpec).toMatchObject({ role: "researcher", agent: "claude", provider_session_mode: "fresh_persistent" });
  expect(planSpec.task_text).toContain("## Destination");
  expect(planSpec.task_text).toContain("## Later (not yet specified)");
  const execSpec = JSON.parse(readFileSync(join(runsDir, payload.exec_run, "spec.json"), "utf8")) as RunSpec;
  expect(execSpec).toMatchObject({ role: "controller", agent: "claude", provider_session_mode: "resume_exact" });
  // The exec controller resumes the plan session and is taught the inline-task dispatch pattern.
  expect(execSpec.provider_session_id).toBe(planSpec.provider_session_id ?? execSpec.provider_session_id);
  expect(execSpec.task_text).toContain("--task - <<'EOF'");
  expect(execSpec.task_text).toContain("orch wait --thread new-x");
  expect(execSpec.task_text).toContain("--tag");
  expect(execSpec.task_text).toContain("## Tasks (now)");
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
