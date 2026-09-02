import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  scanWorktreeClones,
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

test("a relative link that exits and re-enters the source retargets to the clone", async () => {
  const { root, src } = await fixture();
  // Leaves the repo root lexically, re-enters by directory name: internal in
  // the source's frame, but resolved from the clone it points at the SOURCE.
  symlinkSync(`../${basename(src)}/a.txt`, join(src, "loop-link"));
  mkdirSync(join(src, "sub"));
  symlinkSync("../a.txt", join(src, "sub", "in-link"));
  const dest = join(root, "reenter");
  const outcome = cloneWorktreeCow(src, dest, null, { externalSymlinks: "reject" }, portableBackend);
  expect(outcome.external_symlinks).toEqual([]);
  expect(outcome.rewritten_symlinks).toContain("loop-link");
  expect(readlinkSync(join(dest, "loop-link"))).toBe(join(dest, "a.txt"));
  // A legitimately internal relative link stays relative.
  expect(readlinkSync(join(dest, "sub", "in-link"))).toBe("../a.txt");
  writeFileSync(join(dest, "loop-link"), "written from clone\n");
  expect(await Bun.file(join(src, "a.txt")).text()).toBe("a-dirty\n");
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

test("warm-head bulk-copies an unfiltered cache in a single copy call", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  let copies = 0;
  const countingBackend: CowBackendFactory = () => ({
    copy(source: string, target: string): void {
      copies += 1;
      portableBackend(dirname(target)).copy(source, target);
    },
  });
  const dest = join(root, "warm-bulk");
  cloneWorktreeCow(src, dest, null, { mode: "warm-head", cachePaths: ["build"] }, countingBackend);
  expect(copies).toBe(1);
  expect(await Bun.file(join(dest, "build", "private", "secret.bin")).text()).toBe("secret\n");
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

test("removal parks inherited filenames containing literal glob characters", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  writeFileSync(join(src, "notes [draft].md"), "x\n", "utf8");
  writeFileSync(join(src, "build", "out[dev].log"), "log\n", "utf8");
  const dest = join(root, "glob-names");
  cloneWorktreeCow(src, dest, null, { cachePaths: ["build"] }, portableBackend);
  expect(inspectWorktreeLosses(src, dest)).toEqual({ safe: true, losses: [] });
  expect(removeWorktreeClone(src, dest)).toBe(true);
  expect(existsSync(dest)).toBe(false);
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

test("an untracked nested repository is digest-pinned: pristine removes, new work blocks", async () => {
  const { root, src } = await fixture();
  const vendor = join(src, "vendor");
  mkdirSync(vendor);
  await sh(vendor, "git", "init", "-q");
  writeFileSync(join(vendor, "lib.ts"), "export {}\n", "utf8");
  await sh(vendor, "git", "add", ".");
  await sh(vendor, "git", "commit", "-q", "-m", "vendored");
  // An inherited non-sample hook, mode 0644: the digest must pin its
  // executable bit, not just its bytes.
  writeFileSync(join(vendor, ".git", "hooks", "post-commit"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(vendor, ".git", "hooks", "post-commit"), 0o644);

  const pristine = join(root, "nested-pristine");
  cloneWorktreeCow(src, pristine, null, {}, portableBackend);
  expect(inspectWorktreeLosses(src, pristine)).toEqual({ safe: true, losses: [] });
  expect(removeWorktreeClone(src, pristine)).toBe(true);
  expect(existsSync(join(src, "vendor", "lib.ts"))).toBe(true);

  for (const mutate of ["commit", "branch", "tag", "dirty", "hook", "hook-mode", "attributes", "config"] as const) {
    const dest = join(root, `nested-${mutate}`);
    cloneWorktreeCow(src, dest, null, {}, portableBackend);
    if (mutate === "commit") {
      writeFileSync(join(dest, "vendor", "lib.ts"), "export {}\n// agent work\n", "utf8");
      await sh(join(dest, "vendor"), "git", "commit", "-qam", "agent work");
    } else if (mutate === "branch") {
      await sh(join(dest, "vendor"), "git", "branch", "agent-work");
    } else if (mutate === "tag") {
      await sh(join(dest, "vendor"), "git", "tag", "agent-tag");
    } else if (mutate === "hook") {
      writeFileSync(join(dest, "vendor", ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
    } else if (mutate === "hook-mode") {
      chmodSync(join(dest, "vendor", ".git", "hooks", "post-commit"), 0o755);
    } else if (mutate === "attributes") {
      // Collision control: creating a file whose content is the literal word
      // the old encoding used for absence must still move the digest.
      writeFileSync(join(dest, "vendor", ".git", "info", "attributes"), "absent", "utf8");
    } else if (mutate === "config") {
      await sh(join(dest, "vendor"), "git", "config", "agent.marker", "1");
    } else {
      writeFileSync(join(dest, "vendor", "lib.ts"), "export {}\n// dirty\n", "utf8");
    }
    expect(inspectWorktreeLosses(src, dest).safe).toBe(false);
    expect(removeWorktreeClone(src, dest)).toBe(false);
    expect(existsSync(join(dest, "vendor", ".git"))).toBe(true);
  }
}, 60000);

test("a nested repo whose git resolution redirects elsewhere stays fail-closed", async () => {
  const { root, src } = await fixture();
  const gitdir = join(root, "gd-vendor");
  const vendor = join(src, "vendor");
  await sh(root, "git", "init", "-q", `--separate-git-dir=${gitdir}`, vendor);
  writeFileSync(join(vendor, "f.txt"), "v\n", "utf8");
  await sh(vendor, "git", "add", ".");
  await sh(vendor, "git", "commit", "-q", "-m", "vendored");
  // Redirect the nested repo's worktree back at the SOURCE: git commands run
  // in the clone's copy would then describe the source tree, not the clone.
  await sh(root, "git", `--git-dir=${gitdir}`, "config", "core.worktree", vendor);
  const dest = join(root, "redirected");
  cloneWorktreeCow(src, dest, null, {}, portableBackend);
  writeFileSync(join(dest, "vendor", "f.txt"), "v\nAGENT WORK\n", "utf8");
  expect(inspectWorktreeLosses(src, dest).losses.some((loss) => loss.includes("nested repository"))).toBe(true);
  expect(removeWorktreeClone(src, dest)).toBe(false);
  expect(await Bun.file(join(dest, "vendor", "f.txt")).text()).toBe("v\nAGENT WORK\n");
});

test("warm-head cache ancestors mirror private source directory modes", async () => {
  const { root, src } = await fixture();
  const priv = join(src, "priv");
  mkdirSync(join(priv, "cache"), { recursive: true });
  writeFileSync(join(priv, "cache", "data.bin"), "d\n", "utf8");
  writeFileSync(join(src, ".gitignore"), "priv/\n", "utf8");
  await sh(src, "git", "add", ".gitignore");
  await sh(src, "git", "commit", "-q", "-m", "ignore priv");
  chmodSync(priv, 0o700);
  for (const exclude of [[], ["nomatch/**"]] as string[][]) {
    const dest = join(root, `warm-priv-${exclude.length}`);
    cloneWorktreeCow(src, dest, null, { mode: "warm-head", cachePaths: ["priv/cache"], exclude }, portableBackend);
    expect(statSync(join(dest, "priv")).mode & 0o777).toBe(0o700);
    expect(await Bun.file(join(dest, "priv", "cache", "data.bin")).text()).toBe("d\n");
  }
});

test("a still-registered worktree with a newline in its path is not force-removed", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const dest = join(root, "nl\nclone");
  cloneWorktreeCow(src, dest, null, { cachePaths: ["build"] }, portableBackend);
  await sh(src, "git", "worktree", "lock", dest);
  expect(removeWorktreeClone(src, dest)).toBe(false);
  expect(await Bun.file(join(dest, "build", "out.bin")).text()).toBe("artifact\n");
  await sh(src, "git", "worktree", "unlock", dest);
  expect(removeWorktreeClone(src, dest)).toBe(true);
  expect(existsSync(dest)).toBe(false);
});

test("removal recovers when git unregisters but cannot delete a read-only directory", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const ro = join(src, "ro");
  mkdirSync(ro);
  writeFileSync(join(ro, "f.txt"), "x\n", "utf8");
  await sh(src, "git", "add", "ro");
  await sh(src, "git", "commit", "-q", "-m", "ro dir");
  chmodSync(ro, 0o555);
  const dest = join(root, "ro-remove");
  try {
    cloneWorktreeCow(src, dest, null, { cachePaths: ["build"], exclude: ["nomatch/**"] }, portableBackend);
    expect(inspectWorktreeLosses(src, dest)).toEqual({ safe: true, losses: [] });
    expect(removeWorktreeClone(src, dest)).toBe(true);
    expect(existsSync(dest)).toBe(false);
    expect((await sh(src, "git", "worktree", "list"))).not.toContain(dest);
  } finally {
    chmodSync(ro, 0o755);
    if (existsSync(join(dest, "ro"))) chmodSync(join(dest, "ro"), 0o755);
  }
});

test("clone-internal chains through dangling symlinks are not external", async () => {
  const { root, src } = await fixture();
  symlinkSync("missing-file", join(src, "mid"));
  symlinkSync("mid", join(src, "outer"));
  symlinkSync(join("mid-dir", "file"), join(src, "outer2"));
  symlinkSync("missing-dir", join(src, "mid-dir"));
  const dest = join(root, "dangling");
  const outcome = cloneWorktreeCow(src, dest, null, { externalSymlinks: "reject" }, portableBackend);
  expect(outcome.external_symlinks).toEqual([]);
  expect(readlinkSync(join(dest, "outer"))).toBe("mid");
});

test("rollback survives read-only directories and keeps the original error", async () => {
  const { root, src } = await fixture();
  const ro = join(src, "ro");
  mkdirSync(ro);
  writeFileSync(join(ro, "f.txt"), "x\n", "utf8");
  chmodSync(ro, 0o555);
  const external = tempDir("orch-wt-ro-external-");
  symlinkSync(external, join(src, "ext-link"));
  const dest = join(root, "ro-rollback");
  try {
    expect(() =>
      cloneWorktreeCow(src, dest, "feat/ro-rollback", { externalSymlinks: "reject" }, portableBackend),
    ).toThrow("external symlink rejected");
    expect(existsSync(dest)).toBe(false);
    expect(shSync(src, "git", "show-ref", "--verify", "--quiet", "refs/heads/feat/ro-rollback").exitCode).not.toBe(0);
    expect((await sh(src, "git", "worktree", "list"))).not.toContain("ro-rollback");
  } finally {
    chmodSync(ro, 0o755);
  }
});

test("exclude copies preserve read-only directory modes without failing", async () => {
  const { root, src } = await fixture();
  const ro = join(src, "ro");
  mkdirSync(ro);
  writeFileSync(join(ro, "f.txt"), "x\n", "utf8");
  chmodSync(ro, 0o555);
  const dest = join(root, "ro-exclude");
  try {
    cloneWorktreeCow(src, dest, null, { exclude: ["nomatch/**"] }, portableBackend);
    expect(await Bun.file(join(dest, "ro", "f.txt")).text()).toBe("x\n");
    expect(statSync(join(dest, "ro")).mode & 0o777).toBe(0o555);
  } finally {
    chmodSync(ro, 0o755);
    if (existsSync(join(dest, "ro"))) chmodSync(join(dest, "ro"), 0o755);
  }
});

test("filtered copies never widen a private directory during the copy", async () => {
  const { root, src } = await fixture();
  const secret = join(src, "secret");
  mkdirSync(secret);
  writeFileSync(join(secret, "key.txt"), "k\n", "utf8");
  chmodSync(secret, 0o700);
  const dest = join(root, "private-window");
  const observed: number[] = [];
  const observingBackend: CowBackendFactory = () => ({
    copy(source: string, target: string): void {
      if (dirname(target) === join(dest, "secret")) observed.push(statSync(dirname(target)).mode & 0o777);
      portableBackend(dirname(target)).copy(source, target);
    },
  });
  cloneWorktreeCow(src, dest, null, { exclude: ["nomatch/**"] }, observingBackend);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((mode) => (mode & 0o077) === 0)).toBe(true);
  expect(statSync(join(dest, "secret")).mode & 0o777).toBe(0o700);
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
  // The park manifest and directory are cleaned up with the restore.
  const trash = join(root, ".orch-worktrees", basename(src), ".trash");
  expect(!existsSync(trash) || readdirSync(trash).length === 0).toBe(true);
  await sh(src, "git", "worktree", "unlock", dest);
  expect(removeWorktreeClone(src, dest)).toBe(true);
});

test("fanout clones use a private same-filesystem root instead of /tmp", async () => {
  const { root, src } = await fixture();
  const outcome = cloneForFanout(src, "review/a", {}, portableBackend);
  const storage = join(root, ".orch-worktrees");
  const repoRoot = join(storage, basename(src));
  expect(outcome.dest.startsWith(`${repoRoot}/review_a-`)).toBe(true);
  // The retired default root, matched exactly: on Linux the whole fixture
  // legitimately lives under /tmp, so a bare /tmp prefix check is wrong.
  expect(outcome.dest.startsWith("/tmp/orch-clones/")).toBe(false);
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

test("scanWorktreeClones inventories clones, orphans, and trash", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const safe = join(root, "gc-safe");
  cloneWorktreeCow(src, safe, null, { cachePaths: ["build"] }, portableBackend);
  const edited = join(root, "gc-edited");
  cloneWorktreeCow(src, edited, null, {}, portableBackend);
  writeFileSync(join(edited, "a.txt"), "agent edit\n", "utf8");
  const missing = join(root, "gc-missing");
  cloneWorktreeCow(src, missing, null, {}, portableBackend);
  rmSync(missing, { recursive: true, force: true });

  const storageRoot = join(root, ".orch-worktrees", basename(src));
  mkdirSync(join(storageRoot, "orphan-debris"), { recursive: true });
  const trashRoot = join(storageRoot, ".trash");
  const sweepable = join(trashRoot, "gone-1234");
  mkdirSync(join(sweepable, "0"), { recursive: true });
  writeFileSync(
    join(sweepable, "manifest.json"),
    JSON.stringify({ dest: join(storageRoot, "gone"), entries: [{ index: 0, rel: "build" }] }),
    "utf8",
  );
  const partial = join(trashRoot, "partial-5678");
  mkdirSync(join(partial, "0"), { recursive: true });
  writeFileSync(join(partial, "manifest.json"), JSON.stringify({ dest: edited, entries: [{ index: 0, rel: "build" }] }), "utf8");
  const unknown = join(trashRoot, "unknown-9abc");
  mkdirSync(unknown, { recursive: true });

  const scan = scanWorktreeClones(src);
  expect(scan.clones.map((clone) => clone.dest).sort()).toEqual([edited, missing, safe].sort());
  expect(scan.clones.find((clone) => clone.dest === missing)?.dest_exists).toBe(false);
  expect(scan.orphans).toEqual([join(storageRoot, "orphan-debris")]);
  const trashByPath = new Map(scan.trash.map((entry) => [entry.path, entry]));
  expect(trashByPath.get(sweepable)?.clone_exists).toBe(false);
  expect(trashByPath.get(partial)?.clone_exists).toBe(true);
  expect(trashByPath.get(unknown)?.dest).toBeNull();
});

test.skipIf(process.platform !== "darwin")("worktree gc plans, then executes only proven-safe removals", async () => {
  const { root, src } = await fixture({ ignoredBuild: true });
  const runGc = async (...extra: string[]) => {
    const proc = Bun.spawn(
      [process.execPath, "src/orch.ts", "worktree", "gc", "--source", src, ...extra],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: gitEnv(src) },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout);
  };
  const safe = join(root, "gc-cli-safe");
  cloneWorktreeCow(src, safe, null, {});
  const edited = join(root, "gc-cli-edited");
  cloneWorktreeCow(src, edited, null, {});
  writeFileSync(join(edited, "a.txt"), "agent edit\n", "utf8");

  const plan = await runGc();
  expect(plan.executed).toBe(false);
  expect(plan.clones.find((clone: { dest: string }) => clone.dest === safe)?.action).toBe("remove");
  expect(plan.clones.find((clone: { dest: string }) => clone.dest === edited)?.action).toBe("keep");
  expect(plan.execute_with).toBe("orch worktree gc --execute");
  expect(existsSync(safe)).toBe(true);

  const applied = await runGc("--execute");
  expect(applied.clones.find((clone: { dest: string }) => clone.dest === safe)?.removed).toBe(true);
  const kept = applied.clones.find((clone: { dest: string }) => clone.dest === edited);
  expect(kept?.action).toBe("keep");
  expect(kept?.losses.length).toBeGreaterThan(0);
  expect(existsSync(safe)).toBe(false);
  expect(existsSync(edited)).toBe(true);
  expect((await sh(src, "git", "worktree", "list"))).not.toContain("gc-cli-safe");
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
