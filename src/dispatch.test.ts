import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchDir,
  insideSandbox,
  proxyToHost,
  reconcileDispatchOnce,
  shouldProxyToHost,
  type DispatchRequest,
  type DispatchResult,
} from "./dispatch.ts";
import {
  ORCH_SANDBOX_RUN_DIR_ENV,
  ORCH_SANDBOX_RUN_ID_ENV,
  SEATBELT_ENV_MARKER,
} from "../drivers/driver-common.ts";
import type { RunSpec, RunStatus } from "./types.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-dispatch-"));
  tempDirs.push(dir);
  return dir;
}

interface ControllerFixture {
  stateRoot: string;
  worktree: string;
  runDir: string;
  runId: string;
  targetRunId: string;
  thread: string;
  env: NodeJS.ProcessEnv;
}

function controllerFixture(
  opts: { controllerMr?: string; thread?: string; tag?: string; idempotencyKey?: string } = {},
): ControllerFixture {
  const stateRoot = tempDir();
  const worktree = join(stateRoot, "worktree");
  const controllerMr = opts.controllerMr ?? "thread-1";
  const thread = opts.thread ?? controllerMr;
  const runDir = join(stateRoot, "repo", "mrs", controllerMr, "runs", "controller-1");
  const runId = "controller-1";
  const targetRunId = "worker-1";
  mkdirSync(worktree, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(dispatchDir(stateRoot), "pending", runId), { recursive: true });
  mkdirSync(join(dispatchDir(stateRoot), "claims", runId), { recursive: true });
  mkdirSync(join(dispatchDir(stateRoot), "done", runId), { recursive: true });
  const spec: RunSpec = {
    version: 1,
    run_id: runId,
    mr: controllerMr,
    role: "controller",
    agent: "claude",
    model: null,
    tag: opts.tag ?? "controller",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: opts.idempotencyKey ?? "controller-test",
    repo_key: "repo",
    worktree,
    task_path: null,
    task_text: "test",
    task_sha: "sha",
    base_sha: "base",
    timeout_sec: 60,
    created_at: new Date().toISOString(),
    sandbox_engine: "seatbelt-v1",
  };
  const status: RunStatus = {
    run_id: runId,
    mr: controllerMr,
    role: "controller",
    agent: "claude",
    tag: opts.tag ?? "controller",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    state: "running",
    pid: process.pid,
    pgid: process.pid,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    exit_code: null,
    timeout_sec: 60,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree,
    base_sha: "base",
    head_sha: null,
    sandbox_engine: "seatbelt-v1",
    sandbox_posture: "read-only",
    sandbox_profile_sha256: null,
    provider_native_sandbox: true,
  };
  writeFileSync(join(runDir, "spec.json"), JSON.stringify(spec));
  writeFileSync(join(runDir, "status.json"), JSON.stringify(status));
  const targetDir = join(stateRoot, "repo", "mrs", thread, "runs", targetRunId);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "status.json"), JSON.stringify({ ...status, run_id: targetRunId, mr: thread, role: "implementer", agent: "pi", tag: "worker" }));
  return {
    stateRoot,
    worktree,
    runDir,
    runId,
    targetRunId,
    thread,
    env: { [ORCH_SANDBOX_RUN_ID_ENV]: runId, [ORCH_SANDBOX_RUN_DIR_ENV]: runDir },
  };
}

function queuedRequest(fx: ControllerFixture, _id: string, argv: string[]): DispatchRequest {
  return {
    schema: "orch.dispatch/request/v1",
    argv,
    stdin: "",
    controller_run_dir: fx.runDir,
  };
}

test("shouldProxyToHost proxies only controller mutations", () => {
  expect(shouldProxyToHost(["run", "create"])).toBe(true);
  expect(shouldProxyToHost(["run", "cancel"])).toBe(true);
  expect(shouldProxyToHost(["fanout"])).toBe(true);
  expect(shouldProxyToHost(["cross-review"])).toBe(true);
  expect(shouldProxyToHost(["decision", "accept"])).toBe(true);
  expect(shouldProxyToHost(["mailctl", "reply"])).toBe(true);
  expect(shouldProxyToHost(["mailctl", "ack"])).toBe(true);
  expect(shouldProxyToHost(["mailctl", "guidance"])).toBe(false);
  expect(shouldProxyToHost(["mailctl", "poll"])).toBe(false);
  expect(shouldProxyToHost(["run", "list"])).toBe(false);
  expect(shouldProxyToHost(["run", "reap"])).toBe(false);
  expect(shouldProxyToHost(["decision", "close"])).toBe(false);
  expect(shouldProxyToHost(["mail"])).toBe(false);
  expect(shouldProxyToHost(["mirror"])).toBe(false);
  expect(shouldProxyToHost(["wait"])).toBe(false);
  expect(shouldProxyToHost(["result"])).toBe(false);
  expect(shouldProxyToHost(["status"])).toBe(false);
  expect(shouldProxyToHost(["__supervisor"])).toBe(false);
});

test("insideSandbox reads the seatbelt marker", () => {
  expect(insideSandbox({})).toBe(false);
  expect(insideSandbox({ [SEATBELT_ENV_MARKER]: "seatbelt-v1" })).toBe(true);
});

test("proxyToHost round-trips through a spec-bound host reconcile", async () => {
  const fx = controllerFixture();
  const fakeOrch = join(fx.stateRoot, "fake-orch.js");
  writeFileSync(
    fakeOrch,
    String.raw`
const argv = process.argv.slice(2);
const stdin = require("node:fs").readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({ argv, stdin, cwd: process.cwd() }) + "\n");
process.stderr.write("fake-orch stderr\n");
process.exit(argv[0] === "decision" ? 7 : 0);
`,
    "utf8",
  );
  const orchCommand = [process.execPath, fakeOrch];
  const runProxy = (argv: string[], stdin: string) =>
    proxyToHost({ argv, stdin }, { stateRoot: fx.stateRoot, pollMs: 20, env: fx.env });

  let stop = false;
  const loop = (async () => {
    while (!stop) {
      await reconcileDispatchOnce(orchCommand, { stateRoot: fx.stateRoot });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();

  const ok = await runProxy(["run", "create", "--task", "-", "--role", "implementer", "--mr", fx.thread], "task body\n");
  expect(ok.exit_code).toBe(0);
  expect(JSON.parse(ok.stdout.trim())).toEqual({
    argv: ["run", "create", `--mr=${fx.thread}`, "--role=implementer", "--task=-"],
    stdin: "task body\n",
    cwd: realpathSync(fx.worktree),
  });
  expect(ok.stderr).toContain("fake-orch stderr");

  const boom = await runProxy(["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId], "");
  expect(boom.exit_code).toBe(7);
  const canceled = await runProxy(["run", "cancel", "--mr", fx.thread, "--run", fx.targetRunId, "--reason=--still-reason"], "");
  expect(canceled.exit_code).toBe(0);
  expect(JSON.parse(canceled.stdout.trim()).argv).toEqual([
    "run",
    "cancel",
    `--mr=${fx.thread}`,
    `--run=${fx.targetRunId}`,
    "--reason=--still-reason",
  ]);
  stop = true;
  await loop;
  expect(readdirSync(join(dispatchDir(fx.stateRoot), "pending", fx.runId))).toEqual([]);
});

test("host rejects unlisted operations, path overrides, and malformed envelopes", async () => {
  const fx = controllerFixture();
  const pending = join(dispatchDir(fx.stateRoot), "pending", fx.runId);
  const ids = [
    "1700000000000-aaaaaaaaaaaa",
    "1700000000001-bbbbbbbbbbbb",
    "1700000000002-cccccccccccc",
    "1700000000007-222222222222",
    "1700000000008-333333333333",
    "1700000000009-444444444444",
    "1700000000010-555555555555",
    "1700000000011-666666666666",
    "1700000000012-777777777777",
  ];
  writeFileSync(join(pending, `${ids[0]}.json`), JSON.stringify(queuedRequest(fx, ids[0]!, ["__supervisor"])));
  writeFileSync(join(pending, `${ids[1]}.json`), JSON.stringify(queuedRequest(fx, ids[1]!, ["run", "create", "--role", "implementer", "--mr", fx.thread, "--worktree", fx.stateRoot])));
  writeFileSync(
    join(pending, `${ids[2]}.json`),
    JSON.stringify({
      ...queuedRequest(fx, ids[2]!, ["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId]),
      unexpected: true,
    }),
  );
  writeFileSync(
    join(pending, `${ids[3]}.json`),
    JSON.stringify(queuedRequest(fx, ids[3]!, ["run", "create", "--role", "implementer", "--mr", fx.thread, "--task", "/etc/hosts"])),
  );
  writeFileSync(
    join(pending, `${ids[4]}.json`),
    JSON.stringify(queuedRequest(fx, ids[4]!, ["decision", "accept", "--mr", "other", "--mr", fx.thread, "--run", fx.targetRunId])),
  );
  writeFileSync(
    join(pending, `${ids[5]}.json`),
    JSON.stringify(queuedRequest(fx, ids[5]!, ["mailctl", "reply", "--thread", fx.thread, "--report-key", "k", "--body-file", "/etc/hosts"])),
  );
  writeFileSync(
    join(pending, `${ids[6]}.json`),
    JSON.stringify(queuedRequest(fx, ids[6]!, ["run", "create", "--mr", fx.thread, "--role", "implementer", "--task", "-", "--json", "--json"])),
  );
  mkdirSync(join(pending, `${ids[7]}.json`));
  symlinkSync("/etc/hosts", join(pending, `${ids[8]}.json`));
  const invalidIdDir = join(pending, "bad.json");
  mkdirSync(invalidIdDir);

  const handled = await reconcileDispatchOnce([process.execPath, "-e", "process.exit(99)"], { stateRoot: fx.stateRoot });
  expect(handled).toBe(ids.length);
  expect(existsSync(invalidIdDir)).toBe(false);
  for (const id of ids) {
    const result = JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${id}.json`), "utf8")) as DispatchResult;
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain("dispatch rejected");
  }
});

test("mailctl host mutations are scoped to the controller thread", async () => {
  const fx = controllerFixture({ controllerMr: "mailctl-em-x", thread: "em-x", tag: "mailctl", idempotencyKey: "ctrl:em-x:0" });
  const pending = join(dispatchDir(fx.stateRoot), "pending", fx.runId);
  const okId = "1700000000003-dddddddddddd";
  const badId = "1700000000004-eeeeeeeeeeee";
  writeFileSync(join(pending, `${okId}.json`), JSON.stringify(queuedRequest(fx, okId, ["mailctl", "ack", "--thread", fx.thread, "--attention", "a"])));
  writeFileSync(join(pending, `${badId}.json`), JSON.stringify(queuedRequest(fx, badId, ["mailctl", "reply", "--thread", "other", "--report-key", "k", "--body", "x"])));
  await reconcileDispatchOnce([process.execPath, "-e", "process.exit(0)"], { stateRoot: fx.stateRoot });
  expect((JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${okId}.json`), "utf8")) as DispatchResult).exit_code).toBe(0);
  expect((JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${badId}.json`), "utf8")) as DispatchResult).exit_code).toBe(1);
});

test("an ordinary controller MR beginning with mailctl- keeps its full thread id", async () => {
  const fx = controllerFixture({ controllerMr: "mailctl-ordinary", tag: "exec" });
  const pending = join(dispatchDir(fx.stateRoot), "pending", fx.runId);
  const okId = "1700000000014-999999999999";
  const badId = "1700000000015-aaaaaaaaaaab";
  const mailId = "1700000000017-cccccccccccd";
  writeFileSync(join(pending, `${okId}.json`), JSON.stringify(queuedRequest(fx, okId, ["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId])));
  writeFileSync(join(pending, `${badId}.json`), JSON.stringify(queuedRequest(fx, badId, ["decision", "accept", "--mr", "ordinary", "--run", fx.targetRunId])));
  writeFileSync(join(pending, `${mailId}.json`), JSON.stringify(queuedRequest(fx, mailId, ["mailctl", "ack", "--thread", fx.thread, "--attention", "a"])));
  await reconcileDispatchOnce([process.execPath, "-e", "process.exit(0)"], { stateRoot: fx.stateRoot });
  expect((JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${okId}.json`), "utf8")) as DispatchResult).exit_code).toBe(0);
  expect((JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${badId}.json`), "utf8")) as DispatchResult).exit_code).toBe(1);
  expect((JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${mailId}.json`), "utf8")) as DispatchResult).exit_code).toBe(1);
});

test("dead reconciler claims produce an explicit unknown outcome without replay", async () => {
  const fx = controllerFixture();
  const id = "1700000000005-ffffffffffff";
  const claimed = join(dispatchDir(fx.stateRoot), "claims", fx.runId, `${id}.json.claimed-999999`);
  writeFileSync(claimed, JSON.stringify(queuedRequest(fx, id, ["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId])));
  writeFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${id}.json`), "{", "utf8");
  const handled = await reconcileDispatchOnce([join(fx.stateRoot, "missing-orch")], { stateRoot: fx.stateRoot });
  expect(handled).toBe(0);
  expect(existsSync(claimed)).toBe(false);
  const result = JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${id}.json`), "utf8")) as DispatchResult;
  expect(result.state).toBe("outcome_unknown");
  expect(result.exit_code).toBe(75);
});

test("reconciler waits for atomic hardlink publication to settle before claiming", async () => {
  const fx = controllerFixture();
  const id = "1700000000018-ddddddddddde";
  const pendingDir = join(dispatchDir(fx.stateRoot), "pending", fx.runId);
  const final = join(pendingDir, `${id}.json`);
  const temporary = `${final}.${process.pid}.123.pending`;
  writeFileSync(temporary, JSON.stringify(queuedRequest(fx, id, ["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId])));
  linkSync(temporary, final);

  expect(await reconcileDispatchOnce([process.execPath, "-e", "process.exit(0)"], { stateRoot: fx.stateRoot })).toBe(0);
  expect(existsSync(final)).toBe(true);
  expect(existsSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${id}.json`))).toBe(false);

  rmSync(temporary);
  expect(await reconcileDispatchOnce([process.execPath, "-e", "process.exit(0)"], { stateRoot: fx.stateRoot })).toBe(1);
  const result = JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${id}.json`), "utf8")) as DispatchResult;
  expect(result.state).toBe("completed");
  expect(existsSync(final)).toBe(false);
});

test("claim recovery preserves a valid result written before the previous host stopped", async () => {
  const fx = controllerFixture();
  const id = "1700000000016-bbbbbbbbbbbc";
  const claimed = join(dispatchDir(fx.stateRoot), "claims", fx.runId, `${id}.json.claimed-999999`);
  const done = join(dispatchDir(fx.stateRoot), "done", fx.runId, `${id}.json`);
  const completed: DispatchResult = {
    schema: "orch.dispatch/result/v1",
    id,
    state: "completed",
    exit_code: 0,
    stdout: "already persisted",
    stderr: "",
  };
  writeFileSync(claimed, JSON.stringify(queuedRequest(fx, id, ["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId])));
  writeFileSync(done, JSON.stringify(completed));
  expect(await reconcileDispatchOnce([join(fx.stateRoot, "missing-orch")], { stateRoot: fx.stateRoot })).toBe(0);
  expect(existsSync(claimed)).toBe(false);
  expect(JSON.parse(readFileSync(done, "utf8"))).toEqual(completed);
});

test("spawn failures produce a terminal rejected result", async () => {
  const fx = controllerFixture();
  const id = "1700000000006-111111111111";
  const pending = join(dispatchDir(fx.stateRoot), "pending", fx.runId, `${id}.json`);
  const unexecutable = join(fx.stateRoot, "not-executable");
  writeFileSync(unexecutable, "not an executable", "utf8");
  writeFileSync(pending, JSON.stringify(queuedRequest(fx, id, ["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId])));
  expect(await reconcileDispatchOnce([unexecutable], { stateRoot: fx.stateRoot })).toBe(1);
  const result = JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${id}.json`), "utf8")) as DispatchResult;
  expect(result.state).toBe("rejected");
  expect(result.exit_code).toBe(1);
});

test("host refuses an orch executable sourced from the controller worktree", async () => {
  const fx = controllerFixture();
  const id = "1700000000013-888888888888";
  const pending = join(dispatchDir(fx.stateRoot), "pending", fx.runId, `${id}.json`);
  const worktreeScript = join(fx.worktree, "modified-orch.js");
  writeFileSync(worktreeScript, "process.exit(0)", "utf8");
  writeFileSync(pending, JSON.stringify(queuedRequest(fx, id, ["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId])));
  expect(await reconcileDispatchOnce([process.execPath, worktreeScript], { stateRoot: fx.stateRoot })).toBe(1);
  const result = JSON.parse(readFileSync(join(dispatchDir(fx.stateRoot), "done", fx.runId, `${id}.json`), "utf8")) as DispatchResult;
  expect(result.state).toBe("rejected");
  expect(result.stderr).toContain("outside the controller worktree");
});

test("reconcile strips sandbox and controller context from the host process", async () => {
  const fx = controllerFixture();
  const fakeOrch = join(fx.stateRoot, "fake-orch.js");
  writeFileSync(
    fakeOrch,
    `process.stdout.write(JSON.stringify({ marker: process.env[${JSON.stringify(SEATBELT_ENV_MARKER)}] ?? null, run: process.env[${JSON.stringify(ORCH_SANDBOX_RUN_ID_ENV)}] ?? null }));`,
    "utf8",
  );
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      await reconcileDispatchOnce([process.execPath, fakeOrch], {
        stateRoot: fx.stateRoot,
        env: { ...process.env, ...fx.env, [SEATBELT_ENV_MARKER]: "seatbelt-v1" },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const result = await proxyToHost(
    { argv: ["decision", "accept", "--mr", fx.thread, "--run", fx.targetRunId], stdin: "" },
    { stateRoot: fx.stateRoot, pollMs: 20, env: fx.env },
  );
  stop = true;
  await loop;
  expect(JSON.parse(result.stdout)).toEqual({ marker: null, run: null });
});
