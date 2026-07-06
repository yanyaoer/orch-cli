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
    if (raw.length > 0) return raw;
  }
  return findings[0]!.body;
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
  if (run.state !== "done") {
    return { decision: null, reason: null, attention: `run ${run.state}; inspect: orch events tail --run ${run.run_id} --native` };
  }
  if (fallback) {
    return {
      decision: null,
      reason: null,
      attention: `result schema fallback — raw review recovered into the comment; decide manually: orch decision accept|rework --run ${run.run_id}`,
    };
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
