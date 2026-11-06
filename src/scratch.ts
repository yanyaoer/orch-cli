// Per-run scratch copies: CoW snapshots of the run's worktree that a worker may
// mutate freely (break checks, mutation testing, a base tree at another
// commit) and that orch removes when the run ends.
//
// Why orch makes them instead of the worker: a whole-tree copy made by the
// worker (`git clone`, `cp -R`, `git worktree add` + reinstall) costs hundreds
// of MB of real disk each and rebuilds every cache, and a sandboxed worker
// cannot register a worktree (the common Git dir is never writable). A
// snapshot clone shares every block with the source until written — a 400 MB
// sandbox-muse checkout with node_modules and android/app/build costs ~10 MB —
// and checking it out at another commit only rewrites the files that differ.
//
// Layout: <repo-parent>/.orch-worktrees/<repo-name>/scratch/<run_id>/<name>,
// next to the other orch clones (same filesystem as the source, so clonefile
// applies) and keyed by run so cleanup is a single, identity-checked subtree.
// <run_id>/.orch-scratch.json names the owning run dir: `orch worktree gc`
// removes copies a dead supervisor left once that run is no longer in flight.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "./cli.ts";
import { gitEnv } from "./git-env.ts";
import { readJsonFile } from "./json.ts";
import { runInFlight } from "./run-store.ts";
import type { RunStatus } from "./types.ts";
import {
  cloneWorktreeCow,
  ensurePrivateDirectory,
  fanoutRootPath,
  forceRemoveTree,
  privateWorktreeRoot,
  readProvenance,
  worktreeRegistered,
  type CowBackendFactory,
} from "./worktree.ts";

export const ORCH_RUN_SCRATCH_DIR_ENV = "ORCH_RUN_SCRATCH_DIR";
const SCRATCH_DIR = "scratch";
const MARKER = ".orch-scratch.json";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_COPIES = 8;

export interface ScratchRequest {
  name: string;
  rev: string | null; // as typed; null = the worktree's own HEAD and content
}

export interface ScratchCopy {
  name: string;
  path: string;
  rev: string | null;
  head: string; // full commit the copy is checked out at
}

export interface ScratchCleanup {
  removed: string[];
  kept: Array<{ path: string; reason: string }>;
}

function git(args: string[]): { ok: boolean; out: string; err: string } {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() };
}

// `--scratch combo,base@origin/main --scratch mut`: comma lists, repeatable.
export function parseScratchRequests(values: string[]): ScratchRequest[] {
  const requests: ScratchRequest[] = [];
  const seen = new Set<string>();
  for (const item of values.flatMap((value) => value.split(",")).map((part) => part.trim())) {
    if (!item) continue;
    const at = item.indexOf("@");
    const name = at === -1 ? item : item.slice(0, at);
    const rev = at === -1 ? null : item.slice(at + 1);
    if (!NAME_RE.test(name)) throw new CliError(`--scratch name ${JSON.stringify(name)} must match ${NAME_RE.source}`);
    if (rev !== null && (!rev || rev.startsWith("-"))) throw new CliError(`--scratch ${item}: empty or option-like rev`);
    if (seen.has(name)) throw new CliError(`--scratch ${name} given twice`);
    seen.add(name);
    requests.push({ name, rev });
  }
  if (requests.length > MAX_COPIES) throw new CliError(`--scratch: at most ${MAX_COPIES} copies per run`);
  return requests;
}

// Main checkout of the repository a worktree belongs to: scratch copies of a
// linked worktree (a verify copy) live under the main checkout's orch root,
// not under a root derived from the linked worktree's own path.
export function mainCheckoutOf(worktree: string): string {
  const common = git(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok || !common.out) throw new CliError(`--scratch: ${worktree} is not a git worktree: ${common.err}`);
  const commonDir = realpathSync(common.out);
  if (basename(commonDir) !== ".git") throw new CliError(`--scratch: unsupported repository layout (common dir ${commonDir})`);
  return dirname(commonDir);
}

// Revs resolve at create, so the idempotency key and the copies agree even if
// the ref moves before the run starts.
export function resolveScratchRevs(worktree: string, requests: ScratchRequest[]): Array<ScratchRequest & { head: string | null }> {
  return requests.map((request) => {
    if (request.rev === null) return { ...request, head: null };
    const resolved = git(["-C", worktree, "rev-parse", "--verify", "--quiet", `${request.rev}^{commit}`]);
    if (!resolved.ok || !resolved.out) throw new CliError(`--scratch ${request.name}@${request.rev}: not a commit in ${worktree}`);
    return { ...request, head: resolved.out };
  });
}

export function scratchFingerprint(requests: Array<ScratchRequest & { head: string | null }>): string {
  return requests.map((request) => `${request.name}@${request.head ?? "worktree"}`).join(",");
}

// Read-only: where a run's copies would go (dry-run shows it).
export function scratchRootPath(worktree: string, runId: string): string {
  return join(fanoutRootPath(mainCheckoutOf(worktree)), SCRATCH_DIR, runId);
}

export function createScratchCopies(
  worktree: string,
  runId: string,
  runDir: string,
  requests: Array<ScratchRequest & { head: string | null }>,
  backendFactory?: CowBackendFactory,
): { root: string; copies: ScratchCopy[] } {
  if (!RUN_ID_RE.test(runId) || runId.includes("..")) throw new CliError(`--scratch: unusable run id ${JSON.stringify(runId)}`);
  const main = mainCheckoutOf(worktree);
  // Each level is a real 0700 directory (ensurePrivateDirectory refuses a
  // symlink or a file), so a planted link cannot redirect the copies.
  const base = privateWorktreeRoot(main);
  const scratchBase = ensurePrivateDirectory(join(base, SCRATCH_DIR));
  const root = join(scratchBase, runId);
  if (existsSync(root) || isSymlink(root)) throw new CliError(`scratch root already exists: ${root}`);
  mkdirSync(root, { mode: 0o700 });
  if (realpathSync(root) !== root || expectedRoot(main, runId) !== root) throw new CliError(`scratch root ${root} does not resolve to itself`);
  writeFileSync(join(root, MARKER), `${JSON.stringify({ run_id: runId, run_dir: runDir, created_at: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
  const copies: ScratchCopy[] = [];
  try {
    for (const request of requests) {
      const dest = join(root, request.name);
      const outcome = backendFactory
        ? cloneWorktreeCow(worktree, dest, null, { mode: "snapshot" }, backendFactory)
        : cloneWorktreeCow(worktree, dest, null, { mode: "snapshot" });
      // Recorded before the checkout: a copy whose checkout fails is already a
      // registered clone and must be rolled back with the others.
      const copy: ScratchCopy = { name: request.name, path: outcome.dest, rev: request.rev, head: outcome.head };
      copies.push(copy);
      if (request.head && request.head !== outcome.head) {
        // --force: the copy carries the source's uncommitted state; at another
        // commit that state is meaningless and must not block the checkout.
        const checkout = git(["-C", outcome.dest, "checkout", "--quiet", "--force", "--detach", request.head]);
        if (!checkout.ok) throw new CliError(`--scratch ${request.name}: checkout ${request.rev} failed: ${checkout.err}`);
        copy.head = request.head;
      }
    }
  } catch (error) {
    removeScratchCopies({ worktree, run_id: runId, scratch_root: root, scratch: copies });
    // A copy that failed mid-clone was rolled back by cloneWorktreeCow itself.
    throw error;
  }
  return { root, copies };
}

// <repo-parent>/.orch-worktrees/<repo>/scratch/<run_id> -> <repo-parent>/<repo>.
// Used when the run's own worktree (a verify copy) is already gone.
function mainCheckoutFromRoot(root: string): string {
  const base = dirname(dirname(root));
  return join(dirname(dirname(base)), basename(base));
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// The only place a run's copies may live: realpath'd orch root (privateWorktreeRoot
// returns a realpath) + scratch/<run_id>.
function expectedRoot(main: string, runId: string): string {
  return join(fanoutRootPath(realpathSync(main)), SCRATCH_DIR, runId);
}

// Why a recorded root is not this run's scratch root, or null when it is: the
// exact <orch root>/scratch/<run_id> path, no symlink at either level, and the
// marker naming the same run. Without this, a crafted spec could point
// scratch_root at the orch root itself and name a sibling clone as a "copy".
function rootProblem(main: string, root: string, runId: string | undefined): string | null {
  if (!runId || !RUN_ID_RE.test(runId) || runId.includes("..")) return "spec has no usable run_id";
  let expected: string;
  try {
    expected = expectedRoot(main, runId);
  } catch (error) {
    return `cannot resolve the orch root: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (root !== expected) return `scratch_root is not ${expected}`;
  if (!existsSync(root)) return null;
  if (isSymlink(dirname(root)) || isSymlink(root)) return "scratch root or its parent is a symlink";
  try {
    if (realpathSync(root) !== root) return "scratch root does not resolve to itself";
    const marker = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as { run_id?: unknown };
    if (marker.run_id !== runId) return "scratch marker names another run";
  } catch {
    return "scratch marker missing or unreadable";
  }
  return null;
}

function removeEmptyRoot(root: string): void {
  try {
    const left = readdirSync(root).filter((name) => name !== MARKER);
    if (left.length > 0) return;
    rmMarker(root);
    rmdirSync(root);
  } catch {}
}

function rmMarker(root: string): void {
  try {
    Bun.spawnSync(["rm", "-f", "--", join(root, MARKER)]);
  } catch {}
}

// Removes exactly the copies a spec recorded, each only if it is still the
// registered orch clone at <root>/<name>. Copies are disposable by contract
// (mutations, base trees), so there is no loss gate — identity is the gate.
export function removeScratchCopies(spec: {
  worktree: string;
  run_id?: string;
  scratch_root?: string;
  scratch?: ScratchCopy[];
}): ScratchCleanup {
  const cleanup: ScratchCleanup = { removed: [], kept: [] };
  const root = spec.scratch_root;
  if (!root) return cleanup;
  const copies = spec.scratch ?? [];
  let main: string | null = null;
  for (const candidate of [spec.worktree, mainCheckoutFromRoot(root)]) {
    if (main || !candidate || !existsSync(candidate)) continue;
    try {
      main = mainCheckoutOf(candidate);
    } catch {}
  }
  const problem = main ? rootProblem(main, root, spec.run_id) : "cannot locate the main checkout to unregister the copies";
  if (problem) {
    for (const copy of copies) cleanup.kept.push({ path: copy.path, reason: problem });
    return cleanup;
  }
  for (const copy of copies) {
    const reason = removeOneCopy(main!, root, copy, [spec.worktree, main!]);
    if (reason === null) cleanup.removed.push(copy.path);
    else cleanup.kept.push({ path: copy.path, reason });
  }
  removeEmptyRoot(root);
  return cleanup;
}

function removeOneCopy(main: string, root: string, copy: ScratchCopy, protectedPaths: string[]): string | null {
  if (copy.path !== join(root, copy.name) || !NAME_RE.test(copy.name)) return "recorded path is not <scratch root>/<name>";
  if (protectedPaths.some((path) => path === copy.path)) return "recorded path is the run's worktree or the main checkout";
  if (!existsSync(copy.path)) {
    git(["-C", main, "worktree", "prune"]);
    return null;
  }
  let canonical: string;
  try {
    if (lstatSync(copy.path).isSymbolicLink()) return "copy path is a symlink";
    canonical = realpathSync(copy.path);
  } catch (error) {
    return `cannot resolve copy: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (canonical !== copy.path) return `copy resolves elsewhere (${canonical})`;
  const provenance = readProvenance(copy.path);
  if (!provenance || provenance.dest !== copy.path) return "no matching orch clone provenance";
  if (!worktreeRegistered(main, copy.path)) return "not a registered worktree of this repository";
  if (!git(["-C", main, "worktree", "remove", "--force", copy.path]).ok) {
    if (worktreeRegistered(main, copy.path)) return "git worktree remove failed (locked?)";
    forceRemoveTree(copy.path);
  }
  git(["-C", main, "worktree", "prune"]);
  return existsSync(copy.path) ? "content could not be deleted" : null;
}

export interface ScratchGcEntry {
  root: string;
  run_id: string;
  run_dir: string | null;
  action: "remove" | "keep";
  reason: string;
  removed?: string[];
  kept?: Array<{ path: string; reason: string }>;
}

// `orch worktree gc`: scratch roots whose run is no longer in flight (its
// supervisor died before cleanup, or the run dir was gc'd) are removed; a root
// without a readable marker is reported and left alone.
export function scratchGc(source: string, execute: boolean): ScratchGcEntry[] {
  const main = mainCheckoutOf(source);
  const base = join(fanoutRootPath(main), SCRATCH_DIR);
  if (!existsSync(base)) return [];
  const entries: ScratchGcEntry[] = [];
  for (const runId of readdirSync(base)) {
    const root = join(base, runId);
    let marker: { run_id?: unknown; run_dir?: unknown } | null = null;
    try {
      marker = JSON.parse(readFileSync(join(root, MARKER), "utf8"));
    } catch {}
    const runDir = typeof marker?.run_dir === "string" ? marker.run_dir : null;
    if (!marker || marker.run_id !== runId || !runDir) {
      entries.push({ root, run_id: runId, run_dir: runDir, action: "keep", reason: "no scratch marker naming this run; inspect manually" });
      continue;
    }
    const status = readJsonFile<RunStatus | null>(join(runDir, "status.json"), null);
    if (status && runInFlight(status)) {
      entries.push({ root, run_id: runId, run_dir: runDir, action: "keep", reason: `run is ${status.state}` });
      continue;
    }
    const spec = readJsonFile<{ worktree?: string; scratch_root?: string; scratch?: ScratchCopy[] } | null>(join(runDir, "spec.json"), null);
    const copies: ScratchCopy[] =
      spec?.scratch_root === root && Array.isArray(spec.scratch)
        ? spec.scratch
        : readdirSync(root)
            .filter((name) => name !== MARKER && NAME_RE.test(name))
            .map((name) => ({ name, path: join(root, name), rev: null, head: "" }));
    const entry: ScratchGcEntry = {
      root,
      run_id: runId,
      run_dir: runDir,
      action: "remove",
      reason: status ? `run ${status.state}` : "run dir gone",
    };
    if (execute) {
      const result = removeScratchCopies({ worktree: main, run_id: runId, scratch_root: root, scratch: copies });
      entry.removed = result.removed;
      entry.kept = result.kept;
    }
    entries.push(entry);
  }
  return entries;
}

export function isScratchRoot(path: string, source: string): boolean {
  try {
    return resolve(path) === join(fanoutRootPath(mainCheckoutOf(source)), SCRATCH_DIR);
  } catch {
    return false;
  }
}
