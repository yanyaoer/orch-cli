import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKeyFromRemote } from "./paths.ts";

// Accounts step 1 end-to-end through the CLI: `run create --account`, the
// spec/status snapshot, dry-run payload, and the run list column. The golden
// case pins that a config WITHOUT `accounts` behaves exactly as before.

const fixturesRoot = join(import.meta.dir, "..", "fixtures", "accounts");
const update = process.env.UPDATE_FIXTURES === "1";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orch-accounts-")));
  tempDirs.push(dir);
  return dir;
}

async function runOrch(args: string[], env: Record<string, string>, stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function runCmd(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${args.join(" ")} failed`);
}

interface Fixture {
  root: string;
  home: string;
  worktree: string;
  configPath: string;
  env: Record<string, string>;
  runsDir: string;
}

async function fixture(config: Record<string, unknown>): Promise<Fixture> {
  const root = tempDir();
  const home = join(root, "home");
  const worktree = join(root, "worktree");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const remote = "git@github.com:example/accounts.git";
  await runCmd(["git", "init", "-q"], worktree);
  await runCmd(["git", "remote", "add", "origin", remote], worktree);
  await runCmd(["git", "-c", "user.email=orch@example.com", "-c", "user.name=orch", "commit", "-q", "--allow-empty", "-m", "init"], worktree);
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "orch"), { recursive: true });
  const configPath = join(configHome, "orch", "config.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, workspaces: {}, ...config }));
  const stateHome = join(root, "state");
  return {
    root,
    home,
    worktree,
    configPath,
    env: { HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, CLAUDE_CONFIG_DIR: "/inherited/claude", CODEX_HOME: "/inherited/codex" },
    runsDir: join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", "42", "runs"),
  };
}

const createArgs = (worktree: string, extra: string[]) => ["run", "create", "--mr", "42", "--role", "implementer", "--worktree", worktree, "--task", "-", "--json", ...extra];

// Strip everything that legitimately varies between two invocations (temp
// paths, run ids, commit ids, the host temp dir) so the rest is byte-compared.
function normalizeDryRun(stdout: string, fx: Fixture): string {
  const payload = JSON.parse(stdout) as { base_sha: string; run_id: string; provider_plan: { sandbox_profile_sha256: string | null } };
  let text = stdout;
  const replacements: Array<[string, string]> = [
    [payload.run_id, "<run_id>"],
    [payload.base_sha, "<head>"],
    [fx.root, "<root>"],
    [process.execPath, "<bun>"],
    [process.cwd(), "<cwd>"],
    [realpathSync(tmpdir()), "<tmp>"],
  ];
  if (payload.provider_plan.sandbox_profile_sha256) replacements.push([payload.provider_plan.sandbox_profile_sha256, "<profile_sha256>"]);
  for (const [from, to] of replacements) text = text.split(from).join(to);
  // The lock file name hashes the absolute worktree path.
  return text.replace(/worktree-locks\/[0-9a-f]{64}\.lock/g, "worktree-locks/<lock>.lock");
}

function golden(name: string, actual: string): void {
  const path = join(fixturesRoot, name);
  if (update || !existsSync(path)) {
    mkdirSync(fixturesRoot, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

test("golden: no accounts configured → run create --dry-run --json is unchanged", async () => {
  const fx = await fixture({});
  const dry = await runOrch(createArgs(fx.worktree, ["--agent", "claude", "--dry-run"]), fx.env, "golden task\n");
  expect(dry.stderr).toBe("");
  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).not.toHaveProperty("account");
  golden("dry-run-no-accounts.json", normalizeDryRun(dry.stdout, fx));
});

test.skipIf(process.platform !== "darwin")("golden: no accounts + sandbox → seatbelt-v1 plan is unchanged", async () => {
  const fx = await fixture({ sandbox: true });
  const dry = await runOrch(createArgs(fx.worktree, ["--agent", "claude", "--dry-run"]), fx.env, "golden task\n");
  expect(dry.stderr).toBe("");
  expect(dry.exitCode).toBe(0);
  golden("dry-run-no-accounts-sandbox.json", normalizeDryRun(dry.stdout, fx));
});

async function accountFixture(extra: Record<string, unknown> = {}) {
  const pre = tempDir();
  const work = join(pre, "claude-work");
  const codexB = join(pre, "codex-b");
  mkdirSync(work);
  mkdirSync(codexB);
  const fx = await fixture({
    accounts: [
      { id: "claude-work", provider: "claude", env: { CLAUDE_CONFIG_DIR: work }, max_concurrent: 3, models: ["opus"] },
      { id: "codex-b", provider: "codex", env: { CODEX_HOME: codexB } },
    ],
    ...extra,
  });
  return { ...fx, work, codexB };
}

async function waitForTerminal(statusPath: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as { state: string };
      if (["done", "failed", "timeout", "cancelled"].includes(status.state)) return status;
    }
    await Bun.sleep(100);
  }
  throw new Error(`run did not reach a terminal state: ${statusPath}`);
}

test("run create --account: dry-run shows the account (never env), the account decides the agent", async () => {
  const fx = await accountFixture();
  const dry = await runOrch(createArgs(fx.worktree, ["--account", "codex-b", "--dry-run"]), fx.env, "task\n");
  expect(dry.exitCode).toBe(0);
  const payload = JSON.parse(dry.stdout) as Record<string, unknown> & { idempotency_key: string };
  expect(payload.agent).toBe("codex");
  expect(payload.account).toEqual({ id: "codex-b", provider: "codex" });
  expect(payload.idempotency_key).toEndWith(":account-codex-b");
  expect(dry.stdout).not.toContain(fx.codexB);
  expect(dry.stdout).not.toContain("CODEX_HOME");

  const text = await runOrch(createArgs(fx.worktree, ["--account", "claude-work", "--agent", "claude", "--dry-run"]).filter((a) => a !== "--json"), fx.env, "task\n");
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("account: claude-work (claude)");
  expect(text.stdout).not.toContain(fx.work);

  // The account wins over defaults.agents when --agent is omitted.
  const withDefaults = await accountFixture({ defaults: { agents: { implementer: "pi" } } });
  const picked = await runOrch(createArgs(withDefaults.worktree, ["--account", "claude-work", "--dry-run"]), withDefaults.env, "task\n");
  expect(JSON.parse(picked.stdout).agent).toBe("claude");
});

test("run create --account: unknown id and provider mismatch exit 1", async () => {
  const fx = await accountFixture();
  const unknown = await runOrch(createArgs(fx.worktree, ["--account", "nope", "--dry-run"]), fx.env, "task\n");
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain('unknown account "nope"; configured: claude-work, codex-b');
  const mismatch = await runOrch(createArgs(fx.worktree, ["--account", "claude-work", "--agent", "codex", "--dry-run"]), fx.env, "task\n");
  expect(mismatch.exitCode).toBe(1);
  expect(mismatch.stderr).toContain("--account claude-work is a claude account but the run's agent is codex");
  const none = await fixture({});
  const unconfigured = await runOrch(createArgs(none.worktree, ["--account", "x", "--agent", "claude", "--dry-run"]), none.env, "task\n");
  expect(unconfigured.exitCode).toBe(1);
  expect(unconfigured.stderr).toContain("configured: none (add accounts[] to config.json)");
});

test.skipIf(process.platform !== "darwin")("run create --account under sandbox: seatbelt-v2 with the account dir granted", async () => {
  const fx = await accountFixture({ sandbox: true });
  const dry = await runOrch(createArgs(fx.worktree, ["--account", "claude-work", "--dry-run"]), fx.env, "task\n");
  expect(dry.stderr).toBe("");
  expect(dry.exitCode).toBe(0);
  const payload = JSON.parse(dry.stdout) as { idempotency_key: string; provider_plan: { sandbox_engine: string; argv: string[] } };
  expect(payload.provider_plan.sandbox_engine).toBe("seatbelt-v2");
  expect(payload.idempotency_key).toContain(":sandbox-seatbelt-v2:account-claude-work");
  expect(payload.provider_plan.argv[2]).toContain(`(subpath "${fx.work}")`);
  expect(payload.provider_plan.argv[2]).not.toContain(".claude.json");
});

test("run create --account: spec/status snapshot, provider env, run list column, trajectory in the account dir", async () => {
  const fx = await accountFixture();
  const binDir = join(fx.root, "bin");
  const envOut = join(fx.root, "provider-env.txt");
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const result = { schema: "orch.result/implementer/v1", verdict: "completed", summary: "ok", base_sha: "x", head_sha: "x", changed_files: [], tests: [], acceptance: [], risks: [], rollback: "none" };
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "claude"),
    `#!/bin/sh
cat >/dev/null
printf 'CLAUDE_CONFIG_DIR=%s\\nCODEX_HOME=%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" "\${CODEX_HOME-unset}" > ${JSON.stringify(envOut)}
printf '%s\\n' '${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}'
printf '%s\\n' '${JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: JSON.stringify(result) })}'
`,
  );
  Bun.spawnSync(["chmod", "755", join(binDir, "claude")]);
  const env = { ...fx.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

  const created = await runOrch(createArgs(fx.worktree, ["--account", "claude-work"]), env, "account run\n");
  expect(created.exitCode).toBe(0);
  const createdPayload = JSON.parse(created.stdout) as { run_id: string; account: unknown };
  expect(createdPayload.account).toEqual({ id: "claude-work", provider: "claude" });
  const runDir = join(fx.runsDir, createdPayload.run_id);
  const status = await waitForTerminal(join(runDir, "status.json"));
  const spec = JSON.parse(readFileSync(join(runDir, "spec.json"), "utf8")) as { agent: string; account: unknown };
  expect(spec.agent).toBe("claude");
  expect(spec.account).toEqual({ id: "claude-work", provider: "claude", env: { CLAUDE_CONFIG_DIR: fx.work } });
  expect(status.account).toBe("claude-work");
  expect(status.state).toBe("done");
  // The provider saw the account dir, not the inherited ones.
  expect(readFileSync(envOut, "utf8")).toBe(`CLAUDE_CONFIG_DIR=${fx.work}\nCODEX_HOME=unset\n`);

  // A second, account-less run on the same MR inherits the environment.
  const plain = await runOrch(createArgs(fx.worktree, ["--agent", "claude", "--tag", "plain"]), env, "plain run\n");
  expect(plain.exitCode).toBe(0);
  const plainId = (JSON.parse(plain.stdout) as { run_id: string }).run_id;
  const plainStatus = await waitForTerminal(join(fx.runsDir, plainId, "status.json"));
  expect(plainStatus).not.toHaveProperty("account");
  expect(readFileSync(envOut, "utf8")).toBe("CLAUDE_CONFIG_DIR=/inherited/claude\nCODEX_HOME=/inherited/codex\n");

  const table = await runOrch(["run", "list", "--worktree", fx.worktree, "--mr", "42"], env);
  expect(table.exitCode).toBe(0);
  const [header, ...lines] = table.stdout.trim().split("\n");
  expect(header!.split(/\s+/)).toEqual(["run_id", "mr", "role", "agent", "tag", "state", "started_at", "exit_code", "account"]);
  expect(lines.find((line) => line.startsWith(createdPayload.run_id))!.split(/\s+/).at(-1)).toBe("claude-work");
  expect(lines.find((line) => line.startsWith(plainId))!.split(/\s+/).at(-1)).toBe("-");
  const listed = JSON.parse((await runOrch(["run", "list", "--worktree", fx.worktree, "--mr", "42", "--json"], env)).stdout) as Array<{ run_id: string; account: string | null }>;
  expect(Object.fromEntries(listed.map((row) => [row.run_id, row.account]))).toEqual({ [createdPayload.run_id]: "claude-work", [plainId]: null });

  // Trajectory: the account run's session lives under the account dir, the
  // plain run's under HOME/.claude.
  mkdirSync(join(fx.work, "projects", "-wt"), { recursive: true });
  writeFileSync(join(fx.work, "projects", "-wt", `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
  const trajectory = await runOrch(["trajectory", "--run", createdPayload.run_id, "--worktree", fx.worktree], env);
  expect(trajectory.stderr).toBe("");
  expect(trajectory.exitCode).toBe(0);
  expect(JSON.parse(trajectory.stdout).session_path).toBe(join(fx.work, "projects", "-wt", `${sessionId}.jsonl`));
  const plainTrajectory = await runOrch(["trajectory", "--run", plainId, "--worktree", fx.worktree], env);
  expect(plainTrajectory.exitCode).toBe(1);
  expect(plainTrajectory.stderr).toContain(`no claude session file found for id ${sessionId}`);
  mkdirSync(join(fx.home, ".claude", "projects", "-wt"), { recursive: true });
  writeFileSync(join(fx.home, ".claude", "projects", "-wt", `${sessionId}.jsonl`), `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
  const plainFound = await runOrch(["trajectory", "--run", plainId, "--worktree", fx.worktree], env);
  expect(JSON.parse(plainFound.stdout).session_path).toBe(join(fx.home, ".claude", "projects", "-wt", `${sessionId}.jsonl`));
}, 60_000);
