import { basename, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { $ } from "bun";
import { shortHash } from "./hash.ts";

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

export function mrStateDir(repoKey: string, mr: string): string {
  return `${orchStateRoot()}/${repoKey}/mrs/${mr}`;
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
    const parts = ssh[2].split("/").filter(Boolean);
    const project = parts.pop() ?? basename(repoRoot);
    return `${ssh[1]}/${parts.join("/")}/${project}-${hash}`.replace(/\/+/g, "/");
  }

  try {
    const url = new URL(cleaned);
    const parts = url.pathname.split("/").filter(Boolean);
    const project = (parts.pop() ?? basename(repoRoot)).replace(/\.git$/, "");
    return `${url.host}/${parts.join("/")}/${project}-${hash}`.replace(/\/+/g, "/");
  } catch {
    return `local/${basename(repoRoot)}-${hash}`;
  }
}

export async function getRepoIdentity(worktree: string): Promise<RepoIdentity> {
  const repoRoot = realpathSync(resolve(worktree));
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

export function lockPathForWorktree(mrDir: string, worktree: string): string {
  return `${mrDir}/locks/worktree.${shortHash(resolve(worktree), 64)}.lock`;
}

