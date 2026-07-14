import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentName, RunRole, SandboxPosture } from "../src/types.ts";

// macOS Seatbelt (`sandbox-exec`) write-jail primitives for orch workers —
// engine `seatbelt-v1`, docs/sandbox-design.md. This is accidental-write
// blast-radius control for trusted local agents, not a hostile-code boundary:
// reads, exec, and network stay open; only local file writes are confined.
// All path inputs are computed by orch for the current run; no task- or
// model-supplied path may ever reach these functions.

export const SEATBELT_ENGINE = "seatbelt-v1" as const;

// Role decides the worktree posture; the provider cannot widen it. verifier
// is project-write because real test/build commands create artifacts, caches,
// and snapshots inside the worktree.
export function sandboxPosture(role: RunRole): SandboxPosture {
  return role === "implementer" || role === "verifier" ? "project-write" : "read-only";
}

// sandbox:true must fail closed, never silently downgrade: a run created with
// the sandbox on either executes under it or does not execute at all.
export function seatbeltUnsupportedReason(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "darwin") {
    return `config sandbox:true requires macOS Seatbelt but this platform is ${platform}; disable sandbox in config.json or run on macOS (fail-closed, no silent downgrade)`;
  }
  try {
    accessSync("/usr/bin/sandbox-exec", constants.X_OK);
  } catch {
    return "config sandbox:true requires /usr/bin/sandbox-exec, which is missing or not executable (fail-closed, no silent downgrade)";
  }
  return null;
}

// Pin a path to its real location so a symlink alias cannot widen a rule.
// Trailing segments that do not exist yet (a dry-run's run dir, files like
// ~/.claude.json.backup) are rebuilt on the deepest existing ancestor's
// realpath: canonical parent + basename.
export function canonicalizePath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

// SBPL string literal with its own escaping — never shell quoting. A path that
// cannot round-trip through an SBPL string (NUL, newline, other control
// characters) must fail the run instead of silently moving the boundary.
export function sbplString(path: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`sandbox: path contains control characters and cannot be encoded into an SBPL profile: ${JSON.stringify(path)}`);
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface ProviderStatePaths {
  // Auth/session state the provider may rewrite (subpath rules). These must
  // exist: a missing dir means the CLI was never initialized on this host, and
  // the fix is a normal-terminal login — not opening $HOME so the provider can
  // pick its own landing spot.
  dirs: string[];
  // Root-level state files (literal rules). They may not exist yet (claude
  // recreates ~/.claude.json.backup), so they ride canonical parent + basename.
  files: string[];
}

// Only the selected provider's state is writable per run; other providers'
// state and generic dirs (~/.config, ~/Library/*) stay read-only. New provider
// paths require real-run evidence and a policy version bump, not a quiet edit.
export function providerStatePaths(provider: AgentName, home: string): ProviderStatePaths {
  if (provider === "claude") {
    return { dirs: [join(home, ".claude")], files: [join(home, ".claude.json"), join(home, ".claude.json.backup")] };
  }
  return { dirs: [join(home, `.${provider}`)], files: [] };
}

// Seatbelt is a path policy: a pre-existing regular file inside the worktree
// that shares an inode with an outside file lets an allowed write mutate
// outside content (probe-verified escape). Scan before spawn and fail closed;
// deliberately no ignore switch. `.git` is skipped: it stays read-only under
// the profile and git object stores hardlink routinely.
export function findWorktreeHardlinks(worktree: string, limit = 20): string[] {
  const found: string[] = [];
  const stack = [worktree];
  while (stack.length > 0 && found.length < limit) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && lstatSync(path).nlink > 1) {
        found.push(path);
        if (found.length >= limit) break;
      }
    }
  }
  return found;
}

// Per-run scratch redirections: provider temp/cache writes land in the run's
// scratch instead of needing ~/.cache, ~/.npm, ~/.bun, or ~/Library/Caches.
// Extend only when a real run proves a tool needs another cache variable.
export function scratchEnv(scratchDir: string): Record<string, string> {
  const tmp = join(scratchDir, "tmp");
  const cache = join(scratchDir, "cache");
  return { TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: cache, BUN_INSTALL_CACHE_DIR: join(cache, "bun") };
}

// The host per-user temp dir (confstr DARWIN_USER_TEMP_DIR) is a deliberate
// disposable-state exception: some tools resolve it directly and ignore
// $TMPDIR. Accept it only when it is genuinely narrow — never a broad shared
// parent like /tmp or /private/var/folders, and never an ancestor of $HOME.
export function acceptableHostTmpDir(canonicalTmp: string, canonicalHome: string): boolean {
  const broad = new Set([
    "/",
    "/tmp",
    "/private/tmp",
    "/var",
    "/private/var",
    "/var/tmp",
    "/private/var/tmp",
    "/var/folders",
    "/private/var/folders",
    canonicalHome,
  ]);
  if (broad.has(canonicalTmp)) return false;
  return !canonicalHome.startsWith(`${canonicalTmp}/`);
}

export interface SeatbeltProfileInput {
  posture: SandboxPosture;
  worktree: string; // canonical
  scratchDir: string; // canonical ${runDir}/scratch — never the whole run dir
  providerStateDirs: string[]; // canonical, subpath rules
  providerStateFiles: string[]; // canonical, literal rules
  hostTmpDir: string | null; // canonical, pre-vetted via acceptableHostTmpDir
  orchStateDir: string | null; // canonical, controller role only
}

// Profile shape: reads/exec/network stay open, writes are default-denied, the
// run-computed minimum is re-allowed, and Git metadata is re-denied last (in
// SBPL the last matching rule wins). Agents deliver uncommitted diffs that the
// supervisor collects, so Git metadata needs no write access in v1; a future
// agent-commits workflow must ship as an explicit new posture, not a quiet
// widening here.
export function seatbeltProfile(input: SeatbeltProfileInput): string {
  const allows: string[] = [];
  if (input.posture === "project-write") allows.push(`(subpath ${sbplString(input.worktree)})`);
  for (const dir of input.providerStateDirs) allows.push(`(subpath ${sbplString(dir)})`);
  for (const file of input.providerStateFiles) allows.push(`(literal ${sbplString(file)})`);
  allows.push(`(subpath ${sbplString(input.scratchDir)})`);
  // Disposable-state exceptions, not part of the project boundary: /private/tmp
  // for CLI temp files, /dev/null for the ubiquitous sink. Never the whole
  // /dev, never the whole /private/var/folders tree.
  allows.push('(subpath "/private/tmp")');
  if (input.hostTmpDir) allows.push(`(subpath ${sbplString(input.hostTmpDir)})`);
  allows.push('(literal "/dev/null")');
  if (input.orchStateDir) allows.push(`(subpath ${sbplString(input.orchStateDir)})`);
  const gitDir = join(input.worktree, ".git");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    ...allows.map((rule) => `  ${rule}`),
    ")",
    "(deny file-write*",
    // Both forms: .git is a file in a linked worktree, a dir in the main one.
    // A linked worktree's common Git dir lives outside the worktree and is
    // simply never allowed.
    `  (literal ${sbplString(gitDir)})`,
    `  (subpath ${sbplString(gitDir)})`,
    ")",
  ].join("\n");
}
