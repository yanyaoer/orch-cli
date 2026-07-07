import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKeyFromRemote } from "./paths.ts";
import type { RunStatus } from "./types.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
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

function makeFixture(): { root: string; stateHome: string; worktree: string; repoKey: string } {
  const root = mkdtempSync(join(tmpdir(), "orch-search-usage-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const repoKey = repoKeyFromRemote(worktree, worktree);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, stateHome, worktree, repoKey };
}

function status(overrides: Partial<RunStatus> & { run_id: string; mr: string; started_at: string }): RunStatus {
  return {
    role: "implementer",
    agent: "codex",
    tag: "impl-a",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    state: "done",
    pid: null,
    pgid: null,
    updated_at: overrides.started_at,
    exit_code: 0,
    timeout_sec: 3600,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree: "/tmp/wt",
    base_sha: "base",
    head_sha: "head",
    ...overrides,
  } as RunStatus;
}

function writeRun(args: {
  stateHome: string;
  repoKey: string;
  mr: string;
  runId: string;
  startedAt: string;
  specModel?: string;
  nativeLines?: unknown[];
  result?: string;
  events?: string;
  artifacts?: Record<string, string>;
}): string {
  const runDir = join(args.stateHome, "orch", args.repoKey, "mrs", args.mr, "runs", args.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify(status({ run_id: args.runId, mr: args.mr, started_at: args.startedAt }), null, 2)}\n`);
  if (args.specModel !== undefined) {
    writeFileSync(join(runDir, "spec.json"), `${JSON.stringify({ model: args.specModel }, null, 2)}\n`);
  }
  if (args.result !== undefined) writeFileSync(join(runDir, "result.json"), args.result);
  if (args.events !== undefined) writeFileSync(join(runDir, "events.jsonl"), args.events);
  if (args.nativeLines !== undefined) {
    writeFileSync(
      join(runDir, "native.jsonl"),
      args.nativeLines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
  }
  if (args.artifacts) {
    const artifactsDir = join(runDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    for (const [file, text] of Object.entries(args.artifacts)) writeFileSync(join(artifactsDir, file), text);
  }
  return runDir;
}

test("orch search scans run files, scoped artifacts, and mail events", async () => {
  const fixture = makeFixture();
  const env = { XDG_STATE_HOME: fixture.stateHome };
  const now = new Date().toISOString();
  writeRun({
    stateHome: fixture.stateHome,
    repoKey: fixture.repoKey,
    mr: "42",
    runId: "impl-a",
    startedAt: now,
    result: '{ "summary": "NEEDLE in result" }\n',
    events: '{"type":"done","message":"NEEDLE in events"}\n',
    nativeLines: [{ type: "item.completed", item: { type: "agent_message", text: "NEEDLE in native" } }],
    artifacts: {
      "diff.patch": "diff --git a/x b/x\n+NEEDLE in patch\n",
      "worker.log": "NEEDLE in artifact log\n",
      "ignored.md": "NEEDLE outside the artifact extension allowlist\n",
    },
  });
  const mailEvents = join(fixture.stateHome, "orch", fixture.repoKey, "mail", "threads", "thread-a", "inbox", "events");
  mkdirSync(mailEvents, { recursive: true });
  writeFileSync(join(mailEvents, "mail-events.jsonl"), '{"type":"task.assigned","body":"NEEDLE in mail"}\n');

  const searched = await runOrch(["search", "NEEDLE", "--worktree", fixture.worktree, "--json"], env);
  expect(searched).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(searched.stdout) as {
    schema: string;
    searched_files: number;
    hits: Array<{ source: string; mr: string | null; run_id: string | null; thread: string | null; file: string; line: number; context: string }>;
  };
  expect(payload.schema).toBe("orch.search/v1");
  expect(payload.searched_files).toBe(6);
  expect(payload.hits.map((hit) => hit.file).sort()).toEqual([
    "artifacts/diff.patch",
    "artifacts/worker.log",
    "events.jsonl",
    "mail-events.jsonl",
    "native.jsonl",
    "result.json",
  ]);
  expect(payload.hits.find((hit) => hit.file === "mail-events.jsonl")).toMatchObject({ source: "mail", thread: "thread-a" });
  expect(payload.hits.find((hit) => hit.file === "result.json")).toMatchObject({ source: "run", mr: "42", run_id: "impl-a", line: 1 });

  const scoped = await runOrch(["search", "NEEDLE", "--worktree", fixture.worktree, "--mr", "42", "--json"], env);
  expect((JSON.parse(scoped.stdout) as typeof payload).hits.map((hit) => hit.file)).not.toContain("mail-events.jsonl");
});

test("orch usage reports missing token data as missing and aggregates token maps", async () => {
  const fixture = makeFixture();
  const env = { XDG_STATE_HOME: fixture.stateHome };
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  writeRun({
    stateHome: fixture.stateHome,
    repoKey: fixture.repoKey,
    mr: "usage-thread",
    runId: "r-token",
    startedAt: now,
    specModel: "codex-test-model",
    nativeLines: [
      { type: "thread.started", thread_id: "t1", model: "gpt-test" },
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, requests: 1 } },
    ],
  });
  writeRun({
    stateHome: fixture.stateHome,
    repoKey: fixture.repoKey,
    mr: "usage-thread",
    runId: "r-missing",
    startedAt: now,
    nativeLines: [{ type: "turn.completed", usage: { requests: 1 } }],
  });
  writeRun({
    stateHome: fixture.stateHome,
    repoKey: fixture.repoKey,
    mr: "old-thread",
    runId: "r-old",
    startedAt: old,
    nativeLines: [{ type: "turn.completed", usage: { input_tokens: 999, output_tokens: 999 } }],
  });

  const run = await runOrch(["usage", "run", "--run", "r-token", "--mr", "usage-thread", "--worktree", fixture.worktree, "--json"], env);
  expect(run).toMatchObject({ exitCode: 0, stderr: "" });
  const runPayload = JSON.parse(run.stdout) as {
    schema: string;
    has_token_data: boolean;
    usage: Record<string, number>;
    estimated_cost_usd: null;
    unpriced_models: string[];
    usage_events: number;
  };
  expect(runPayload.schema).toBe("orch.usage/run/v1");
  expect(runPayload.has_token_data).toBe(true);
  expect(runPayload.usage).toEqual({ cache_read_input_tokens: 5, input_tokens: 100, output_tokens: 20 });
  expect(runPayload.estimated_cost_usd).toBeNull();
  expect(runPayload.unpriced_models).toEqual(["codex-test-model", "gpt-test"]);
  expect(runPayload.usage_events).toBe(1);

  const missing = await runOrch(["usage", "run", "--run", "r-missing", "--mr", "usage-thread", "--worktree", fixture.worktree, "--json"], env);
  const missingPayload = JSON.parse(missing.stdout) as { has_token_data: boolean; usage: null };
  expect(missingPayload).toMatchObject({ has_token_data: false, usage: null });

  const thread = await runOrch(["usage", "thread", "--thread", "usage-thread", "--worktree", fixture.worktree, "--json"], env);
  const threadPayload = JSON.parse(thread.stdout) as {
    schema: string;
    run_count: number;
    runs_with_token_data: number;
    missing_runs: string[];
    usage: Record<string, number>;
    runs: unknown[];
  };
  expect(threadPayload.schema).toBe("orch.usage/thread/v1");
  expect(threadPayload.run_count).toBe(2);
  expect(threadPayload.runs_with_token_data).toBe(1);
  expect(threadPayload.missing_runs).toEqual(["r-missing"]);
  expect(threadPayload.usage).toEqual({ cache_read_input_tokens: 5, input_tokens: 100, output_tokens: 20 });
  expect(threadPayload.runs).toHaveLength(2);

  const daily = await runOrch(["usage", "daily", "--days", "2", "--worktree", fixture.worktree, "--json"], env);
  const dailyPayload = JSON.parse(daily.stdout) as {
    schema: string;
    buckets: Array<{ date: string; run_count: number; missing_runs: string[]; usage: Record<string, number> }>;
  };
  expect(dailyPayload.schema).toBe("orch.usage/daily/v1");
  expect(dailyPayload.buckets).toHaveLength(1);
  expect(dailyPayload.buckets[0]).toMatchObject({
    date: now.slice(0, 10),
    run_count: 2,
    missing_runs: ["r-missing"],
    usage: { cache_read_input_tokens: 5, input_tokens: 100, output_tokens: 20 },
  });
});
