// orch status, bare overview, verdict, wait: read-side views over an MR's or thread's runs.
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RunStatus } from "../types.ts";
import { getRepoIdentity, mrStateDir } from "../paths.ts";
import { readJsonFile } from "../json.ts";
import { DEFAULT_ATTENTION_DAYS, buildOverview, collectMrRuns, collectRepoKeys, isGoodVerdict, isTerminal, mergedBranchMrs, renderArgv, renderOverview, suggestedRunAction } from "../overview.ts";
import { STALE_CLONE_DAYS, scanWorktreeClones } from "../worktree.ts";
import { CliError, flagBool, flagNumber, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { looksStale, mrIdsForRepo } from "../run-store.ts";

function mrStatusSection(repoKey: string, mr: string): { mr: string; state_dir: string; runs: Array<RunStatus & { stale: boolean }> } {
  const root = mrStateDir(repoKey, mr);
  const runsRoot = `${root}/runs`;
  const runs = existsSync(runsRoot)
    ? readdirSync(runsRoot)
        .map((id) => readJsonFile<RunStatus | null>(`${runsRoot}/${id}/status.json`, null))
        .filter((item): item is RunStatus => item !== null)
        .map((run) => ({ ...run, stale: looksStale(run) }))
    : [];
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
  const overview = buildOverview(repoKeys, all, { attentionDays, archived });
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

  const staleRuns = runs.filter((run) => run.stale);
  const allTerminal = runs.every((run) => isTerminal(run.state));
  const suggestion = staleRuns.length > 0
    ? "reap"
    : !allTerminal
      ? "pending"
      : runs.some((run) => run.state === "failed" || run.state === "timeout")
        ? "inspect"
        : runs.some((run) => (run.blocking ?? 0) > 0 || (run.verdict !== null && !isGoodVerdict(run.verdict)))
          ? "rework"
          : "accept";

  const actions = runs.map((run) => suggestedRunAction(run, false)).filter((action) => action !== null);
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
    printJson({ thread: mr, all_terminal: allTerminal, suggestion, runs, actions });
    return 0;
  }

  const lines: string[] = [];
  lines.push(`thread ${mr}: ${runs.filter((run) => isTerminal(run.state)).length}/${runs.length} terminal`);
  for (const run of runs) {
    const verdict = run.verdict ?? "-";
    const blocking = run.blocking !== null ? `blocking ${run.blocking}` : "";
    const marks = [run.stale ? "stale?" : "", run.decided ? "decided" : ""].filter(Boolean).join(" ");
    lines.push(`  ${run.run_id}  ${run.role}/${run.agent}  ${run.state}  ${verdict}  ${[blocking, marks].filter(Boolean).join("  ")}`.trimEnd());
  }
  lines.push(`suggestion: ${suggestion}`);
  actions.forEach((action, index) => {
    lines.push(`  ${index + 1}. ${renderArgv(action.argv)}`);
  });
  if (actions.length === 0) lines.push("  nothing left to do — all runs decided");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

// Wait-any: block until some run in the thread needs attention. A decision is
// the natural ack — decided runs are never returned again, so the agent loop
// is `orch wait` -> handle -> `orch wait` until it reports settled.
export async function waitCommand(args: ParsedArgs): Promise<number> {
  const mr = threadMr(args);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const timeoutSec = flagNumber(args, "timeout-sec") ?? 900;
  const deadline = Date.now() + timeoutSec * 1000;

  for (;;) {
    const runs = collectMrRuns(repo.repo_key, mr);
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
      const action = suggestedRunAction(run, false);
      if (action) {
        printJson({ kind: "run_terminal", thread: mr, run, reason: action.reason, suggested_argv: action.argv });
        return 0;
      }
    }

    if (runs.every((run) => isTerminal(run.state))) {
      printJson({ kind: "settled", thread: mr, runs: runs.length });
      return 0;
    }

    if (Date.now() >= deadline) {
      throw new CliError(`no run reached a terminal state within ${timeoutSec}s (thread: ${mr})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
