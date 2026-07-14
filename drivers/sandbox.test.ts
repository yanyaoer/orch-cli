import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptableHostTmpDir,
  canonicalizePath,
  findWorktreeHardlinks,
  narrowWritableDirReason,
  providerStatePaths,
  rootLevelStateFileReason,
  sandboxPosture,
  sandboxRunIdentity,
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

// F6 seam: the idempotency-key suffix and the spec field are derived together
// from one resolved engine value, so they can never split across two config
// reads. createRun resolves the engine once and threads it to both.
test("sandboxRunIdentity derives key suffix and spec field from one engine value", () => {
  const on = sandboxRunIdentity("seatbelt-v1");
  expect(on.keySuffix).toBe(":sandbox-seatbelt-v1");
  expect(on.specField).toEqual({ sandbox_engine: "seatbelt-v1" });
  const off = sandboxRunIdentity(null);
  expect(off.keySuffix).toBe("");
  expect(off.specField).toEqual({});
  // The key carries the engine iff the spec records it — the two cannot diverge.
  for (const engine of ["seatbelt-v1", null] as const) {
    const id = sandboxRunIdentity(engine);
    expect(id.keySuffix !== "").toBe(id.specField.sandbox_engine !== undefined);
  }
});

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

// F1 repro: the old acceptableHostTmpDir returned true for any $TMPDIR that
// wasn't a hardcoded broad parent, so ~/Documents, another repo, and
// /opt/company/config all slipped into the write allow-set. Only the real
// Darwin per-user temp (owned by the current uid) may be accepted now.
test("acceptableHostTmpDir accepts only the real Darwin per-user temp, not arbitrary TMPDIR", () => {
  // A real, current-uid-owned per-user temp dir under /private/var/folders is
  // accepted (synthetic home outside the temp tree so temp is not its ancestor).
  const realTemp = process.env.TMPDIR ? realpathSync(process.env.TMPDIR).replace(/\/$/, "") : null;
  if (realTemp && /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T$/.test(realTemp)) {
    expect(acceptableHostTmpDir(realTemp, "/Users/synthetic-home")).toBe(true);
  }
  // F1 attack paths: the old impl accepted any $TMPDIR that wasn't a hardcoded
  // broad parent, so all three slipped into the write allow-set. The Darwin
  // per-user-temp regex now rejects them before any dir even needs to exist.
  const home = "/Users/alice";
  for (const attack of ["/Users/alice/Documents", "/Users/alice/other-repo", "/opt/company/config", "/Users/alice/.pi"]) {
    expect(acceptableHostTmpDir(attack, home)).toBe(false);
  }
  // Broad shared parents and the var/folders root (no /T component) stay rejected.
  for (const broad of ["/", "/tmp", "/private/tmp", "/private/var", "/private/var/folders", "/private/var/folders/ab/cdef", "/Users", home]) {
    expect(acceptableHostTmpDir(broad, home)).toBe(false);
  }
});

// F2 repro: provider/controller state dirs are realpath'd and then handed to
// (subpath ...) allows. Without this gate, a symlinked `~/.pi -> $HOME` (or
// `XDG_STATE_HOME -> /`) canonicalizes to HOME/root and grants a home/root-wide
// write. narrowWritableDirReason must reject every such target.
test("narrowWritableDirReason rejects home/root/ancestor/shared/non-owned/non-dir targets", () => {
  const root = realpathSync(tempDir());
  const home = join(root, "home");
  const worktree = join(home, "proj", "repo");
  mkdirSync(worktree, { recursive: true });
  const good = join(home, ".pi");
  mkdirSync(good, { recursive: true });

  expect(narrowWritableDirReason(good, home, worktree)).toBeNull(); // the legit case
  expect(narrowWritableDirReason(home, home, worktree)).toContain("home");
  expect(narrowWritableDirReason("/", home, worktree)).toContain("shared system root");
  expect(narrowWritableDirReason(join(home, "proj"), home, worktree)).toContain("ancestor of it"); // worktree parent
  expect(narrowWritableDirReason(root, home, worktree)).toContain("ancestor of HOME"); // HOME's parent
  for (const shared of ["/usr", "/etc", "/private/var/folders", "/Library", "/opt"]) {
    expect(narrowWritableDirReason(shared, home, worktree)).toContain("shared system root");
  }
  // Non-directory (a symlink resolved to a file) and non-existent are rejected.
  const file = join(home, "afile");
  writeFileSync(file, "x", "utf8");
  expect(narrowWritableDirReason(file, home, worktree)).toContain("not a directory");
  expect(narrowWritableDirReason(join(home, "missing"), home, worktree)).toContain("does not exist");
});

test("rootLevelStateFileReason accepts only direct children of HOME", () => {
  const home = "/Users/u";
  expect(rootLevelStateFileReason("/Users/u/.claude.json", home)).toBeNull();
  expect(rootLevelStateFileReason("/Users/u/.claude.json.backup", home)).toBeNull();
  // A symlinked ~/.claude.json resolving off HOME (e.g. -> /etc/hosts) is rejected.
  expect(rootLevelStateFileReason("/etc/hosts", home)).toContain("direct child of HOME");
  expect(rootLevelStateFileReason("/Users/u/nested/x.json", home)).toContain("direct child of HOME");
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
