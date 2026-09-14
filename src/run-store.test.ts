import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestRunId, looksStale, runListRows, scanRunsRoot } from "./run-store.ts";
import { isAcceptableOutcome } from "./overview.ts";
import type { RunStatus } from "./types.ts";

function status(overrides: Partial<RunStatus>): RunStatus {
  return {
    run_id: "run-1",
    mr: "42",
    role: "reviewer",
    agent: "claude",
    tag: "review",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    state: "done",
    pid: null,
    pgid: null,
    started_at: "2026-06-19T12:00:00.000Z",
    updated_at: "2026-06-19T12:05:00.000Z",
    exit_code: 0,
    timeout_sec: 60,
    last_event_seq: 3,
    native_event_count: 0,
    provider_resume_id: null,
    worktree: "/tmp/repo",
    base_sha: "base",
    head_sha: "head",
    ...overrides,
  };
}

function writeRun(runsRoot: string, id: string, files: Record<string, unknown>): void {
  mkdirSync(join(runsRoot, id), { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(runsRoot, id, name), `${JSON.stringify(value)}\n`);
}

test("scanRunsRoot reads every run file once and projects list rows and the latest run", () => {
  const root = mkdtempSync(join(tmpdir(), "orch-run-store-"));
  const runsRoot = join(root, "runs");
  writeRun(runsRoot, "review-b", {
    "spec.json": { run_id: "review-b", role: "reviewer" },
    "status.json": status({ run_id: "review-b", started_at: "2026-06-19T12:10:00.000Z", updated_at: "2026-06-19T12:20:00.000Z" }),
    "result.json": { schema: "orch.result/reviewer/v1", run_id: "review-b", verdict: "approve", blocking_findings: [], non_blocking_findings: [], suggested_tests: [] },
    "decision.json": { verdict: "accept", run_id: "review-b", reason: null, ts: "2026-06-19T12:21:00.000Z" },
  });
  writeRun(runsRoot, "review-a", { "status.json": status({ run_id: "review-a" }) });
  // Mid-creation: directory without status.json is reported, not skipped.
  mkdirSync(join(runsRoot, "review-c"), { recursive: true });
  try {
    const records = scanRunsRoot(runsRoot, "42");
    expect(records.map((r) => r.run_id)).toEqual(["review-c", "review-a", "review-b"]);
    const b = records.find((r) => r.run_id === "review-b")!;
    expect(b.spec?.role).toBe("reviewer");
    expect(b.result?.verdict).toBe("approve");
    expect(b.decision?.verdict).toBe("accept");
    expect(b.stale).toBe(false);
    expect(records.find((r) => r.run_id === "review-c")).toMatchObject({ mr: "42", status: null, spec: null, result: null, decision: null, stale: false });

    expect(runListRows(runsRoot).map((row) => row.run_id)).toEqual(["review-a", "review-b"]);
    expect(latestRunId(runsRoot)).toBe("review-b");
    expect(scanRunsRoot(join(root, "missing"), "42")).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("looksStale is the one rule: dead pid, or no pid and no movement for an hour", () => {
  expect(looksStale(status({ state: "done", pid: 1 }))).toBe(false);
  expect(looksStale(status({ state: "running", pid: process.pid }))).toBe(false);
  expect(looksStale(status({ state: "running", pid: 2 ** 22 - 1 }))).toBe(true);
  expect(looksStale(status({ state: "created", pid: null, updated_at: new Date().toISOString() }))).toBe(false);
  expect(looksStale(status({ state: "created", pid: null, updated_at: "2026-01-01T00:00:00.000Z" }))).toBe(true);
});

test("isAcceptableOutcome is the one accept/rework rubric", () => {
  expect(isAcceptableOutcome("approve", 0)).toBe(true);
  expect(isAcceptableOutcome("pass", null)).toBe(true);
  expect(isAcceptableOutcome("completed", 0)).toBe(true);
  expect(isAcceptableOutcome("approve", 1)).toBe(false);
  expect(isAcceptableOutcome("request_changes", 0)).toBe(false);
  expect(isAcceptableOutcome(null, 0)).toBe(false);
});
