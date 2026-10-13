// orch decision accept|rework|close|sweep: record decision.json (O_EXCL) and queue the mirror comment.
import { basename, resolve } from "node:path";
import { ensureStateLayout, getRepoIdentity, mrStateDir } from "../paths.ts";
import { readJsonFile, writeJsonExclusive } from "../json.ts";
import { evidenceRoles, isRunRole } from "../types.ts";
import { assessRun, collectMrRuns, describeCandidate, isTerminal, mrDirsForRepo, resolveCandidate, type CandidateResolution } from "../overview.ts";
import { CliError, flagBool, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { decisionBody } from "../render.ts";
import { assertMirrorBodySafe, enqueueComment, locateRun, readMirrorResult,  type DecisionRecord, type DecisionVerdict } from "../run-store.ts";

export async function decisionCommand(args: ParsedArgs): Promise<number> {
  const verdict = args.positionals[1];
  if (verdict === "sweep") return decisionSweep(args);
  if (verdict !== "accept" && verdict !== "rework" && verdict !== "close") {
    throw new CliError("usage: orch decision accept|rework|close --run <run_id> [--mr <id>] [--reason <text>] [--head <rev>] [--worktree <path>], or orch decision sweep [--mr <id>] [--head <rev>] [--execute]");
  }
  const runId = flagString(args, "run");
  const reason = args.flags.has("reason") ? flagString(args, "reason") : null;
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  // --mr optional: the run id is unique enough to locate its MR by scanning.
  const mr = locateRun(repo.repo_key, runId, args.flags.has("mr") ? flagString(args, "mr") : undefined).mr;
  const mrDir = mrStateDir(repo.repo_key, mr);
  ensureStateLayout(mrDir);

  const runsRoot = `${mrDir}/runs`;
  // accept is a claim about the current candidate, so it goes through the
  // shared rubric: invalid/failed/superseded results and reviewer/verifier
  // evidence for another snapshot are refused, not recorded.
  if (verdict === "accept") {
    const candidate = await resolveCandidate(worktree, headFlag(args));
    const run = collectMrRuns(repo.repo_key, mr).find((item) => item.run_id === runId);
    if (!run) throw new CliError(`run not found: ${runId}`);
    const assessment = assessRun(run, candidate);
    if (assessment.outcome !== "accept") {
      throw new CliError(
        `refusing to accept ${runId}: ${assessment.reason} (candidate ${describeCandidate(candidate)}); use rework/close, or re-run the review/verify against the current candidate`,
      );
    }
  }
  const ts = new Date().toISOString();
  const record: DecisionRecord = { verdict, run_id: runId, reason, ts };
  // close is a pure ack: no PR/MR comment rides on it, so no body is built.
  let body: string | null = null;
  if (verdict !== "close") {
    const { result, status } = readMirrorResult(runsRoot, runId);
    body = decisionBody(mr, runId, record, result, status);
    assertMirrorBodySafe(body);
  }
  const runDir = `${runsRoot}/${runId}`;
  writeDecisionExclusive(runDir, record);

  const outboxPath =
    body === null
      ? null
      : enqueueComment(mrDir, {
          kind: "comment",
          mr,
          body,
          created_at: ts,
        });

  printJson({
    decision: verdict,
    mr,
    run_id: runId,
    decision_path: `${runDir}/decision.json`,
    outbox_path: outboxPath,
  });
  return 0;
}

function headFlag(args: ParsedArgs): string | null {
  if (!args.flags.has("head")) return null;
  const head = flagString(args, "head").trim();
  if (!head) throw new CliError("--head must not be empty");
  return head;
}

// decision.json is the run's atomic ack: O_EXCL create-or-fail, so two
// controllers racing on the same run get one winner and one clear error —
// never a silent overwrite plus a second queued mirror comment.
function writeDecisionExclusive(runDir: string, record: DecisionRecord): void {
  try {
    writeJsonExclusive(`${runDir}/decision.json`, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const prior = readJsonFile<DecisionRecord | null>(`${runDir}/decision.json`, null);
      throw new CliError(
        `run ${record.run_id} already decided (${prior?.verdict ?? "unknown"}${prior?.ts ? ` at ${prior.ts}` : ""}); not queueing another mirror comment`,
      );
    }
    throw error;
  }
}

// Batch-ack the backlog: record the obvious decision for every undecided
// terminal run, following the same rubric the overview suggests. Sweep never
// queues mirror comments — it clears attention debt; runs that deserve a PR
// comment should go through a single `orch decision accept|rework`.
async function decisionSweep(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const execute = flagBool(args, "execute");
  const repo = await getRepoIdentity(worktree);
  const mrFilter = args.flags.has("mr") ? flagString(args, "mr") : null;
  const mrDirNames = mrFilter ? [basename(mrStateDir(repo.repo_key, mrFilter))] : mrDirsForRepo(repo.repo_key);

  const candidate: CandidateResolution = await resolveCandidate(worktree, headFlag(args));
  const planned: Array<{ mr: string; run_id: string; verdict: DecisionVerdict; reason: string }> = [];
  // Left undecided on purpose: sweep never launders a failed, contradictory,
  // or unbound reviewer/verifier result into the ledger.
  const manual: Array<{ mr: string; run_id: string; reason: string }> = [];
  for (const mrDirName of mrDirNames) {
    for (const run of collectMrRuns(repo.repo_key, mrDirName)) {
      if (!isTerminal(run.state) || run.decided) continue;
      // stale/cancelled runs are already retired by reap/cancel; leave them out
      // of the decision ledger, mirroring suggestedRunAction.
      if (run.state === "stale" || run.state === "cancelled") continue;
      const assessment = assessRun(run, candidate);
      const evidenceRole = isRunRole(run.role) && evidenceRoles.has(run.role);
      if (assessment.outcome === "accept" || assessment.outcome === "rework" || assessment.outcome === "close") {
        planned.push({ mr: run.mr, run_id: run.run_id, verdict: assessment.outcome, reason: `sweep: ${assessment.reason}` });
      } else if (!evidenceRole && (run.state !== "done" || run.verdict === null)) {
        planned.push({ mr: run.mr, run_id: run.run_id, verdict: "close", reason: run.state !== "done" ? `sweep: run ${run.state}` : "sweep: done without result" });
      } else {
        manual.push({ mr: run.mr, run_id: run.run_id, reason: assessment.reason });
      }
    }
  }

  if (!execute) {
    printJson({ sweep: "dry-run", repo_key: repo.repo_key, candidate: describeCandidate(candidate), planned, manual, hint: "re-run with --execute to record these decisions (no mirror comments are queued)" });
    return 0;
  }

  const decided: typeof planned = [];
  const skipped: Array<{ mr: string; run_id: string; error: string }> = [];
  const ts = new Date().toISOString();
  for (const plan of planned) {
    const runDir = `${mrStateDir(repo.repo_key, plan.mr)}/runs/${plan.run_id}`;
    try {
      writeJsonExclusive(`${runDir}/decision.json`, { verdict: plan.verdict, run_id: plan.run_id, reason: plan.reason, ts });
      decided.push(plan);
    } catch (error) {
      skipped.push({
        mr: plan.mr,
        run_id: plan.run_id,
        error: (error as NodeJS.ErrnoException).code === "EEXIST" ? "already decided" : String(error),
      });
    }
  }
  printJson({ sweep: "executed", repo_key: repo.repo_key, candidate: describeCandidate(candidate), decided, skipped, manual });
  return skipped.length > 0 ? 1 : 0;
}
