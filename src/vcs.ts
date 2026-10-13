import { $ } from "bun";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "./git-env.ts";
import type { VcsSnapshot } from "./types.ts";
import { nestedRepoDigest } from "./worktree.ts";

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
      env: gitEnv(),
    });
    const root = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
    // Nearest-repo rule: a git checkout nested inside a jj workspace (e.g. a
    // linked worktree under <jj-repo>/.claude/worktrees/) belongs to git —
    // jj root walks past it to the outer workspace and would misdirect
    // base/dirty/evidence to the outer working copy. jj wins only when git
    // agrees on the same root (colocated) or has no repo here at all.
    if (root) {
      const gitTop = gitToplevel(worktree);
      if (gitTop === null || realpathSync(root) === gitTop) result = { kind: "jj", jjRoot: root };
    }
  } catch {
    // jj missing or worktree unreadable: git handles (or fails) as before.
  }
  probeCache.set(worktree, result);
  return result;
}

// Nearest git toplevel, realpath'd; null when no git repo encloses the path
// (pure jj workspace — jj wins by default there).
function gitToplevel(worktree: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "ignore",
      env: gitEnv(),
    });
    const top = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
    return top ? realpathSync(top) : null;
  } catch {
    return null;
  }
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
    return (await $`jj log -r @ --no-graph -T commit_id`.cwd(worktree).env(gitEnv()).quiet().text()).trim();
  }
  return (await $`git -C ${worktree} rev-parse HEAD`.env(gitEnv()).quiet().text()).trim();
}

// Non-empty iff the worktree carries uncommitted work; "" on any failure.
// jj: @ is the working copy, so "dirty" means @ has file changes against its
// parents — empty exactly when work was `jj commit`ed / `jj new`ed away.
export async function vcsDirty(worktree: string): Promise<string> {
  try {
    if (vcsKind(worktree) === "jj") {
      return (await $`jj diff --summary`.cwd(worktree).env(gitEnv()).quiet().text()).trim();
    }
    return (await $`git -C ${worktree} status --porcelain`.env(gitEnv()).quiet().text()).trim();
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
        .env(gitEnv()).quiet()
        .text();
      return out.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
    }
    const branch = (await $`git -C ${worktree} rev-parse --abbrev-ref HEAD`.env(gitEnv()).quiet().text()).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

// URL of the `origin` remote, or "" when there is none. Callers decide the
// fallback (repo identity uses the root path).
export async function vcsRemoteOriginUrl(repoRoot: string): Promise<string> {
  if (vcsKind(repoRoot) === "jj") {
    const out = await $`jj git remote list`.cwd(repoRoot).env(gitEnv()).quiet().text();
    for (const line of out.split("\n")) {
      const [name, ...rest] = line.trim().split(/\s+/);
      if (name === "origin" && rest.length > 0) return rest.join(" ");
    }
    return "";
  }
  return (await $`git -C ${repoRoot} remote get-url origin`.env(gitEnv()).quiet().text()).trim();
}

// Host-captured identity of what a checkout currently contains: HEAD plus,
// when dirty, a hash of the on-disk content of every changed/untracked path. Throws
// when the worktree cannot be queried — callers must fail closed, never treat
// a failed query as "unchanged".
export async function vcsSnapshot(worktree: string): Promise<VcsSnapshot> {
  if (vcsKind(worktree) === "jj") {
    const root = jjWorkspaceRoot(worktree) ?? worktree;
    // jj snapshots on-disk edits into @ first, so @'s commit id already binds
    // content. An empty @ on top of a single parent is that parent's tree:
    // report the parent so `jj new` churn does not look like a new candidate.
    const template = 'commit_id ++ " " ++ if(empty, "empty", "changed") ++ " " ++ parents.map(|c| c.commit_id()).join(",")';
    const out = (await $`jj log -r @ --no-graph -T ${template}`.cwd(root).env(gitEnv()).quiet().text()).trim();
    const [id, state, parentList] = out.split(" ");
    if (!id || (state !== "empty" && state !== "changed")) throw new Error(`unexpected jj log output: ${out}`);
    const parents = (parentList ?? "").split(",").filter(Boolean);
    if (state === "empty" && parents.length === 1) return { vcs: "jj", head: parents[0]!, dirty: false, content_sha: parents[0]! };
    return { vcs: "jj", head: id, dirty: state === "changed", content_sha: state === "changed" ? `jj:${id}` : id };
  }
  const env = gitEnv();
  const head = (await $`git -C ${worktree} rev-parse --verify HEAD`.env(env).quiet().text()).trim();
  const root = (await $`git -C ${worktree} rev-parse --show-toplevel`.env(env).quiet().text()).trim();
  // Content-only fingerprint: every path whose working-tree state may differ
  // from HEAD (tracked edits staged or not, staged additions/deletions,
  // untracked files), recorded by its on-disk content. Index state is not
  // part of it, so a clone whose `reset --mixed` turned staged changes into
  // unstaged/untracked ones still matches when the bytes are the same.
  const changed = await $`git -C ${root} diff --name-only -z --no-renames --no-ext-diff HEAD --`.env(env).quiet().text();
  const untracked = await $`git -C ${root} ls-files --others --exclude-standard -z`.env(env).quiet().text();
  const paths = [...new Set(`${changed}\0${untracked}`.split("\0").filter(Boolean).map((rel) => rel.replace(/\/$/, "")))].sort();
  if (paths.length === 0) return { vcs: "git", head, dirty: false, content_sha: head };
  const records = paths.map((rel) => snapshotRecord(root, rel));
  const digest = createHash("sha256").update(JSON.stringify(["orch.git-content/v2", head, records])).digest("hex");
  return { vcs: "git", head, dirty: true, content_sha: `sha256:${digest}` };
}

// One typed record per path, so a regular file whose bytes spell a link
// target can never collide with a symlink. A directory here is a nested
// repository (untracked repo or submodule): pinned by its full digest, or
// rejected when that state cannot be proven — never reduced to its name.
function snapshotRecord(root: string, rel: string): unknown[] {
  const path = join(root, rel);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [rel, "absent"];
    throw error;
  }
  if (stat.isSymbolicLink()) return [rel, "symlink", readlinkSync(path)];
  if (stat.isFile()) return [rel, "file", stat.mode & 0o111 ? "exec" : "plain", createHash("sha256").update(readFileSync(path)).digest("hex")];
  if (stat.isDirectory()) {
    const digest = nestedRepoDigest(path);
    if (digest) return [rel, "repo", digest];
    throw new Error(`cannot fingerprint nested directory ${rel}: its repository state is not provable; commit, ignore or remove it`);
  }
  throw new Error(`cannot fingerprint special file ${rel}`);
}

// Resolve a user-supplied revision (`--head`) to a full commit id; throws when
// it names nothing.
export async function vcsResolveCommit(worktree: string, rev: string): Promise<string> {
  if (vcsKind(worktree) === "jj") {
    const root = jjWorkspaceRoot(worktree) ?? worktree;
    const out = (await $`jj log -r ${rev} --no-graph --ignore-working-copy -T ${'commit_id ++ "\\n"'}`.cwd(root).env(gitEnv()).quiet().text()).trim();
    const ids = out.split("\n").filter(Boolean);
    if (ids.length !== 1) throw new Error(`revision ${rev} resolves to ${ids.length} commits`);
    return ids[0]!;
  }
  return (await $`git -C ${worktree} rev-parse --verify --quiet ${`${rev}^{commit}`}`.env(gitEnv()).quiet().text()).trim();
}

export function sameSnapshot(a: VcsSnapshot | null | undefined, b: VcsSnapshot | null | undefined): boolean {
  return Boolean(a && b && a.vcs === b.vcs && a.head === b.head && a.content_sha === b.content_sha);
}

export function describeSnapshot(snapshot: VcsSnapshot | null | undefined): string {
  if (!snapshot) return "none";
  return `${snapshot.head.slice(0, 12)}${snapshot.dirty ? `+dirty(${snapshot.content_sha.replace(/^(sha256|jj):/, "").slice(0, 12)})` : ""}`;
}
