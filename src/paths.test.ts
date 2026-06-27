import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalWorktreeRoot, getRepoIdentity, lockPathForWorktree, mrStateDir, repoKeyFromRemote } from "./paths.ts";

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
