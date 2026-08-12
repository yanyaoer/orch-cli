import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomHex } from "./hash.ts";
import { assertKnownFlags, CliError, flagString, printJson, type ParsedArgs } from "./cli.ts";

// Per-agent isolated checkout via APFS copy-on-write. `cp -c` clones an 11 GB
// worktree in seconds at near-zero disk cost and — unlike `git worktree add` —
// carries the UNTRACKED build output (Gradle caches etc.), so the clone's
// incremental builds start warm. A raw clone would share the source's
// worktree slot (index/HEAD corruption under concurrent writers); the fix is
// to discard the cloned .git pointer and graft a freshly registered slot:
//   cp -c -R <source> <dest>            # CoW file clone
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
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new CliError(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim().slice(0, 500)}`);
  }
  return proc.stdout.toString().trim();
}

export function cloneWorktreeCow(sourceArg: string, destArg: string, branch: string | null): WorktreeCloneOutcome {
  if (process.platform !== "darwin") {
    throw new CliError("orch worktree clone requires macOS (APFS copy-on-write clonefile)");
  }
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
  const head = git(["-C", source, "rev-parse", "HEAD"]);
  const cp = Bun.spawnSync(["cp", "-c", "-R", source, dest], { stdout: "pipe", stderr: "pipe" });
  if (cp.exitCode !== 0) {
    rmSync(dest, { recursive: true, force: true });
    throw new CliError(
      `cp -c failed (source and dest must be on the same APFS volume): ${cp.stderr.toString().trim().slice(0, 500)}`,
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
    return { source, dest, head, branch };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    rmSync(slot, { recursive: true, force: true });
    try {
      git(["-C", source, "worktree", "prune"]);
    } catch {}
    throw error;
  }
}

export async function worktreeClone(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "worktree clone", ["source", "dest", "branch"]);
  const source = flagString(args, "source", process.cwd());
  const dest = flagString(args, "dest");
  const branch = args.flags.has("branch") ? flagString(args, "branch") : null;
  const outcome = cloneWorktreeCow(source, dest, branch);
  printJson({
    worktree: "cloned",
    ...outcome,
    remove_with: `git -C ${outcome.source} worktree remove --force ${outcome.dest}`,
  });
  return 0;
}
