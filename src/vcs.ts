import { $ } from "bun";

// jj-first local VCS seam. A worktree managed by Jujutsu answers every local
// VCS question through jj — including colocated repos, where plain git
// "works" but keeps HEAD detached at @-, so branch→MR inference and dirty
// semantics silently degrade. Anything else (or a machine without jj) falls
// back to git. Consumers with bespoke output plumbing (evidence redirects,
// handoff capture) branch on vcsKind locally; only the shared questions live
// here.
export type VcsKind = "jj" | "git";

interface VcsProbe {
  kind: VcsKind;
  // Workspace root as reported by `jj root`; null for git/non-repos.
  jjRoot: string | null;
}

// One probe per distinct worktree path per process: the answer cannot change
// mid-run, and every op would otherwise pay the spawn.
const probeCache = new Map<string, VcsProbe>();

function probe(worktree: string): VcsProbe {
  const cached = probeCache.get(worktree);
  if (cached) return cached;
  let result: VcsProbe = { kind: "git", jjRoot: null };
  try {
    // --ignore-working-copy: a pure existence question must not snapshot.
    const proc = Bun.spawnSync(["jj", "root", "--ignore-working-copy"], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "ignore",
    });
    const root = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
    if (root) result = { kind: "jj", jjRoot: root };
  } catch {
    // jj missing or worktree unreadable: git handles (or fails) as before.
  }
  probeCache.set(worktree, result);
  return result;
}

export function vcsKind(worktree: string): VcsKind {
  return probe(worktree).kind;
}

export function jjWorkspaceRoot(worktree: string): string | null {
  return probe(worktree).jjRoot;
}

// Current commit of the working copy; throws when the worktree is no repo.
// jj snapshots first, so pre-existing on-disk edits become part of the base —
// a later `jj diff --from <base>` then shows exactly what a run changed.
export async function vcsHead(worktree: string): Promise<string> {
  if (vcsKind(worktree) === "jj") {
    return (await $`jj log -r @ --no-graph -T commit_id`.cwd(worktree).quiet().text()).trim();
  }
  return (await $`git -C ${worktree} rev-parse HEAD`.quiet().text()).trim();
}

// Non-empty iff the worktree carries uncommitted work; "" on any failure.
// jj: @ is the working copy, so "dirty" means @ has file changes against its
// parents — empty exactly when work was `jj commit`ed / `jj new`ed away.
export async function vcsDirty(worktree: string): Promise<string> {
  try {
    if (vcsKind(worktree) === "jj") {
      return (await $`jj diff --summary`.cwd(worktree).quiet().text()).trim();
    }
    return (await $`git -C ${worktree} status --porcelain`.quiet().text()).trim();
  } catch {
    return "";
  }
}

// Branch (git) / nearest bookmark (jj) naming the line of work at @, for
// MR inference. jj bookmarks trail the working copy, so look at the closest
// bookmarked ancestor rather than @ alone; remote-only refs never qualify.
export async function vcsBranch(worktree: string): Promise<string | null> {
  try {
    if (vcsKind(worktree) === "jj") {
      const out = await $`jj log -r ${"heads(::@ & bookmarks())"} --no-graph --ignore-working-copy -T ${'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"'}`
        .cwd(worktree)
        .quiet()
        .text();
      return out.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
    }
    const branch = (await $`git -C ${worktree} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

// URL of the `origin` remote, or "" when there is none. Callers decide the
// fallback (repo identity uses the root path).
export async function vcsRemoteOriginUrl(repoRoot: string): Promise<string> {
  if (vcsKind(repoRoot) === "jj") {
    const out = await $`jj git remote list`.cwd(repoRoot).quiet().text();
    for (const line of out.split("\n")) {
      const [name, ...rest] = line.trim().split(/\s+/);
      if (name === "origin" && rest.length > 0) return rest.join(" ");
    }
    return "";
  }
  return (await $`git -C ${repoRoot} remote get-url origin`.quiet().text()).trim();
}
