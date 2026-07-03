// Shared aggregation layer behind the bare `orch` overview, `orch verdict`,
// and `orch wait`. One contract, all consumers: every pending action is
// expressed as a runnable orch argv, so the command a human copies from the
// overview and the command an agent spawns from --json are the same audited
// line. Read-only: this module never writes state.

import { existsSync, readdirSync } from "node:fs";
import type { RunState, RunStatus } from "./types.ts";
import { readJsonFile } from "./json.ts";
import { mrStateDir, orchStateRoot } from "./paths.ts";
import { isPidAlive } from "./locks.ts";

export interface OverviewRun {
  repo_key: string;
  mr: string;
  run_id: string;
  role: string;
  agent: string;
  state: RunState;
  stale: boolean;
  verdict: string | null;
  blocking: number | null;
  decided: boolean;
  started_at: string | null;
  updated_at: string;
  worktree: string;
}

export type ActionKind = "decision" | "inspect" | "reap" | "mirror_sync";

export interface OverviewAction {
  kind: ActionKind;
  reason: string;
  argv: string[];
  repo_key: string;
  mr: string;
  run_id?: string;
}

export interface Overview {
  scanned_repos: string[];
  active: OverviewRun[];
  actions: OverviewAction[];
  settled: number;
}

const nonTerminal = new Set<RunState>(["created", "starting", "running"]);

// Verdicts that mean "this run's work is acceptable" across the role schemas.
const goodVerdicts = new Set(["approve", "pass", "completed"]);

export function isGoodVerdict(verdict: string | null): boolean {
  return verdict !== null && goodVerdicts.has(verdict);
}

function looksStale(status: RunStatus): boolean {
  if (!nonTerminal.has(status.state)) return false;
  if (status.pid !== null) return !isPidAlive(status.pid);
  // Orphaned before spawn: no pid was ever recorded and the run has not moved
  // in over an hour (same heuristic as `orch run reap`).
  const ageMs = Date.now() - Date.parse(status.updated_at ?? "");
  return Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000;
}

export function isTerminal(state: RunState): boolean {
  return !nonTerminal.has(state);
}

export function collectMrRuns(repoKey: string, mr: string): OverviewRun[] {
  const runsRoot = `${mrStateDir(repoKey, mr)}/runs`;
  if (!existsSync(runsRoot)) return [];
  const runs: OverviewRun[] = [];
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = `${runsRoot}/${entry.name}`;
    const status = readJsonFile<RunStatus | null>(`${runDir}/status.json`, null);
    if (!status) continue;
    const result = readJsonFile<{ verdict?: unknown; blocking_findings?: unknown } | null>(`${runDir}/result.json`, null);
    runs.push({
      repo_key: repoKey,
      mr: status.mr,
      run_id: status.run_id,
      role: status.role,
      agent: status.agent,
      state: status.state,
      stale: looksStale(status),
      verdict: typeof result?.verdict === "string" ? result.verdict : null,
      blocking: Array.isArray(result?.blocking_findings) ? result.blocking_findings.length : null,
      decided: existsSync(`${runDir}/decision.json`),
      started_at: status.started_at,
      updated_at: status.updated_at,
      worktree: status.worktree,
    });
  }
  return runs.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "") || a.run_id.localeCompare(b.run_id));
}

// Directory names under <repo>/mrs are sanitized at write time; the raw mr id
// is recovered from each run's status.json by collectMrRuns.
function mrDirsForRepo(repoKey: string): string[] {
  const root = `${orchStateRoot()}/${repoKey}/mrs`;
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Enumerate every repo_key under the state root (a repo is any directory that
// contains an mrs/ child). repo keys nest (host/namespace/project-hash), so
// walk a few levels instead of assuming a fixed depth.
export function collectRepoKeys(): string[] {
  const root = orchStateRoot();
  const repos: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 4 || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name === "mrs")) {
      repos.push(rel);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "worktree-locks") continue;
      walk(`${dir}/${entry.name}`, rel ? `${rel}/${entry.name}` : entry.name, depth + 1);
    }
  };
  walk(root, "", 0);
  return repos.sort();
}

export function suggestedRunAction(run: OverviewRun, withWorktree: boolean): OverviewAction | null {
  if (!isTerminal(run.state) || run.decided) return null;
  // stale/cancelled runs are managed by reap, not by per-run decisions.
  if (run.state === "stale" || run.state === "cancelled") return null;
  const worktreeFlags = withWorktree ? ["--worktree", run.worktree] : [];
  if (run.state === "done") {
    const good = run.verdict !== null && goodVerdicts.has(run.verdict) && (run.blocking ?? 0) === 0;
    const verdictText = run.verdict ?? "no verdict";
    const blockingText = run.blocking !== null ? ` · blocking ${run.blocking}` : "";
    return {
      kind: "decision",
      reason: `done · ${run.role} ${verdictText}${blockingText} · no decision`,
      argv: [
        "orch", "decision", good ? "accept" : "rework",
        "--run", run.run_id, "--mr", run.mr,
        "--reason", `${run.role} ${verdictText}`,
        ...worktreeFlags,
      ],
      repo_key: run.repo_key,
      mr: run.mr,
      run_id: run.run_id,
    };
  }
  return {
    kind: "inspect",
    reason: `${run.state} · no decision`,
    argv: ["orch", "result", "--run", run.run_id, "--mr", run.mr, ...worktreeFlags],
    repo_key: run.repo_key,
    mr: run.mr,
    run_id: run.run_id,
  };
}

function pendingOutboxCount(repoKey: string, mrDirName: string): number {
  const pendingDir = `${orchStateRoot()}/${repoKey}/mrs/${mrDirName}/outbox/pending`;
  if (!existsSync(pendingDir)) return 0;
  return readdirSync(pendingDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
}

export function buildOverview(repoKeys: string[], withWorktree: boolean): Overview {
  const active: OverviewRun[] = [];
  const decisions: OverviewAction[] = [];
  const tail: OverviewAction[] = [];
  let settled = 0;

  for (const repoKey of repoKeys) {
    for (const mrDirName of mrDirsForRepo(repoKey)) {
      const runs = collectMrRuns(repoKey, mrDirName);
      let mr = mrDirName;
      let staleCount = 0;
      let sampleWorktree: string | null = null;
      for (const run of runs) {
        mr = run.mr;
        sampleWorktree = run.worktree;
        if (run.stale) staleCount += 1;
        else if (!isTerminal(run.state)) active.push(run);
        const action = suggestedRunAction(run, withWorktree);
        if (action) decisions.push(action);
        else if (isTerminal(run.state)) settled += 1;
      }
      const worktreeFlags = withWorktree && sampleWorktree ? ["--worktree", sampleWorktree] : [];
      if (staleCount > 0) {
        tail.push({
          kind: "reap",
          reason: `${staleCount} stale run${staleCount > 1 ? "s" : ""} (supervisor gone)`,
          argv: ["orch", "run", "reap", "--mr", mr, ...worktreeFlags],
          repo_key: repoKey,
          mr,
        });
      }
      const pending = pendingOutboxCount(repoKey, mrDirName);
      if (pending > 0) {
        tail.push({
          kind: "mirror_sync",
          reason: `outbox: ${pending} pending comment${pending > 1 ? "s" : ""}`,
          argv: ["orch", "mirror", "sync", "--mr", mr, "--execute", ...worktreeFlags],
          repo_key: repoKey,
          mr,
        });
      }
    }
  }

  decisions.sort((a, b) => a.mr.localeCompare(b.mr) || (a.run_id ?? "").localeCompare(b.run_id ?? ""));
  return { scanned_repos: repoKeys, active, actions: [...decisions, ...tail], settled };
}

export function formatAge(iso: string | null): string {
  if (!iso) return "-";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Quote an argv for display so the printed line is directly runnable in a
// POSIX shell. The JSON view carries the raw argv array instead.
export function renderArgv(argv: string[]): string {
  return argv
    .map((arg) => (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(" ");
}

export function renderOverview(overview: Overview): string {
  const lines: string[] = [];
  const multiRepo = overview.scanned_repos.length > 1;
  const runPrefix = (run: OverviewRun): string => (multiRepo ? `${run.repo_key}  ` : "");
  const actionPrefix = (action: OverviewAction): string => (multiRepo ? `${action.repo_key} · ` : "");

  lines.push(`ACTIVE (${overview.active.length})`);
  if (overview.active.length === 0) {
    lines.push("  none");
  } else {
    for (const run of overview.active) {
      lines.push(`  ${runPrefix(run)}${run.mr}  ${run.run_id}  ${run.role}/${run.agent}  ${run.state}  ${formatAge(run.started_at ?? run.updated_at)}`);
    }
  }

  lines.push("", `NEEDS ACTION (${overview.actions.length})`);
  if (overview.actions.length === 0) {
    lines.push("  none");
  } else {
    overview.actions.forEach((action, index) => {
      lines.push(`  ${index + 1}. ${actionPrefix(action)}${action.mr} · ${action.reason}`);
      lines.push(`     ${renderArgv(action.argv)}`);
    });
  }

  lines.push("", `settled: ${overview.settled} run${overview.settled === 1 ? "" : "s"} decided or closed`);
  return `${lines.join("\n")}\n`;
}
