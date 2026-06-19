import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKeyFromRemote } from "./paths.ts";
import type { ImplementerResult, RunStatus } from "./types.ts";

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
      role: "implementer",
      agent: "codex",
      tag: "impl-a",
      state: "done",
      started_at: "2026-06-19T12:00:00.000Z",
      exit_code: 0,
    },
  ]);

  const table = await runOrch(["run", "list", "--mr", mr, "--worktree", worktree], env);
  expect(table).toMatchObject({ exitCode: 0, stderr: "" });
  expect(table.stdout).toContain("run_id");
  expect(table.stdout).toContain(runId);

  const events = await runOrch(["events", "tail", "--run", runId, "--worktree", worktree, "-n", "1"], env);
  expect(events).toMatchObject({ exitCode: 0, stderr: "" });
  expect(events.stdout).toBe("{\"type\":\"done\",\"seq\":1}\n");

  const jsonResult = await runOrch(["result", "--run", runId, "--mr", mr, "--worktree", worktree, "--json"], env);
  expect(jsonResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(jsonResult.stdout).toBe(`${rawResult}\n`);

  const humanResult = await runOrch(["result", "--run", runId, "--worktree", worktree], env);
  expect(humanResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(humanResult.stdout).toContain("schema: orch.result/implementer/v1");
  expect(humanResult.stdout).toContain("changed_files:");
  expect(humanResult.stdout).toContain("bun test (exit 0): passed");
});
