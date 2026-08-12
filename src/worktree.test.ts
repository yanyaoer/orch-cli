import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./cli.ts";
import { cloneWorktreeCow, defaultCloneDest } from "./worktree.ts";

// cp -c needs APFS; the command itself is gated on darwin.
const darwin = process.platform === "darwin";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function sh(cwd: string, ...argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Hermetic git: the user's XDG ignore file (e.g. a global `build/` rule)
    // must not leak into fixture status output.
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      XDG_CONFIG_HOME: join(cwd, ".xdg-empty"),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

// Committed file, a dirty edit on top, untracked "build output", and a fake
// colocated .jj store — the states the clone must carry or drop correctly.
async function fixture(): Promise<{ root: string; src: string }> {
  const root = tempDir("orch-wt-");
  const src = join(root, "src-repo");
  mkdirSync(src);
  await sh(src, "git", "init", "-q", "-b", "main");
  writeFileSync(join(src, "a.txt"), "a\n", "utf8");
  await sh(src, "git", "add", "a.txt");
  await sh(src, "git", "commit", "-q", "-m", "init");
  writeFileSync(join(src, "a.txt"), "a-dirty\n", "utf8");
  mkdirSync(join(src, "build"));
  writeFileSync(join(src, "build", "out.bin"), "artifact\n", "utf8");
  mkdirSync(join(src, ".jj"));
  writeFileSync(join(src, ".jj", "store"), "jj\n", "utf8");
  return { root, src };
}

test.skipIf(!darwin)("clone carries dirty + untracked state into an isolated registered worktree", async () => {
  const { root, src } = await fixture();
  const dest = join(root, "agent2");
  const outcome = cloneWorktreeCow(src, dest, "feat/agent2");

  expect(outcome.head).toMatch(/^[0-9a-f]{40}$/);
  expect(outcome.branch).toBe("feat/agent2");
  expect(outcome.upstream).toBeNull(); // fixture has no origin/main
  expect(await Bun.file(join(dest, "build", "out.bin")).text()).toBe("artifact\n");
  expect(existsSync(join(dest, ".jj"))).toBe(false);

  expect((await sh(dest, "git", "rev-parse", "HEAD")).trim()).toBe(outcome.head);
  expect((await sh(dest, "git", "branch", "--show-current")).trim()).toBe("feat/agent2");
  const status = (await sh(dest, "git", "status", "--porcelain")).split("\n").filter(Boolean).sort();
  expect(status).toEqual([" M a.txt", "?? build/"]);
  expect(await sh(src, "git", "worktree", "list")).toContain(dest);

  // Slot isolation: committing in the clone must leave the source untouched.
  await sh(dest, "git", "commit", "-q", "-am", "clone work");
  expect((await sh(src, "git", "status", "--porcelain")).split("\n").filter(Boolean).sort()).toEqual([" M a.txt", "?? .jj/", "?? build/"]);
  expect((await sh(src, "git", "rev-parse", "HEAD")).trim()).toBe(outcome.head);
  expect(await Bun.file(join(src, "a.txt")).text()).toBe("a-dirty\n");
});

test.skipIf(!darwin)("omitting branch leaves the clone detached at source HEAD", async () => {
  const { root, src } = await fixture();
  const dest = join(root, "detached");
  const outcome = cloneWorktreeCow(src, dest, null);
  expect(outcome.branch).toBeNull();
  expect((await sh(dest, "git", "rev-parse", "HEAD")).trim()).toBe(outcome.head);
  expect((await sh(dest, "git", "branch", "--show-current")).trim()).toBe("");
});

test.skipIf(!darwin)("existing dest and dest inside source are rejected", async () => {
  const { root, src } = await fixture();
  const taken = join(root, "taken");
  mkdirSync(taken);
  expect(() => cloneWorktreeCow(src, taken, null)).toThrow(CliError);
  expect(() => cloneWorktreeCow(src, join(src, "nested"), null)).toThrow(CliError);
  // A symlink alias of the source must not defeat the containment check.
  const alias = join(root, "alias");
  symlinkSync(src, alias);
  expect(() => cloneWorktreeCow(src, join(alias, "nested"), null)).toThrow(CliError);
});

test.skipIf(!darwin)("existing branch fails fast, before any copy", async () => {
  const { root, src } = await fixture();
  await sh(src, "git", "branch", "occupied");
  const dest = join(root, "conflict");
  expect(() => cloneWorktreeCow(src, dest, "occupied")).toThrow("branch already exists");
  expect(existsSync(dest)).toBe(false);
});

test.skipIf(!darwin)("failed registration cleans up the clone and the slot", async () => {
  const { root, src } = await fixture();
  const dest = join(root, "conflict");
  // "bad..name" passes the show-ref pre-check (no such branch) and dies at
  // worktree add -b, exercising the post-copy cleanup path.
  expect(() => cloneWorktreeCow(src, dest, "bad..name")).toThrow(CliError);
  expect(existsSync(dest)).toBe(false);
  const worktrees = await sh(src, "git", "worktree", "list");
  expect(worktrees).not.toContain("conflict");
  expect(worktrees).not.toContain(".wt-");
});

test.skipIf(!darwin)("branch clones track origin/main when the ref exists", async () => {
  const { root, src } = await fixture();
  // A remote-tracking ref only counts as an upstream when its remote is configured.
  await sh(src, "git", "remote", "add", "origin", "git@example.com:x/y.git");
  await sh(src, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
  const dest = join(root, "tracked");
  const outcome = cloneWorktreeCow(src, dest, "feat/tracked");
  expect(outcome.upstream).toBe("origin/main");
  expect((await sh(dest, "git", "rev-parse", "--abbrev-ref", "feat/tracked@{upstream}")).trim()).toBe("origin/main");
});

test("defaultCloneDest: sibling dir named after the branch", () => {
  expect(defaultCloneDest("/Users/x/mi/osbot", "feat/agent2")).toBe("/Users/x/mi/osbot-feat_agent2");
  expect(defaultCloneDest("/Users/x/mi/osbot", null)).toMatch(/^\/Users\/x\/mi\/osbot-wt-[0-9a-f]{6}$/);
});
