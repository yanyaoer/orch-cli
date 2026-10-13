import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jjWorkspaceRoot, sameSnapshot, vcsBranch, vcsDirty, vcsHead, vcsKind, vcsRemoteOriginUrl, vcsResolveCommit, vcsSnapshot } from "./vcs.ts";

const hasJj = Boolean(Bun.which("jj"));

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
    // Fixture commits need an identity; JJ_* only affects jj invocations.
    env: { ...process.env, JJ_USER: "t", JJ_EMAIL: "t@example.com", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out;
}

async function gitFixture(): Promise<string> {
  const dir = tempDir("orch-vcs-git-");
  await sh(dir, "git", "init", "-q", "-b", "main");
  await sh(dir, "git", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

async function jjFixture(): Promise<string> {
  const dir = tempDir("orch-vcs-jj-");
  await sh(dir, "jj", "git", "init", "--colocate");
  writeFileSync(join(dir, "a.txt"), "a\n", "utf8");
  await sh(dir, "jj", "commit", "-m", "first");
  return dir;
}

test("vcsKind: plain dirs and git repos stay git", async () => {
  const plain = tempDir("orch-vcs-plain-");
  expect(vcsKind(plain)).toBe("git");
  const git = await gitFixture();
  expect(vcsKind(git)).toBe("git");
  expect(jjWorkspaceRoot(git)).toBeNull();
});

test("git repo: head, dirty, branch behave as before", async () => {
  const dir = await gitFixture();
  const head = await vcsHead(dir);
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  expect(await vcsBranch(dir)).toBe("main");
  expect(await vcsDirty(dir)).toBe("");
  writeFileSync(join(dir, "x.txt"), "x\n", "utf8");
  expect((await vcsDirty(dir)).length).toBeGreaterThan(0);
  await sh(dir, "git", "checkout", "-q", "--detach", "HEAD");
  expect(await vcsBranch(dir)).toBeNull();
});

test("git repo: origin url resolves; missing origin yields empty", async () => {
  const dir = await gitFixture();
  expect(await vcsRemoteOriginUrl(dir).catch(() => "")).toBe("");
  await sh(dir, "git", "remote", "add", "origin", "git@github.com:acme/demo.git");
  expect(await vcsRemoteOriginUrl(dir)).toBe("git@github.com:acme/demo.git");
});

test.skipIf(!hasJj)("jj repo: detected jj-first even though colocated git would answer", async () => {
  const dir = await jjFixture();
  expect(vcsKind(dir)).toBe("jj");
  expect(jjWorkspaceRoot(dir)).toBe(dir);
  const head = await vcsHead(dir);
  expect(head).toMatch(/^[0-9a-f]{40}$/);
  // Colocated git reports a detached HEAD here; jj must not inherit that view.
  const gitView = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  expect(gitView.stdout.toString().trim()).toBe("HEAD");
});

test.skipIf(!hasJj)("jj repo: dirty tracks the working-copy commit's file changes", async () => {
  const dir = await jjFixture();
  // `jj commit` left @ empty: clean.
  expect(await vcsDirty(dir)).toBe("");
  writeFileSync(join(dir, "b.txt"), "b\n", "utf8");
  const dirty = await vcsDirty(dir);
  expect(dirty).toContain("b.txt");
  // head snapshots the edit; a fresh @ id still parses as a commit.
  expect(await vcsHead(dir)).toMatch(/^[0-9a-f]{40}$/);
});

test.skipIf(!hasJj)("jj repo: branch is the nearest bookmarked ancestor's local bookmark", async () => {
  const dir = await jjFixture();
  expect(await vcsBranch(dir)).toBeNull();
  await sh(dir, "jj", "bookmark", "create", "feat/task", "-r", "@-");
  expect(await vcsBranch(dir)).toBe("feat/task");
  // Working-copy edits do not detach the inferred line of work.
  writeFileSync(join(dir, "c.txt"), "c\n", "utf8");
  expect(await vcsBranch(dir)).toBe("feat/task");
});

test.skipIf(!hasJj)("git linked worktree nested inside a jj workspace stays git", async () => {
  const dir = await jjFixture();
  // Mirrors <jj-repo>/.claude/worktrees/<name>: jj root resolves to the outer
  // workspace, but base/dirty/branch must bind to the inner git checkout.
  const nested = join(dir, ".claude", "worktrees", "side");
  await sh(dir, "git", "worktree", "add", "-b", "side-branch", nested);
  expect(vcsKind(nested)).toBe("git");
  expect(jjWorkspaceRoot(nested)).toBeNull();
  expect(await vcsBranch(nested)).toBe("side-branch");
  // The outer workspace itself still answers as jj.
  expect(vcsKind(dir)).toBe("jj");
});

test.skipIf(!hasJj)("jj repo: origin url comes from jj git remote list", async () => {
  const dir = await jjFixture();
  expect(await vcsRemoteOriginUrl(dir)).toBe("");
  await sh(dir, "git", "remote", "add", "origin", "https://github.com/acme/demo.git");
  expect(await vcsRemoteOriginUrl(dir)).toBe("https://github.com/acme/demo.git");
});

test("vcsSnapshot (git): clean binds to HEAD, every content change moves content_sha, aliases agree", async () => {
  const dir = await gitFixture();
  const head = await vcsHead(dir);
  const clean = await vcsSnapshot(dir);
  expect(clean).toEqual({ vcs: "git", head, dirty: false, content_sha: head });
  expect(await vcsResolveCommit(dir, "HEAD")).toBe(head);
  await expect(vcsResolveCommit(dir, "no-such-ref")).rejects.toThrow();

  writeFileSync(join(dir, "new.txt"), "one\n", "utf8");
  const untracked = await vcsSnapshot(dir);
  expect(untracked).toMatchObject({ head, dirty: true });
  expect(untracked.content_sha).toMatch(/^sha256:/);
  // Same bytes -> same snapshot; different untracked bytes -> different one.
  expect(sameSnapshot(untracked, await vcsSnapshot(dir))).toBe(true);
  writeFileSync(join(dir, "new.txt"), "two\n", "utf8");
  const changed = await vcsSnapshot(dir);
  expect(changed.content_sha).not.toBe(untracked.content_sha);

  // A symlinked path to the same checkout reports the same snapshot.
  const alias = join(tempDir("orch-vcs-alias-"), "wt");
  symlinkSync(dir, alias);
  expect(sameSnapshot(await vcsSnapshot(alias), changed)).toBe(true);

  // Committing moves the head; a non-repo fails loudly instead of "clean".
  await sh(dir, "git", "add", "new.txt");
  await sh(dir, "git", "commit", "-q", "-m", "add");
  const committed = await vcsSnapshot(dir);
  expect(committed.head).not.toBe(head);
  expect(committed.dirty).toBe(false);
  await expect(vcsSnapshot(tempDir("orch-vcs-plain-"))).rejects.toThrow();
});

test.skipIf(!hasJj)("vcsSnapshot (jj): empty @ reports its parent, edits make it dirty", async () => {
  const dir = await jjFixture();
  const parent = (await sh(dir, "jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id")).trim();
  const clean = await vcsSnapshot(dir);
  expect(clean).toEqual({ vcs: "jj", head: parent, dirty: false, content_sha: parent });
  expect(await vcsResolveCommit(dir, "@-")).toBe(parent);
  writeFileSync(join(dir, "b.txt"), "b\n", "utf8");
  const dirty = await vcsSnapshot(dir);
  expect(dirty.dirty).toBe(true);
  expect(dirty.head).not.toBe(parent);
  expect(sameSnapshot(dirty, clean)).toBe(false);
});
