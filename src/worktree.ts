import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomHex, sha256 } from "./hash.ts";
import { assertKnownFlags, CliError, collectFlags, flagString, printJson, type ParsedArgs } from "./cli.ts";

export type WorktreeMaterializationMode = "snapshot" | "warm-head";
export type ExternalSymlinkPolicy = "preserve" | "warn" | "reject";

export interface WorktreeCloneOptions {
  mode?: WorktreeMaterializationMode;
  cachePaths?: string[];
  exclude?: string[];
  externalSymlinks?: ExternalSymlinkPolicy;
  targetBranch?: string | null;
}

export interface WorktreeCloneOutcome {
  source: string;
  dest: string;
  head: string;
  branch: string | null;
  upstream: string | null;
  mode: WorktreeMaterializationMode;
  cache_paths: string[];
  excluded: string[];
  rewritten_symlinks: string[];
  external_symlinks: string[];
  provenance: string;
}

export interface CowCopyBackend {
  copy(source: string, dest: string): void;
}

export type CowBackendFactory = (destParent: string) => CowCopyBackend;

interface WorkspaceState {
  index: string;
  worktree: string;
  untracked: string;
  index_clean: boolean;
  worktree_clean: boolean;
  untracked_empty: boolean;
  untracked_unverifiable: string[];
}

interface CloneProvenance {
  schema: "orch.worktree-clone/v1";
  source: string;
  dest: string;
  head: string;
  branch: string | null;
  upstream: string | null;
  created_at: string;
  mode: WorktreeMaterializationMode;
  cache_paths: string[];
  excluded: string[];
  external_symlink_policy: ExternalSymlinkPolicy;
  rewritten_symlinks: string[];
  external_symlinks: string[];
  baseline: WorkspaceState;
}

export interface WorktreeLossAssessment {
  safe: boolean;
  losses: string[];
}

function spawnGit(args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
}

function gitRaw(args: string[]): string {
  const proc = spawnGit(args);
  if (proc.exitCode !== 0) {
    throw new CliError(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim().slice(0, 500)}`);
  }
  return proc.stdout.toString();
}

function git(args: string[]): string {
  return gitRaw(args).trim();
}

function gitOk(args: string[]): boolean {
  return spawnGit(args).exitCode === 0;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function inside(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

// Canonicalizes the longest resolvable prefix and joins the rest lexically.
// A dangling symlink component makes realpathSync throw even though lstat
// sees it; climb past it instead of failing, or a clone-internal chain
// through a dangling link would be misclassified as external.
function canonicalizeAllowMissing(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync(cursor), ...suffix);
    } catch {}
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
}

function ensurePrivateDirectory(path: string): string {
  if (pathExists(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CliError(`private worktree path must be a real directory: ${path}`);
    }
  } else {
    mkdirSync(path, { mode: 0o700 });
  }
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function privateWorktreeRoot(source: string): string {
  const storage = ensurePrivateDirectory(join(dirname(source), ".orch-worktrees"));
  return ensurePrivateDirectory(join(storage, basename(source)));
}

// Probe where the clone will live. No silent full-copy fallback: an unattended
// "seconds" operation must not turn into a multi-minute copy of a large tree.
function systemCowBackend(destParent: string): CowCopyBackend {
  const probe = join(destParent, `.orch-cowprobe-${randomHex(4)}`);
  const clone = `${probe}.clone`;
  // Per-platform binary and flag: on some older GNU coreutils builds `cp -c`
  // is `--preserve=context` and exits 0 with a full copy, which would defeat
  // the fail-closed CoW contract — so Linux only ever probes reflink, and
  // darwin pins the system cp (a PATH-shadowing GNU cp would either reject
  // -c or silently full-copy).
  const cpBin = process.platform === "darwin" ? "/bin/cp" : "cp";
  let flag: string | null = null;
  try {
    writeFileSync(probe, "");
    const candidates = process.platform === "darwin" ? ["-c"] : ["--reflink=always"];
    for (const candidate of candidates) {
      const proc = Bun.spawnSync([cpBin, candidate, probe, clone], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode === 0) {
        flag = candidate;
        break;
      }
      rmSync(clone, { force: true });
    }
  } finally {
    rmSync(probe, { force: true });
    rmSync(clone, { force: true });
  }
  if (!flag) {
    throw new CliError(
      `no copy-on-write support on ${destParent} (needs APFS clonefile or reflink: Btrfs/XFS/ZFS); refusing a slow full copy — cp -R manually if that is acceptable`,
    );
  }
  return {
    copy(source: string, dest: string): void {
      const proc = Bun.spawnSync([cpBin, flag!, "-R", "-P", source, dest], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) {
        throw new CliError(
          `cp ${flag} failed (source and dest must be on the same CoW filesystem): ${proc.stderr.toString().trim().slice(0, 500)}`,
        );
      }
    },
  };
}

// "parked path" covers filenames enumerated from git itself: they may contain
// literal glob characters or backslashes, so only traversal and VCS-metadata
// guards apply — never the glob-char rejection meant for user-typed cache paths.
function validatePolicyPath(path: string, kind: "cache path" | "exclude pattern" | "parked path"): string {
  const normalized = kind === "parked path" ? path : path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || isAbsolute(path) || normalized.split("/").includes("..")) {
    throw new CliError(`${kind} must stay inside the worktree: ${path}`);
  }
  if (kind === "cache path" && /[*?\[\]{}]/.test(normalized)) {
    throw new CliError(`cache path must be a literal relative path: ${path}`);
  }
  if (normalized === ".git" || normalized.startsWith(".git/") || normalized === ".jj" || normalized.startsWith(".jj/")) {
    throw new CliError(`${kind} cannot select VCS metadata: ${path}`);
  }
  return normalized;
}

function normalizeOptions(options: WorktreeCloneOptions): Required<WorktreeCloneOptions> {
  const mode = options.mode ?? "snapshot";
  if (mode !== "snapshot" && mode !== "warm-head") throw new CliError(`unknown worktree mode: ${mode}`);
  const externalSymlinks = options.externalSymlinks ?? "warn";
  if (!(["preserve", "warn", "reject"] as string[]).includes(externalSymlinks)) {
    throw new CliError(`unknown external symlink policy: ${externalSymlinks}`);
  }
  const cachePaths = [...new Set((options.cachePaths ?? []).map((path) => validatePolicyPath(path, "cache path")))];
  const exclude = [...new Set((options.exclude ?? []).map((path) => validatePolicyPath(path, "exclude pattern")))];
  for (const pattern of exclude) new Bun.Glob(pattern);
  return { mode, cachePaths, exclude, externalSymlinks, targetBranch: options.targetBranch ?? null };
}

function isExcluded(rel: string, matchers: Bun.Glob[]): boolean {
  const normalized = rel.split(sep).join("/");
  return matchers.some((matcher) => matcher.match(normalized));
}

function copyFiltered(
  sourceRoot: string,
  destRoot: string,
  rel: string,
  copier: CowCopyBackend,
  matchers: Bun.Glob[],
): void {
  if (isExcluded(rel, matchers)) return;
  const source = join(sourceRoot, rel);
  const dest = join(destRoot, rel);
  const stat = lstatSync(source);
  if (!stat.isDirectory()) {
    mkdirSync(dirname(dest), { recursive: true });
    copier.copy(source, dest);
    return;
  }
  // Owner-write is forced so children can be copied into a read-only source
  // directory; group/other bits never widen beyond the source's own mode.
  mkdirSync(dest, { recursive: true, mode: (stat.mode & 0o777) | 0o700 });
  for (const entry of readdirSync(source)) copyFiltered(sourceRoot, destRoot, join(rel, entry), copier, matchers);
  // Restore the exact source mode only after its children are copied.
  chmodSync(dest, stat.mode & 0o777);
}

function copySnapshot(source: string, dest: string, copier: CowCopyBackend, exclude: string[]): void {
  const matchers = exclude.map((pattern) => new Bun.Glob(pattern));
  for (const entry of readdirSync(source)) {
    if (entry === ".git" || entry === ".jj") continue;
    if (matchers.length === 0) copier.copy(join(source, entry), join(dest, entry));
    else copyFiltered(source, dest, entry, copier, matchers);
  }
}

function normalizeCachePaths(paths: string[]): string[] {
  return paths
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .filter((candidate, index, all) => !all.slice(0, index).some((parent) => inside(parent, candidate) !== null));
}

function validateExistingCaches(source: string, paths: string[]): string[] {
  const normalized = normalizeCachePaths([...paths]);
  for (const rel of normalized) {
    if (!pathExists(join(source, rel))) continue;
    if (!gitOk(["-C", source, "check-ignore", "--quiet", "--", rel])) {
      throw new CliError(`cache path must be ignored by git: ${rel}`);
    }
  }
  return normalized;
}

function copyWarmCaches(source: string, dest: string, copier: CowCopyBackend, paths: string[], exclude: string[]): string[] {
  const matchers = exclude.map((pattern) => new Bun.Glob(pattern));
  const copied: string[] = [];
  for (const rel of paths) {
    const sourcePath = join(source, rel);
    if (!pathExists(sourcePath)) continue;
    if (!gitOk(["-C", source, "check-ignore", "--quiet", "--", rel])) {
      throw new CliError(`warm-head cache path must be ignored by git: ${rel}`);
    }
    if (isExcluded(rel, matchers)) continue;
    if (matchers.length === 0) {
      // Bulk-copy the whole cache in one CoW call — the per-file walk below
      // would turn a large build cache into O(files) cp spawns.
      const destPath = join(dest, rel);
      mkdirSync(dirname(destPath), { recursive: true });
      copier.copy(sourcePath, destPath);
    } else {
      copyFiltered(source, dest, rel, copier, matchers);
    }
    copied.push(rel);
  }
  return copied;
}

function classifyAndRetargetSymlinks(
  source: string,
  dest: string,
  policy: ExternalSymlinkPolicy,
): { rewritten: string[]; external: string[] } {
  const rewritten: string[] = [];
  const external: string[] = [];
  const links: Array<{ path: string; rel: string; target: string }> = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === dest && entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (stat.isSymbolicLink()) links.push({ path, rel: relative(dest, path), target: readlinkSync(path) });
    }
  };
  visit(dest);
  const retargetToClone = (link: { path: string; rel: string }, sourceRelative: string): void => {
    rmSync(link.path);
    symlinkSync(join(dest, sourceRelative), link.path);
    rewritten.push(link.rel);
  };
  const markExternal = (link: { rel: string; target: string }): void => {
    external.push(link.rel);
    if (policy === "reject") throw new CliError(`external symlink rejected: ${link.rel} -> ${link.target}`);
  };
  // Pass 1 — absolute links, classified in the source's frame: a target inside
  // the source retargets to the clone so writes can never land in the source.
  for (const link of links.filter((entry) => isAbsolute(entry.target))) {
    let sourceRelative: string | null = null;
    try {
      sourceRelative = inside(source, canonicalizeAllowMissing(resolve(link.target)));
    } catch {}
    if (sourceRelative !== null) retargetToClone(link, sourceRelative);
    else markExternal(link);
  }
  // Pass 2 — relative links, classified in the CLONE's frame, the only frame
  // that matters at runtime (after pass 1 so absolute-internal intermediates
  // already resolve inside the clone). A link that lexically stays inside the
  // source can still exit the clone and re-enter the source by name; when it
  // does, retarget it to the clone like an absolute-internal link.
  for (const link of links.filter((entry) => !isAbsolute(entry.target))) {
    let canonical: string;
    try {
      canonical = canonicalizeAllowMissing(resolve(dirname(link.path), link.target));
    } catch {
      markExternal(link);
      continue;
    }
    if (inside(dest, canonical) !== null) continue;
    const sourceRelative = inside(source, canonical);
    if (sourceRelative !== null) retargetToClone(link, sourceRelative);
    else markExternal(link);
  }
  if (policy === "warn" && external.length > 0) {
    process.stderr.write(
      `orch: warning: clone preserves ${external.length} external symlink(s): ${external.slice(0, 5).join(", ")}${external.length > 5 ? ", ..." : ""}\n`,
    );
  }
  return { rewritten, external };
}

function detectUpstream(repo: string, branch: string | null, targetBranch: string | null): string | null {
  if (!branch) return null;
  const candidates: string[] = [];
  if (targetBranch) candidates.push(targetBranch.startsWith("origin/") ? targetBranch : `origin/${targetBranch}`);
  const originHead = spawnGit(["-C", repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.exitCode === 0) candidates.push(originHead.stdout.toString().trim());
  candidates.push("origin/main", "origin/master", "origin/trunk");
  for (const candidate of [...new Set(candidates)]) {
    if (!gitOk(["-C", repo, "show-ref", "--verify", "--quiet", `refs/remotes/${candidate}`])) continue;
    if (gitOk(["-C", repo, "branch", "--set-upstream-to", candidate, branch])) return candidate;
  }
  return null;
}

// A digest that pins an untracked nested repository's provable state: HEAD,
// every ref (branches, tags, stash), and its own recursive workspace state.
// null means the state cannot be proven and loss detection must fail closed.
function nestedRepoDigest(path: string): string | null {
  try {
    const refs = spawnGit(["-C", path, "for-each-ref", "--format=%(refname) %(objectname)"]);
    if (refs.exitCode !== 0) return null;
    const head = spawnGit(["-C", path, "rev-parse", "--quiet", "--verify", "HEAD"]);
    const state = workspaceState(path);
    if (state.untracked_unverifiable.length > 0) return null;
    return sha256(
      [
        head.exitCode === 0 ? head.stdout.toString().trim() : "no-head",
        refs.stdout.toString(),
        state.index,
        state.worktree,
        state.untracked,
      ].join("\n"),
    );
  } catch {
    return null;
  }
}

function untrackedManifest(repo: string): { manifest: string; unverifiable: string[] } {
  const paths = gitRaw(["-C", repo, "ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const unverifiable: string[] = [];
  const records = paths.map((rel) => {
    const path = join(repo, rel.replace(/\/$/, ""));
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [rel, "symlink", sha256(readlinkSync(path))];
    if (stat.isFile()) return [rel, "file", git(["-C", repo, "hash-object", "--", rel])];
    if (stat.isDirectory()) {
      // ls-files emits a bare directory only for an untracked nested
      // repository; pin it by digest when provable, fail closed otherwise.
      const digest = nestedRepoDigest(path);
      if (digest) return [rel, "nested-repo", digest];
      unverifiable.push(rel);
      return [rel, "nested-repo", "unverifiable"];
    }
    return [rel, "special", `${stat.mode}:${stat.size}`];
  });
  return { manifest: JSON.stringify(records), unverifiable };
}

function workspaceState(repo: string): WorkspaceState {
  const indexPatch = gitRaw(["-C", repo, "diff", "--cached", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const worktreePatch = gitRaw(["-C", repo, "diff", "--binary", "--no-ext-diff", "--"]);
  const untracked = untrackedManifest(repo);
  return {
    index: sha256(indexPatch),
    worktree: sha256(worktreePatch),
    untracked: sha256(untracked.manifest),
    index_clean: indexPatch.length === 0,
    worktree_clean: worktreePatch.length === 0,
    untracked_empty: untracked.manifest === "[]",
    untracked_unverifiable: untracked.unverifiable,
  };
}

function provenancePath(dest: string): string {
  return join(git(["-C", dest, "rev-parse", "--absolute-git-dir"]), "orch-clone.json");
}

function writeProvenance(dest: string, provenance: CloneProvenance): string {
  const path = provenancePath(dest);
  const temp = `${path}.tmp-${randomHex(4)}`;
  try {
    writeFileSync(temp, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return path;
}

function readProvenance(dest: string): CloneProvenance | null {
  try {
    const parsed = JSON.parse(readFileSync(provenancePath(dest), "utf8")) as CloneProvenance;
    return parsed.schema === "orch.worktree-clone/v1" ? parsed : null;
  } catch {
    return null;
  }
}

// Every step is individually guarded: this runs inside a catch block, and no
// cleanup failure (including a spawn that fails to launch) may replace the
// original error or skip the remaining steps.
function attempt(step: () => unknown): void {
  try {
    step();
  } catch {}
}

// A copied read-only directory blocks unlink of its children; repair the
// doomed tree's modes (never the source's) and retry.
function forceRemoveTree(path: string): void {
  attempt(() => rmSync(path, { recursive: true, force: true }));
  if (!pathExists(path)) return;
  attempt(() => Bun.spawnSync(["chmod", "-R", "u+w", path], { stdout: "pipe", stderr: "pipe" }));
  attempt(() => rmSync(path, { recursive: true, force: true }));
}

function rollbackClone(source: string, dest: string, branch: string | null, registered: boolean): void {
  if (registered) attempt(() => gitOk(["-C", source, "worktree", "remove", "--force", dest]));
  forceRemoveTree(dest);
  attempt(() => gitOk(["-C", source, "worktree", "prune"]));
  if (registered && branch) attempt(() => gitOk(["-C", source, "branch", "-D", branch]));
}

// Register the real worktree first, then materialize content around its .git
// pointer. This avoids copying the object store and eliminates slot grafting
// and `git worktree repair` from the old flow.
export function cloneWorktreeCow(
  sourceArg: string,
  destArg: string,
  branch: string | null,
  options: WorktreeCloneOptions = {},
  backendFactory: CowBackendFactory = systemCowBackend,
): WorktreeCloneOutcome {
  const source = realpathSync(git(["-C", resolve(sourceArg), "rev-parse", "--show-toplevel"]));
  const rejectInside = (path: string): never => {
    throw new CliError(`dest must live outside the source worktree: ${path}`);
  };
  const destResolved = resolve(destArg);
  if (inside(source, destResolved) !== null) rejectInside(destResolved);
  mkdirSync(dirname(destResolved), { recursive: true });
  const dest = join(realpathSync(dirname(destResolved)), basename(destResolved));
  if (pathExists(dest)) throw new CliError(`dest already exists: ${dest}`);
  if (inside(source, dest) !== null) rejectInside(dest);
  if (branch && gitOk(["-C", source, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new CliError(`branch already exists: ${branch}`);
  }

  const normalized = normalizeOptions(options);
  normalized.cachePaths = validateExistingCaches(source, normalized.cachePaths);
  const head = git(["-C", source, "rev-parse", "HEAD"]);
  const copier = backendFactory(dirname(dest));
  let registered = false;
  try {
    const addArgs = branch
      ? ["worktree", "add", "--no-checkout", dest, "-b", branch, head]
      : ["worktree", "add", "--no-checkout", "--detach", dest, head];
    git(["-C", source, ...addArgs]);
    registered = true;

    let copiedCaches: string[] = [];
    if (normalized.mode === "snapshot") {
      copySnapshot(source, dest, copier, normalized.exclude);
      git(["-C", dest, "reset", "--mixed", "-q", "HEAD"]);
      copiedCaches = normalized.cachePaths.filter((path) => pathExists(join(dest, path)));
    } else {
      git(["-C", dest, "reset", "--hard", "-q", "HEAD"]);
      copiedCaches = copyWarmCaches(source, dest, copier, normalized.cachePaths, normalized.exclude);
    }

    const links = classifyAndRetargetSymlinks(source, dest, normalized.externalSymlinks);
    const upstream = detectUpstream(dest, branch, normalized.targetBranch);
    const provenance: CloneProvenance = {
      schema: "orch.worktree-clone/v1",
      source,
      dest,
      head,
      branch,
      upstream,
      created_at: new Date().toISOString(),
      mode: normalized.mode,
      cache_paths: copiedCaches,
      excluded: normalized.exclude,
      external_symlink_policy: normalized.externalSymlinks,
      rewritten_symlinks: links.rewritten,
      external_symlinks: links.external,
      baseline: workspaceState(dest),
    };
    const provenanceFile = writeProvenance(dest, provenance);
    return {
      source,
      dest,
      head,
      branch,
      upstream,
      mode: normalized.mode,
      cache_paths: copiedCaches,
      excluded: normalized.exclude,
      rewritten_symlinks: links.rewritten,
      external_symlinks: links.external,
      provenance: provenanceFile,
    };
  } catch (error) {
    rollbackClone(source, dest, branch, registered);
    throw error;
  }
}

export function cloneForFanout(
  source: string,
  label: string,
  options: WorktreeCloneOptions = {},
  backendFactory: CowBackendFactory = systemCowBackend,
): WorktreeCloneOutcome {
  const src = realpathSync(git(["-C", resolve(source), "rev-parse", "--show-toplevel"]));
  gitOk(["-C", src, "worktree", "prune"]);
  const root = privateWorktreeRoot(src);
  const slug = label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "thread";
  const dest = join(root, `${slug}-${randomHex(3)}`);
  return cloneWorktreeCow(src, dest, null, options, backendFactory);
}

function commitIsPreserved(repo: string, head: string): boolean {
  const branch = spawnGit(["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.exitCode === 0 && branch.stdout.toString().trim()) return true;
  const refs = spawnGit([
    "-C",
    repo,
    "for-each-ref",
    `--contains=${head}`,
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  return refs.exitCode === 0 && refs.stdout.toString().trim().length > 0;
}

export function inspectWorktreeLosses(sourceArg: string, destArg: string): WorktreeLossAssessment {
  if (!pathExists(destArg)) return { safe: true, losses: [] };
  const losses: string[] = [];
  try {
    const source = realpathSync(git(["-C", resolve(sourceArg), "rev-parse", "--show-toplevel"]));
    const dest = realpathSync(destArg);
    const provenance = readProvenance(dest);
    if (!provenance) return { safe: false, losses: ["clone provenance is missing or invalid"] };
    if (provenance.source !== source || provenance.dest !== dest) {
      return { safe: false, losses: ["clone provenance does not match source and destination"] };
    }
    const head = git(["-C", dest, "rev-parse", "HEAD"]);
    const state = workspaceState(dest);
    for (const rel of state.untracked_unverifiable) {
      losses.push(`untracked nested repository cannot be verified: ${rel}`);
    }
    if (head === provenance.head) {
      if (state.index !== provenance.baseline.index) losses.push("index differs from the inherited baseline");
      if (state.worktree !== provenance.baseline.worktree) losses.push("worktree differs from the inherited baseline");
      if (state.untracked !== provenance.baseline.untracked) losses.push("untracked files differ from the inherited baseline");
    } else {
      if (!commitIsPreserved(dest, head)) losses.push(`detached commit is not reachable from a ref: ${head}`);
      if (!state.index_clean || !state.worktree_clean) losses.push("committed work is preserved, but tracked changes remain");
      if (state.untracked !== provenance.baseline.untracked) losses.push("untracked files differ from the inherited baseline");
    }
  } catch (error) {
    losses.push(error instanceof Error ? error.message : String(error));
  }
  return { safe: losses.length === 0, losses };
}

function listParkablePaths(dest: string, provenance: CloneProvenance): string[] {
  const raw = [
    ...provenance.cache_paths,
    ...gitRaw(["-C", dest, "ls-files", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "-z"])
      .split("\0")
      .filter(Boolean),
    ...gitRaw([
      "-C",
      dest,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
    ])
      .split("\0")
      .filter(Boolean),
  ];
  const candidates = [...new Set(raw.map((path) => path.replace(/\/$/, "")).map((path) => validatePolicyPath(path, "parked path")))]
    .filter((path) => pathExists(join(dest, path)))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return candidates.filter((candidate, index) => !candidates.slice(0, index).some((parent) => inside(parent, candidate) !== null));
}

function restoreParked(moves: Array<{ from: string; to: string }>, parkRoot: string): void {
  for (const move of [...moves].reverse()) {
    if (!pathExists(move.to) || pathExists(move.from)) continue;
    mkdirSync(dirname(move.from), { recursive: true });
    renameSync(move.to, move.from);
  }
  if (!pathExists(parkRoot)) return;
  // The manifest is the only index -> original-path map; it must outlive any
  // entry that could not be restored (e.g. its original path was recreated).
  const leftover = readdirSync(parkRoot).filter((name) => name !== "manifest.json");
  if (leftover.length === 0) rmSync(parkRoot, { recursive: true, force: true });
}

function worktreeRegistered(source: string, dest: string): boolean {
  const list = spawnGit(["-C", source, "worktree", "list", "--porcelain"]);
  if (list.exitCode !== 0) return true;
  let canonical = dest;
  try {
    canonical = realpathSync(dest);
  } catch {}
  return list.stdout
    .toString()
    .split("\n")
    .some((line) => line === `worktree ${dest}` || line === `worktree ${canonical}`);
}

function sweepDetached(path: string): void {
  try {
    const proc = Bun.spawn(["rm", "-rf", "--", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    proc.unref();
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}

export function removeWorktreeClone(source: string, dest: string): boolean {
  const assessment = inspectWorktreeLosses(source, dest);
  if (!assessment.safe) return false;
  if (!pathExists(dest)) {
    gitOk(["-C", source, "worktree", "prune"]);
    return true;
  }
  const provenance = readProvenance(dest);
  if (!provenance) return false;

  let parkRoot: string | null = null;
  const moves: Array<{ from: string; to: string }> = [];
  try {
    const paths = listParkablePaths(dest, provenance);
    if (paths.length > 0) {
      const trash = ensurePrivateDirectory(join(privateWorktreeRoot(provenance.source), ".trash"));
      parkRoot = ensurePrivateDirectory(join(trash, `${basename(dest)}-${randomHex(4)}`));
      // Persist the index -> original-path map before the first rename: a crash
      // mid-park must leave enough to reassemble the clone by hand.
      writeFileSync(
        join(parkRoot, "manifest.json"),
        `${JSON.stringify(paths.map((rel, index) => ({ index, rel })))}\n`,
        { mode: 0o600 },
      );
      for (const [index, rel] of paths.entries()) {
        const from = join(dest, rel);
        const to = join(parkRoot, String(index));
        renameSync(from, to);
        moves.push({ from, to });
      }
    }
    if (!gitOk(["-C", source, "worktree", "remove", "--force", dest])) {
      // git deletes the worktree registration even when content deletion
      // fails ("there's no going back from here"): once the slot is gone,
      // the only consistent forward path is to finish the removal — safety
      // was proven before parking. A still-registered failure (e.g. a
      // locked worktree) restores the parked paths and reports failure.
      if (worktreeRegistered(source, dest)) {
        if (parkRoot) restoreParked(moves, parkRoot);
        return false;
      }
      forceRemoveTree(dest);
      gitOk(["-C", source, "worktree", "prune"]);
      if (pathExists(dest)) return false;
    }
    if (parkRoot) sweepDetached(parkRoot);
    return true;
  } catch {
    if (parkRoot) {
      try {
        restoreParked(moves, parkRoot);
      } catch {}
    }
    return false;
  }
}

export function defaultCloneDest(source: string, branch: string | null): string {
  const slug = branch ? branch.replace(/[^A-Za-z0-9._-]/g, "_") : `wt-${randomHex(3)}`;
  return join(dirname(source), `${basename(source)}-${slug}`);
}

export async function worktreeClone(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "worktree clone", [
    "source",
    "dest",
    "branch",
    "mode",
    "cache-path",
    "exclude",
    "external-symlinks",
    "target-branch",
  ]);
  const source = resolve(flagString(args, "source", process.cwd()));
  const branch = args.flags.has("branch") ? flagString(args, "branch") : null;
  for (const repeated of ["cache-path", "exclude"]) {
    if (args.flags.has(repeated)) flagString(args, repeated);
  }
  const options: WorktreeCloneOptions = {
    mode: args.flags.has("mode") ? (flagString(args, "mode") as WorktreeMaterializationMode) : undefined,
    cachePaths: collectFlags(args, "cache-path"),
    exclude: collectFlags(args, "exclude"),
    externalSymlinks: args.flags.has("external-symlinks")
      ? (flagString(args, "external-symlinks") as ExternalSymlinkPolicy)
      : undefined,
    targetBranch: args.flags.has("target-branch") ? flagString(args, "target-branch") : undefined,
  };
  const dest = flagString(args, "dest", defaultCloneDest(git(["-C", source, "rev-parse", "--show-toplevel"]), branch));
  const outcome = cloneWorktreeCow(source, dest, branch, options);
  printJson({
    worktree: "cloned",
    ...outcome,
    remove_with: `git -C ${outcome.source} worktree remove --force ${outcome.dest}`,
  });
  return 0;
}
