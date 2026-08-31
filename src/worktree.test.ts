import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CliError } from "./cli.ts";
import {
  cloneForFanout,
  cloneWorktreeCow,
  defaultCloneDest,
  inspectWorktreeLosses,
  removeWorktreeClone,
  type CowBackendFactory,
} from "./worktree.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitEnv(cwd: string): Record<string, string> {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    XDG_CONFIG_HOME: join(cwd, ".xdg-empty"),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

async function sh(cwd: string, ...argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv(cwd) });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  expect(exit, `${argv.join(" ")} failed: ${stderr}`).toBe(0);
  return stdout;
}

function shSync(cwd: string, ...argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", env: gitEnv(cwd) });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const portableBackend: CowBackendFactory = () => ({
  copy(source: string, dest: string): void {
    const proc = Bun.spawnSync(["cp", "-R", "-P", source, dest], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  },
});

async function fixture(options: { ignoredBuild?: boolean } = {}): Promise<{ root: string; src: string }> {
  const root = tempDir("orch-wt-");
  const src = join(root, "src-repo");
  mkdirSync(src);
  await sh(src, "git", "init", "-q", "-b", "main");
  await sh(src, "git", "config", "core.excludesFile", "/dev/null");
  writeFileSync(join(src, "a.txt"), "a\n", "utf8");
  if (options.ignoredBuild) writeFileSync(join(src, ".gitignore"), "build/\n", "utf8");
  await sh(src, "git", "add", ".");
  await sh(src, "git", "commit", "-q", "-m", "init");
  writeFileSync(join(src, "a.txt"), "a-dirty\n", "utf8");
  mkdirSync(join(src, "build", "private"), { recursive: true });
  writeFileSync(join(src, "build", "out.bin"), "artifact\n", "utf8");
  writeFileSync(join(src, "build", "private", "secret.bin"), "secret\n", "utf8");
  writeFileSync(join(src, "note.txt"), "untracked\n", "utf8");
  mkdirSync(join(src, ".jj"));
  writeFileSync(join(src, ".jj", "store"), "jj\n", "utf8");
  return { root, src };
}

test("snapshot registers first and carries dirty, untracked, and ignored state", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const dest = join(root, "agent2");
  let observedRegistration = false;
  const observingBackend: CowBackendFactory = () => ({
    copy(source: string, target: string): void {
      observedRegistration ||= existsSync(join(dest, ".git")) && shSync(src, "git", "worktree", "list").stdout.includes(dest);
      portableBackend(dirname(target)).copy(source, target);
    },
  });
  const outcome = cloneWorktreeCow(src, dest, "feat/agent2", {}, observingBackend);

  expect(observedRegistration).toBe(true);
  expect(outcome.head).toMatch(/^[0-9a-f]{40}$/);
  expect(outcome.branch).toBe("feat/agent2");
  expect(outcome.mode).toBe("snapshot");
  expect(await Bun.file(join(dest, "build", "out.bin")).text()).toBe("artifact\n");
  expect(await Bun.file(join(dest, "note.txt")).text()).toBe("untracked\n");
  expect(existsSync(join(dest, ".jj"))).toBe(false);
  expect(existsSync(outcome.provenance)).toBe(true);
  expect(statSync(outcome.provenance).mode & 0o777).toBe(0o600);
  expect((await sh(dest, "git", "branch", "--show-current")).trim()).toBe("feat/agent2");
  expect((await sh(dest, "git", "status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean).sort()).toEqual([
    " M a.txt",
    "?? note.txt",
  ]);
  expect((await sh(src, "git", "worktree", "list"))).toContain(dest);
  expect((await sh(src, "git", "worktree", "list"))).not.toContain(".wt-");

  await sh(dest, "git", "commit", "-q", "-am", "clone work");
  expect(await Bun.file(join(src, "a.txt")).text()).toBe("a-dirty\n");
  expect((await sh(src, "git", "rev-parse", "HEAD")).trim()).toBe(outcome.head);
});

test("detached snapshot stays at the captured source HEAD", async () => {
  const { root, src } = await fixture();
  const dest = join(root, "detached");
  const outcome = cloneWorktreeCow(src, dest, null, {}, portableBackend);
  expect(outcome.branch).toBeNull();
  expect((await sh(dest, "git", "rev-parse", "HEAD")).trim()).toBe(outcome.head);
  expect((await sh(dest, "git", "branch", "--show-current")).trim()).toBe("");
});

test("destination containment rejects direct and canonical aliases", async () => {
  const { root, src } = await fixture();
  const taken = join(root, "taken");
  mkdirSync(taken);
  expect(() => cloneWorktreeCow(src, taken, null, {}, portableBackend)).toThrow(CliError);
  expect(() => cloneWorktreeCow(src, join(src, "nested"), null, {}, portableBackend)).toThrow(CliError);
  const alias = join(root, "alias");
  symlinkSync(src, alias);
  expect(() => cloneWorktreeCow(src, join(alias, "nested"), null, {}, portableBackend)).toThrow(CliError);
});

test("branch and policy validation fail before registration or copy", async () => {
  const { root, src } = await fixture();
  await sh(src, "git", "branch", "occupied");
  let copies = 0;
  const countingBackend: CowBackendFactory = () => ({ copy: () => void (copies += 1) });
  expect(() => cloneWorktreeCow(src, join(root, "occupied"), "occupied", {}, countingBackend)).toThrow("branch already exists");
  expect(() => cloneWorktreeCow(src, join(root, "escape"), null, { cachePaths: ["../escape"] }, countingBackend)).toThrow(
    "must stay inside",
  );
  expect(() => cloneWorktreeCow(src, join(root, "metadata"), null, { cachePaths: [".git"] }, countingBackend)).toThrow(
    "cannot select VCS metadata",
  );
  expect(copies).toBe(0);
  expect((await sh(src, "git", "worktree", "list"))).not.toContain(join(root, "escape"));
});

test("registration and copy failures roll back worktree and new branch", async () => {
  const { root, src } = await fixture();
  const invalid = join(root, "invalid");
  expect(() => cloneWorktreeCow(src, invalid, "bad..name", {}, portableBackend)).toThrow(CliError);
  expect(existsSync(invalid)).toBe(false);

  const dest = join(root, "copy-failure");
  const failingBackend: CowBackendFactory = () => ({ copy: () => { throw new Error("injected copy failure"); } });
  expect(() => cloneWorktreeCow(src, dest, "feat/copy-failure", {}, failingBackend)).toThrow("injected copy failure");
  expect(existsSync(dest)).toBe(false);
  expect(shSync(src, "git", "show-ref", "--verify", "--quiet", "refs/heads/feat/copy-failure").exitCode).not.toBe(0);
  const worktrees = await sh(src, "git", "worktree", "list");
  expect(worktrees).not.toContain("copy-failure");
  expect(worktrees).not.toContain(".wt-");
});

test("internal absolute symlinks retarget to the clone", async () => {
  const { root, src } = await fixture();
  symlinkSync(join(src, "build"), join(src, "cache-link"));
  const dest = join(root, "links");
  const outcome = cloneWorktreeCow(src, dest, null, {}, portableBackend);
  expect(readlinkSync(join(dest, "cache-link"))).toBe(join(dest, "build"));
  expect(outcome.rewritten_symlinks).toContain("cache-link");
});

test("external symlinks can be preserved, warned, or rejected", async () => {
  const { root, src } = await fixture();
  const external = tempDir("orch-wt-external-");
  symlinkSync(external, join(src, "external-link"));

  const preserveDest = join(root, "preserve");
  const preserved = cloneWorktreeCow(src, preserveDest, null, { externalSymlinks: "preserve" }, portableBackend);
  expect(readlinkSync(join(preserveDest, "external-link"))).toBe(external);
  expect(preserved.external_symlinks).toContain("external-link");

  const warnDest = join(root, "warn");
  const warned = cloneWorktreeCow(src, warnDest, null, { externalSymlinks: "warn" }, portableBackend);
  expect(warned.external_symlinks).toContain("external-link");

  const rejectDest = join(root, "reject");
  expect(() => cloneWorktreeCow(src, rejectDest, null, { externalSymlinks: "reject" }, portableBackend)).toThrow(
    "external symlink rejected",
  );
  expect(existsSync(rejectDest)).toBe(false);
});

test("an absolute link that escapes through an intermediate symlink is external", async () => {
  const { root, src } = await fixture();
  const external = tempDir("orch-wt-escape-");
  writeFileSync(join(external, "payload"), "outside\n");
  symlinkSync(external, join(src, "escape-dir"));
  symlinkSync(join(src, "escape-dir", "payload"), join(src, "escape-link"));
  const dest = join(root, "rejected-escape");
  expect(() => cloneWorktreeCow(src, dest, null, { externalSymlinks: "reject" }, portableBackend)).toThrow(
    "external symlink rejected",
  );
  expect(existsSync(dest)).toBe(false);
});

test("snapshot excludes nested matches without copying VCS metadata", async () => {
  const { root, src } = await fixture();
  const dest = join(root, "excluded");
  cloneWorktreeCow(src, dest, null, { exclude: ["build/private/**"] }, portableBackend);
  expect(existsSync(join(dest, "build", "out.bin"))).toBe(true);
  expect(existsSync(join(dest, "build", "private", "secret.bin"))).toBe(false);
  expect(existsSync(join(dest, ".jj"))).toBe(false);
  expect(readFileSync(join(dest, ".git"), "utf8")).toContain("gitdir:");
});

test("warm-head materializes tracked HEAD plus explicit ignored caches only", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const dest = join(root, "warm");
  const outcome = cloneWorktreeCow(
    src,
    dest,
    "feat/warm",
    { mode: "warm-head", cachePaths: ["build"], exclude: ["build/private/**"] },
    portableBackend,
  );
  expect(await Bun.file(join(dest, "a.txt")).text()).toBe("a\n");
  expect(await Bun.file(join(dest, "build", "out.bin")).text()).toBe("artifact\n");
  expect(existsSync(join(dest, "build", "private", "secret.bin"))).toBe(false);
  expect(existsSync(join(dest, "note.txt"))).toBe(false);
  expect(outcome.cache_paths).toEqual(["build"]);
  expect((await sh(dest, "git", "status", "--porcelain")).trim()).toBe("");
});

test("warm-head rejects a cache path that Git does not ignore and rolls back", async () => {
  const { root, src } = await fixture();
  const dest = join(root, "bad-cache");
  expect(() =>
    cloneWorktreeCow(src, dest, "feat/bad-cache", { mode: "warm-head", cachePaths: ["note.txt"] }, portableBackend),
  ).toThrow("must be ignored by git");
  expect(existsSync(dest)).toBe(false);
  expect(shSync(src, "git", "show-ref", "--verify", "--quiet", "refs/heads/feat/bad-cache").exitCode).not.toBe(0);
});

test("upstream selection prefers the explicit target, then origin/HEAD", async () => {
  const { root, src } = await fixture();
  await sh(src, "git", "remote", "add", "origin", "git@example.com:x/y.git");
  await sh(src, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
  await sh(src, "git", "update-ref", "refs/remotes/origin/release", "HEAD");
  await sh(src, "git", "update-ref", "refs/remotes/origin/trunk", "HEAD");
  await sh(src, "git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");

  const explicit = cloneWorktreeCow(
    src,
    join(root, "explicit"),
    "feat/explicit",
    { targetBranch: "release" },
    portableBackend,
  );
  expect(explicit.upstream).toBe("origin/release");

  const detected = cloneWorktreeCow(src, join(root, "detected"), "feat/detected", {}, portableBackend);
  expect(detected.upstream).toBe("origin/trunk");
});

test("origin/main remains the fallback when origin/HEAD is absent", async () => {
  const { root, src } = await fixture();
  await sh(src, "git", "remote", "add", "origin", "git@example.com:x/y.git");
  await sh(src, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
  const outcome = cloneWorktreeCow(src, join(root, "tracked"), "feat/tracked", {}, portableBackend);
  expect(outcome.upstream).toBe("origin/main");
});

test("provenance records policy and the inherited dirty baseline outside the clone", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const outcome = cloneWorktreeCow(
    src,
    join(root, "provenance"),
    null,
    { cachePaths: ["build"], exclude: ["**/*.secret"], externalSymlinks: "preserve" },
    portableBackend,
  );
  const provenance = JSON.parse(readFileSync(outcome.provenance, "utf8"));
  expect(outcome.provenance.startsWith(join(src, ".git", "worktrees"))).toBe(true);
  expect(provenance.schema).toBe("orch.worktree-clone/v1");
  expect(provenance.mode).toBe("snapshot");
  expect(provenance.cache_paths).toEqual(["build"]);
  expect(provenance.baseline.worktree_clean).toBe(false);
  expect(provenance.baseline.untracked_empty).toBe(false);
});

test("unchanged inherited changes are safe to remove", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const dest = join(root, "safe-remove");
  cloneWorktreeCow(src, dest, null, { cachePaths: ["build"] }, portableBackend);
  expect(inspectWorktreeLosses(src, dest)).toEqual({ safe: true, losses: [] });
  expect(removeWorktreeClone(src, dest)).toBe(true);
  expect(existsSync(dest)).toBe(false);
  expect((await sh(src, "git", "worktree", "list"))).not.toContain(dest);
});

test("an already-missing clone prunes its stale registration", async () => {
  const { root, src } = await fixture();
  const dest = join(root, "missing");
  cloneWorktreeCow(src, dest, null, {}, portableBackend);
  rmSync(dest, { recursive: true, force: true });
  expect(removeWorktreeClone(src, dest)).toBe(true);
  expect((await sh(src, "git", "worktree", "list"))).not.toContain(dest);
});

test("loss detection catches edits, staging, and restoring inherited dirt to HEAD", async () => {
  const { root, src } = await fixture();

  const edited = join(root, "edited");
  cloneWorktreeCow(src, edited, null, {}, portableBackend);
  writeFileSync(join(edited, "a.txt"), "new edit\n");
  expect(inspectWorktreeLosses(src, edited).losses).toContain("worktree differs from the inherited baseline");
  expect(removeWorktreeClone(src, edited)).toBe(false);

  const staged = join(root, "staged");
  cloneWorktreeCow(src, staged, null, {}, portableBackend);
  await sh(staged, "git", "add", "a.txt");
  expect(inspectWorktreeLosses(src, staged).losses).toContain("index differs from the inherited baseline");

  const restored = join(root, "restored");
  cloneWorktreeCow(src, restored, null, {}, portableBackend);
  await sh(restored, "git", "checkout", "--", "a.txt");
  expect(inspectWorktreeLosses(src, restored).losses).toContain("worktree differs from the inherited baseline");
});

test("an unreachable detached commit blocks automatic removal", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const dest = join(root, "detached-commit");
  cloneWorktreeCow(src, dest, null, {}, portableBackend);
  writeFileSync(join(dest, "a.txt"), "committed\n");
  await sh(dest, "git", "add", "a.txt");
  await sh(dest, "git", "commit", "-q", "-m", "detached work");
  expect(inspectWorktreeLosses(src, dest).losses.some((loss) => loss.includes("detached commit"))).toBe(true);
  expect(removeWorktreeClone(src, dest)).toBe(false);
});

test("clean commits on a named branch remain reachable and remove safely", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const dest = join(root, "named-commit");
  cloneWorktreeCow(src, dest, "feat/named", {}, portableBackend);
  writeFileSync(join(dest, "a.txt"), "committed\n");
  await sh(dest, "git", "commit", "-q", "-am", "named work");
  const head = (await sh(dest, "git", "rev-parse", "HEAD")).trim();
  expect(inspectWorktreeLosses(src, dest)).toEqual({ safe: true, losses: [] });
  expect(removeWorktreeClone(src, dest)).toBe(true);
  expect((await sh(src, "git", "rev-parse", "refs/heads/feat/named")).trim()).toBe(head);
});

test("parked caches are restored when unregister fails", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const dest = join(root, "locked");
  cloneWorktreeCow(src, dest, null, { cachePaths: ["build"] }, portableBackend);
  await sh(src, "git", "worktree", "lock", dest);
  expect(removeWorktreeClone(src, dest)).toBe(false);
  expect(await Bun.file(join(dest, "build", "out.bin")).text()).toBe("artifact\n");
  await sh(src, "git", "worktree", "unlock", dest);
  expect(removeWorktreeClone(src, dest)).toBe(true);
});

test("fanout clones use a private same-filesystem root instead of /tmp", async () => {
  const { root, src } = await fixture();
  const outcome = cloneForFanout(src, "review/a", {}, portableBackend);
  const storage = join(root, ".orch-worktrees");
  const repoRoot = join(storage, basename(src));
  expect(outcome.dest.startsWith(`${repoRoot}/review_a-`)).toBe(true);
  expect(outcome.dest.startsWith("/tmp/")).toBe(false);
  expect(lstatSync(storage).isSymbolicLink()).toBe(false);
  expect(statSync(storage).mode & 0o777).toBe(0o700);
  expect(statSync(repoRoot).mode & 0o777).toBe(0o700);
});

test("fanout storage and removal trash reject symlink substitution", async () => {
  const first = await fixture();
  const externalStorage = tempDir("orch-wt-storage-");
  symlinkSync(externalStorage, join(first.root, ".orch-worktrees"));
  expect(() => cloneForFanout(first.src, "review", {}, portableBackend)).toThrow("must be a real directory");

  const second = await fixture({ ignoredBuild: true });
  const dest = join(second.root, "trash-guard");
  cloneWorktreeCow(second.src, dest, null, { cachePaths: ["build"] }, portableBackend);
  const privateRoot = join(second.root, ".orch-worktrees", basename(second.src));
  mkdirSync(privateRoot, { recursive: true });
  const externalTrash = tempDir("orch-wt-trash-");
  symlinkSync(externalTrash, join(privateRoot, ".trash"));
  expect(removeWorktreeClone(second.src, dest)).toBe(false);
  expect(existsSync(join(dest, "build", "out.bin"))).toBe(true);
});

test.skipIf(process.platform !== "darwin")("native APFS clone backend smoke", async () => {
  const { root, src } = await fixture();
  const dest = join(root, "native");
  const outcome = cloneWorktreeCow(src, dest, null);
  expect(outcome.dest).toBe(dest);
  expect(await Bun.file(join(dest, "a.txt")).text()).toBe("a-dirty\n");
});

test.skipIf(process.platform !== "darwin")("worktree clone CLI accepts lifecycle policy flags", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const dest = join(root, "cli-warm");
  const proc = Bun.spawn(
    [
      process.execPath,
      "src/orch.ts",
      "worktree",
      "clone",
      "--source",
      src,
      "--dest",
      dest,
      "--branch",
      "feat/cli-warm",
      "--mode",
      "warm-head",
      "--cache-path",
      "build",
      "--exclude",
      "build/private/**",
      "--external-symlinks",
      "reject",
      "--target-branch",
      "main",
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: gitEnv(src) },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  const payload = JSON.parse(stdout);
  expect(payload).toMatchObject({ worktree: "cloned", mode: "warm-head", cache_paths: ["build"] });
  expect(await Bun.file(join(dest, "a.txt")).text()).toBe("a\n");
  expect(existsSync(join(dest, "build", "private", "secret.bin"))).toBe(false);
});

test("defaultCloneDest uses a sibling named after the branch", () => {
  expect(defaultCloneDest("/Users/x/mi/osbot", "feat/agent2")).toBe("/Users/x/mi/osbot-feat_agent2");
  expect(defaultCloneDest("/Users/x/mi/osbot", null)).toMatch(/^\/Users\/x\/mi\/osbot-wt-[0-9a-f]{6}$/);
});
