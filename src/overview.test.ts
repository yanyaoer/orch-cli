import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState, RunStatus } from "./types.ts";
import { buildOverview, collectMrRuns, collectRepoKeys, renderArgv, renderOverview } from "./overview.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeStateHome(): string {
  const root = mkdtempSync(join(tmpdir(), "orch-overview-"));
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function status(overrides: Partial<RunStatus> & { run_id: string; mr: string; state: RunState }): RunStatus {
  return {
    role: "reviewer",
    agent: "claude",
    tag: "review-a",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    pid: null,
    pgid: null,
    started_at: "2026-07-03T10:00:00.000Z",
    updated_at: new Date().toISOString(),
    exit_code: null,
    timeout_sec: 3600,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree: "/tmp/wt",
    base_sha: "base",
    head_sha: null,
    ...overrides,
  } as RunStatus;
}

function writeRun(stateHome: string, repoKey: string, mr: string, runStatus: RunStatus, extra?: { verdict?: string; blocking?: number; decided?: boolean }): void {
  const runDir = join(stateHome, "orch", repoKey, "mrs", mr, "runs", runStatus.run_id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "status.json"), JSON.stringify(runStatus), "utf8");
  if (extra?.verdict) {
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify({
        schema: "orch.result/reviewer/v1",
        run_id: runStatus.run_id,
        verdict: extra.verdict,
        reviews_run_id: "impl-a",
        blocking_findings: Array.from({ length: extra.blocking ?? 0 }, (_, i) => ({ id: `b${i}`, severity: "major", file: "x", body: "issue" })),
        non_blocking_findings: [],
        suggested_tests: [],
      }),
      "utf8",
    );
  }
  if (extra?.decided) {
    writeFileSync(join(runDir, "decision.json"), JSON.stringify({ verdict: "accept", run_id: runStatus.run_id, reason: "ok", ts: "2026-07-03T11:00:00.000Z" }), "utf8");
  }
}

const REPO = "local/demo-abcd1234";

function seedMixedMr(stateHome: string): void {
  // done+approve, no decision -> decision accept action
  writeRun(stateHome, REPO, "42", status({ run_id: "r-approve", mr: "42", state: "done", exit_code: 0 }), { verdict: "approve" });
  // running with a live pid -> active
  writeRun(stateHome, REPO, "42", status({ run_id: "r-running", mr: "42", state: "running", pid: process.pid, pgid: process.pid }));
  // done + decided -> settled
  writeRun(stateHome, REPO, "42", status({ run_id: "r-decided", mr: "42", state: "done", exit_code: 0 }), { verdict: "approve", decided: true });
  // running with a dead pid -> stale -> reap action
  writeRun(stateHome, REPO, "42", status({ run_id: "r-stale", mr: "42", state: "running", pid: 999999999, pgid: 999999999 }));
  // pending outbox comment -> mirror_sync action
  const pendingDir = join(stateHome, "orch", REPO, "mrs", "42", "outbox", "pending");
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(join(pendingDir, "c1.json"), "{}", "utf8");
}

test("buildOverview groups active runs and emits runnable actions", () => {
  const stateHome = makeStateHome();
  seedMixedMr(stateHome);

  const overview = buildOverview([REPO], false);
  expect(overview.active.map((run) => run.run_id)).toEqual(["r-running"]);
  expect(overview.settled).toBe(1);
  expect(overview.actions.map((action) => action.kind)).toEqual(["decision", "reap", "mirror_sync"]);

  const decision = overview.actions[0]!;
  expect(decision.argv).toEqual([
    "orch", "decision", "accept", "--run", "r-approve", "--mr", "42", "--reason", "reviewer approve",
  ]);
  expect(overview.actions[1]!.argv).toEqual(["orch", "run", "reap", "--mr", "42"]);
  expect(overview.actions[2]!.argv).toEqual(["orch", "mirror", "sync", "--mr", "42", "--execute"]);

  const rendered = renderOverview(overview);
  expect(rendered).toContain("ACTIVE (1)");
  expect(rendered).toContain("NEEDS ACTION (3)");
  expect(rendered).toContain("orch decision accept --run r-approve --mr 42 --reason 'reviewer approve'");
});

test("blocking findings and bad verdicts flip the suggestion to rework", () => {
  const stateHome = makeStateHome();
  writeRun(stateHome, REPO, "7", status({ run_id: "r-block", mr: "7", state: "done", exit_code: 0 }), { verdict: "request_changes", blocking: 2 });

  const overview = buildOverview([REPO], false);
  expect(overview.actions).toHaveLength(1);
  expect(overview.actions[0]!.argv[2]).toBe("rework");
  expect(overview.actions[0]!.reason).toContain("blocking 2");
});

test("collectRepoKeys finds nested repo keys and skips worktree-locks", () => {
  const stateHome = makeStateHome();
  seedMixedMr(stateHome);
  mkdirSync(join(stateHome, "orch", "github.com", "acme", "app-12345678", "mrs", "9"), { recursive: true });
  mkdirSync(join(stateHome, "orch", "worktree-locks"), { recursive: true });

  expect(collectRepoKeys()).toEqual(["github.com/acme/app-12345678", REPO]);
});

test("renderArgv quotes only what the shell needs", () => {
  expect(renderArgv(["orch", "decision", "accept", "--reason", "reviewer approve"])).toBe(
    "orch decision accept --reason 'reviewer approve'",
  );
  expect(renderArgv(["orch", "status", "--mr", "42"])).toBe("orch status --mr 42");
});

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

test("bare orch, verdict, and wait read the same aggregation end to end", async () => {
  const stateHome = makeStateHome();
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "orch-overview-wt-")));
  cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
  const { repoKeyFromRemote } = await import("./paths.ts");
  const repoKey = repoKeyFromRemote(worktree, worktree);

  writeRun(stateHome, repoKey, "th-1", status({ run_id: "rv-a", mr: "th-1", state: "done", exit_code: 0 }), { verdict: "approve" });
  writeRun(stateHome, repoKey, "th-1", status({ run_id: "rv-b", mr: "th-1", state: "done", exit_code: 0 }), { verdict: "approve", decided: true });

  const env = { XDG_STATE_HOME: stateHome };

  const bare = await runOrch(["--worktree", worktree], env);
  expect(bare).toMatchObject({ exitCode: 0, stderr: "" });
  expect(bare.stdout).toContain("NEEDS ACTION (1)");
  expect(bare.stdout).toContain("orch decision accept --run rv-a --mr th-1");

  const bareJson = await runOrch(["--worktree", worktree, "--json"], env);
  const parsed = JSON.parse(bareJson.stdout) as { actions: Array<{ kind: string; argv: string[] }> };
  expect(parsed.actions[0]!.kind).toBe("decision");
  expect(parsed.actions[0]!.argv[0]).toBe("orch");

  const verdict = await runOrch(["verdict", "--thread", "th-1", "--worktree", worktree], env);
  expect(verdict).toMatchObject({ exitCode: 0, stderr: "" });
  expect(verdict.stdout).toContain("thread th-1: 2/2 terminal");
  expect(verdict.stdout).toContain("suggestion: accept");

  const wait = await runOrch(["wait", "--thread", "th-1", "--worktree", worktree], env);
  expect(wait).toMatchObject({ exitCode: 0, stderr: "" });
  const event = JSON.parse(wait.stdout) as { kind: string; run: { run_id: string }; suggested_argv: string[] };
  expect(event.kind).toBe("run_terminal");
  expect(event.run.run_id).toBe("rv-a");
  expect(event.suggested_argv.slice(0, 3)).toEqual(["orch", "decision", "accept"]);

  // Decide the remaining run; wait must then report the thread settled.
  const runDir = join(stateHome, "orch", repoKey, "mrs", "th-1", "runs", "rv-a");
  writeFileSync(join(runDir, "decision.json"), JSON.stringify({ verdict: "accept", run_id: "rv-a", reason: "ok", ts: "t" }), "utf8");
  const settled = await runOrch(["wait", "--thread", "th-1", "--worktree", worktree], env);
  expect(JSON.parse(settled.stdout)).toEqual({ kind: "settled", thread: "th-1", runs: 2 });
});

test("decision is an atomic ack: a second decision fails and queues nothing", async () => {
  const stateHome = makeStateHome();
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "orch-overview-wt-")));
  cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
  const { repoKeyFromRemote } = await import("./paths.ts");
  const repoKey = repoKeyFromRemote(worktree, worktree);
  writeRun(stateHome, repoKey, "th-2", status({ run_id: "rv-x", mr: "th-2", state: "done", exit_code: 0 }), { verdict: "approve" });
  const env = { XDG_STATE_HOME: stateHome };

  const first = await runOrch(["decision", "accept", "--run", "rv-x", "--mr", "th-2", "--reason", "ok", "--worktree", worktree], env);
  expect(first).toMatchObject({ exitCode: 0, stderr: "" });

  const second = await runOrch(["decision", "rework", "--run", "rv-x", "--mr", "th-2", "--worktree", worktree], env);
  expect(second.exitCode).toBe(1);
  expect(second.stderr).toContain("already decided (accept");

  // The loser queued no second mirror comment and did not overwrite the ack.
  const pendingDir = join(stateHome, "orch", repoKey, "mrs", "th-2", "outbox", "pending");
  expect(readdirSync(pendingDir).filter((file) => file.endsWith(".json"))).toHaveLength(1);
  const decision = JSON.parse(readFileSync(join(stateHome, "orch", repoKey, "mrs", "th-2", "runs", "rv-x", "decision.json"), "utf8")) as { verdict: string };
  expect(decision.verdict).toBe("accept");
});
