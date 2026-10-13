import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverviewRun } from "./overview.ts";
import { fallbackRawReview, planAutoDecision, sanitizeCommentBody, withheldSection } from "./review-auto.ts";
import type { ReviewerResult } from "./types.ts";

function reviewerResult(overrides: Partial<ReviewerResult> = {}): ReviewerResult {
  return {
    schema: "orch.result/reviewer/v1",
    run_id: "run-1",
    verdict: "approve",
    reviews_run_id: "run-0",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: [],
    ...overrides,
  };
}

const fallback = reviewerResult({
  verdict: "request_changes",
  blocking_findings: [
    { id: "orch-driver-result", severity: "blocking", file: "native.jsonl", body: "claude did not return a valid orch result JSON" },
  ],
});

test("fallbackRawReview recovers result.raw.md for driver fallback results", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-review-auto-"));
  writeFileSync(join(dir, "result.raw.md"), "Real review text.\n", "utf8");
  expect(fallbackRawReview(dir, fallback)).toBe("Real review text.");
});

test("fallbackRawReview falls back to the synthetic finding body without raw file", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-review-auto-"));
  expect(fallbackRawReview(dir, fallback)).toContain("did not return a valid orch result JSON");
});

test("fallbackRawReview refuses a raw file that is a JSONL event stream", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-review-auto-"));
  writeFileSync(
    join(dir, "result.raw.md"),
    `{"type":"session","id":"x","cwd":"/Users/someone/repo"}\n{"type":"agent_start"}\n`,
    "utf8",
  );
  // machine log, not a review: keep the short driver summary instead
  expect(fallbackRawReview(dir, fallback)).toContain("did not return a valid orch result JSON");
});

test("withheldSection never contains a private-path marker itself", async () => {
  const { findPrivateLeak } = await import("./leak.ts");
  const section = withheldSection("6", "run-1", "done", "unparsed");
  expect(findPrivateLeak(section)).toBeNull();
  expect(section).toContain("orch result --run run-1");
});

test("sanitizeCommentBody relativizes worktree and home prefixes", () => {
  const body = "Bug in /Users/dev/repo/src/a.ts; state at /Users/dev/.local/state/orch/x; see /Users/dev/repo itself.";
  const clean = sanitizeCommentBody(body, "/Users/dev/repo", "/Users/dev");
  expect(clean).toBe("Bug in src/a.ts; state at ~/.local/state/orch/x; see <worktree> itself.");
  expect(sanitizeCommentBody("no paths here", "/Users/dev/repo", "/Users/dev")).toBe("no paths here");
});

test("fallbackRawReview ignores real reviewer results", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-review-auto-"));
  expect(fallbackRawReview(dir, reviewerResult())).toBeNull();
  const realBlocking = reviewerResult({
    verdict: "request_changes",
    blocking_findings: [{ id: "bug-1", severity: "blocking", file: "a.ts", body: "off by one" }],
  });
  expect(fallbackRawReview(dir, realBlocking)).toBeNull();
});

const snap = { vcs: "git" as const, head: "a".repeat(40), dirty: false, content_sha: "a".repeat(40) };
const candidate = { candidate: { source: "worktree" as const, snapshot: snap }, error: null };

const baseRun: OverviewRun = {
  repo_key: "local/demo",
  run_id: "run-1",
  mr: "42",
  role: "reviewer",
  agent: "claude",
  state: "done" as const,
  stale: false,
  verdict: "approve",
  blocking: 0,
  decided: false,
  decision: null,
  started_at: null,
  updated_at: "2026-10-13T00:00:00.000Z",
  worktree: "/tmp/wt",
  result_errors: [],
  supersedes: [],
  superseded_by: null,
  evidence_snapshot: snap,
  evidence_problem: null,
};

test("planAutoDecision accepts clean approvals and reworks blocking reviews", () => {
  const accept = planAutoDecision(baseRun, false, candidate);
  expect(accept.decision).toBe("accept");
  expect(accept.attention).toBeNull();
  const rework = planAutoDecision({ ...baseRun, verdict: "request_changes", blocking: 2 }, false, candidate);
  expect(rework.decision).toBe("rework");
  expect(rework.reason).toContain("blocking 2");
});

test("planAutoDecision never decides fallback, failed, stale, or decided runs", () => {
  const fallbackPlan = planAutoDecision(baseRun, true);
  expect(fallbackPlan.decision).toBeNull();
  expect(fallbackPlan.attention).toContain("schema fallback");

  const failed = planAutoDecision({ ...baseRun, state: "failed", verdict: null }, false);
  expect(failed.decision).toBeNull();
  expect(failed.attention).toContain("run failed");

  // Unparseable answers now fail the run, but the raw review is in the
  // comment: failed + fallback keeps the manual-decision guidance.
  const failedFallback = planAutoDecision({ ...baseRun, state: "failed", verdict: null }, true);
  expect(failedFallback.decision).toBeNull();
  expect(failedFallback.attention).toContain("decide manually");

  const stale = planAutoDecision({ ...baseRun, state: "running", stale: true }, false);
  expect(stale.decision).toBeNull();
  expect(stale.attention).toContain("orch run reap");

  const decided = planAutoDecision({ ...baseRun, decided: true }, false);
  expect(decided).toMatchObject({ decision: null, attention: null });

  // aligned with decision sweep: done without a verdict is a close, never a rework
  const noVerdict = planAutoDecision({ ...baseRun, verdict: null }, false);
  expect(noVerdict.decision).toBeNull();
  expect(noVerdict.attention).toContain("orch decision close");
});

test("planAutoDecision only accepts approvals bound to the source checkout's current snapshot", () => {
  // The source moved on after the fan-out: the approve is for another head.
  const moved = { candidate: { source: "worktree" as const, snapshot: { ...snap, head: "b".repeat(40), content_sha: "b".repeat(40) } }, error: null };
  const stale = planAutoDecision(baseRun, false, moved);
  expect(stale.decision).toBeNull();
  expect(stale.attention).toContain("stale");
  // Legacy run without an orch-captured snapshot, and an unknown candidate.
  expect(planAutoDecision({ ...baseRun, evidence_snapshot: null, evidence_problem: "no snapshot" }, false, candidate).decision).toBeNull();
  expect(planAutoDecision(baseRun, false, { candidate: null, error: "not a repo" }).decision).toBeNull();
  expect(planAutoDecision(baseRun, false, null).decision).toBeNull();
});
