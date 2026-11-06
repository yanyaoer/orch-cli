import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./cli.ts";
import {
  createScratchCopies,
  mainCheckoutOf,
  parseScratchRequests,
  removeScratchCopies,
  resolveScratchRevs,
  scratchFingerprint,
  scratchGc,
  scratchRootPath,
} from "./scratch.ts";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
import { seatbeltProfile } from "../drivers/sandbox.ts";
import { buildPrompt, buildProviderExecutionPlan } from "../drivers/driver-common.ts";
import type { RunSpec, RunStatus } from "./types.ts";
import type { CowBackendFactory } from "./worktree.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// Linux CI has no reflink on ext4: a plain recursive copy stands in for the
// CoW backend, exactly as worktree.test.ts does.
const portableBackend: CowBackendFactory = () => ({
  copy(source, dest) {
    const proc = Bun.spawnSync(["cp", "-R", "-P", source, dest], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  },
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function sh(cwd: string, ...argv: string[]): string {
  const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  if (proc.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

// <parent>/repo (main checkout, two commits, an ignored dependency dir) and a
// linked verify copy at <parent>/.orch-worktrees/repo/verify-1 — the layout
// sandbox-muse verifier runs use.
function fixture(): { parent: string; main: string; verify: string; first: string; second: string } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "orch-scratch-")));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const main = join(parent, "repo");
  mkdirSync(main);
  sh(main, "git", "init", "-q", "-b", "main");
  writeFileSync(join(main, ".gitignore"), "node_modules/\n");
  writeFileSync(join(main, "app.txt"), "v1\n");
  sh(main, "git", "add", ".");
  sh(main, "git", "commit", "-q", "-m", "one");
  const first = sh(main, "git", "rev-parse", "HEAD");
  writeFileSync(join(main, "app.txt"), "v2\n");
  sh(main, "git", "commit", "-q", "-am", "two");
  const second = sh(main, "git", "rev-parse", "HEAD");
  const verify = join(parent, ".orch-worktrees", "repo", "verify-1");
  mkdirSync(join(parent, ".orch-worktrees", "repo"), { recursive: true });
  sh(main, "git", "worktree", "add", "-q", "--detach", verify, second);
  mkdirSync(join(verify, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(verify, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  return { parent, main, verify, first, second };
}

function registered(main: string): string {
  return sh(main, "git", "worktree", "list", "--porcelain");
}

test("parseScratchRequests accepts comma lists and repeats, rejects bad names, duplicates and option-like revs", () => {
  expect(parseScratchRequests(["combo,base@origin/main", "mut"])).toEqual([
    { name: "combo", rev: null },
    { name: "base", rev: "origin/main" },
    { name: "mut", rev: null },
  ]);
  expect(() => parseScratchRequests(["../x"])).toThrow(CliError);
  expect(() => parseScratchRequests([".hidden"])).toThrow(CliError);
  expect(() => parseScratchRequests(["a,a"])).toThrow(CliError);
  expect(() => parseScratchRequests(["a@"])).toThrow(CliError);
  expect(() => parseScratchRequests(["a@--upload-pack=x"])).toThrow(CliError);
  expect(() => parseScratchRequests([Array.from({ length: 9 }, (_, i) => `c${i}`).join(",")])).toThrow(CliError);
});

test("revs resolve to commits up front and feed the fingerprint", () => {
  const { verify, first } = fixture();
  const resolved = resolveScratchRevs(verify, parseScratchRequests(["combo,base@HEAD~1"]));
  expect(resolved[1]!.head).toBe(first);
  expect(scratchFingerprint(resolved)).toBe(`combo@worktree,base@${first}`);
  expect(() => resolveScratchRevs(verify, parseScratchRequests(["x@no-such-ref"]))).toThrow(CliError);
});

test("copies of a linked worktree live under the main checkout's orch root and carry deps; @rev checks out that commit", () => {
  const { parent, main, verify, first, second } = fixture();
  expect(mainCheckoutOf(verify)).toBe(main);
  const runDir = join(parent, "state", "run-1");
  mkdirSync(runDir, { recursive: true });
  const requests = resolveScratchRevs(verify, parseScratchRequests(["combo,base@HEAD~1"]));
  const { root, copies } = createScratchCopies(verify, "run-1", runDir, requests, portableBackend);

  expect(root).toBe(join(parent, ".orch-worktrees", "repo", "scratch", "run-1"));
  expect(root).toBe(scratchRootPath(verify, "run-1"));
  expect(JSON.parse(readFileSync(join(root, ".orch-scratch.json"), "utf8"))).toMatchObject({ run_id: "run-1", run_dir: runDir });
  const [combo, base] = copies;
  expect(combo).toMatchObject({ name: "combo", path: join(root, "combo"), rev: null, head: second });
  expect(base).toMatchObject({ name: "base", path: join(root, "base"), rev: "HEAD~1", head: first });
  expect(readFileSync(join(combo!.path, "node_modules", "dep", "index.js"), "utf8")).toContain("module.exports");
  expect(readFileSync(join(combo!.path, "app.txt"), "utf8")).toBe("v2\n");
  expect(readFileSync(join(base!.path, "app.txt"), "utf8")).toBe("v1\n");
  expect(sh(base!.path, "git", "rev-parse", "HEAD")).toBe(first);
  expect(registered(main)).toContain(combo!.path);

  // Disposable by contract: a mutated copy is still removed.
  writeFileSync(join(combo!.path, "app.txt"), "mutated\n");
  writeFileSync(join(combo!.path, "untracked.txt"), "x\n");
  const cleanup = removeScratchCopies({ worktree: verify, scratch_root: root, scratch: copies });
  expect(cleanup.removed.sort()).toEqual([base!.path, combo!.path].sort());
  expect(cleanup.kept).toEqual([]);
  expect(existsSync(root)).toBe(false);
  expect(registered(main)).not.toContain(join(root, "combo"));
  // The source verify copy is untouched.
  expect(readFileSync(join(verify, "app.txt"), "utf8")).toBe("v2\n");
  expect(existsSync(join(verify, "node_modules", "dep", "index.js"))).toBe(true);
});

test("removal works after the run's own worktree is gone (derived from the scratch root)", () => {
  const { parent, main, verify } = fixture();
  const runDir = join(parent, "state", "run-2");
  mkdirSync(runDir, { recursive: true });
  const { root, copies } = createScratchCopies(verify, "run-2", runDir, resolveScratchRevs(verify, parseScratchRequests(["combo"])), portableBackend);
  sh(main, "git", "worktree", "remove", "--force", verify);
  const cleanup = removeScratchCopies({ worktree: verify, scratch_root: root, scratch: copies });
  expect(cleanup.removed).toEqual([copies[0]!.path]);
  expect(existsSync(root)).toBe(false);
});

test("removal is identity-gated: a recorded path outside <root>/<name>, or a non-clone, is kept untouched", () => {
  const { parent, verify } = fixture();
  const runDir = join(parent, "state", "run-3");
  mkdirSync(runDir, { recursive: true });
  const { root, copies } = createScratchCopies(verify, "run-3", runDir, resolveScratchRevs(verify, parseScratchRequests(["combo"])), portableBackend);
  const victim = join(parent, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep.txt"), "precious\n");
  const outside = removeScratchCopies({ worktree: verify, scratch_root: root, scratch: [{ name: "combo", path: victim, rev: null, head: "x" }] });
  expect(outside.removed).toEqual([]);
  expect(outside.kept[0]!.reason).toContain("not <scratch root>/<name>");
  expect(existsSync(join(victim, "keep.txt"))).toBe(true);

  // A plain directory planted at <root>/<name> has no orch provenance.
  const planted = join(root, "planted");
  mkdirSync(planted);
  writeFileSync(join(planted, "keep.txt"), "precious\n");
  const notClone = removeScratchCopies({ worktree: verify, scratch_root: root, scratch: [{ name: "planted", path: planted, rev: null, head: "x" }] });
  expect(notClone.kept[0]!.reason).toContain("provenance");
  expect(existsSync(join(planted, "keep.txt"))).toBe(true);
  removeScratchCopies({ worktree: verify, scratch_root: root, scratch: copies });
  expect(existsSync(copies[0]!.path)).toBe(false);
});

test("a failing @rev checkout rolls back the copies already made", () => {
  const { parent, main, verify } = fixture();
  const runDir = join(parent, "state", "run-4");
  mkdirSync(runDir, { recursive: true });
  const requests = [
    ...resolveScratchRevs(verify, parseScratchRequests(["combo"])),
    { name: "bad", rev: "deadbeef", head: "0000000000000000000000000000000000000000" },
  ];
  expect(() => createScratchCopies(verify, "run-4", runDir, requests, portableBackend)).toThrow(CliError);
  const root = scratchRootPath(verify, "run-4");
  expect(existsSync(root)).toBe(false);
  expect(registered(main)).not.toContain(root);
});

function writeStatus(runDir: string, patch: Partial<RunStatus>): void {
  writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: "x", state: "running", ...patch }));
}

test("gc keeps scratch of a run in flight and removes it once the run is terminal; dry-run removes nothing", () => {
  const { parent, main, verify } = fixture();
  const runDir = join(parent, "state", "run-5");
  mkdirSync(runDir, { recursive: true });
  const { root, copies } = createScratchCopies(verify, "run-5", runDir, resolveScratchRevs(verify, parseScratchRequests(["combo"])), portableBackend);
  writeFileSync(join(runDir, "spec.json"), JSON.stringify({ worktree: verify, scratch_root: root, scratch: copies }));

  writeStatus(runDir, { state: "running", supervisor_pid: process.pid, updated_at: new Date().toISOString() });
  expect(scratchGc(main, true)).toMatchObject([{ run_id: "run-5", action: "keep" }]);
  expect(existsSync(copies[0]!.path)).toBe(true);

  writeStatus(runDir, { state: "done" });
  expect(scratchGc(main, false)).toMatchObject([{ run_id: "run-5", action: "remove" }]);
  expect(existsSync(copies[0]!.path)).toBe(true);
  const executed = scratchGc(main, true);
  expect(executed).toMatchObject([{ run_id: "run-5", action: "remove", removed: [copies[0]!.path], kept: [] }]);
  expect(existsSync(root)).toBe(false);
});

test("gc removes scratch whose run dir is gone and reports a root without a marker", () => {
  const { parent, main, verify } = fixture();
  const runDir = join(parent, "state", "run-6");
  mkdirSync(runDir, { recursive: true });
  const { root } = createScratchCopies(verify, "run-6", runDir, resolveScratchRevs(verify, parseScratchRequests(["combo"])), portableBackend);
  rmSync(runDir, { recursive: true, force: true });
  const stray = join(parent, ".orch-worktrees", "repo", "scratch", "stray");
  mkdirSync(stray);
  const entries = scratchGc(main, true);
  expect(entries.find((entry) => entry.run_id === "run-6")).toMatchObject({ action: "remove", reason: "run dir gone" });
  expect(existsSync(root)).toBe(false);
  expect(entries.find((entry) => entry.run_id === "stray")).toMatchObject({ action: "keep" });
  expect(existsSync(stray)).toBe(true);
});

function writeFakeDriver(root: string): string {
  const path = join(root, "fake-driver.js");
  writeFileSync(
    path,
    String.raw`
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const specPath = process.argv[process.argv.indexOf("--spec") + 1];
const runDir = process.argv[process.argv.indexOf("--run-dir") + 1];
const spec = JSON.parse(readFileSync(specPath, "utf8"));
// The worker mutates its copy; the run must still end clean and the copy go.
writeFileSync(join(spec.scratch[0].path, "app.txt"), "mutated\n");
writeFileSync(join(runDir, "result.json"), JSON.stringify({
  schema: "orch.result/verifier/v1", run_id: spec.run_id, verdict: "pass", verifies_run_id: spec.run_id,
  commands: [{ cmd: "fake", exit_code: 0, status: "passed", summary: "ok" }], acceptance: [{ id: "a", status: "pass" }],
}));
`,
  );
  return path;
}

test("the supervisor removes a run's scratch copies when it ends and records the cleanup", async () => {
  const { parent, main, verify, second } = fixture();
  const runDir = join(parent, "state", "mrs", "1", "runs", "verify-1-x");
  mkdirSync(runDir, { recursive: true });
  const { root, copies } = createScratchCopies(verify, "verify-1-x", runDir, resolveScratchRevs(verify, parseScratchRequests(["combo,base@HEAD~1"])), portableBackend);
  const spec: RunSpec = {
    version: 1,
    run_id: "verify-1-x",
    mr: "1",
    role: "verifier",
    agent: "codex",
    model: null,
    tag: "verify",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: "k",
    repo_key: "local/repo",
    worktree: verify,
    task_path: null,
    task_text: "t",
    task_sha: "s",
    base_sha: second,
    timeout_sec: 30,
    created_at: new Date().toISOString(),
    scratch_root: root,
    scratch: copies,
  };
  writeFileSync(join(runDir, "spec.json"), JSON.stringify(spec));
  writeInitialRunFiles(runDir, spec);
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(parent, "xdg");
  let exit: number;
  try {
    exit = await runSupervisor(runDir, [process.execPath, writeFakeDriver(parent)]);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
  expect(exit).toBe(0);
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as RunStatus;
  expect(status.state).toBe("done");
  expect(status.scratch_cleanup?.removed.sort()).toEqual(copies.map((copy) => copy.path).sort());
  expect(status.scratch_cleanup?.kept).toEqual([]);
  expect(existsSync(root)).toBe(false);
  expect(registered(main)).not.toContain(root);
});

test("prompt, provider argv and Seatbelt profile expose the scratch copies and keep their .git read-only", () => {
  const root = "/x/.orch-worktrees/repo/scratch/r1";
  const spec = {
    version: 1,
    run_id: "r1",
    mr: "1",
    role: "verifier",
    agent: "codex",
    model: null,
    tag: "verify",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: "k",
    repo_key: "local/repo",
    worktree: "/x/wt",
    task_path: null,
    task_text: "t",
    task_sha: "s",
    base_sha: "b",
    timeout_sec: 30,
    created_at: "2026-11-06T00:00:00Z",
    scratch_root: root,
    scratch: [{ name: "combo", path: `${root}/combo`, rev: null, head: "abc" }],
  } as RunSpec;
  const prompt = buildPrompt(spec, "codex", "/x/run");
  expect(prompt).toContain(`ORCH_RUN_SCRATCH_DIR=${root}`);
  expect(prompt).toContain(`- combo: ${root}/combo (at abc`);

  for (const provider of ["codex", "claude"] as const) {
    const plan = buildProviderExecutionPlan({ provider, spec: { ...spec, agent: provider }, runDir: "/x/run", worktree: "/x/wt", prompt: "p", dryRun: true });
    const addDirs = plan.argv.flatMap((arg, index) => (arg === "--add-dir" ? [plan.argv[index + 1]] : []));
    expect(addDirs).toContain(root);
    expect(plan.env.ORCH_RUN_SCRATCH_DIR).toBe(root);
  }
  const noScratch = buildProviderExecutionPlan({ provider: "codex", spec: { ...spec, scratch: undefined, scratch_root: undefined }, runDir: "/x/run", worktree: "/x/wt", prompt: "p", dryRun: true });
  expect(noScratch.argv).not.toContain(root);
  expect(noScratch.env.ORCH_RUN_SCRATCH_DIR).toBeUndefined();

  const profile = seatbeltProfile({
    posture: "project-write",
    worktree: "/x/wt",
    scratchDir: "/x/run/scratch",
    providerStateDirs: [],
    providerStateFiles: [],
    hostTmpDir: null,
    orchStateDir: null,
    workerCacheDir: "/x/cache",
    extraWriteDirs: [],
    evidenceDir: "/x/run/evidence",
    scratchCopiesRoot: root,
    scratchCopyPaths: [`${root}/combo`],
  });
  const [allowBlock, denyBlock] = profile.split("(deny file-write*\n");
  expect(allowBlock).toContain(`(subpath "${root}")`);
  expect(denyBlock).toContain(`(literal "${root}/combo/.git")`);
  expect(denyBlock).toContain(`(subpath "${root}/combo/.git")`);
});
