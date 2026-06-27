import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
import type { ReviewerResult, RunSpec, RunStatus } from "./types.ts";

test("supervisor records terminal failure when driver spawn throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-supervisor-"));
  const runDir = join(root, "run");
  const missingWorktree = join(root, "missing-worktree");
  const spec: RunSpec = {
    version: 1,
    run_id: "review-spawn-failure",
    mr: "spawn-failure",
    role: "reviewer",
    agent: "codex",
    tag: "review",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: "spawn-failure",
    repo_key: "local/repo",
    worktree: missingWorktree,
    task_path: null,
    task_text: "review",
    task_sha: "sha",
    base_sha: "base",
    timeout_sec: 5,
    created_at: "2026-06-25T00:00:00.000Z",
  };
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  writeInitialRunFiles(runDir, spec);

  const exitCode = await runSupervisor(runDir, [process.execPath, "src/orch.ts"]);
  expect(exitCode).toBe(1);
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
  expect(status).toMatchObject({ state: "failed", exit_code: 1, head_sha: null });
  const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as ReviewerResult;
  expect(result).toMatchObject({ schema: "orch.result/reviewer/v1", verdict: "request_changes" });
  expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain("\"type\":\"failed\"");
});
