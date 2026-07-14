import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKeyFromRemote } from "./paths.ts";
import type { RunSpec, RunStatus } from "./types.ts";

// End-to-end contract of config `sandbox: true` through orch run create:
// spec/dry-run/status snapshots, idempotency isolation, and a real sandboxed
// driver spawn. Everything that touches /usr/bin/sandbox-exec is darwin-only.

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-sandbox-flow-"));
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

interface Fixture {
  home: string;
  worktree: string;
  env: Record<string, string>;
  runsDir: string;
}

// Fake HOME with pi "logged in", isolated orch config/state, sandbox flag as
// requested. Repo identity comes from a real git repo in a temp worktree.
async function fixture(sandbox: boolean, extraEnv: Record<string, string> = {}): Promise<Fixture> {
  const root = tempDir();
  const home = join(root, "home");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  mkdirSync(join(home, ".pi"), { recursive: true });
  await initRepo(worktree, remote);
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "orch"), { recursive: true });
  writeFileSync(join(configHome, "orch", "config.json"), JSON.stringify({ version: 1, workspaces: {}, ...(sandbox ? { sandbox: true } : {}) }));
  const stateHome = join(root, "state");
  return {
    home,
    worktree,
    env: { HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, ...extraEnv },
    runsDir: join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", "42", "runs"),
  };
}

async function waitForTerminal(statusPath: string, timeoutMs = 20_000): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as RunStatus;
      if (["done", "failed", "timeout", "cancelled"].includes(status.state)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`run did not reach a terminal state: ${statusPath}`);
}

const createArgs = (worktree: string, extra: string[] = []) => [
  "run",
  "create",
  "--mr",
  "42",
  "--role",
  "implementer",
  "--agent",
  "pi",
  "--worktree",
  worktree,
  "--task",
  "-",
  "--json",
  ...extra,
];

test.skipIf(process.platform !== "darwin")("dry-run shows the seatbelt plan; spec snapshots sandbox_engine", async () => {
  const fx = await fixture(true);
  const dry = await runOrch(createArgs(fx.worktree, ["--dry-run"]), fx.env, "sandboxed task\n");
  expect(dry.exitCode).toBe(0);
  const payload = JSON.parse(dry.stdout) as {
    provider_plan: {
      argv: string[];
      sandbox_engine: string;
      sandbox_posture: string;
      sandbox_profile_sha256: string;
      provider_native_sandbox: boolean;
    };
  };
  expect(payload.provider_plan.sandbox_engine).toBe("seatbelt-v1");
  expect(payload.provider_plan.sandbox_posture).toBe("project-write");
  expect(payload.provider_plan.sandbox_profile_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(payload.provider_plan.provider_native_sandbox).toBe(false);
  expect(payload.provider_plan.argv[0]).toBe("/usr/bin/sandbox-exec");

  // Text view: profile replaced by its hash; posture line present.
  const text = await runOrch(
    createArgs(fx.worktree, ["--dry-run"]).filter((arg) => arg !== "--json"),
    fx.env,
    "sandboxed task\n",
  );
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("sandbox: seatbelt-v1/project-write");
  expect(text.stdout).toContain("<sbpl sha256=");

  // Sandbox off: same builder reports the native posture.
  const off = await fixture(false);
  const plain = await runOrch(createArgs(off.worktree, ["--dry-run"]), off.env, "plain task\n");
  expect(plain.exitCode).toBe(0);
  const plainPlan = (JSON.parse(plain.stdout) as { provider_plan: { argv: string[]; sandbox_engine: string; provider_native_sandbox: boolean } }).provider_plan;
  expect(plainPlan.sandbox_engine).toBe("none");
  expect(plainPlan.provider_native_sandbox).toBe(false); // pi has no native sandbox
  expect(plainPlan.argv[0]).toBe("pi");
});

test.skipIf(process.platform !== "darwin")("dry-run fails closed when the worktree contains hardlinks", async () => {
  const fx = await fixture(true);
  const root = join(fx.home, "..");
  writeFileSync(join(root, "outside.txt"), "x", "utf8");
  const { linkSync } = await import("node:fs");
  linkSync(join(root, "outside.txt"), join(fx.worktree, "aliased.txt"));
  const dry = await runOrch(createArgs(fx.worktree, ["--dry-run"]), fx.env, "task\n");
  expect(dry.exitCode).not.toBe(0);
  expect(dry.stderr).toContain("hardlink-preflight");
});

test.skipIf(process.platform !== "darwin")("sandboxed and unsandboxed runs never cross-reuse via idempotency", async () => {
  const fx = await fixture(true, { ORCH_DRIVER_FAKE_RESULT: "1" });
  const task = "idempotency probe\n";

  // Default keys: sandbox on → run A.
  const on = await runOrch(createArgs(fx.worktree), fx.env, task);
  expect(on.exitCode).toBe(0);
  const runA = (JSON.parse(on.stdout) as { run_id: string }).run_id;
  await waitForTerminal(join(fx.runsDir, runA, "status.json"));
  const specA = JSON.parse(readFileSync(join(fx.runsDir, runA, "spec.json"), "utf8")) as RunSpec;
  expect(specA.sandbox_engine).toBe("seatbelt-v1");
  const statusA = JSON.parse(readFileSync(join(fx.runsDir, runA, "status.json"), "utf8")) as RunStatus;
  expect(statusA.sandbox_engine).toBe("seatbelt-v1");
  expect(statusA.sandbox_posture).toBe("project-write");

  // Same request again → idempotent hit on A.
  const again = await runOrch(createArgs(fx.worktree), fx.env, task);
  expect((JSON.parse(again.stdout) as { run_id: string; idempotent?: boolean }).run_id).toBe(runA);

  // Flip sandbox off: the default key no longer matches → a new run, and its
  // spec carries no engine.
  writeFileSync(join(fx.env.XDG_CONFIG_HOME!, "orch", "config.json"), JSON.stringify({ version: 1, workspaces: {} }));
  const off = await runOrch(createArgs(fx.worktree), fx.env, task);
  expect(off.exitCode).toBe(0);
  const runB = (JSON.parse(off.stdout) as { run_id: string }).run_id;
  expect(runB).not.toBe(runA);
  await waitForTerminal(join(fx.runsDir, runB, "status.json"));
  const specB = JSON.parse(readFileSync(join(fx.runsDir, runB, "spec.json"), "utf8")) as RunSpec;
  expect(specB.sandbox_engine).toBeUndefined();

  // Explicit key that hits the sandboxed run A from an unsandboxed request →
  // hard error, resolvable only via --retry.
  const clash = await runOrch(createArgs(fx.worktree, ["--idempotency-key", specA.idempotency_key]), fx.env, task);
  expect(clash.exitCode).not.toBe(0);
  expect(clash.stderr).toContain("different sandbox settings");
  const retried = await runOrch(createArgs(fx.worktree, ["--idempotency-key", specA.idempotency_key, "--retry"]), fx.env, task);
  expect(retried.exitCode).toBe(0);
  expect((JSON.parse(retried.stdout) as { run_id: string }).run_id).not.toBe(runA);
});

test.skipIf(process.platform !== "darwin")("a real sandboxed run: driver applies the jail, provider runs inside it, status audits it", async () => {
  const fx = await fixture(true);
  // Fake pi provider on PATH: consumes the prompt on stdin, emits a valid
  // implementer result. It runs INSIDE the driver's Seatbelt wrapper.
  const binDir = join(fx.home, "bin");
  mkdirSync(binDir, { recursive: true });
  const result = {
    schema: "orch.result/implementer/v1",
    run_id: "RUN_ID",
    verdict: "completed",
    summary: "sandboxed fake pi completed",
    base_sha: "BASE",
    head_sha: "BASE",
    changed_files: [],
    tests: [],
    acceptance: [],
    risks: [],
    rollback: "none",
  };
  writeFileSync(
    join(binDir, "pi"),
    `#!/bin/sh
cat >/dev/null
# Prove the jail is live: a write outside the allowed set must fail.
if echo escape > "$HOME/escape.txt" 2>/dev/null; then echo "JAIL_BROKEN" >&2; exit 9; fi
printf '%s\\n' '${JSON.stringify(result)}'
`,
    "utf8",
  );
  chmodSync(join(binDir, "pi"), 0o755);

  const env = { ...fx.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
  const created = await runOrch(createArgs(fx.worktree), env, "real sandboxed run\n");
  expect(created.exitCode).toBe(0);
  const runId = (JSON.parse(created.stdout) as { run_id: string }).run_id;
  const runDir = join(fx.runsDir, runId);
  const status = await waitForTerminal(join(runDir, "status.json"));

  // The provider ran inside the jail (the in-jail escape write failed) and the
  // run completed with a valid result.
  expect(status.state).toBe("done");
  expect(existsSync(join(fx.home, "escape.txt"))).toBe(false);
  const written = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as { verdict: string };
  expect(written.verdict).toBe("completed");

  // Status audits the effective plan recorded by the driver.
  expect(status.sandbox_engine).toBe("seatbelt-v1");
  expect(status.sandbox_posture).toBe("project-write");
  expect(status.sandbox_profile_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(status.provider_native_sandbox).toBe(false);

  // The driver recorded the plan artifact alongside the run.
  const sandboxJson = JSON.parse(readFileSync(join(runDir, "sandbox.json"), "utf8")) as { sandbox_engine: string };
  expect(sandboxJson.sandbox_engine).toBe("seatbelt-v1");

  // The event stream audits the contract too (starting event message).
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  expect(events).toContain("sandbox_engine=seatbelt-v1 sandbox_posture=project-write");
}, 30_000);
