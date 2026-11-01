import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, utimesSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePlanned, planMrDir, type RunGcOptions } from "./commands/run-gc.ts";
import type { ForgeMrLifecycle } from "./forge.ts";
import { repoKeyFromRemote } from "./paths.ts";

// Every temp root this file makes is removed after the file's tests (the race
// test alone leaves a 32 MiB file per run otherwise).
const tempRoots: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(prefix);
  tempRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});


const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-01T00:00:00Z");

// Set every entry under root (and root) to `daysAgo` before NOW.
function age(root: string, daysAgo: number, now = NOW): void {
  const when = new Date(now - daysAgo * DAY);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      utimesSync(path, when, when);
    }
  };
  walk(root);
  utimesSync(root, when, when);
}

function mrDir(mrsRoot: string, mr: string, opts: { state?: string; pid?: number; forgeRef?: string; daysAgo: number; now?: number }): string {
  const dir = join(mrsRoot, mr);
  const run = join(dir, "runs", `verify-${mr}-20260101T000000-abc123`);
  mkdirSync(join(run, "evidence"), { recursive: true });
  mkdirSync(join(dir, "outbox", "pending"), { recursive: true });
  writeFileSync(join(run, "evidence", "log.txt"), "x".repeat(5000));
  writeFileSync(
    join(run, "status.json"),
    JSON.stringify({ run_id: `verify-${mr}`, mr, state: opts.state ?? "succeeded", pid: opts.pid ?? null, updated_at: new Date((opts.now ?? NOW) - opts.daysAgo * DAY).toISOString() }),
  );
  if (opts.forgeRef) writeFileSync(join(dir, "forge_ref"), `${opts.forgeRef}\n`);
  age(dir, opts.daysAgo, opts.now);
  return dir;
}

function options(states: Record<string, ForgeMrLifecycle>, calls: string[] = [], over: Partial<RunGcOptions> = {}): RunGcOptions {
  return {
    now: NOW,
    minAgeDays: 90,
    maxAgeDays: 180,
    forge: "gitlab",
    concurrency: 4,
    lookup: async (ref) => {
      calls.push(ref);
      return states[ref] ?? { state: "error", terminal_at: null, detail: "unexpected lookup" };
    },
    ...over,
  };
}

const merged = (daysAgo: number): ForgeMrLifecycle => ({ state: "merged", terminal_at: new Date(NOW - daysAgo * DAY).toISOString(), detail: null });

test("run gc plan: open MRs are never deleted, terminal MRs only after the window, lookups fail closed", async () => {
  const root = tempRoot(join(tmpdir(), "orch-run-gc-plan-"));
  mrDir(root, "1", { daysAgo: 400 }); // open, ancient
  mrDir(root, "2", { daysAgo: 100 }); // merged 100d, idle 100d
  mrDir(root, "3", { daysAgo: 10 }); // merged long ago but written 10d ago
  mrDir(root, "4", { daysAgo: 100 }); // merged only 30d ago
  mrDir(root, "5", { daysAgo: 100 }); // lookup error
  mrDir(root, "6", { daysAgo: 200 }); // 404, past the age cap
  mrDir(root, "7", { daysAgo: 100 }); // 404, inside the age cap
  mrDir(root, "issue-292", { daysAgo: 200 }); // thread name: age cap, no lookup
  mrDir(root, "audit-night", { daysAgo: 100 });
  mrDir(root, "new-x-ab12", { daysAgo: 100, forgeRef: "4245" }); // forge_ref wins
  mrDir(root, "8", { daysAgo: 100 }); // closed without a time
  const calls: string[] = [];
  const opts = options(
    {
      "1": { state: "open", terminal_at: null, detail: null },
      "2": merged(100),
      "3": merged(300),
      "4": merged(30),
      "5": { state: "error", terminal_at: null, detail: "glab exit 1: 401 Unauthorized" },
      "6": { state: "not_found", terminal_at: null, detail: "glab: not found" },
      "7": { state: "not_found", terminal_at: null, detail: "glab: not found" },
      "4245": { state: "closed", terminal_at: new Date(NOW - 95 * DAY).toISOString(), detail: null },
      "8": { state: "closed", terminal_at: null, detail: null },
    },
    calls,
  );
  const plan = Object.fromEntries(
    await Promise.all(["1", "2", "3", "4", "5", "6", "7", "issue-292", "audit-night", "new-x-ab12", "8"].map(async (mr) => [mr, await planMrDir(root, mr, opts)] as const)),
  );
  const verdict = (mr: string) => [plan[mr]!.action, plan[mr]!.reason];
  expect(verdict("1")).toEqual(["keep", "mr_open"]);
  expect(verdict("2")).toEqual(["delete", "mr_terminal"]);
  expect(verdict("3")).toEqual(["keep", "recent"]);
  expect(verdict("4")).toEqual(["keep", "terminal_recent"]);
  expect(verdict("5")).toEqual(["keep", "lookup_failed"]);
  expect(plan["5"]!.detail).toContain("401");
  expect(verdict("6")).toEqual(["delete", "age_cap"]);
  expect(verdict("7")).toEqual(["keep", "age_cap_recent"]);
  expect(verdict("issue-292")).toEqual(["delete", "age_cap"]);
  expect(verdict("audit-night")).toEqual(["keep", "age_cap_recent"]);
  expect(verdict("new-x-ab12")).toEqual(["delete", "mr_terminal"]);
  expect(plan["new-x-ab12"]!.forge_ref).toBe("4245");
  expect(verdict("8")).toEqual(["keep", "terminal_time_unknown"]);
  // Too-recent dirs and thread names never reach the forge.
  expect(calls.sort()).toEqual(["1", "2", "4", "4245", "5", "6", "7", "8"].sort());
  expect(plan["2"]!.evidence_bytes).toBeGreaterThan(0);
  expect(plan["2"]!.disk_bytes).toBeGreaterThanOrEqual(plan["2"]!.evidence_bytes);
});

test("run gc plan: a run in flight keeps the whole dir, a dead non-terminal run does not", async () => {
  const root = tempRoot(join(tmpdir(), "orch-run-gc-active-"));
  mrDir(root, "10", { daysAgo: 400, state: "running", pid: process.pid });
  mrDir(root, "11", { daysAgo: 400, state: "running", pid: 2 ** 22 + 12345 }); // pid gone: stale
  // A finished run whose recorded pid now belongs to another process (pid reuse).
  mrDir(root, "14", { daysAgo: 400, state: "done", pid: process.pid });
  const opts = options({ "10": merged(300), "11": merged(300), "14": merged(300) });
  const live = await planMrDir(root, "10", opts);
  expect([live.action, live.reason]).toEqual(["keep", "active_run"]);
  const dead = await planMrDir(root, "11", opts);
  expect([dead.action, dead.reason]).toEqual(["delete", "mr_terminal"]);
  const reused = await planMrDir(root, "14", opts);
  expect([reused.action, reused.reason]).toEqual(["delete", "mr_terminal"]);
});

test("run gc plan: a repo without a forge falls back to the age cap only", async () => {
  const root = tempRoot(join(tmpdir(), "orch-run-gc-noforge-"));
  mrDir(root, "12", { daysAgo: 200 });
  mrDir(root, "13", { daysAgo: 100 });
  const calls: string[] = [];
  const opts = options({}, calls, { forge: "none" });
  expect((await planMrDir(root, "12", opts)).reason).toBe("age_cap");
  expect((await planMrDir(root, "13", opts)).reason).toBe("age_cap_recent");
  expect(calls).toEqual([]);
});

test("run gc execute: a dir written after the plan is kept", async () => {
  const repoRoot = tempRoot(join(tmpdir(), "orch-run-gc-race-"));
  const mrsRoot = join(repoRoot, "mrs");
  const now = Date.now();
  mrDir(mrsRoot, "20", { daysAgo: 200, now });
  mrDir(mrsRoot, "21", { daysAgo: 200, now });
  const opts = options({ "20": merged(300), "21": merged(300) }, [], { now });
  const raced = await planMrDir(mrsRoot, "20", opts);
  const clean = await planMrDir(mrsRoot, "21", opts);
  expect(raced.action).toBe("delete");
  expect(clean.action).toBe("delete");
  // A new evidence file lands between plan and execute.
  writeFileSync(join(mrsRoot, "20", "runs", readdirSync(join(mrsRoot, "20", "runs"))[0]!, "evidence", "late.txt"), "late");
  await deletePlanned(repoRoot, raced);
  await deletePlanned(repoRoot, clean);
  expect([raced.action, raced.reason, raced.removed]).toEqual(["keep", "changed_since_plan", false]);
  expect(existsSync(join(mrsRoot, "20"))).toBe(true);
  expect(clean.removed).toBe(true);
  expect(existsSync(join(mrsRoot, "21"))).toBe(false);
  expect(readdirSync(join(repoRoot, ".run-gc-trash"))).toEqual([]);
});

async function sh(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

test("orch run gc end to end: plan deletes nothing, --execute deletes exactly the plan via a fake glab", async () => {
  const root = realpathSync(tempRoot(join(tmpdir(), "orch-run-gc-e2e-")));
  const worktree = join(root, "repo");
  mkdirSync(worktree);
  const remote = "git@git.example.com:grp/proj.git";
  await sh(["git", "init", "-q"], worktree);
  await sh(["git", "remote", "add", "origin", remote], worktree);
  const stateHome = join(root, "state");
  const repoKey = repoKeyFromRemote(remote, worktree);
  const mrsRoot = join(stateHome, "orch", repoKey, "mrs");
  const now = Date.now();
  const ago = (d: number) => new Date(now - d * DAY).toISOString();
  mrDir(mrsRoot, "1", { daysAgo: 400, now }); // open
  mrDir(mrsRoot, "2", { daysAgo: 120, now }); // merged 120d
  mrDir(mrsRoot, "3", { daysAgo: 120, now }); // 404, inside the cap
  mrDir(mrsRoot, "4", { daysAgo: 120, now }); // glab fails
  mrDir(mrsRoot, "5", { daysAgo: 40, now }); // merged 40d: inside the old 90d window, past the 30d default
  mrDir(mrsRoot, "6", { daysAgo: 20, now }); // too recent for the default: no lookup
  mrDir(mrsRoot, "issue-9", { daysAgo: 365, now }); // thread name past the cap
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "glab.log");
  writeFileSync(
    join(bin, "glab"),
    [
      "#!/bin/sh",
      `echo "$PWD $*" >> ${log}`,
      'case "$3" in',
      `  1) echo '{"iid":1,"state":"opened","merged_at":null,"closed_at":null,"updated_at":"${ago(400)}"}' ;;`,
      `  2) echo '{"iid":2,"state":"merged","merged_at":"${ago(120)}","closed_at":null,"updated_at":"${ago(120)}"}' ;;`,
      `  5) echo '{"iid":5,"state":"merged","merged_at":"${ago(40)}","closed_at":null,"updated_at":"${ago(40)}"}' ;;`,
      `  3) echo '{"error":{"message":"failed to get merge request 3: 404 Not Found"}}'; echo 'failed to get merge request 3: 404 Not Found.' >&2; exit 1 ;;`,
      `  *) echo 'connection refused' >&2; exit 1 ;;`,
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: join(root, "config"), PATH: `${bin}:${process.env.PATH ?? ""}` };
  const orch = (...args: string[]) => sh([process.execPath, join(import.meta.dir, "orch.ts"), "run", "gc", "--worktree", worktree, ...args], import.meta.dir, env);

  const planned = await orch("--dry-run");
  expect(planned.stderr).toBe("");
  expect(planned.exitCode).toBe(0);
  const plan = JSON.parse(planned.stdout);
  const byMr = Object.fromEntries(plan.mrs.map((row: { mr: string; action: string; reason: string }) => [row.mr, `${row.action}:${row.reason}`]));
  expect(byMr).toEqual({
    "1": "keep:mr_open",
    "2": "delete:mr_terminal",
    "3": "keep:age_cap_recent",
    "4": "keep:lookup_failed",
    "5": "delete:mr_terminal",
    "6": "keep:recent",
    "issue-9": "delete:age_cap",
  });
  expect(plan.executed).toBe(false);
  expect(plan.min_age_days).toBe(30);
  expect(plan.summary.delete).toBe(3);
  expect(plan.execute_with).toContain("--execute");
  for (const mr of ["1", "2", "3", "4", "5", "6", "issue-9"]) expect(existsSync(join(mrsRoot, mr))).toBe(true);
  // glab ran from the repo root, once per numeric MR.
  const calls = (await Bun.file(log).text()).trim().split("\n");
  expect(calls.length).toBe(5);
  expect(calls.every((line) => line.startsWith(`${realpathSync(worktree)} mr view `))).toBe(true);

  const applied = JSON.parse((await orch("--execute")).stdout);
  expect(applied.executed).toBe(true);
  expect(applied.summary.removed).toBe(3);
  expect(readdirSync(mrsRoot).sort()).toEqual(["1", "3", "4", "6"]);
  expect(statSync(join(stateHome, "orch", repoKey, ".run-gc-trash")).isDirectory()).toBe(true);
  expect(readdirSync(join(stateHome, "orch", repoKey, ".run-gc-trash"))).toEqual([]);

  const both = await orch("--execute", "--dry-run");
  expect(both.exitCode).not.toBe(0);
  expect(both.stderr).toContain("mutually exclusive");
});
