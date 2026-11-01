// orch run gc: retention for one repo's run state. The unit is an MR dir
// (${repo_key}/mrs/<mr>/: runs with their evidence, control-plane evidence,
// outbox, idempotency) — evidence never outlives the run_id that cites it.
//
// Rules, strongest first (fail closed: anything unproven is kept):
//   1. a run whose processes are alive (or a non-terminal run not yet stale)
//      keeps the whole dir;
//   2. an MR the forge reports open is never deleted, however old;
//   3. a merged / closed MR is deleted once both its terminal time and the
//      dir's last write are at least --min-age-days old (default 30);
//   4. a dir with no forge MR (non-numeric thread name without forge_ref, a
//      404, a repo without a forge) is deleted once its last write is at
//      least --max-age-days old (default 180) — the age cap;
//   5. a forge lookup that fails for any other reason keeps the dir.
// Without --execute only the plan is printed. --execute re-checks every
// candidate under the MR lock, moves it into ${repo_key}/.run-gc-trash/ and
// deletes it there; trash left by an interrupted --execute is swept next time.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getRepoIdentity, orchStateRoot } from "../paths.ts";
import { CliError, assertKnownFlags, flagBool, flagNumber, flagString, printJson, type ParsedArgs } from "../cli.ts";
import { forgeRefFor, mrIdsForRepo, runInFlight, scanRunsRoot, utcCompact } from "../run-store.ts";
import { detectForge, forgeMrLifecycle, type ForgeKind, type ForgeMrLifecycle } from "../forge.ts";
import { acquirePidfileLockWait } from "../locks.ts";
import { randomHex } from "../hash.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_GC_FLAGS = ["worktree", "execute", "dry-run", "min-age-days", "max-age-days", "concurrency"];

export type RunGcReason =
  | "active_run"
  | "recent"
  | "mr_open"
  | "terminal_recent"
  | "terminal_time_unknown"
  | "lookup_failed"
  | "age_cap_recent"
  | "mr_terminal"
  | "age_cap"
  | "changed_since_plan";

export interface DirUsage {
  disk_bytes: number;
  evidence_bytes: number;
  files: number;
  last_write_ms: number | null;
}

export interface RunGcRow {
  mr: string;
  mr_dir: string;
  forge_ref: string | null;
  forge_state: ForgeMrLifecycle["state"] | "not_checked" | "no_forge";
  terminal_at: string | null;
  last_write_at: string | null;
  idle_days: number | null;
  runs: number;
  disk_bytes: number;
  evidence_bytes: number;
  pending_outbox: number;
  action: "delete" | "keep";
  reason: RunGcReason;
  detail: string;
  removed?: boolean;
  error?: string;
}

export interface RunGcOptions {
  now: number;
  minAgeDays: number;
  maxAgeDays: number;
  forge: ForgeKind;
  lookup: (ref: string) => Promise<ForgeMrLifecycle>;
  concurrency: number;
}

// Disk usage (allocated blocks, like du) and newest mtime of a tree, without
// following symlinks. A file under any evidence/ directory counts as evidence.
export function dirUsage(root: string): DirUsage {
  const usage: DirUsage = { disk_bytes: 0, evidence_bytes: 0, files: 0, last_write_ms: null };
  const walk = (dir: string, inEvidence: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      const bytes = stat.blocks * 512;
      usage.disk_bytes += bytes;
      if (inEvidence) usage.evidence_bytes += bytes;
      if (usage.last_write_ms === null || stat.mtimeMs > usage.last_write_ms) usage.last_write_ms = stat.mtimeMs;
      if (entry.isDirectory()) walk(path, inEvidence || entry.name === "evidence");
      else usage.files += 1;
    }
  };
  walk(root, false);
  return usage;
}

// Runs that still have work in flight (see runInFlight).
export function activeRunIds(mrDir: string): string[] {
  return scanRunsRoot(`${mrDir}/runs`, "")
    .filter(({ status }) => status !== null && runInFlight(status))
    .map(({ run_dir }) => run_dir.slice(run_dir.lastIndexOf("/") + 1));
}

function countEntries(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function countDirs(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

// The forge ref an MR dir answers to: a recorded forge_ref, else a dir name
// that is a bare MR/PR number. Branch-like thread names are never guessed
// into refs (glab would resolve a branch to whatever MR it heads).
export function gcForgeRef(mrDir: string, mr: string): string | null {
  const ref = forgeRefFor(mrDir, "").trim();
  if (ref) return ref;
  return /^\d+$/.test(mr) ? mr : null;
}

function days(ms: number): number {
  return Math.round((ms / DAY_MS) * 10) / 10;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// Exact last-write time per planned row (the ISO string in the row drops
// sub-millisecond precision); --execute compares against it.
const plannedLastWrite = new WeakMap<RunGcRow, number>();

export async function planMrDir(mrsRoot: string, mr: string, options: RunGcOptions): Promise<RunGcRow> {
  const mrDir = `${mrsRoot}/${mr}`;
  const usage = dirUsage(mrDir);
  const idleMs = usage.last_write_ms === null ? null : options.now - usage.last_write_ms;
  const ref = gcForgeRef(mrDir, mr);
  const row: RunGcRow = {
    mr,
    mr_dir: mrDir,
    forge_ref: ref,
    forge_state: options.forge === "none" ? "no_forge" : "not_checked",
    terminal_at: null,
    last_write_at: usage.last_write_ms === null ? null : new Date(usage.last_write_ms).toISOString(),
    idle_days: idleMs === null ? null : days(idleMs),
    runs: countDirs(`${mrDir}/runs`),
    disk_bytes: usage.disk_bytes,
    evidence_bytes: usage.evidence_bytes,
    pending_outbox: countEntries(`${mrDir}/outbox/pending`),
    action: "keep",
    reason: "recent",
    detail: "",
  };
  if (usage.last_write_ms !== null) plannedLastWrite.set(row, usage.last_write_ms);
  const keep = (reason: RunGcReason, detail: string): RunGcRow => Object.assign(row, { action: "keep" as const, reason, detail });
  const del = (reason: RunGcReason, detail: string): RunGcRow => Object.assign(row, { action: "delete" as const, reason, detail });

  const active = activeRunIds(mrDir);
  if (active.length > 0) return keep("active_run", `runs in flight: ${active.join(", ")}`);
  // An empty dir has no write time; treat it as idle forever.
  const idle = idleMs ?? Number.POSITIVE_INFINITY;
  const idleText = idleMs === null ? "empty" : `idle ${days(idleMs)}d`;

  const ageCap = (why: string): RunGcRow =>
    idle >= options.maxAgeDays * DAY_MS
      ? del("age_cap", `${why}; ${idleText} >= --max-age-days ${options.maxAgeDays}`)
      : keep("age_cap_recent", `${why}; ${idleText} < --max-age-days ${options.maxAgeDays}`);

  if (ref === null || options.forge === "none") return ageCap(ref === null ? "no forge MR ref" : "repo has no forge");
  // Too recent to delete whatever the forge says: skip the lookup.
  if (idle < options.minAgeDays * DAY_MS) return keep("recent", `${idleText} < --min-age-days ${options.minAgeDays}`);

  const lifecycle = await options.lookup(ref);
  row.forge_state = lifecycle.state;
  row.terminal_at = lifecycle.terminal_at;
  if (lifecycle.state === "open") return keep("mr_open", `MR ${ref} is open`);
  if (lifecycle.state === "error") return keep("lookup_failed", lifecycle.detail ?? "forge lookup failed");
  if (lifecycle.state === "not_found") return ageCap(`forge has no MR ${ref}`);
  const terminalMs = lifecycle.terminal_at === null ? Number.NaN : Date.parse(lifecycle.terminal_at);
  if (!Number.isFinite(terminalMs)) return keep("terminal_time_unknown", `MR ${ref} is ${lifecycle.state} but reports no time`);
  const sinceTerminal = options.now - terminalMs;
  if (sinceTerminal < options.minAgeDays * DAY_MS) {
    return keep("terminal_recent", `MR ${ref} ${lifecycle.state} ${days(sinceTerminal)}d ago < --min-age-days ${options.minAgeDays}`);
  }
  return del("mr_terminal", `MR ${ref} ${lifecycle.state} ${days(sinceTerminal)}d ago; ${idleText}`);
}

export async function planRunGc(mrsRoot: string, mrs: string[], options: RunGcOptions): Promise<RunGcRow[]> {
  return mapLimit(mrs, options.concurrency, (mr) => planMrDir(mrsRoot, mr, options));
}

function trashRoot(repoRoot: string): string {
  return `${repoRoot}/.run-gc-trash`;
}

// Delete one planned dir: under the MR lock (run create holds it while it
// claims a run), re-check that nothing started or wrote since the plan, move
// the dir out of mrs/ in one rename so readers never see a half-deleted MR,
// then delete the moved copy.
export async function deletePlanned(repoRoot: string, row: RunGcRow): Promise<void> {
  let lock;
  try {
    lock = await acquirePidfileLockWait(`${row.mr_dir}/locks/mr.lock`, 10_000);
  } catch (error) {
    Object.assign(row, { action: "keep", reason: "active_run", detail: `mr lock busy: ${error instanceof Error ? error.message : String(error)}`, removed: false });
    return;
  }
  let moved: string | null = null;
  try {
    const active = activeRunIds(row.mr_dir);
    if (active.length > 0) {
      Object.assign(row, { action: "keep", reason: "active_run", detail: `runs in flight: ${active.join(", ")}`, removed: false });
      return;
    }
    if (!onlyLockWritesSince(row.mr_dir, plannedLastWrite.get(row) ?? 0)) {
      Object.assign(row, { action: "keep", reason: "changed_since_plan", detail: "written after the plan", removed: false });
      return;
    }
    mkdirSync(trashRoot(repoRoot), { recursive: true, mode: 0o700 });
    moved = `${trashRoot(repoRoot)}/${row.mr}-${utcCompact()}-${randomHex(3)}`;
    renameSync(row.mr_dir, moved);
  } finally {
    lock.release();
  }
  try {
    rmSync(moved, { recursive: true, force: true });
    row.removed = !existsSync(moved) && !existsSync(row.mr_dir);
  } catch (error) {
    row.removed = !existsSync(row.mr_dir);
    row.error = `moved to ${moved} but not deleted: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function lstatSafeMtime(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// True when every entry written after `sinceMs` lives under locks/ (the lock
// this command took, or a stale lock record) — those are not activity.
function onlyLockWritesSince(mrDir: string, sinceMs: number): boolean {
  let clean = true;
  const walk = (dir: string, rel: string): void => {
    if (!clean) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (relPath === "locks" || relPath.startsWith("locks/")) continue;
      const path = `${dir}/${entry.name}`;
      const mtime = lstatSafeMtime(path);
      if (mtime !== null && mtime > sinceMs) {
        clean = false;
        return;
      }
      if (entry.isDirectory()) walk(path, relPath);
    }
  };
  walk(mrDir, "");
  return clean;
}

function sweepTrash(repoRoot: string, execute: boolean): Array<{ path: string; swept: boolean }> {
  const root = trashRoot(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root).map((name) => {
    const path = `${root}/${name}`;
    if (execute) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // reported below as not swept
      }
    }
    return { path, swept: execute && !existsSync(path) };
  });
}

function nonNegative(args: ParsedArgs, name: string, fallback: number): number {
  const value = flagNumber(args, name) ?? fallback;
  if (!Number.isFinite(value) || value < 0) throw new CliError(`--${name} must be a non-negative number`);
  return value;
}

export async function runGc(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "run gc", RUN_GC_FLAGS);
  const execute = flagBool(args, "execute");
  if (execute && flagBool(args, "dry-run")) throw new CliError("--execute and --dry-run are mutually exclusive");
  const minAgeDays = nonNegative(args, "min-age-days", 30);
  const maxAgeDays = nonNegative(args, "max-age-days", 180);
  const concurrency = Math.max(1, Math.floor(nonNegative(args, "concurrency", 8)));
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const forge = detectForge(repo.remote_url);
  const repoRoot = `${orchStateRoot()}/${repo.repo_key}`;
  const mrsRoot = `${repoRoot}/mrs`;
  const lookups = new Map<string, Promise<ForgeMrLifecycle>>();
  const options: RunGcOptions = {
    now: Date.now(),
    minAgeDays,
    maxAgeDays,
    forge,
    concurrency,
    lookup: (ref) => {
      if (forge === "none") return Promise.resolve({ state: "error", terminal_at: null, detail: "no forge" });
      let pending = lookups.get(ref);
      if (!pending) {
        pending = forgeMrLifecycle(forge, ref, repo.repo_root);
        lookups.set(ref, pending);
      }
      return pending;
    },
  };
  const rows = await planRunGc(mrsRoot, mrIdsForRepo(repo.repo_key), options);
  if (execute) {
    for (const row of rows) if (row.action === "delete") await deletePlanned(repoRoot, row);
  }
  const trash = sweepTrash(repoRoot, execute);

  const sum = (selected: RunGcRow[], key: "disk_bytes" | "evidence_bytes"): number => selected.reduce((total, row) => total + row[key], 0);
  const deletes = rows.filter((row) => row.action === "delete");
  const keeps = rows.filter((row) => row.action === "keep");
  const byReason: Record<string, { mrs: number; disk_bytes: number }> = {};
  for (const row of rows) {
    const bucket = (byReason[`${row.action}:${row.reason}`] ??= { mrs: 0, disk_bytes: 0 });
    bucket.mrs += 1;
    bucket.disk_bytes += row.disk_bytes;
  }
  printJson({
    run: "gc",
    repo_key: repo.repo_key,
    forge,
    executed: execute,
    min_age_days: minAgeDays,
    max_age_days: maxAgeDays,
    summary: {
      mrs: rows.length,
      delete: deletes.length,
      delete_disk_bytes: sum(deletes, "disk_bytes"),
      delete_evidence_bytes: sum(deletes, "evidence_bytes"),
      keep: keeps.length,
      keep_disk_bytes: sum(keeps, "disk_bytes"),
      forge_lookups: lookups.size,
      by_reason: byReason,
      removed: execute ? rows.filter((row) => row.removed).length : 0,
    },
    mrs: rows,
    trash,
    ...(execute || deletes.length === 0 ? {} : { execute_with: `orch run gc --execute --min-age-days ${minAgeDays} --max-age-days ${maxAgeDays}` }),
  });
  return 0;
}
