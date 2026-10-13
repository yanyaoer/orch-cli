// orch status, bare overview, verdict, wait: read-side views over an MR's or thread's runs.
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RunStatus } from "../types.ts";
import { getRepoIdentity, mrStateDir } from "../paths.ts";

import { DEFAULT_ATTENTION_DAYS, assessThread, buildOverview, collectMrRuns, collectRepoKeys, describeCandidate, isTerminal, mergedBranchMrs, renderArgv, renderOverview, staleBlockerHints, resolveCandidate, suggestedRunAction, type OverviewRun } from "../overview.ts";
import { STALE_CLONE_DAYS, scanWorktreeClones } from "../worktree.ts";
import { CliError, flagBool, flagNumber, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { mrIdsForRepo, scanMrRuns } from "../run-store.ts";

function mrStatusSection(repoKey: string, mr: string): { mr: string; state_dir: string; runs: Array<RunStatus & { stale: boolean }> } {
  const root = mrStateDir(repoKey, mr);
  const runs = scanMrRuns(repoKey, mr)
    .filter((record): record is typeof record & { status: RunStatus } => record.status !== null)
    .map((record) => ({ ...record.status, stale: record.stale }));
  // Prefer the raw mr recorded in the runs over the sanitized directory name.
  return { mr: runs[0]?.mr ?? mr, state_dir: root, runs };
}

export async function statusCommand(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const explicitMr = args.flags.has("mr") ? flagString(args, "mr") : null;
  // Aggregate view hides MRs without runs (empty dirs from aborted creates);
  // an explicit --mr always shows its section, even when empty.
  const sections = (explicitMr ? [explicitMr] : mrIdsForRepo(repo.repo_key))
    .map((mr) => mrStatusSection(repo.repo_key, mr))
    .filter((section) => explicitMr !== null || section.runs.length > 0);

  if (flagBool(args, "json")) {
    if (explicitMr) {
      const section = sections[0]!;
      printJson({ repo_key: repo.repo_key, mr: section.mr, state_dir: section.state_dir, runs: section.runs });
    } else {
      printJson({ repo_key: repo.repo_key, mrs: sections });
    }
    return 0;
  }
  for (const section of sections) {
    process.stdout.write(`MR ${section.mr} (${repo.repo_key})\n`);
    for (const run of section.runs) {
      const state = run.stale ? `${run.state} (stale?)` : run.state;
      process.stdout.write(`${run.run_id}\t${state}\t${run.role}\t${run.agent}\t${run.updated_at}\n`);
    }
  }
  return 0;
}

// Bare `orch`: the shared status + pending-actions view. Text and --json are
// projections of the same aggregation, and every suggested action is a
// runnable orch command line — humans copy it, agents spawn it.
export async function overviewCommand(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const all = flagBool(args, "all");
  const attentionDays = flagNumber(args, "attention-days") ?? DEFAULT_ATTENTION_DAYS;
  if (!Number.isFinite(attentionDays) || attentionDays < 0) {
    throw new CliError("--attention-days must be a non-negative number (0 disables the window)");
  }
  const repoIdentity = await getRepoIdentity(worktree);
  const repoKeys = all ? collectRepoKeys() : [repoIdentity.repo_key];
  // Branch lifecycle only applies to the repo we have a worktree for; other
  // repos in --all mode have no local branch context to consult.
  const mergedMrs = await mergedBranchMrs(worktree);
  const archived = mergedMrs ? { repoKey: repoIdentity.repo_key, mrs: mergedMrs } : null;
  // Cross-repo suggestions need --worktree to resolve the right repo_key when
  // they are executed from elsewhere; same-repo suggestions stay short.
  const candidates = new Map([[repoIdentity.repo_key, await resolveCandidate(worktree, null)]]);
  const overview = buildOverview(repoKeys, all, { attentionDays, archived, candidates });
  // Durable clone storage plus fail-closed removal means leftovers accumulate
  // silently; surface them here so the backlog stays visible. Cheap scan only
  // (provenance + directory listing) — safety assessment happens in gc itself.
  try {
    const scan = scanWorktreeClones(worktree);
    const staleClones = scan.clones.filter(
      (clone) => !clone.dest_exists || clone.age_days === null || clone.age_days >= STALE_CLONE_DAYS,
    ).length;
    const sweepableTrash = scan.trash.length + scan.orphans.length;
    if (staleClones + sweepableTrash > 0) {
      const parts = [
        staleClones > 0 ? `${staleClones} clone${staleClones > 1 ? "s" : ""} ≥${STALE_CLONE_DAYS}d or damaged` : "",
        sweepableTrash > 0 ? `${sweepableTrash} trash/orphan entr${sweepableTrash > 1 ? "ies" : "y"}` : "",
      ].filter(Boolean);
      overview.actions.push({
        kind: "worktree_gc",
        reason: `worktree clones: ${parts.join(", ")}`,
        argv: ["orch", "worktree", "gc"],
        repo_key: repoIdentity.repo_key,
        mr: "worktree",
      });
    }
  } catch {}
  if (flagBool(args, "json")) {
    printJson(overview);
  } else {
    process.stdout.write(renderOverview(overview));
  }
  return 0;
}

export function threadMr(args: ParsedArgs): string {
  if (args.flags.has("thread")) return flagString(args, "thread");
  if (args.flags.has("mr")) return flagString(args, "mr");
  throw new CliError("missing --thread (or --mr)");
}

function headFlag(args: ParsedArgs): string | null {
  if (!args.flags.has("head")) return null;
  const head = flagString(args, "head").trim();
  if (!head) throw new CliError("--head must not be empty");
  return head;
}

export async function verdictCommand(args: ParsedArgs): Promise<number> {
  const mr = threadMr(args);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const waitSec = flagNumber(args, "wait-sec") ?? 900;
  const deadline = Date.now() + waitSec * 1000;

  let runs = collectMrRuns(repo.repo_key, mr);
  if (flagBool(args, "wait")) {
    for (;;) {
      runs = collectMrRuns(repo.repo_key, mr);
      if (runs.length > 0 && runs.every((run) => isTerminal(run.state) || run.stale)) break;
      if (Date.now() >= deadline) {
        throw new CliError(`thread ${mr} did not settle within ${waitSec}s (${runs.filter((r) => isTerminal(r.state)).length}/${runs.length} terminal)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (runs.length === 0) throw new CliError(`no runs found for thread: ${mr}`);

  // Judged against the candidate as it is now (or the pinned --head), after
  // any wait: evidence for an older snapshot never counts.
  const candidate = await resolveCandidate(worktree, headFlag(args));
  const { suggestion, reasons, assessments } = assessThread(runs, candidate);
  const supersedeHints = suggestion === "rework" ? staleBlockerHints(mr, runs, candidate) : [];
  const staleRuns = runs.filter((run) => run.stale);
  const allTerminal = runs.every((run) => isTerminal(run.state));

  const actions = runs.map((run) => suggestedRunAction(run, false, candidate)).filter((action): action is NonNullable<typeof action> => action !== null);
  if (staleRuns.length > 0) {
    actions.unshift({
      kind: "reap",
      reason: `${staleRuns.length} stale run${staleRuns.length > 1 ? "s" : ""}`,
      argv: ["orch", "run", "reap", "--mr", mr],
      repo_key: repo.repo_key,
      mr,
    });
  }

  if (flagBool(args, "json")) {
    printJson({
      thread: mr,
      all_terminal: allTerminal,
      candidate: { ...candidate, label: describeCandidate(candidate) },
      suggestion,
      reasons,
      runs: runs.map((run) => ({ ...run, assessment: assessments.get(run.run_id) })),
      actions,
      supersede_hints: supersedeHints,
    });
    return 0;
  }

  const lines: string[] = [];
  lines.push(`thread ${mr}: ${runs.filter((run) => isTerminal(run.state)).length}/${runs.length} terminal · candidate ${describeCandidate(candidate)}`);
  for (const run of runs) {
    const verdict = run.verdict ?? "-";
    const blocking = run.blocking !== null ? `blocking ${run.blocking}` : "";
    const marks = [
      run.stale ? "stale?" : "",
      run.decision ? `decided:${run.decision}` : "",
      run.superseded_by ? `superseded-by:${run.superseded_by}` : "",
      run.supersedes.length > 0 ? `supersedes:${run.supersedes.join(",")}` : "",
    ].filter(Boolean).join(" ");
    lines.push(`  ${run.run_id}  ${run.role}/${run.agent}  ${run.state}  ${verdict}  ${[blocking, marks].filter(Boolean).join("  ")}`.trimEnd());
    lines.push(`    -> ${assessments.get(run.run_id)!.outcome}: ${assessments.get(run.run_id)!.reason}`);
  }
  lines.push(`suggestion: ${suggestion}`);
  for (const reason of reasons) lines.push(`  - ${reason}`);
  actions.forEach((action, index) => {
    lines.push(`  ${index + 1}. ${renderArgv(action.argv)}`);
  });
  if (actions.length === 0) lines.push("  nothing left to do — all runs decided");
  for (const hint of supersedeHints) {
    lines.push(`hint: ${hint.role} blocker${hint.run_ids.length > 1 ? "s" : ""} ${hint.run_ids.join(", ")} judged other content than the candidate.`);
    lines.push(`  If the rework answered ${hint.run_ids.length > 1 ? "them" : "it"}, evaluate the candidate in ${hint.run_ids.length > 1 ? "their" : "its"} place:`);
    lines.push(`  ${renderArgv(hint.argv)}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

// Opaque, stateless wait cursor: the set of run ids whose terminal (or stale)
// event the caller has already consumed. Exact by construction — no event is
// returned twice for the same cursor lineage, none is skipped by clock skew.
function encodeCursor(thread: string, seen: Set<string>): string {
  return `c1.${Buffer.from(JSON.stringify({ t: thread, s: [...seen].sort() })).toString("base64url")}`;
}

function decodeCursor(raw: string, thread: string): Set<string> {
  const invalid = (why: string) => new CliError(`invalid --cursor (${why}); start with --cursor start or --cursor now`);
  if (!raw.startsWith("c1.")) throw invalid("unknown format");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw.slice(3), "base64url").toString("utf8"));
  } catch {
    throw invalid("undecodable");
  }
  const obj = value as { t?: unknown; s?: unknown };
  if (!obj || typeof obj !== "object" || typeof obj.t !== "string" || !Array.isArray(obj.s) || !obj.s.every((id) => typeof id === "string")) {
    throw invalid("malformed");
  }
  if (obj.t !== thread) throw invalid(`cursor belongs to thread ${obj.t}`);
  return new Set(obj.s as string[]);
}

function consumable(run: OverviewRun): boolean {
  return isTerminal(run.state) || run.stale;
}

// Wait-any: block until some run in the thread needs attention.
// Legacy mode (no --cursor): a decision is the ack — decided runs are never
// returned again, so the loop is `orch wait` -> decide -> `orch wait`.
// Cursor mode: notification is decoupled from adjudication — every terminal
// or stale run is returned exactly once per cursor lineage, decided or not,
// and the caller passes the returned cursor to the next call.
export async function waitCommand(args: ParsedArgs): Promise<number> {
  const mr = threadMr(args);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const timeoutSec = flagNumber(args, "timeout-sec") ?? 900;
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) throw new CliError("--timeout-sec must be a non-negative number");
  const deadline = Date.now() + timeoutSec * 1000;
  const candidate = await resolveCandidate(worktree, headFlag(args));

  let seen: Set<string> | null = null;
  if (args.flags.has("cursor")) {
    const raw = flagString(args, "cursor").trim();
    if (raw === "start") seen = new Set();
    else if (raw === "now") seen = new Set(collectMrRuns(repo.repo_key, mr).filter(consumable).map((run) => run.run_id));
    else seen = decodeCursor(raw, mr);
  }

  for (;;) {
    const runs = collectMrRuns(repo.repo_key, mr);
    if (seen !== null) {
      const next = runs.find((run) => !seen!.has(run.run_id) && consumable(run));
      if (next) {
        seen.add(next.run_id);
        const action = next.stale ? null : suggestedRunAction(next, false, candidate);
        printJson({
          kind: next.stale ? "stale" : "run_terminal",
          thread: mr,
          run: next,
          cursor: encodeCursor(mr, seen),
          reason: next.stale ? "supervisor gone" : (action?.reason ?? (next.decision ? `already decided: ${next.decision}` : next.state)),
          suggested_argv: next.stale ? ["orch", "run", "reap", "--mr", mr] : (action?.argv ?? null),
        });
        return 0;
      }
      if (runs.length > 0 && runs.every((run) => seen!.has(run.run_id) && isTerminal(run.state))) {
        printJson({ kind: "settled", thread: mr, runs: runs.length, cursor: encodeCursor(mr, seen) });
        return 0;
      }
    } else {
      if (runs.length === 0) throw new CliError(`no runs found for thread: ${mr}`);

      const stale = runs.find((run) => run.stale);
      if (stale) {
        printJson({
          kind: "stale",
          thread: mr,
          run_id: stale.run_id,
          suggested_argv: ["orch", "run", "reap", "--mr", mr],
        });
        return 0;
      }

      for (const run of runs) {
        const action = suggestedRunAction(run, false, candidate);
        if (action) {
          printJson({ kind: "run_terminal", thread: mr, run, reason: action.reason, suggested_argv: action.argv });
          return 0;
        }
      }

      if (runs.every((run) => isTerminal(run.state))) {
        printJson({ kind: "settled", thread: mr, runs: runs.length });
        return 0;
      }
    }

    if (Date.now() >= deadline) {
      throw new CliError(`no run reached a terminal state within ${timeoutSec}s (thread: ${mr})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
