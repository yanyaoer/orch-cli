import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptableHostTmpDir,
  canonicalizePath,
  findWorktreeHardlinks,
  providerStatePaths,
  sandboxPosture,
  sbplString,
  scratchEnv,
  seatbeltProfile,
  seatbeltUnsupportedReason,
} from "./sandbox.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-sandbox-"));
  tempDirs.push(dir);
  return dir;
}

test("sandboxPosture: only implementer/verifier get project-write", () => {
  expect(sandboxPosture("implementer")).toBe("project-write");
  expect(sandboxPosture("verifier")).toBe("project-write");
  expect(sandboxPosture("reviewer")).toBe("read-only");
  expect(sandboxPosture("researcher")).toBe("read-only");
  expect(sandboxPosture("controller")).toBe("read-only");
});

test("seatbeltUnsupportedReason: non-darwin always fails closed", () => {
  expect(seatbeltUnsupportedReason("linux")).toContain("requires macOS Seatbelt");
  expect(seatbeltUnsupportedReason("win32")).toContain("requires macOS Seatbelt");
});

test("sbplString escapes SBPL specials and rejects control characters", () => {
  expect(sbplString("/plain/path")).toBe('"/plain/path"');
  expect(sbplString('/has"quote')).toBe('"/has\\"quote"');
  expect(sbplString("/has\\backslash")).toBe('"/has\\\\backslash"');
  // NUL/newline can't round-trip through an SBPL literal → must throw, never mangle.
  expect(() => sbplString("/bad\npath")).toThrow(/control characters/);
  expect(() => sbplString("/bad\u0000path")).toThrow(/control characters/);
});

test("canonicalizePath resolves symlink aliases and rebuilds missing tails on the real parent", () => {
  const root = tempDir();
  const real = join(root, "real");
  mkdirSync(real, { recursive: true });
  const alias = join(root, "alias");
  symlinkSync(real, alias);
  const canonicalRoot = realpathSync(root);
  // Symlink alias resolves to the real dir; a rule on the alias would not
  // constrain writes through the real path.
  expect(canonicalizePath(alias)).toBe(join(canonicalRoot, "real"));
  // Missing tail (dry-run run dir, not-yet-created literal file): canonical
  // existing ancestor + remaining segments.
  expect(canonicalizePath(join(alias, "missing", "leaf.txt"))).toBe(join(canonicalRoot, "real", "missing", "leaf.txt"));
});

test("providerStatePaths: exactly the selected provider's state", () => {
  expect(providerStatePaths("pi", "/home/u")).toEqual({ dirs: ["/home/u/.pi"], files: [] });
  expect(providerStatePaths("omp", "/home/u")).toEqual({ dirs: ["/home/u/.omp"], files: [] });
  expect(providerStatePaths("codex", "/home/u")).toEqual({ dirs: ["/home/u/.codex"], files: [] });
  expect(providerStatePaths("claude", "/home/u")).toEqual({
    dirs: ["/home/u/.claude"],
    files: ["/home/u/.claude.json", "/home/u/.claude.json.backup"],
  });
});

test("findWorktreeHardlinks flags nlink>1 regular files and skips .git", () => {
  const root = tempDir();
  const worktree = join(root, "wt");
  mkdirSync(join(worktree, "nested"), { recursive: true });
  mkdirSync(join(worktree, ".git"), { recursive: true });
  writeFileSync(join(worktree, "plain.txt"), "a", "utf8");
  expect(findWorktreeHardlinks(worktree)).toEqual([]);

  // A hardlinked pair inside .git is ignored (read-only under the profile)…
  writeFileSync(join(worktree, ".git", "obj"), "o", "utf8");
  linkSync(join(worktree, ".git", "obj"), join(worktree, ".git", "obj2"));
  expect(findWorktreeHardlinks(worktree)).toEqual([]);

  // …but one that aliases content outside the worktree is found.
  writeFileSync(join(root, "outside.txt"), "x", "utf8");
  linkSync(join(root, "outside.txt"), join(worktree, "nested", "aliased.txt"));
  expect(findWorktreeHardlinks(worktree)).toEqual([join(worktree, "nested", "aliased.txt")]);
});

test("scratchEnv redirects temp and caches into the run scratch", () => {
  expect(scratchEnv("/runs/r1/scratch")).toEqual({
    TMPDIR: "/runs/r1/scratch/tmp",
    TMP: "/runs/r1/scratch/tmp",
    TEMP: "/runs/r1/scratch/tmp",
    XDG_CACHE_HOME: "/runs/r1/scratch/cache",
    BUN_INSTALL_CACHE_DIR: "/runs/r1/scratch/cache/bun",
  });
});

test("acceptableHostTmpDir rejects broad shared parents and HOME ancestors", () => {
  const home = "/Users/u";
  expect(acceptableHostTmpDir("/private/var/folders/ab/cdef/T", home)).toBe(true);
  for (const broad of ["/", "/tmp", "/private/tmp", "/private/var", "/private/var/folders", "/Users", home]) {
    expect(acceptableHostTmpDir(broad, home)).toBe(false);
  }
});

test("seatbeltProfile: default-deny writes, minimal allows, Git denied last", () => {
  const profile = seatbeltProfile({
    posture: "project-write",
    worktree: "/wt",
    scratchDir: "/runs/r1/scratch",
    providerStateDirs: ["/Users/u/.pi"],
    providerStateFiles: [],
    hostTmpDir: "/private/var/folders/ab/cdef/T",
    orchStateDir: null,
  });
  const lines = profile.split("\n");
  expect(lines[0]).toBe("(version 1)");
  expect(lines[1]).toBe("(allow default)");
  expect(lines[2]).toBe("(deny file-write*)");
  expect(profile).toContain('(subpath "/wt")');
  expect(profile).toContain('(subpath "/Users/u/.pi")');
  expect(profile).toContain('(subpath "/runs/r1/scratch")');
  expect(profile).toContain('(subpath "/private/tmp")');
  expect(profile).toContain('(subpath "/private/var/folders/ab/cdef/T")');
  expect(profile).toContain('(literal "/dev/null")');
  // Git deny comes after the allow block: in SBPL the last matching rule wins.
  const gitDeny = profile.indexOf('(subpath "/wt/.git")');
  expect(gitDeny).toBeGreaterThan(profile.indexOf('(subpath "/wt")'));
  expect(profile.slice(gitDeny)).not.toContain("(allow file-write*");

  // read-only posture: no worktree rule; controller gets exactly the orch state root.
  const readOnly = seatbeltProfile({
    posture: "read-only",
    worktree: "/wt",
    scratchDir: "/runs/r1/scratch",
    providerStateDirs: ["/Users/u/.claude"],
    providerStateFiles: ["/Users/u/.claude.json"],
    hostTmpDir: null,
    orchStateDir: "/Users/u/.local/state/orch",
  });
  expect(readOnly).not.toContain('(subpath "/wt")');
  expect(readOnly).toContain('(literal "/Users/u/.claude.json")');
  expect(readOnly).toContain('(subpath "/Users/u/.local/state/orch")');
  expect(readOnly).not.toContain('"/Users/u/.local/state")');
});
