// orch cross-review|fanout|investigate: fan one task out over several agents via the mail thread; --auto adjudicates and mirrors.
import { renameSync } from "node:fs";
import { basename } from "node:path";
import type { RoleResult, RunStatus } from "../types.ts";
import { acquirePidfileLockWait } from "../locks.ts";
import { ensureStateLayout, mrStateDir } from "../paths.ts";
import {  writeJsonExclusive } from "../json.ts";
import { argvForDisplay, createForgeAdapter, detectForge } from "../forge.ts";
import { findPrivateLeak, privateLeakAllowed } from "../leak.ts";
import { collectMrRuns, isTerminal } from "../overview.ts";
import { mailFanout, type MailFanoutOutcome } from "../mail-cli.ts";
import { fallbackRawReview, planAutoDecision, sanitizeCommentBody, withheldSection } from "../review-auto.ts";
import { inspectWorktreeLosses, removeWorktreeClone } from "../worktree.ts";
import { CliError, flagBool, flagNumber, printJson, type ParsedArgs } from "../cli.ts";
import { MIRROR_BODY_MAX_CHARS, mirrorBody, zhComments } from "../render.ts";
import { assertMirrorBodySafe, enqueueComment, forgeRefFor, pendingOutboxFiles, scanMrRuns, sentOutboxDir } from "../run-store.ts";

import { mailFanoutContext } from "./mailctl.ts";

// cross-review: one diff reviewed in parallel by distinct model families.
// --auto inlines the follow-up ritual: wait for this fan-out's runs to settle,
// record the unambiguous decisions, queue ONE merged mirror comment (dry-run
// preview unless --execute).
export async function crossReviewCommand(args: ParsedArgs): Promise<number> {
  const auto = flagBool(args, "auto");
  for (const flag of ["execute", "wait-sec"]) {
    if (!auto && args.flags.has(flag)) throw new CliError(`--${flag} requires --auto`);
  }
  const outcome = await mailFanout(args, mailFanoutContext(), {
    command: "cross-review",
    role: "reviewer",
    defaultAgentIds: ["claude-reviewer", "omp-reviewer"],
    extraFlags: ["auto", "execute", "wait-sec", "rework"],
  });
  if (!auto || outcome.code !== 0 || outcome.dry_run) {
    printJson(outcome.payload);
    return outcome.code;
  }
  return crossReviewAuto(args, outcome);
}

// fanout: generic — run any result role across --to-agent / auto-invited agents.
export async function fanoutCommand(args: ParsedArgs): Promise<number> {
  const outcome = await mailFanout(args, mailFanoutContext(), { command: "fanout" });
  printJson(outcome.payload);
  return outcome.code;
}

// investigate: read-only research/analysis, defaults to the gemini + claude
// researchers. Researcher (not reviewer) role: research questions deliver a
// recommendation, not an approve/request_changes verdict.
export async function investigateCommand(args: ParsedArgs): Promise<number> {
  const outcome = await mailFanout(args, mailFanoutContext(), {
    command: "investigate",
    role: "researcher",
    defaultAgentIds: ["omp-researcher", "claude-researcher"],
  });
  printJson(outcome.payload);
  return outcome.code;
}

// ---------------------------------------------------------------------------
// orch new: one-sentence task -> researcher drafts a plan -> human confirms in
// the terminal -> the same provider session resumes as a controller and
// dispatches/drives the work. Plan phase is mechanically read-only (researcher
// role); only the confirmed session gets the controller's `Bash(orch *)` reach.

function runIdOfClaim(run: unknown): string | null {
  if (run && typeof run === "object" && typeof (run as { run_id?: unknown }).run_id === "string") {
    return (run as { run_id: string }).run_id;
  }
  return null;
}

// A fallback result's synthetic finding is a driver error message, not a
// review; the comment carries the recovered raw review text instead.
function unparsedRunSection(mr: string, runId: string, state: string, raw: string): string {
  const zh = zhComments();
  const truncated = zh
    ? `…(原始评审已截断;其余内容请运行 \`orch result --run ${runId}\` 查看)`
    : `…(raw review truncated; run \`orch result --run ${runId}\` for the rest)`;
  const text = raw.length > MIRROR_BODY_MAX_CHARS ? `${raw.slice(0, MIRROR_BODY_MAX_CHARS)}\n\n${truncated}` : raw;
  return [
    zh ? "### orch 运行结果" : "### orch run result",
    "",
    `- MR/PR: ${mr}`,
    `- ${zh ? "运行" : "Run"}: ${runId}`,
    `- ${zh ? "状态" : "State"}: ${state}`,
    zh ? "- 结论: unparsed(driver schema 回退 — 原始评审见下)" : "- Verdict: unparsed (driver schema fallback — raw review below)",
    "",
    text,
  ].join("\n");
}

// The auto phase acts only on the runs THIS fan-out claimed — never on the
// thread's history — and decides only unambiguous outcomes (planAutoDecision).
// Rework/fallback/failed runs are surfaced with the exact follow-up command
// instead of being auto-driven: no unbounded impl↔review loops.
async function crossReviewAuto(args: ParsedArgs, outcome: MailFanoutOutcome): Promise<number> {
  const execute = flagBool(args, "execute");
  const waitSec = flagNumber(args, "wait-sec") ?? 900;
  if (!Number.isFinite(waitSec) || waitSec <= 0) throw new CliError("--wait-sec must be positive");
  const runIds = new Set(outcome.runs.map((item) => runIdOfClaim(item.run)).filter((id): id is string => id !== null));
  if (runIds.size === 0) {
    printJson({
      ...outcome.payload,
      auto: "skipped",
      reason: `no new runs claimed (thread tasks already acked); follow up with: orch verdict --thread ${outcome.thread} --wait`,
    });
    return 0;
  }
  const mr = outcome.runs[0]!.mr;
  const repoKey = outcome.repo_key;

  const deadline = Date.now() + waitSec * 1000;
  let tracked = collectMrRuns(repoKey, mr).filter((run) => runIds.has(run.run_id));
  while (!(tracked.length === runIds.size && tracked.every((run) => isTerminal(run.state) || run.stale))) {
    if (Date.now() >= deadline) {
      throw new CliError(
        `--auto timed out after ${waitSec}s (${tracked.filter((run) => isTerminal(run.state)).length}/${runIds.size} terminal); runs continue — follow up with: orch verdict --thread ${outcome.thread} --wait`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    tracked = collectMrRuns(repoKey, mr).filter((run) => runIds.has(run.run_id));
  }

  // Every run is terminal: the fan-out's CoW clone has served its purpose.
  // The timeout path above throws before this line, so runs that continue
  // past --wait-sec keep their clone (remove_with stays in the payload).
  let cloneReport: Record<string, unknown> | null = null;
  if (outcome.clone) {
    const removed = removeWorktreeClone(outcome.clone.source, outcome.clone.dest);
    cloneReport = removed
      ? { dest: outcome.clone.dest, removed: true }
      : {
          dest: outcome.clone.dest,
          removed: false,
          losses: inspectWorktreeLosses(outcome.clone.source, outcome.clone.dest).losses,
          remove_with: outcome.clone.remove_with,
        };
  }

  const mrDir = mrStateDir(repoKey, mr);
  ensureStateLayout(mrDir);
  const runsRoot = `${mrDir}/runs`;
  const records = new Map(scanMrRuns(repoKey, mr).map((record) => [record.run_id, record]));
  const ts = new Date().toISOString();

  // Pass 1 — read-only: results, decision plans, comment sections. Nothing is
  // written until the merged body has passed the leak guard, mirroring
  // decisionCommand()'s ordering: a body that can't be mirrored must never leave
  // decided-but-unmirrored runs behind (recovery would hit EEXIST).
  const zh = zhComments();
  const sections: string[] = [];
  const attention: string[] = [];
  const reportRuns: Array<Record<string, unknown>> = [];
  const plans: Array<{ run_id: string; decision: "accept" | "rework"; reason: string | null; report: Record<string, unknown> }> = [];
  for (const run of tracked) {
    // failed/timeout/stale runs may never have written result.json; surface
    // them instead of crashing — and never decide a run without a result.
    const result = records.get(run.run_id)?.result ?? null;
    const status = records.get(run.run_id)?.status ?? null;
    const raw = result ? fallbackRawReview(`${runsRoot}/${run.run_id}`, result) : null;
    const plan =
      result === null
        ? { decision: null, reason: null, attention: `no result.json; inspect: orch events tail --run ${run.run_id} --native` }
        : planAutoDecision(run, raw !== null);
    if (plan.attention) attention.push(`${run.run_id} (${run.agent}): ${plan.attention}`);

    const verdict = result === null ? null : raw !== null ? "unparsed" : run.verdict;
    let section =
      result === null
        ? [
            zh ? "### orch 运行结果" : "### orch run result",
            "",
            `- MR/PR: ${mr}`,
            `- ${zh ? "运行" : "Run"}: ${run.run_id}`,
            `- ${zh ? "状态" : "State"}: ${run.state}`,
            zh ? "- 结论: 无(缺少 result.json)" : "- Verdict: none (no result.json)",
          ].join("\n")
        : raw !== null
          ? unparsedRunSection(mr, run.run_id, run.state, raw)
          : mirrorBody(mr, run.run_id, result, status);
    // Reviewer prose quotes absolute local paths as a matter of course:
    // relativize the known prefixes, and withhold a section that still trips
    // the guard rather than aborting the whole auto phase on honest content.
    // Clone runs quote clone paths, not worktree paths; relativize those first.
    if (outcome.clone) section = sanitizeCommentBody(section, outcome.clone.dest, undefined);
    section = sanitizeCommentBody(section, outcome.worktree, process.env.HOME);
    const leak = privateLeakAllowed() ? null : findPrivateLeak(section);
    if (leak) {
      // The marker string may only go to stdout (attention), never into the
      // comment body — it would re-trigger the leak guard on the merged body.
      section = withheldSection(mr, run.run_id, run.state, verdict ?? "-");
      attention.push(`${run.run_id} (${run.agent}): comment section withheld (private path ${leak.marker})`);
    }
    sections.push(section);

    const report: Record<string, unknown> = {
      run_id: run.run_id,
      agent: run.agent,
      state: run.state,
      verdict,
      blocking: run.blocking,
      decision: plan.decision,
      attention: plan.attention,
    };
    reportRuns.push(report);
    if (plan.decision) plans.push({ run_id: run.run_id, decision: plan.decision, reason: plan.reason, report });
  }

  const header = [
    zh ? "### orch 交叉评审" : "### orch cross-review",
    "",
    `- MR/PR: ${mr}`,
    `- ${zh ? "线程" : "Thread"}: ${outcome.thread}`,
    `- ${zh ? "运行" : "Runs"}: ${tracked.map((run) => `${run.agent}/${run.run_id}`).join(", ")}`,
  ].join("\n");
  let body = [header, ...sections].join("\n\n---\n\n");
  // Per-section caps don't bound the sum; GitHub rejects comments over 65536.
  if (body.length > MIRROR_BODY_MAX_CHARS) {
    const truncated = zh
      ? "…(评论已截断;完整结果请运行 `orch result --run <run_id>` 查看)"
      : "…(comment truncated; run `orch result --run <run_id>` for the full results)";
    body = `${body.slice(0, MIRROR_BODY_MAX_CHARS)}\n\n${truncated}`;
  }
  assertMirrorBodySafe(body); // before any write: a leaky body aborts cleanly with nothing recorded

  const forge = detectForge(outcome.remote_url);
  const adapter = forge === "none" ? null : createForgeAdapter(forge, execute, outcome.worktree);
  if (forge !== "none" && !adapter) throw new CliError(`unsupported forge: ${forge}`);

  // On --execute, hold the outbox lock across enqueue→post→rename: enqueueing
  // outside the lock lets a concurrent `mirror sync --execute` send the pending
  // file first and this command post the same comment a second time.
  const outboxLock = execute ? await acquirePidfileLockWait(`${mrDir}/locks/outbox.lock`, 10_000) : null;
  let comment: Record<string, unknown>;
  let sendFailed = false;
  let queuedName: string | null = null;
  try {
    const outboxPath = enqueueComment(mrDir, { kind: "comment", mr, body, created_at: ts });
    queuedName = basename(outboxPath);
    for (const plan of plans) {
      try {
        writeJsonExclusive(`${runsRoot}/${plan.run_id}/decision.json`, { verdict: plan.decision, run_id: plan.run_id, reason: plan.reason, ts });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        plan.report.decision = "already-decided";
      }
    }
    comment = { outbox_path: outboxPath, mode: "queued", forge };
    if (adapter) {
      const command = await adapter.postComment(forgeRefFor(mrDir, mr), body);
      const success = command.exit_code === 0;
      let finalPath = outboxPath;
      if (execute && success) {
        finalPath = `${sentOutboxDir(mrDir)}/${basename(outboxPath)}`;
        renameSync(outboxPath, finalPath);
      }
      sendFailed = execute && !success;
      comment = {
        outbox_path: finalPath,
        mode: execute ? (success ? "sent" : "failed") : "dry-run",
        forge,
        command: argvForDisplay(command.argv),
        exit_code: command.exit_code,
      };
      if (command.stderr) process.stderr.write(command.stderr);
    } else {
      comment = { ...comment, note: "no github/gitlab remote; comment stays queued" };
    }
  } finally {
    outboxLock?.release();
  }

  // --auto sends only its own comment; older queued comments stay untouched.
  const otherPending = pendingOutboxFiles(mrDir).filter((file) => file !== queuedName);
  printJson({
    mail: "cross-review",
    auto: true,
    thread: outcome.thread,
    mr,
    fanout: outcome.payload,
    runs: reportRuns,
    comment,
    attention,
    ...(cloneReport ? { clone: cloneReport } : {}),
    ...(otherPending.length > 0 ? { other_pending_outbox: otherPending.length, other_pending_hint: `orch mirror sync --mr ${mr}` } : {}),
    ...(execute ? {} : { next: `orch mirror sync --mr ${mr} --execute` }),
  });
  return sendFailed ? 1 : 0;
}
