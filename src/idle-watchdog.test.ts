import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyProcesses,
  DEFAULT_IGNORED_PROCS,
  IDLE_TIMEOUT_MIN_DEFAULT,
  idleCheckIntervalMs,
  idleTimeoutMinutes,
  ignoredProcNames,
  IdleWatchdog,
  newestMtimeUnder,
  parsePs,
  type PsRunner,
} from "./idle-watchdog.ts";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
import type { OrchEvent, RunSpec, RunStatus } from "./types.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-09T00:00:00.000Z");
const DRIVER = 100;

// Shaped after a live codex verifier tree (2026-11-09): the driver, the codex
// binary, its two node_repl helpers and code-mode host, and one tool command
// in a session of its own.
function psLines(...extra: string[]): string {
  return [
    `  ${DRIVER}     1   ${DRIVER} SNs  /Users/u/.local/bin/orch __driver-codex --spec /s/spec.json --run-dir /r`,
    `  101   ${DRIVER}   ${DRIVER} SN   /opt/codex/vendor/bin/codex exec --json -`,
    `  102   101   102 SN   /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl`,
    `  103   101   103 SN   /opt/codex/vendor/bin/codex-code-mode-host`,
    `  999     1   999 Ss   /sbin/launchd-unrelated`,
    ...extra,
  ].join("\n");
}

const FULL_TEST = [
  `  200   101   200 SNs  /bin/zsh -lc python3 ~/.agents/loops/full-test.py /wt test`,
  `  201   200   200 SN   python3 /Users/u/.agents/loops/full-test.py /wt test`,
  `  202   201   200 SN   ssh clouddev make test`,
];

function runDirAt(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-idle-"));
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ type: "running", seq: 1, ts: new Date(T0).toISOString() })}\n`);
  writeFileSync(join(dir, "native.jsonl"), "{}\n");
  setMtime(join(dir, "native.jsonl"), T0);
  return dir;
}

function setMtime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

function heartbeat(dir: string, ms: number): void {
  appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ type: "heartbeat", seq: 0, ts: new Date(ms).toISOString() })}\n`);
}

function watchdogFor(dir: string, clock: { now: number }, ps: string | null, idleMin = 90): IdleWatchdog {
  const runner: PsRunner = async () => ps;
  return new IdleWatchdog({ runDir: dir, driverPid: DRIVER, idleMs: idleMin * MIN, startedAtMs: T0, ps: runner, now: () => clock.now, ignore: DEFAULT_IGNORED_PROCS });
}

test("ORCH_IDLE_TIMEOUT_MIN: default 90, 0 disables, fractions accepted, junk falls back", () => {
  expect(IDLE_TIMEOUT_MIN_DEFAULT).toBe(90);
  expect(idleTimeoutMinutes({})).toBe(90);
  expect(idleTimeoutMinutes({ ORCH_IDLE_TIMEOUT_MIN: "" })).toBe(90);
  expect(idleTimeoutMinutes({ ORCH_IDLE_TIMEOUT_MIN: "0" })).toBe(0);
  expect(idleTimeoutMinutes({ ORCH_IDLE_TIMEOUT_MIN: "45" })).toBe(45);
  expect(idleTimeoutMinutes({ ORCH_IDLE_TIMEOUT_MIN: "0.5" })).toBe(0.5);
  expect(idleTimeoutMinutes({ ORCH_IDLE_TIMEOUT_MIN: "-3" })).toBe(90);
  expect(idleTimeoutMinutes({ ORCH_IDLE_TIMEOUT_MIN: "soon" })).toBe(90);
  expect(idleCheckIntervalMs(90 * MIN)).toBe(60_000);
  expect(idleCheckIntervalMs(100)).toBe(50);
  expect(ignoredProcNames({ ORCH_IDLE_IGNORE_PROCS: " my-helper ,other" })).toEqual([...DEFAULT_IGNORED_PROCS, "my-helper", "other"]);
});

test("silent events and native stream with no work process below the agent is idle", async () => {
  const dir = runDirAt();
  const clock = { now: T0 + 89 * MIN };
  // The supervisor's own heartbeats keep events.jsonl growing; they are not activity.
  for (let m = 1; m <= 89; m += 1) heartbeat(dir, T0 + m * MIN);
  const watchdog = watchdogFor(dir, clock, psLines());
  expect((await watchdog.check()).idle).toBe(false);

  clock.now = T0 + 91 * MIN;
  heartbeat(dir, clock.now);
  const verdict = await watchdog.check();
  expect(verdict.idle).toBe(true);
  expect(verdict.snapshot).toMatchObject({
    idle_timeout_min: 90,
    last_activity_at: new Date(T0).toISOString(),
    idle_for_sec: 91 * 60,
    events_last_at: new Date(T0).toISOString(),
    native_last_at: new Date(T0).toISOString(),
    evidence_last_at: null,
    result_json_present: false,
  });
  expect(verdict.snapshot.processes).toMatchObject({ checked: true, busy: [], agent: [DRIVER, 101] });
  expect(verdict.snapshot.processes.checked && verdict.snapshot.processes.ignored.map((p) => p.name)).toEqual(["node_repl", "codex-code-mode-host"]);
});

test("silent events but a full-test child still running is not idle", async () => {
  const dir = runDirAt();
  const clock = { now: T0 + 150 * MIN };
  const verdict = await watchdogFor(dir, clock, psLines(...FULL_TEST)).check();
  expect(verdict.idle).toBe(false);
  expect(verdict.snapshot.idle_for_sec).toBe(150 * 60);
  const processes = verdict.snapshot.processes;
  expect(processes.checked).toBe(true);
  expect(processes.checked && processes.busy.map((p) => p.pid)).toEqual([200, 201, 202]);
  expect(processes.checked && processes.busy[1]!.args).toContain("full-test.py");

  // Once the suite is gone the same quiet run is idle.
  expect((await watchdogFor(dir, clock, psLines()).check()).idle).toBe(true);
});

test("an unreadable process table never counts as idle", async () => {
  const dir = runDirAt();
  const clock = { now: T0 + 200 * MIN };
  const failed = await watchdogFor(dir, clock, null).check();
  expect(failed.idle).toBe(false);
  expect(failed.snapshot.processes).toEqual({ checked: false, error: "ps failed" });
  // The driver already gone (supervisor finalizing): not idle either.
  const gone = await watchdogFor(dir, clock, `  999 1 999 Ss /sbin/launchd\n`).check();
  expect(gone.idle).toBe(false);
});

test("a new worker event, native output or evidence write restarts the clock", async () => {
  const dir = runDirAt();
  const clock = { now: T0 + 60 * MIN };
  const watchdog = watchdogFor(dir, clock, psLines());
  appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ type: "api_resume", attempt: 1, ts: new Date(clock.now).toISOString() })}\n`);
  clock.now = T0 + 120 * MIN;
  let verdict = await watchdog.check();
  expect(verdict.idle).toBe(false);
  expect(verdict.snapshot.last_activity_source).toBe("events.jsonl");
  expect(verdict.snapshot.last_activity_at).toBe(new Date(T0 + 60 * MIN).toISOString());
  // The process table is only read once every file is quiet.
  expect(verdict.snapshot.processes).toEqual({ checked: false, error: "not checked: recent activity" });

  clock.now = T0 + 151 * MIN;
  expect((await watchdog.check()).idle).toBe(true);

  // native.jsonl grew at 140 min: idle again only from 230 min on.
  setMtime(join(dir, "native.jsonl"), T0 + 140 * MIN);
  verdict = await watchdog.check();
  expect(verdict.idle).toBe(false);
  expect(verdict.snapshot.last_activity_source).toBe("native.jsonl");

  // A log written into the evidence dir counts too (criterion c).
  mkdirSync(join(dir, "evidence", "logs"), { recursive: true });
  writeFileSync(join(dir, "evidence", "logs", "suite.log"), "ok\n");
  setMtime(join(dir, "evidence", "logs", "suite.log"), T0 + 200 * MIN);
  setMtime(join(dir, "evidence", "logs"), T0);
  setMtime(join(dir, "evidence"), T0);
  clock.now = T0 + 240 * MIN;
  verdict = await watchdog.check();
  expect(verdict.idle).toBe(false);
  expect(verdict.snapshot.last_activity_source).toBe("evidence");
  expect(newestMtimeUnder(join(dir, "evidence"))).toBe(T0 + 200 * MIN);
  clock.now = T0 + 291 * MIN;
  expect((await watchdog.check()).idle).toBe(true);
});

test("process classification: agent chain, helpers, zombies, own-session tools, reparented group members", () => {
  const rows = parsePs(
    [
      `  ${DRIVER} 1 ${DRIVER} Ss /x/orch __driver-claude --spec s`,
      // claude TUI: the provider runs in a session of its own.
      `  300 ${DRIVER} 300 Ss+ claude --session-id abc -- prompt`,
      `  301 300 301 S /opt/homebrew/bin/github-mcp-server stdio`,
      `  302 301 301 S node child-of-mcp-helper`,
      `  303 300 303 S caffeinate -i -t 300`,
      `  304 300 304 Z (zsh)`,
      // A shell is never a helper, even with "mcp" in its arguments.
      `  305 300 305 Ss /bin/zsh -c pytest tests/test_mcp.py`,
      // Reparented to init but still in the driver's group.
      `  306 1 ${DRIVER} S make -j8 check`,
    ].join("\n"),
  );
  const verdict = classifyProcesses(rows, DRIVER, DEFAULT_IGNORED_PROCS);
  expect(verdict.agent).toEqual([DRIVER, 300]);
  expect(verdict.ignored).toEqual([
    { pid: 301, name: "github-mcp-server" },
    { pid: 303, name: "caffeinate" },
  ]);
  expect(verdict.busy.map((p) => p.pid)).toEqual([305, 306]);

  // A wrapper in front of the provider (cdlane claude-remote, sandbox-exec)
  // is the agent; so is the provider binary right below it.
  const wrapped = classifyProcesses(
    parsePs([`  ${DRIVER} 1 ${DRIVER} Ss orch`, `  400 ${DRIVER} ${DRIVER} S python3 claude-remote.py -p`, `  401 400 ${DRIVER} S claude -p`, `  402 401 402 Ss /bin/bash -c make test`].join("\n")),
    DRIVER,
    DEFAULT_IGNORED_PROCS,
  );
  expect(wrapped.agent).toEqual([DRIVER, 400, 401]);
  expect(wrapped.busy.map((p) => p.pid)).toEqual([402]);
});

// ---- supervisor integration: real driver process, real ps ----

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.trim();
}

async function setup(name: string, driverSource: string, timeoutSec: number) {
  const root = mkdtempSync(join(tmpdir(), `orch-idle-sup-${name}-`));
  const worktree = realpathSync(mkdtempSync(join(root, "wt-")));
  await git(["init", "-q"], worktree);
  writeFileSync(join(worktree, "README.md"), "x\n");
  await git(["add", "README.md"], worktree);
  await git(["-c", "user.email=t@e.x", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], worktree);
  const baseSha = await git(["rev-parse", "HEAD"], worktree);
  const spec: RunSpec = {
    version: 1,
    run_id: `idle-${name}`,
    mr: `idle-${name}`,
    role: "reviewer",
    agent: "codex",
    model: null,
    tag: "test",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: name,
    repo_key: "local/repo",
    worktree,
    task_path: null,
    task_text: "test",
    task_sha: "sha",
    base_sha: baseSha,
    timeout_sec: timeoutSec,
    created_at: "2026-11-09T00:00:00.000Z",
  };
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "spec.json"), JSON.stringify(spec));
  writeInitialRunFiles(runDir, spec);
  const driver = join(root, "driver.js");
  writeFileSync(driver, driverSource);
  return { root, runDir, driver };
}

const REVIEW_RESULT = `{ schema: "orch.result/reviewer/v1", run_id: spec.run_id, verdict: "approve", reviews_run_id: "", blocking_findings: [], non_blocking_findings: [], suggested_tests: [] }`;

const DRIVER_PRELUDE = String.raw`
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const spec = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--spec") + 1], "utf8"));
const runDir = process.argv[process.argv.indexOf("--run-dir") + 1];
`;

async function supervise(runDir: string, driver: string, root: string, idleMin: string): Promise<number> {
  const saved = { idle: process.env.ORCH_IDLE_TIMEOUT_MIN, state: process.env.XDG_STATE_HOME };
  process.env.ORCH_IDLE_TIMEOUT_MIN = idleMin;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    return await runSupervisor(runDir, [process.execPath, driver]);
  } finally {
    if (saved.idle === undefined) delete process.env.ORCH_IDLE_TIMEOUT_MIN;
    else process.env.ORCH_IDLE_TIMEOUT_MIN = saved.idle;
    if (saved.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved.state;
  }
}

function events(runDir: string): Array<OrchEvent & Record<string, unknown>> {
  return readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function status(runDir: string): RunStatus {
  return JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
}

test("supervisor: a silent run with nothing running below it ends as timeout (reason idle) with the snapshot event", async () => {
  // 0.005 min = 300 ms of silence; the total timeout (20 s) is far away.
  const { root, runDir, driver } = await setup("silent", `${DRIVER_PRELUDE}setInterval(() => {}, 1000);\n`, 20);
  const started = Date.now();
  const code = await supervise(runDir, driver, root, "0.005");
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(code).toBe(124);
  const st = status(runDir);
  expect(st).toMatchObject({ state: "timeout", exit_code: 124, timeout_reason: "idle" });
  expect(st.idle_stop).toMatchObject({ idle_timeout_min: 0.005, finalized_from_result: false });
  const idle = events(runDir).find((e) => e.type === "idle_watchdog")!;
  expect(idle.idle).toMatchObject({ result_json_present: false, processes: { checked: true, busy: [] } });
  expect(events(runDir).at(-1)).toMatchObject({ type: "timeout" });
  expect(events(runDir).at(-1)!.message).toContain("idle watchdog: no activity since");
  // The usual timeout ending: fallback result naming the idle stop.
  const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
  expect(result.verdict).toBe("request_changes");
  expect(JSON.stringify(result)).toContain("idle watchdog");
});

test("supervisor: a silent run with a delivered result.json is finalized on that result", async () => {
  const source = `${DRIVER_PRELUDE}writeFileSync(join(runDir, "result.json"), JSON.stringify(${REVIEW_RESULT}));\nsetInterval(() => {}, 1000);\n`;
  const { root, runDir, driver } = await setup("result", source, 20);
  const code = await supervise(runDir, driver, root, "0.005");
  expect(code).toBe(0);
  const st = status(runDir);
  expect(st.state).toBe("done");
  expect(st.timeout_reason).toBeUndefined();
  expect(st.idle_stop).toMatchObject({ finalized_from_result: true });
  expect(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).verdict).toBe("approve");
  expect(events(runDir).find((e) => e.type === "idle_watchdog")!.idle).toMatchObject({ result_json_present: true });
  expect(events(runDir).at(-1)).toMatchObject({ type: "done" });
});

test("supervisor: a silent run waiting on a child process is left to the total timeout", async () => {
  // driver -> provider (agent) -> sleep (work): the sleep keeps the run alive.
  const source = `${DRIVER_PRELUDE}
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); setInterval(() => {}, 1000);"], { stdio: "ignore" });
setInterval(() => {}, 1000);
`;
  const { root, runDir, driver } = await setup("busy", source, 3);
  const code = await supervise(runDir, driver, root, "0.005");
  expect(code).toBe(124);
  expect(status(runDir)).toMatchObject({ state: "timeout", timeout_reason: "total" });
  expect(status(runDir).idle_stop).toBeUndefined();
  expect(events(runDir).some((e) => e.type === "idle_watchdog")).toBe(false);
});

test("supervisor: ORCH_IDLE_TIMEOUT_MIN=0 turns the watchdog off", async () => {
  const { root, runDir, driver } = await setup("off", `${DRIVER_PRELUDE}setInterval(() => {}, 1000);\n`, 2);
  const code = await supervise(runDir, driver, root, "0");
  expect(code).toBe(124);
  expect(status(runDir)).toMatchObject({ state: "timeout", timeout_reason: "total" });
  expect(events(runDir).some((e) => e.type === "idle_watchdog")).toBe(false);
});
