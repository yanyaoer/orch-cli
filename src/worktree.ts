import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomHex } from "./hash.ts";
import { assertKnownFlags, CliError, flagString, printJson, type ParsedArgs } from "./cli.ts";

// Per-agent isolated checkout via filesystem copy-on-write. A CoW copy clones
// an 11 GB worktree in seconds at near-zero disk cost and — unlike `git
// worktree add` — carries the UNTRACKED build output (Gradle caches etc.), so
// the clone's incremental builds start warm. A raw clone would share the
// source's worktree slot (index/HEAD corruption under concurrent writers);
// the fix is to discard the cloned .git pointer and graft a freshly
// registered slot:
//   cp -c|--reflink=always -R <source> <dest>  # CoW file clone
//   rm <dest>/.git                      # drop the shared slot pointer
//   git worktree add --no-checkout <tmp>  # register a real slot
//   mv <tmp>/.git <dest>/.git           # graft it onto the clone
//   git worktree repair <dest>          # fix both back-pointers
//   git -C <dest> reset                 # rebuild the slot's index
export interface WorktreeCloneOutcome {
  source: string;
  dest: string;
  head: string;
  branch: string | null;
  upstream: string | null;
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new CliError(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim().slice(0, 500)}`);
  }
  return proc.stdout.toString().trim();
}

function gitOk(args: string[]): boolean {
  return Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

// CoW capability probe: clone a scratch file where the dest will live.
// macOS APFS answers `cp -c` (clonefile), Linux Btrfs/XFS/ZFS answer
// `cp --reflink=always`. Probing the dest parent (never /tmp on Linux —
// tmpfs has no reflink) picks the right flag; a cross-filesystem source
// still fails at the real copy, loudly. No silent full-copy fallback: orch
// runs unattended, and a "seconds" contract silently becoming a multi-minute
// 11 GB copy looks like a hang.
function cowCopyFlag(destParent: string): string {
  const probe = join(destParent, `.orch-cowprobe-${randomHex(4)}`);
  const clone = `${probe}.clone`;
  try {
    writeFileSync(probe, "");
    for (const flag of ["-c", "--reflink=always"]) {
      const proc = Bun.spawnSync(["cp", flag, probe, clone], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode === 0) return flag;
    }
    throw new CliError(
      `no copy-on-write support on ${destParent} (needs APFS clonefile or reflink: Btrfs/XFS/ZFS); refusing a slow full copy — cp -R manually if that is acceptable`,
    );
  } finally {
    rmSync(probe, { force: true });
    rmSync(clone, { force: true });
  }
}

export function cloneWorktreeCow(sourceArg: string, destArg: string, branch: string | null): WorktreeCloneOutcome {
  const source = git(["-C", resolve(sourceArg), "rev-parse", "--show-toplevel"]);
  const outsideSource = (path: string): boolean => path !== source && !path.startsWith(`${source}/`);
  const rejectInside = (path: string): never => {
    throw new CliError(`dest must live outside the source worktree: ${path}`);
  };
  const destResolved = resolve(destArg);
  // Pre-check before mkdir so an in-source dest never pollutes the source tree...
  if (!outsideSource(destResolved)) rejectInside(destResolved);
  mkdirSync(dirname(destResolved), { recursive: true });
  // ...then re-check on the realpath: git resolved the toplevel through
  // symlinks (e.g. /tmp vs /private/tmp), so the containment check must
  // compare symlink-resolved paths or an aliased dest defeats it.
  const dest = join(realpathSync(dirname(destResolved)), basename(destResolved));
  if (existsSync(dest)) throw new CliError(`dest already exists: ${dest}`);
  if (!outsideSource(dest)) rejectInside(dest);
  // Fail fast, before the copy: a taken branch name would only surface at
  // worktree add otherwise.
  if (branch && gitOk(["-C", source, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new CliError(`branch already exists: ${branch}`);
  }
  const head = git(["-C", source, "rev-parse", "HEAD"]);
  const cowFlag = cowCopyFlag(dirname(dest));
  const cp = Bun.spawnSync(["cp", cowFlag, "-R", source, dest], { stdout: "pipe", stderr: "pipe" });
  if (cp.exitCode !== 0) {
    rmSync(dest, { recursive: true, force: true });
    throw new CliError(
      `cp ${cowFlag} failed (source and dest must be on the same CoW filesystem): ${cp.stderr.toString().trim().slice(0, 500)}`,
    );
  }

  // Slot dir sits next to dest: same volume, so the .git graft is a rename.
  const slot = `${dest}.wt-${randomHex(4)}`;
  try {
    // The cloned .git points at the source's slot; a colocated .jj is a full
    // second jj store that would fight the jj-first probe. Drop both — the
    // clone is driven by plain git through its own freshly registered slot.
    rmSync(`${dest}/.git`, { recursive: true, force: true });
    rmSync(`${dest}/.jj`, { recursive: true, force: true });
    const addArgs = branch
      ? ["worktree", "add", "--no-checkout", slot, "-b", branch, head]
      : ["worktree", "add", "--no-checkout", "--detach", slot, head];
    git(["-C", source, ...addArgs]);
    renameSync(`${slot}/.git`, `${dest}/.git`);
    rmSync(slot, { recursive: true, force: true });
    git(["-C", source, "worktree", "repair", dest]);
    git(["-C", dest, "reset", "-q"]);
    // Feature branches track origin/main by convention; silently skip when
    // the ref does not exist (no remote, unfetched clone).
    const upstream =
      branch && gitOk(["-C", dest, "branch", "--set-upstream-to=origin/main", branch]) ? "origin/main" : null;
    return { source, dest, head, branch, upstream };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    rmSync(slot, { recursive: true, force: true });
    try {
      git(["-C", source, "worktree", "prune"]);
    } catch {}
    throw error;
  }
}

// Fan-out clones live under /tmp: macOS clears it on reboot and purges idle
// files, so an unremoved clone costs nothing durable. The prune below GCs the
// stale worktree registrations that such cleanup leaves behind, keeping
// `git worktree list` honest across reboots.
const FANOUT_CLONE_ROOT = "/tmp/orch-clones";

export function cloneForFanout(source: string, label: string): WorktreeCloneOutcome {
  const src = git(["-C", resolve(source), "rev-parse", "--show-toplevel"]);
  try {
    git(["-C", src, "worktree", "prune"]);
  } catch {}
  const slug = label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "thread";
  const dest = join(FANOUT_CLONE_ROOT, `${basename(src)}-${slug}-${randomHex(3)}`);
  return cloneWorktreeCow(src, dest, null);
}

export function removeWorktreeClone(source: string, dest: string): boolean {
  const proc = Bun.spawnSync(["git", "-C", source, "worktree", "remove", "--force", dest], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0;
}

// Default dest: a sibling of the source (<source>-<branch-slug>), which is
// also guaranteed to sit on the same filesystem — the CoW precondition.
export function defaultCloneDest(source: string, branch: string | null): string {
  const slug = branch ? branch.replace(/[^A-Za-z0-9._-]/g, "_") : `wt-${randomHex(3)}`;
  return join(dirname(source), `${basename(source)}-${slug}`);
}

export async function worktreeClone(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "worktree clone", ["source", "dest", "branch"]);
  const source = resolve(flagString(args, "source", process.cwd()));
  const branch = args.flags.has("branch") ? flagString(args, "branch") : null;
  const dest = flagString(args, "dest", defaultCloneDest(git(["-C", source, "rev-parse", "--show-toplevel"]), branch));
  const outcome = cloneWorktreeCow(source, dest, branch);
  printJson({
    worktree: "cloned",
    ...outcome,
    remove_with: `git -C ${outcome.source} worktree remove --force ${outcome.dest}`,
  });
  return 0;
}
