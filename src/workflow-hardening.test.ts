// Regression tests for evidence-bound adjudication: supersession, HEAD
// binding, fail-closed aggregation shared by verdict/decision/sweep, cursor
// wait, and HEAD-aware idempotency. Unit checks go through collectMrRuns +
// assessThread; CLI checks spawn the real orch entry point.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState, RunStatus, VcsSnapshot } from "./types.ts";
import { assessThread, collectMrRuns } from "./overview.ts";
import { repoKeyFromRemote } from "./paths.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(worktree: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", worktree, "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function commit(worktree: string, content: string): VcsSnapshot {
  writeFileSync(join(worktree, "README.md"), content, "utf8");
  git(worktree, "add", "README.md");
  git(worktree, "commit", "-q", "-m", content.trim());
  const head = git(worktree, "rev-parse", "HEAD");
  return { vcs: "git", head, dirty: false, content_sha: head };
}

interface Fixture {
  stateHome: string;
  worktree: string;
  repoKey: string;
  env: Record<string, string>;
}

function fixture(): Fixture {
  const stateHome = tempDir("orch-hardening-state-");
  const worktree = tempDir("orch-hardening-wt-");
  git(worktree, "init", "-q");
  const configHome = tempDir("orch-hardening-config-");
  return { stateHome, worktree, repoKey: repoKeyFromRemote(worktree, worktree), env: { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome } };
}

interface RunInput {
  id: string;
  mr?: string;
  role?: string;
  agent?: string;
  state?: RunState;
  started?: string;
  snapshot?: VcsSnapshot | null;
  supersedes?: string[];
  result?: Record<string, unknown> | null;
  decision?: string;
  pid?: number | null;
}

function reviewResult(id: string, verdict: "approve" | "request_changes", blocking = verdict === "approve" ? 0 : 1) {
  return {
    schema: "orch.result/reviewer/v1",
    run_id: id,
    verdict,
    reviews_run_id: "",
    blocking_findings: Array.from({ length: blocking }, (_, i) => ({ id: `B${i}`, severity: "high", file: "a.ts:1", body: "broken" })),
    non_blocking_findings: [],
    suggested_tests: [],
  };
}

function writeRun(fx: Fixture, input: RunInput): string {
  const mr = input.mr ?? "mr-1";
  const runDir = join(fx.stateHome, "orch", fx.repoKey, "mrs", mr, "runs", input.id);
  mkdirSync(runDir, { recursive: true });
  const role = input.role ?? "reviewer";
  writeFileSync(join(runDir, "spec.json"), JSON.stringify({ run_id: input.id, mr, role, tag: input.id, ...(input.supersedes ? { supersedes: input.supersedes } : {}) }));
  const snapshot = input.snapshot === undefined ? null : input.snapshot;
  const status: Partial<RunStatus> = {
    run_id: input.id,
    mr,
    role: role as RunStatus["role"],
    agent: (input.agent ?? "claude") as RunStatus["agent"],
    tag: input.id,
    state: input.state ?? "done",
    pid: input.pid ?? null,
    pgid: input.pid ?? null,
    started_at: input.started ?? "2026-10-13T00:00:00.000Z",
    updated_at: new Date().toISOString(),
    exit_code: 0,
    worktree: fx.worktree,
    base_sha: snapshot?.head ?? "base",
    head_sha: null,
    ...(snapshot ? { start_snapshot: snapshot, end_snapshot: snapshot, snapshot_error: null } : {}),
  };
  writeFileSync(join(runDir, "status.json"), JSON.stringify(status));
  const result = input.result === undefined ? (role === "reviewer" ? reviewResult(input.id, "approve") : null) : input.result;
  if (result) writeFileSync(join(runDir, "result.json"), JSON.stringify(result));
  if (input.decision) writeFileSync(join(runDir, "decision.json"), JSON.stringify({ verdict: input.decision, run_id: input.id, reason: "t", ts: "t" }));
  return runDir;
}

async function runOrch(fx: Fixture, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...fx.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const candidateFor = (snapshot: VcsSnapshot) => ({ candidate: { source: "worktree" as const, snapshot }, error: null });

function withState<T>(fx: Fixture, fn: () => T): T {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = fx.stateHome;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
}

test("a superseded blocker leaves the aggregate; an independent reviewer's blocker stays", () => {
  const fx = fixture();
  const a = commit(fx.worktree, "v1\n");
  const b = commit(fx.worktree, "v2\n");
  writeRun(fx, { id: "review-1", snapshot: a, started: "2026-10-13T01:00:00Z", result: reviewResult("review-1", "request_changes"), decision: "rework" });
  writeRun(fx, { id: "review-2", snapshot: b, started: "2026-10-13T02:00:00Z", supersedes: ["review-1"], decision: "accept" });

  const settled = withState(fx, () => collectMrRuns(fx.repoKey, "mr-1"));
  expect(settled.find((run) => run.run_id === "review-1")!.superseded_by).toBe("review-2");
  const verdict = assessThread(settled, candidateFor(b));
  expect(verdict.suggestion).toBe("accept");
  expect(verdict.assessments.get("review-1")).toEqual({ outcome: "close", reason: "superseded by review-2" });

  // A second, independent reviewer blocks the same head; a later approve from
  // the first reviewer does not override it.
  writeRun(fx, { id: "review-codex", agent: "codex", snapshot: b, started: "2026-10-13T02:30:00Z", result: reviewResult("review-codex", "request_changes") });
  writeRun(fx, { id: "review-3", snapshot: b, started: "2026-10-13T03:00:00Z", supersedes: ["review-2"] });
  const blocked = assessThread(withState(fx, () => collectMrRuns(fx.repoKey, "mr-1")), candidateFor(b));
  expect(blocked.suggestion).toBe("rework");
  expect(blocked.reasons).toEqual(["review-codex: reviewer request_changes · blocking 1"]);
});

test("a supersede only takes effect once the replacement is done", () => {
  const fx = fixture();
  const a = commit(fx.worktree, "v1\n");
  writeRun(fx, { id: "review-1", snapshot: a, result: reviewResult("review-1", "request_changes") });
  writeRun(fx, { id: "review-2", snapshot: a, state: "failed", supersedes: ["review-1"], started: "2026-10-13T02:00:00Z" });
  const runs = withState(fx, () => collectMrRuns(fx.repoKey, "mr-1"));
  expect(runs.find((run) => run.run_id === "review-1")!.superseded_by).toBeNull();
  const verdict = assessThread(runs, candidateFor(a));
  // The failed replacement surfaces (inspect outranks rework); the blocker stays.
  expect(verdict.suggestion).toBe("inspect");
  expect(verdict.assessments.get("review-1")!.outcome).toBe("rework");
});

test("evidence for another head, legacy runs, contradictory and failed results never accept", () => {
  const fx = fixture();
  const a = commit(fx.worktree, "v1\n");
  const b = commit(fx.worktree, "v2\n");
  const judge = (input: RunInput) => {
    rmSync(join(fx.stateHome, "orch"), { recursive: true, force: true });
    writeRun(fx, input);
    return assessThread(withState(fx, () => collectMrRuns(fx.repoKey, "mr-1")), candidateFor(b));
  };
  expect(judge({ id: "r", snapshot: b }).suggestion).toBe("accept");
  const stale = judge({ id: "r", snapshot: a });
  expect(stale.suggestion).toBe("inspect");
  expect(stale.reasons[0]).toContain(`evidence is for ${a.head.slice(0, 12)}`);
  expect(judge({ id: "r", snapshot: null }).reasons[0]).toContain("no orch-captured start/end snapshot");
  // Dirty content on the same head is a different candidate.
  expect(judge({ id: "r", snapshot: { ...b, dirty: true, content_sha: "sha256:x" } }).suggestion).toBe("inspect");
  for (const state of ["failed", "timeout", "cancelled", "stale"] as const) expect(judge({ id: "r", snapshot: b, state }).suggestion).toBe("inspect");
  // v0.0.13 accepted this verifier result; the aggregate re-validates it.
  const contradictory = judge({
    id: "v",
    role: "verifier",
    snapshot: b,
    result: { schema: "orch.result/verifier/v1", run_id: "v", verdict: "pass", verifies_run_id: "", commands: [{ cmd: "bun test", exit_code: 1, summary: "1 fail" }], acceptance: [{ id: "AC1", status: "unmet" }] },
  });
  expect(contradictory.suggestion).toBe("inspect");
  expect(contradictory.reasons[0]).toContain("verdict pass contradicts commands[0]");
  expect(judge({ id: "r", snapshot: b, result: null }).suggestion).toBe("inspect");
  // An unknown candidate (no checkout) is not proof either.
  rmSync(join(fx.stateHome, "orch"), { recursive: true, force: true });
  writeRun(fx, { id: "r", snapshot: b });
  expect(assessThread(withState(fx, () => collectMrRuns(fx.repoKey, "mr-1")), { candidate: null, error: "x" }).suggestion).toBe("inspect");
  // Every run superseded: nothing in force, nothing to accept.
  rmSync(join(fx.stateHome, "orch"), { recursive: true, force: true });
  writeRun(fx, { id: "r", snapshot: b, result: reviewResult("r", "request_changes") });
  writeRun(fx, { id: "r2", snapshot: b, state: "failed", supersedes: ["r"], started: "2026-10-13T02:00:00Z" });
  expect(assessThread(withState(fx, () => collectMrRuns(fx.repoKey, "mr-1")), candidateFor(b)).suggestion).toBe("inspect");
});

test("close stays a pure ack: it never clears a blocker or a failed run from the aggregate", () => {
  const fx = fixture();
  const b = commit(fx.worktree, "v1\n");
  writeRun(fx, { id: "review-block", snapshot: b, result: reviewResult("review-block", "request_changes"), decision: "close" });
  writeRun(fx, { id: "review-ok", agent: "codex", snapshot: b, started: "2026-10-13T02:00:00Z" });
  const blocked = assessThread(withState(fx, () => collectMrRuns(fx.repoKey, "mr-1")), candidateFor(b));
  expect(blocked.suggestion).toBe("rework");
  expect(blocked.reasons).toEqual(["review-block: reviewer request_changes · blocking 1"]);
  writeRun(fx, { id: "review-failed", snapshot: b, state: "failed", decision: "close", started: "2026-10-13T03:00:00Z" });
  rmSync(join(fx.stateHome, "orch", fx.repoKey, "mrs", "mr-1", "runs", "review-block"), { recursive: true, force: true });
  expect(assessThread(withState(fx, () => collectMrRuns(fx.repoKey, "mr-1")), candidateFor(b)).suggestion).toBe("inspect");
  // Only an explicit, successful supersede retires the failed run.
  writeRun(fx, { id: "review-redo", snapshot: b, supersedes: ["review-failed"], started: "2026-10-13T04:00:00Z" });
  expect(assessThread(withState(fx, () => collectMrRuns(fx.repoKey, "mr-1")), candidateFor(b)).suggestion).toBe("accept");
});

test("verdict, decision accept, and sweep share the HEAD-bound rubric end to end", async () => {
  const fx = fixture();
  const a = commit(fx.worktree, "v1\n");
  writeRun(fx, { id: "review-old", snapshot: a, started: "2026-10-13T01:00:00Z", result: reviewResult("review-old", "request_changes"), decision: "rework" });
  writeRun(fx, { id: "review-a", snapshot: a, started: "2026-10-13T02:00:00Z", supersedes: ["review-old"] });

  // Repro: every run decided, the final review approves -> accept, not rework.
  const before = JSON.parse((await runOrch(fx, ["verdict", "--thread", "mr-1", "--worktree", fx.worktree, "--json"])).stdout);
  expect(before.suggestion).toBe("accept");

  // The candidate moves on: the old approve is no longer proof.
  const b = commit(fx.worktree, "v2\n");
  const after = JSON.parse((await runOrch(fx, ["verdict", "--thread", "mr-1", "--worktree", fx.worktree, "--json"])).stdout);
  expect(after.suggestion).toBe("inspect");
  expect(after.candidate.label).toBe(b.head.slice(0, 12));
  const refused = await runOrch(fx, ["decision", "accept", "--run", "review-a", "--mr", "mr-1", "--worktree", fx.worktree]);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("refusing to accept review-a");
  expect(existsSync(join(fx.stateHome, "orch", fx.repoKey, "mrs", "mr-1", "runs", "review-a", "decision.json"))).toBe(false);
  // Sweep follows the same rule: the unbound approve is left for a human.
  const sweep = JSON.parse((await runOrch(fx, ["decision", "sweep", "--mr", "mr-1", "--worktree", fx.worktree])).stdout);
  expect(sweep.planned).toEqual([]);
  expect(sweep.manual.map((item: { run_id: string }) => item.run_id)).toEqual(["review-a"]);

  // Explicitly pinning the reviewed commit is the escape hatch, and it is exact.
  const pinned = JSON.parse((await runOrch(fx, ["verdict", "--thread", "mr-1", "--worktree", fx.worktree, "--head", a.head, "--json"])).stdout);
  expect(pinned.suggestion).toBe("accept");
  expect(pinned.actions[0].argv).toContain("--head");
  const accepted = await runOrch(fx, ["decision", "accept", "--run", "review-a", "--mr", "mr-1", "--worktree", fx.worktree, "--head", a.head]);
  expect(accepted).toMatchObject({ exitCode: 0, stderr: "" });
  const badHead = await runOrch(fx, ["verdict", "--thread", "mr-1", "--worktree", fx.worktree, "--head", "no-such-rev", "--json"]);
  expect(JSON.parse(badHead.stdout).suggestion).toBe("inspect");
});

test("wait --cursor reports each terminal run once, decided or not, and validates cursors", async () => {
  const fx = fixture();
  const a = commit(fx.worktree, "v1\n");
  writeRun(fx, { id: "impl-1", role: "implementer", snapshot: a, started: "2026-10-13T01:00:00Z", result: null });
  writeRun(fx, { id: "review-1", snapshot: a, started: "2026-10-13T02:00:00Z" });
  writeRun(fx, { id: "review-2", snapshot: a, state: "running", pid: process.pid, started: "2026-10-13T03:00:00Z" });
  const wait = async (cursor: string, extra: string[] = []) =>
    runOrch(fx, ["wait", "--thread", "mr-1", "--worktree", fx.worktree, "--cursor", cursor, "--timeout-sec", "0", ...extra]);

  const first = JSON.parse((await wait("start")).stdout);
  expect(first).toMatchObject({ kind: "run_terminal", run: { run_id: "impl-1" } });
  const second = JSON.parse((await wait(first.cursor)).stdout);
  expect(second).toMatchObject({ kind: "run_terminal", run: { run_id: "review-1" } });
  // impl-1 is still undecided (waiting on review) yet is not returned again;
  // review-2 is still running, so the cursor wait times out.
  const pending = await wait(second.cursor);
  expect(pending.exitCode).toBe(1);
  expect(pending.stderr).toContain("no run reached a terminal state within 0s");

  // Legacy mode (no cursor) keeps the decision-as-ack behaviour.
  const legacy = JSON.parse((await runOrch(fx, ["wait", "--thread", "mr-1", "--worktree", fx.worktree, "--timeout-sec", "0"])).stdout);
  expect(legacy).toMatchObject({ kind: "run_terminal", run: { run_id: "impl-1" } });

  // The running run finishes and a new run is dispatched and finishes too.
  writeRun(fx, { id: "review-2", snapshot: a, started: "2026-10-13T03:00:00Z" });
  writeRun(fx, { id: "review-3", snapshot: a, started: "2026-10-13T04:00:00Z" });
  const third = JSON.parse((await wait(second.cursor)).stdout);
  expect(third.run.run_id).toBe("review-2");
  const fourth = JSON.parse((await wait(third.cursor)).stdout);
  expect(fourth.run.run_id).toBe("review-3");
  expect(JSON.parse((await wait(fourth.cursor)).stdout)).toMatchObject({ kind: "settled", runs: 4 });

  // A dead supervisor surfaces once as stale, then is consumed.
  writeRun(fx, { id: "review-4", snapshot: a, state: "running", pid: 999_999_999, started: "2026-10-13T05:00:00Z" });
  const stale = JSON.parse((await wait(fourth.cursor)).stdout);
  expect(stale).toMatchObject({ kind: "stale", run: { run_id: "review-4" }, suggested_argv: ["orch", "run", "reap", "--mr", "mr-1"] });
  expect((await wait(stale.cursor)).exitCode).toBe(1);

  // `now` skips everything already terminal.
  expect((await wait("now")).exitCode).toBe(1);

  for (const bad of ["garbage", "c1.!!!", `c1.${Buffer.from(JSON.stringify({ t: "other", s: [] })).toString("base64url")}`]) {
    const out = await wait(bad);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("invalid --cursor");
  }
});

test("run create binds idempotency to the actual HEAD and refuses incompatible reuse", async () => {
  const fx = fixture();
  const a = commit(fx.worktree, "v1\n");
  const taskPath = join(tempDir("orch-hardening-task-"), "task.md");
  writeFileSync(taskPath, "review it\n", "utf8");
  const create = (extra: string[]) =>
    runOrch(fx, ["run", "create", "--mr", "mr-1", "--role", "reviewer", "--agent", "codex", "--tag", "rv", "--worktree", fx.worktree, "--task", taskPath, "--dry-run", "--json", ...extra]);

  const atA = JSON.parse((await create([])).stdout);
  expect(atA.idempotency_key).toContain(`:head-${a.head}`);
  expect(atA.snapshot).toEqual(a);
  const b = commit(fx.worktree, "v2\n");
  const atB = JSON.parse((await create([])).stdout);
  expect(atB.idempotency_key).not.toBe(atA.idempotency_key);

  // Same explicit key, existing run bound to the old HEAD: refused.
  const mrDir = join(fx.stateHome, "orch", fx.repoKey, "mrs", "mr-1");
  const runDir = writeRun(fx, { id: "rv-old", snapshot: a });
  writeFileSync(join(runDir, "spec.json"), JSON.stringify({ run_id: "rv-old", mr: "mr-1", role: "reviewer", agent: "codex", provider_session_mode: "fresh_persistent", provider_session_name: null, provider_session_id: null, model: null, snapshot: a }));
  writeFileSync(
    join(mrDir, "idempotency.json"),
    JSON.stringify({ k: { run_id: "rv-old", run_dir: runDir, status_path: join(runDir, "status.json"), result_path: join(runDir, "result.json"), created_at: "t" } }),
  );
  const reuse = await create(["--idempotency-key", "k"]);
  expect(reuse.exitCode).toBe(1);
  expect(reuse.stderr).toContain("idempotent run already exists for a different worktree snapshot");
  // Runs created before snapshot binding have no snapshot and are never reusable as proof.
  writeFileSync(join(runDir, "spec.json"), JSON.stringify({ run_id: "rv-old", mr: "mr-1", role: "reviewer", agent: "codex", provider_session_mode: "fresh_persistent" }));
  expect((await create(["--idempotency-key", "k"])).stderr).toContain("no recorded worktree snapshot");
  // --retry dispatches anew and records the replaced run as superseded.
  expect(JSON.parse((await create(["--idempotency-key", "k", "--retry"])).stdout)).toMatchObject({ idempotent: false, supersedes: ["rv-old"] });

  // --head must match the checkout, and a pinned review needs it clean.
  expect((await create(["--head", a.head])).stderr).toContain(`is ${a.head.slice(0, 12)} but the worktree is at ${b.head.slice(0, 12)}`);
  expect(JSON.parse((await create(["--head", "HEAD"])).stdout).pinned_head).toBe(b.head);
  writeFileSync(join(fx.worktree, "README.md"), "dirty\n", "utf8");
  expect((await create(["--head", "HEAD"])).stderr).toContain("needs a clean checkout");
  const dirty = JSON.parse((await create([])).stdout);
  expect(dirty.idempotency_key).toContain(":content-");

  // --supersedes accepts only same-role runs of this MR.
  writeRun(fx, { id: "impl-1", role: "implementer", snapshot: a, result: null });
  expect((await create(["--supersedes", "impl-1"])).stderr).toContain("a reviewer run can only supersede reviewer runs");
  expect((await create(["--supersedes", "nope"])).stderr).toContain("no such run");
  expect(JSON.parse((await create(["--supersedes", "rv-old"])).stdout).supersedes).toEqual(["rv-old"]);
});

test("result --wait and staleness follow the supervisor, not the provider, through a slow finalization", async () => {
  const fx = fixture();
  const head = commit(fx.worktree, "v1\n");
  const { writeInitialRunFiles, runSupervisor } = await import("./supervisor.ts");
  const { looksStale } = await import("./run-store.ts");
  const { isPidAlive } = await import("./locks.ts");
  const runDir = join(fx.stateHome, "orch", fx.repoKey, "mrs", "mr-1", "runs", "impl-slow");
  mkdirSync(runDir, { recursive: true });
  const spec = {
    version: 1 as const, run_id: "impl-slow", mr: "mr-1", role: "implementer" as const, agent: "claude" as const, model: null, tag: "impl-slow",
    provider_session_name: null, provider_session_id: null, provider_session_mode: "fresh_persistent" as const, idempotency_key: "k",
    repo_key: fx.repoKey, worktree: fx.worktree, task_path: null, task_text: "t", task_sha: "s", base_sha: head.head, timeout_sec: 60,
    created_at: "2026-10-13T00:00:00Z", snapshot: head,
  };
  writeFileSync(join(runDir, "spec.json"), JSON.stringify(spec));
  writeInitialRunFiles(runDir, spec);
  // The provider writes its result and exits at once, but leaves a grandchild
  // holding its stdout: the supervisor keeps draining (finalizing) for ~3s
  // after the provider pid is gone — the window v0.0.13 reported as stale.
  const driver = join(tempDir("orch-hardening-driver-"), "slow-driver.js");
  writeFileSync(
    driver,
    String.raw`
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");
const runDir = process.argv[process.argv.indexOf("--run-dir") + 1];
writeFileSync(join(runDir, "result.json"), JSON.stringify({ schema: "orch.result/implementer/v1", run_id: "impl-slow", verdict: "completed", summary: "s", base_sha: "a", head_sha: "a", changed_files: [], tests: [], acceptance: [], risks: [], rollback: "r" }));
spawn("sleep", ["3"], { stdio: "inherit" }).unref();
process.exit(0);
`,
    "utf8",
  );
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = fx.stateHome;
  try {
    const supervised = runSupervisor(runDir, [process.execPath, driver]);
    let window: RunStatus | null = null;
    for (let i = 0; i < 200 && !window; i += 1) {
      await Bun.sleep(25);
      const status = JSON.parse(await Bun.file(join(runDir, "status.json")).text()) as RunStatus;
      if (status.state === "running" && status.pid !== null && !isPidAlive(status.pid)) window = status;
    }
    expect(window).not.toBeNull();
    expect(window!.supervisor_pid).toBe(process.pid);
    expect(looksStale(window!)).toBe(false);
    const waited = await runOrch(fx, ["result", "--run", "impl-slow", "--mr", "mr-1", "--wait", "--wait-sec", "30", "--json", "--worktree", fx.worktree]);
    expect(waited).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(waited.stdout).verdict).toBe("completed");
    expect(await supervised).toBe(0);
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
  // A dead supervisor is still stale even while a provider pid lives on, and
  // legacy statuses (no supervisor_pid) keep the old provider-pid rule.
  const base = { state: "running", pid: process.pid, updated_at: new Date().toISOString() } as RunStatus;
  expect(looksStale({ ...base, supervisor_pid: 999_999_999 })).toBe(true);
  expect(looksStale({ ...base, supervisor_pid: process.pid, pid: 999_999_999 })).toBe(false);
  expect(looksStale({ ...base, pid: 999_999_999 })).toBe(true);
  expect(looksStale(base)).toBe(false);
});

async function orchEnv(fx: Fixture, extra: Record<string, string>, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runOrch({ ...fx, env: { ...fx.env, ...extra } }, args);
}

async function waitStatus(statusPath: string, done: (status: RunStatus) => boolean, ms = 15_000): Promise<RunStatus> {
  const deadline = Date.now() + ms;
  for (;;) {
    const status = existsSync(statusPath) ? (JSON.parse(await Bun.file(statusPath).text()) as RunStatus) : null;
    if (status && done(status)) return status;
    if (Date.now() > deadline) throw new Error(`timed out waiting on ${statusPath}: ${JSON.stringify(status)}`);
    await Bun.sleep(25);
  }
}

test("an inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE cannot rebind run create or dodge the checkout lock", async () => {
  const fx = fixture();
  const target = commit(fx.worktree, "target\n");
  const foreign = tempDir("orch-hardening-foreign-");
  git(foreign, "init", "-q");
  commit(foreign, "foreign\n");
  const polluted = { GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: join(foreign, ".git", "index") };
  const args = ["run", "create", "--mr", "mr-1", "--role", "reviewer", "--agent", "codex", "--tag", "rv", "--worktree", fx.worktree, "--dry-run", "--json"];
  const normal = JSON.parse((await orchEnv(fx, {}, args)).stdout);
  const redirected = await orchEnv(fx, polluted, [...args, "--head", target.head]);
  expect(redirected).toMatchObject({ exitCode: 0 });
  const plan = JSON.parse(redirected.stdout);
  expect(plan.repo.repo_root).toBe(fx.worktree);
  expect(plan.snapshot).toEqual(target);
  expect(plan.worktree_lock).toBe(normal.worktree_lock);

  // A writer started from the polluted environment contends on the target's
  // real lock: held here (normal environment), the run fails with 75.
  const { acquireWorktreeLock } = await import("./locks.ts");
  const { lockPathForWorktree } = await import("./paths.ts");
  const held = withState(fx, () => acquireWorktreeLock(lockPathForWorktree(fx.worktree), "exclusive", "holder"));
  try {
    const created = await orchEnv(fx, { ...polluted, ORCH_DRIVER_FAKE_RESULT: "1" }, ["run", "create", "--mr", "mr-1", "--role", "implementer", "--agent", "claude", "--tag", "impl", "--session-mode", "ephemeral", "--worktree", fx.worktree]);
    expect(created.exitCode).toBe(0);
    const status = await waitStatus(JSON.parse(created.stdout).status_path, (s) => !["created", "starting", "running"].includes(s.state));
    expect(status).toMatchObject({ state: "failed", exit_code: 75 });
  } finally {
    held.release();
  }
}, 30_000);

test("a provider outliving its SIGKILLed supervisor keeps the checkout locked until a verified cancel", async () => {
  const fx = fixture();
  commit(fx.worktree, "v1\n");
  const { isPidAlive, isProcessGroupAlive } = await import("./locks.ts");
  const { runProcessesAlive } = await import("./run-store.ts");
  const create = async (tag: string, extra: Record<string, string>) => {
    const out = await orchEnv(fx, { ORCH_DRIVER_FAKE_RESULT: "1", ...extra }, ["run", "create", "--mr", "mr-1", "--role", "implementer", "--agent", "claude", "--tag", tag, "--session-mode", "ephemeral", "--worktree", fx.worktree]);
    expect(out.exitCode).toBe(0);
    return JSON.parse(out.stdout) as { run_id: string; status_path: string; supervisor_pid: number };
  };
  const a = await create("owner-a", { ORCH_DRIVER_FAKE_SLEEP_MS: "60000" });
  const running = await waitStatus(a.status_path, (s) => s.state === "running" && typeof s.pgid === "number");
  const pgid = running.pgid!;
  cleanups.push(() => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  });
  process.kill(a.supervisor_pid, "SIGKILL");
  for (let i = 0; i < 200 && isPidAlive(a.supervisor_pid); i += 1) await Bun.sleep(10);
  expect(isPidAlive(a.supervisor_pid)).toBe(false);
  expect(isProcessGroupAlive(pgid)).toBe(true);

  // Second writer on the same checkout: refused while the orphan provider lives.
  const b = await create("owner-b", {});
  expect(await waitStatus(b.status_path, (s) => !["created", "starting", "running"].includes(s.state))).toMatchObject({ state: "failed", exit_code: 75 });

  // reap keeps the supervisor-loss diagnosis and points at the live group.
  const reaped = JSON.parse((await orchEnv(fx, {}, ["run", "reap", "--mr", "mr-1", "--worktree", fx.worktree])).stdout);
  expect(reaped.reaped).toEqual([expect.objectContaining({ run_id: a.run_id, provider_alive: true, pgid })]);
  const stale = await waitStatus(a.status_path, (s) => s.state === "stale");
  expect(runProcessesAlive(stale)).toBe(true);
  expect(isProcessGroupAlive(pgid)).toBe(true);

  // A stale run stays cancellable; success means the group is confirmed gone.
  const cancel = await orchEnv(fx, {}, ["run", "cancel", "--run", a.run_id, "--mr", "mr-1", "--worktree", fx.worktree]);
  expect(cancel.exitCode).toBe(0);
  expect(JSON.parse(cancel.stdout)).toMatchObject({ canceled: true, orphaned: true, stopped: true, pgid });
  expect(isProcessGroupAlive(pgid)).toBe(false);
  expect(runProcessesAlive(await waitStatus(a.status_path, (s) => s.state === "stale"))).toBe(false);

  // Clean recovery: the checkout is free again.
  const c = await create("owner-c", {});
  expect(await waitStatus(c.status_path, (s) => !["created", "starting", "running"].includes(s.state))).toMatchObject({ state: "done", exit_code: 0 });
}, 60_000);

test("a driver whose supervisor dies before the handshake exits without starting work", async () => {
  const fx = fixture();
  const head = commit(fx.worktree, "v1\n");
  const runDir = join(fx.stateHome, "orch", fx.repoKey, "mrs", "mr-1", "runs", "impl-orphan");
  mkdirSync(runDir, { recursive: true });
  const spec = {
    version: 1, run_id: "impl-orphan", mr: "mr-1", role: "implementer", agent: "claude", model: null, tag: "impl-orphan",
    provider_session_name: null, provider_session_id: null, provider_session_mode: "ephemeral", idempotency_key: "k",
    repo_key: fx.repoKey, worktree: fx.worktree, task_path: null, task_text: "t", task_sha: "s", base_sha: head.head, timeout_sec: 60,
    created_at: "2026-10-13T00:00:00Z", snapshot: head,
  };
  writeFileSync(join(runDir, "spec.json"), JSON.stringify(spec));
  const proc = Bun.spawn([process.execPath, "src/orch.ts", "__driver-claude", "--spec", join(runDir, "spec.json"), "--run-dir", runDir, "--worktree", fx.worktree], {
    env: { ...process.env, ...fx.env, ORCH_DRIVER_FAKE_RESULT: "1", ORCH_DRIVER_HANDSHAKE: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  expect(await proc.exited).toBe(1);
  expect(existsSync(join(runDir, "result.json"))).toBe(false);
}, 15_000);
