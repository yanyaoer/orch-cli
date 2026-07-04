import { basename, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { $ } from "bun";
import { sha256, shortHash } from "./hash.ts";

export interface RepoIdentity {
  repo_root: string;
  remote_url: string;
  repo_key: string;
}

export function stateHome(): string {
  return process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`;
}

export function orchStateRoot(): string {
  return `${stateHome()}/orch`;
}

export function mailControlStateDir(): string {
  return `${orchStateRoot()}/mail-control`;
}

export function statePathSegment(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return `${fallback}-${shortHash(value || fallback)}`;
  return cleaned;
}

export function mrStateDir(repoKey: string, mr: string): string {
  return `${orchStateRoot()}/${repoKey}/mrs/${statePathSegment(mr, "mr")}`;
}

export function ensureStateLayout(mrDir: string): void {
  for (const rel of ["locks", "outbox/pending", "outbox/sent", "runs"]) {
    mkdirSync(`${mrDir}/${rel}`, { recursive: true });
  }
}

export function repoKeyFromRemote(remoteUrl: string, repoRoot: string): string {
  const hash = shortHash(remoteUrl || repoRoot);
  const cleaned = remoteUrl.trim().replace(/\.git$/, "");
  const ssh = cleaned.match(/^git@([^:]+):(.+)$/);
  if (ssh?.[1] && ssh?.[2]) {
    const rawParts = ssh[2].split("/").filter(Boolean);
    const project = statePathSegment(rawParts.pop() ?? basename(repoRoot), "repo");
    const parts = rawParts.map((part) => statePathSegment(part, "group"));
    return `${statePathSegment(ssh[1], "host")}/${parts.join("/")}/${project}-${hash}`.replace(/\/+/g, "/");
  }

  try {
    const url = new URL(cleaned);
    const rawParts = url.pathname.split("/").filter(Boolean);
    const project = statePathSegment((rawParts.pop() ?? basename(repoRoot)).replace(/\.git$/, ""), "repo");
    const parts = rawParts.map((part) => statePathSegment(part, "group"));
    return `${statePathSegment(url.host, "host")}/${parts.join("/")}/${project}-${hash}`.replace(/\/+/g, "/");
  } catch {
    return `local/${statePathSegment(basename(repoRoot), "repo")}-${hash}`;
  }
}

export function canonicalWorktreeRoot(worktree: string): string {
  const resolved = resolve(worktree);
  try {
    const proc = Bun.spawnSync(["git", "-C", resolved, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const root = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
    if (root) return realpathSync(root);
  } catch {
    // Fall through to the resolved path for non-git directories.
  }
  return realpathSync(resolved);
}

export async function getRepoIdentity(worktree: string): Promise<RepoIdentity> {
  const repoRoot = canonicalWorktreeRoot(worktree);
  let remoteUrl = "";
  try {
    remoteUrl = (await $`git -C ${repoRoot} remote get-url origin`.quiet().text()).trim();
  } catch {
    remoteUrl = repoRoot;
  }
  if (!remoteUrl) remoteUrl = repoRoot;
  return {
    repo_root: repoRoot,
    remote_url: remoteUrl,
    repo_key: repoKeyFromRemote(remoteUrl, repoRoot),
  };
}

export function lockPathForWorktree(worktree: string): string {
  return `${orchStateRoot()}/worktree-locks/${sha256(canonicalWorktreeRoot(worktree))}.lock`;
}
