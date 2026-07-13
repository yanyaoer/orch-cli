// Pure decision logic behind `orch cross-review --auto`: which runs the auto
// phase may decide on its own, and how to recover the real review text when a
// driver fell back to the synthetic schema-failure result. Read-only: writing
// decisions and queueing comments stays in orch.ts.

import { existsSync, readFileSync } from "node:fs";
import type { RoleResult } from "./types.ts";
import { isGoodVerdict, isTerminal, type OverviewRun } from "./overview.ts";

// The reviewer fallback the driver writes when the worker's answer doesn't fit
// the canonical schema (drivers/driver-common.ts synthesizeResult): exactly one
// synthetic blocking finding pointing at native.jsonl. Its body is a driver
// error message, not a review — mirroring it verbatim would post misleading
// placeholder content to the MR. The worker's real answer is preserved in
// result.raw.md next to it.
export function fallbackRawReview(runDir: string, result: RoleResult): string | null {
  if (result.schema !== "orch.result/reviewer/v1") return null;
  const findings = result.blocking_findings;
  if (findings.length !== 1 || findings[0]!.id !== "orch-driver-result") return null;
  const rawPath = `${runDir}/result.raw.md`;
  if (existsSync(rawPath)) {
    const raw = readFileSync(rawPath, "utf8").trim();
    if (raw.length > 0 && !looksLikeEventStream(raw)) return raw;
  }
  return findings[0]!.body;
}

// A "raw review" that is actually the provider's JSONL event stream (a worker
// dying before any prose leaves rawResultText holding the stream itself) is a
// machine log, not a review — keep the short driver summary instead.
function looksLikeEventStream(raw: string): boolean {
  const first = raw.split("\n", 1)[0]!.trim();
  if (!first.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(first);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

// Reviewer prose quotes absolute local paths as a matter of course (worktree
// files, state dirs). Relativize the known prefixes so honest content passes
// the mirror leak guard; the caller withholds any section still carrying a
// private marker instead of crashing the whole auto phase.
export function sanitizeCommentBody(text: string, worktree: string, home: string | undefined): string {
  let out = text.replaceAll(`${worktree}/`, "").replaceAll(worktree, "<worktree>");
  if (home && home.length > 1) out = out.replaceAll(`${home}/`, "~/").replaceAll(home, "~");
  return out;
}

// Replacement for a comment section that still trips the leak guard after
// sanitizing. Deliberately does NOT name the detected marker: the marker
// string is itself a private-path marker ("/Users/", ".claude", …), so
// quoting it would re-trigger the guard on the merged body — a reviewer
// finding that QUOTED the marker list is exactly how this was discovered.
export function withheldSection(mr: string, runId: string, state: string, verdict: string): string {
  return [
    "### orch run result",
    "",
    `- MR/PR: ${mr}`,
    `- Run: ${runId}`,
    `- State: ${state}`,
    `- Verdict: ${verdict}`,
    "",
    `Content withheld: contains a private local path; read it with \`orch result --run ${runId}\`.`,
  ].join("\n");
}

export interface AutoDecisionPlan {
  decision: "accept" | "rework" | null;
  reason: string | null;
  // Why --auto refuses to decide; surfaced to the caller instead of guessed at.
  attention: string | null;
}

type AutoRun = Pick<OverviewRun, "run_id" | "mr" | "state" | "verdict" | "blocking" | "stale" | "decided">;

// Only the two unambiguous outcomes are decided automatically. Everything else
// (schema fallback, failed/timeout, stale, already decided) is surfaced, never
// guessed: --auto must not launder uncertain results into the decision ledger.
export function planAutoDecision(run: AutoRun, fallback: boolean): AutoDecisionPlan {
  if (run.stale) {
    return { decision: null, reason: null, attention: `supervisor gone; run: orch run reap --mr ${run.mr}` };
  }
  if (!isTerminal(run.state)) {
    return { decision: null, reason: null, attention: `still ${run.state}` };
  }
  if (run.decided) return { decision: null, reason: null, attention: null };
  // Fallback outranks the state check: the driver exits nonzero when the
  // answer doesn't parse, so these runs arrive `failed` — but the raw review
  // is already in the comment, and manual-decision guidance beats a bare
  // inspect hint.
  if (fallback) {
    return {
      decision: null,
      reason: null,
      attention: `result schema fallback — raw review recovered into the comment; decide manually: orch decision accept|rework --run ${run.run_id}`,
    };
  }
  if (run.state !== "done") {
    return { decision: null, reason: null, attention: `run ${run.state}; inspect: orch events tail --run ${run.run_id} --native` };
  }
  // decision sweep treats done-without-verdict as a close, not a rework; keep
  // the rubrics aligned but stay conservative — --auto only surfaces it.
  if (run.verdict === null) {
    return { decision: null, reason: null, attention: `done without a result verdict; ack with: orch decision close --run ${run.run_id}` };
  }
  if (isGoodVerdict(run.verdict) && (run.blocking ?? 0) === 0) {
    return { decision: "accept", reason: `cross-review --auto: reviewer ${run.verdict}`, attention: null };
  }
  return {
    decision: "rework",
    reason: `cross-review --auto: ${run.verdict ?? "no verdict"}${run.blocking ? ` · blocking ${run.blocking}` : ""}`,
    attention: null,
  };
}
