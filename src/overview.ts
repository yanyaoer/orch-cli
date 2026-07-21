// Shared aggregation layer behind the bare `orch` overview, `orch verdict`,
// and `orch wait`. One contract, all consumers: every pending action is
// expressed as a runnable orch argv, so the command a human copies from the
// overview and the command an agent spawns from --json are the same audited
// line. Read-only: this module never writes state.

import { existsSync, readdirSync, statSync } from "node:fs";
import type { RunState, RunStatus } from "./types.ts";
import { readJsonFile } from "./json.ts";
import { mailControlStateDir, mrStateDir, orchStateRoot, statePathSegment } from "./paths.ts";
import { isPidAlive } from "./locks.ts";
import { vcsKind } from "./vcs.ts";

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

export type ActionKind = "decision" | "inspect" | "reap" | "mirror_sync" | "mailctl";

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
  // Undecided-but-old items that fell out of the attention window: the
  // overview is a notification center, not a permanent debt ledger.
  aged_out: number;
  // Items skipped because their mr matches a branch already merged into HEAD.
  archived: number;
}

export interface OverviewOptions {
  // Terminal-but-undecided runs, stale runs, and pending outbox comments
  // older than this many days sink into `aged_out` instead of NEEDS ACTION.
  // 0 disables the window (everything surfaces forever).
  attentionDays?: number;
  // MRs considered closed because their branch merged: raw or sanitized mr
  // names, applied only to the repo they were computed for.
  archived?: { repoKey: string; mrs: Set<string> } | null;
}

export const DEFAULT_ATTENTION_DAYS = 14;

const nonTerminal = new Set<RunState>(["created", "starting", "running"]);

// Verdicts that mean "this run's work is acceptable" across the role schemas.
const goodVerdicts = new Set(["approve", "pass", "completed"]);

export function isGoodVerdict(verdict: string | null): boolean {
  return verdict !== null && goodVerdicts.has(verdict);
}

export function looksStale(status: RunStatus): boolean {
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
export function mrDirsForRepo(repoKey: string): string[] {
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

function pendingOutbox(repoKey: string, mrDirName: string, agedBefore: number | null): { fresh: number; aged: number } {
  const pendingDir = `${orchStateRoot()}/${repoKey}/mrs/${mrDirName}/outbox/pending`;
  if (!existsSync(pendingDir)) return { fresh: 0, aged: 0 };
  let fresh = 0;
  let aged = 0;
  for (const entry of readdirSync(pendingDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let mtime = Number.POSITIVE_INFINITY;
    try {
      mtime = statSync(`${pendingDir}/${entry.name}`).mtimeMs;
    } catch {
      // Raced away between readdir and stat: it no longer needs attention.
      continue;
    }
    if (agedBefore !== null && mtime < agedBefore) aged += 1;
    else fresh += 1;
  }
  return { fresh, aged };
}

function mailctlConsecutiveFailures(): number {
  const cursor = readJsonFile<{ consecutive_failures?: unknown } | null>(`${mailControlStateDir()}/cursor.json`, null);
  return typeof cursor?.consecutive_failures === "number" && Number.isFinite(cursor.consecutive_failures) ? cursor.consecutive_failures : 0;
}

function droppedMailctlReplies(): number {
  const droppedDir = `${mailControlStateDir()}/outbox-email/dropped`;
  const sentDir = `${mailControlStateDir()}/outbox-email/sent`;
  if (!existsSync(droppedDir)) return 0;
  try {
    return readdirSync(droppedDir, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && !existsSync(`${sentDir}/${entry.name}`),
    ).length;
  } catch {
    return 0;
  }
}

function quarantinedMailctlReplies(): number {
  const dir = `${mailControlStateDir()}/outbox-email/quarantined`;
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return false;
      const record = readJsonFile<{ resolution?: unknown } | null>(`${dir}/${entry.name}`, null);
      return record?.resolution === null;
    }).length;
  } catch {
    return 0;
  }
}

// Reject reasons that fire only after the sender allowlist passes (or that mean
// mail could not be judged at all): each one is likely the owner locked out, not spam.
const REJECT_REASONS_NEEDING_REVIEW = new Set(["auth", "token", "html_only", "parse_error", "conflict", "error"]);
const REJECTED_LOOKBACK_DAYS = 7;

function recentSuspectRejects(): Map<string, number> {
  const messagesDir = `${mailControlStateDir()}/messages`;
  const counts = new Map<string, number>();
  if (!existsSync(messagesDir)) return counts;
  const cutoff = Date.now() - REJECTED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = readdirSync(messagesDir, { withFileTypes: true });
  } catch {
    return counts;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const marker = readJsonFile<{ status?: unknown; created_at?: unknown } | null>(`${messagesDir}/${entry.name}`, null);
    if (typeof marker?.status !== "string" || !marker.status.startsWith("rejected_")) continue;
    const reason = marker.status.slice("rejected_".length);
    if (!REJECT_REASONS_NEEDING_REVIEW.has(reason)) continue;
    const ts = Date.parse(typeof marker.created_at === "string" ? marker.created_at : "");
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return counts;
}

function mailctlHealthAction(): OverviewAction | null {
  const failures = mailctlConsecutiveFailures();
  if (failures >= 3) {
    return {
      kind: "mailctl",
      reason: `mailctl: ${failures} poll failure${failures === 1 ? "" : "s"}`,
      argv: ["orch", "mailctl", "status"],
      repo_key: "",
      mr: "mailctl",
    };
  }

  const dropped = droppedMailctlReplies();
  if (dropped > 0) {
    return {
      kind: "mailctl",
      reason: `mailctl: ${dropped} dropped ${dropped === 1 ? "reply" : "replies"}`,
      argv: ["orch", "mailctl", "status"],
      repo_key: "",
      mr: "mailctl",
    };
  }

  const quarantined = quarantinedMailctlReplies();
  if (quarantined > 0) {
    return {
      kind: "mailctl",
      reason: `mailctl: ${quarantined} policy-quarantined ${quarantined === 1 ? "reply" : "replies"}`,
      argv: ["orch", "mailctl", "status"],
      repo_key: "",
      mr: "mailctl",
    };
  }

  const rejects = recentSuspectRejects();
  if (rejects.size > 0) {
    const total = [...rejects.values()].reduce((sum, count) => sum + count, 0);
    const detail = [...rejects.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(" ");
    return {
      kind: "mailctl",
      reason: `mailctl: ${total} rejected email${total === 1 ? "" : "s"} need review, last ${REJECTED_LOOKBACK_DAYS}d (${detail})`,
      argv: ["orch", "mailctl", "status"],
      repo_key: "",
      mr: "mailctl",
    };
  }

  return null;
}

export function buildOverview(repoKeys: string[], withWorktree: boolean, options: OverviewOptions = {}): Overview {
  const attentionDays = options.attentionDays ?? DEFAULT_ATTENTION_DAYS;
  // Cutoff in epoch ms: anything last touched before it has aged out.
  const agedBefore = attentionDays > 0 ? Date.now() - attentionDays * 24 * 60 * 60 * 1000 : null;
  const isAged = (iso: string | null): boolean => {
    if (agedBefore === null) return false;
    const ts = Date.parse(iso ?? "");
    return Number.isFinite(ts) && ts < agedBefore;
  };
  const archivedMrs = options.archived ?? null;
  const isArchivedMr = (repoKey: string, ...names: string[]): boolean =>
    archivedMrs !== null && archivedMrs.repoKey === repoKey && names.some((name) => archivedMrs.mrs.has(name));

  const active: OverviewRun[] = [];
  const decisions: OverviewAction[] = [];
  const tail: OverviewAction[] = [];
  let settled = 0;
  let agedOut = 0;
  let archived = 0;

  for (const repoKey of repoKeys) {
    for (const mrDirName of mrDirsForRepo(repoKey)) {
      const runs = collectMrRuns(repoKey, mrDirName);
      const mr = runs[0]?.mr ?? mrDirName;
      // A merged branch means the mr's work shipped: retire the whole group
      // (still-running workers stay visible; nothing else needs attention).
      const mrArchived = isArchivedMr(repoKey, mr, mrDirName);
      let staleCount = 0;
      let sampleWorktree: string | null = null;
      for (const run of runs) {
        sampleWorktree = run.worktree;
        if (!run.stale && !isTerminal(run.state)) {
          active.push(run);
          continue;
        }
        if (mrArchived) {
          archived += 1;
          continue;
        }
        if (run.stale) {
          if (isAged(run.updated_at)) agedOut += 1;
          else staleCount += 1;
        }
        const action = suggestedRunAction(run, withWorktree);
        if (action) {
          if (isAged(run.updated_at)) agedOut += 1;
          else decisions.push(action);
        } else if (isTerminal(run.state)) {
          settled += 1;
        }
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
      const pending = pendingOutbox(repoKey, mrDirName, agedBefore);
      if (mrArchived) {
        archived += pending.fresh + pending.aged;
      } else {
        agedOut += pending.aged;
        if (pending.fresh > 0) {
          tail.push({
            kind: "mirror_sync",
            reason: `outbox: ${pending.fresh} pending comment${pending.fresh > 1 ? "s" : ""}`,
            argv: ["orch", "mirror", "sync", "--mr", mr, "--execute", ...worktreeFlags],
            repo_key: repoKey,
            mr,
          });
        }
      }
    }
  }

  decisions.sort((a, b) => a.mr.localeCompare(b.mr) || (a.run_id ?? "").localeCompare(b.run_id ?? ""));
  const mailctl = mailctlHealthAction();
  return { scanned_repos: repoKeys, active, actions: [...decisions, ...tail, ...(mailctl ? [mailctl] : [])], settled, aged_out: agedOut, archived };
}

// The set of mr names retired by branch lifecycle: local branches fully merged
// into HEAD (their work shipped). Excluded: the current branch (always an
// ancestor of HEAD, but its thread may still be live) and branches pointing at
// HEAD itself (a just-created branch with no commits yet is indistinguishable
// from a merged one by ancestry alone). Sanitized forms are included so
// outbox-only mr dirs (no runs to recover the raw name from) match too.
// Returns null outside a git/jj repo.
export async function mergedBranchMrs(worktree: string): Promise<Set<string> | null> {
  if (vcsKind(worktree) === "jj") return mergedBookmarkMrs(worktree);
  const git = (...args: string[]) =>
    Bun.spawn(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "ignore" });
  try {
    const current = (await new Response(git("branch", "--show-current").stdout).text()).trim();
    const head = (await new Response(git("rev-parse", "HEAD").stdout).text()).trim();
    const proc = git("branch", "--format=%(refname:short) %(objectname)", "--merged", "HEAD");
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const mrs = new Set<string>();
    for (const line of out.split("\n")) {
      const [branch, sha] = line.trim().split(" ");
      if (!branch || branch === current || sha === head) continue;
      mrs.add(branch);
      mrs.add(statePathSegment(branch, "mr"));
    }
    return mrs;
  } catch {
    return null;
  }
}

// jj analog of the git rule above: local bookmarks pointing strictly below @-
// retired their line of work. @- is where the active bookmark trails the
// working copy, so it plays both "current branch" and "at HEAD" exclusions;
// remote-only refs never qualify.
async function mergedBookmarkMrs(worktree: string): Promise<Set<string> | null> {
  try {
    const proc = Bun.spawn(
      ["jj", "bookmark", "list", "-r", "::@- ~ @-", "--ignore-working-copy", "-T", 'if(remote, "", name ++ "\\n")'],
      { cwd: worktree, stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const mrs = new Set<string>();
    for (const line of out.split("\n")) {
      const bookmark = line.trim();
      if (!bookmark) continue;
      mrs.add(bookmark);
      mrs.add(statePathSegment(bookmark, "mr"));
    }
    return mrs;
  } catch {
    return null;
  }
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
  const actionHeading = (action: OverviewAction): string => {
    const prefix = multiRepo && action.repo_key ? `${action.repo_key} · ` : "";
    if (action.kind === "mailctl") return `${prefix}${action.reason}`;
    return `${prefix}${action.mr} · ${action.reason}`;
  };

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
      lines.push(`  ${index + 1}. ${actionHeading(action)}`);
      lines.push(`     ${renderArgv(action.argv)}`);
    });
  }

  const trailer = [`settled: ${overview.settled} run${overview.settled === 1 ? "" : "s"} decided or closed`];
  if (overview.aged_out > 0) trailer.push(`${overview.aged_out} aged out (--attention-days 0 to resurface)`);
  if (overview.archived > 0) trailer.push(`${overview.archived} archived (merged branches)`);
  lines.push("", trailer.join(" · "));
  return `${lines.join("\n")}\n`;
}
