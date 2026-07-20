import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWorktreeRoot, claimNewMrDir, getRepoIdentity, lockPathForWorktree, mailControlStateDir, mrStateDir, orchStateRoot, repoKeyFromRemote } from "./paths.ts";

test("claimNewMrDir regenerates on suffix collisions instead of sharing state", () => {
  const stateHome = mkdtempSync(join(tmpdir(), "orch-claim-"));
  tempDirs.push(stateHome);
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    // Deterministic collision: the second claim's first candidate repeats the
    // first claim's suffix and must be rejected by the exclusive mkdir — a
    // shared dir would inherit the other task's forge_ref and outbox.
    const suffixes = ["aaaa", "aaaa", "bbbb"];
    const random = (): string => suffixes.shift()!;
    const first = claimNewMrDir("local/repo-x", "crocs-review", random);
    const second = claimNewMrDir("local/repo-x", "crocs-review", random);
    expect(first.mr).toBe("new-crocs-review-aaaa");
    expect(second.mr).toBe("new-crocs-review-bbbb");
    expect(second.mrDir).not.toBe(first.mrDir);

    // A random source that never yields a fresh suffix fails loudly.
    expect(() => claimNewMrDir("local/repo-x", "crocs-review", () => "aaaa")).toThrow("after 100 attempts");
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-paths-"));
  tempDirs.push(dir);
  return dir;
}

async function runCmd(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed (${exitCode})\n${stdout}${stderr}`);
}

test("repo identity and worktree locks use the git top-level for nested cwd", async () => {
  const root = tempDir();
  const stateHome = join(root, "state");
  const worktree = join(root, "repo");
  const nested = join(worktree, "packages", "cli");
  mkdirSync(nested, { recursive: true });
  await runCmd(["git", "init"], worktree);
  writeFileSync(join(worktree, "README.md"), "initial\n", "utf8");
  await runCmd(["git", "add", "README.md"], worktree);
  await runCmd(["git", "-c", "user.email=orch@example.com", "-c", "user.name=orch", "commit", "-m", "init"], worktree);

  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    expect(canonicalWorktreeRoot(nested)).toBe(canonicalWorktreeRoot(worktree));
    expect(lockPathForWorktree(nested)).toBe(lockPathForWorktree(worktree));
    expect((await getRepoIdentity(nested)).repo_root).toBe(canonicalWorktreeRoot(worktree));
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
});

const hasJj = Boolean(Bun.which("jj"));

test.skipIf(!hasJj)("repo identity resolves through jj for jj worktrees", async () => {
  const root = tempDir();
  const stateHome = join(root, "state");
  const worktree = join(root, "repo");
  const nested = join(worktree, "packages", "cli");
  mkdirSync(nested, { recursive: true });
  await runCmd(["jj", "git", "init", "--colocate"], worktree);
  writeFileSync(join(worktree, "README.md"), "initial\n", "utf8");
  await runCmd(["jj", "commit", "-m", "init"], worktree);
  await runCmd(["jj", "git", "remote", "add", "origin", "https://github.com/acme/demo.git"], worktree);

  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    expect(canonicalWorktreeRoot(nested)).toBe(canonicalWorktreeRoot(worktree));
    const identity = await getRepoIdentity(nested);
    expect(identity.repo_root).toBe(canonicalWorktreeRoot(worktree));
    expect(identity.remote_url).toBe("https://github.com/acme/demo.git");
    expect(identity.repo_key.startsWith("github.com/acme/demo-")).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
});

test("state path components reject traversal segments", () => {
  const root = tempDir();
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const repoKey = repoKeyFromRemote("git@github.com:../evil/repo.git", join(root, "repo"));
    expect(repoKey.startsWith("github.com/")).toBe(true);
    expect(repoKey).not.toContain("/../");
    expect(repoKey).not.toContain("/./");
    const mrDir = mrStateDir(repoKey, "../escape");
    expect(mrDir.startsWith(join(root, "state", "orch"))).toBe(true);
    expect(mrDir).not.toContain("/../");
    expect(mrDir).not.toContain("/./");
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
});

test("mail control state dir lives under orch state root and respects XDG_STATE_HOME", () => {
  const root = tempDir();
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    expect(mailControlStateDir()).toBe(join(root, "state", "orch", "mail-control"));
    expect(mailControlStateDir().startsWith(`${orchStateRoot()}/`)).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
});
