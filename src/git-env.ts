// Repository-locating variables from `git rev-parse --local-env-vars`. Any of
// them inherited from the caller (a git hook, a wrapper, a stale shell) would
// redirect `git -C <worktree>` to another repository or index, so snapshots,
// repo identity and locks would describe a checkout other than the one the
// provider actually runs in. orch always locates the repo from the worktree.
const GIT_LOCATION_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
] as const;

// Remove the locating variables in place. Note Bun.spawn/spawnSync without an
// explicit `env` still use the process's original environment, so git/jj
// spawns must also pass `env: gitEnv()`.
export function scrubGitLocationEnv(env: Record<string, string | undefined>): void {
  for (const key of GIT_LOCATION_ENV_KEYS) delete env[key];
}

// Copy of process.env (or `base`) without the locating variables.
export function gitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  scrubGitLocationEnv(env);
  return env;
}
