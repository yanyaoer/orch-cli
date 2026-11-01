import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { COMPACTION_LEDGER, compactEvidenceDir, compactionTestHooks, readCompactionLedger } from "./evidence-compact.ts";
import { repoKeyFromRemote } from "./paths.ts";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const big = (n: number) => "log line with some repetition 0123456789\n".repeat(Math.ceil(n / 42)).slice(0, n);

function evidenceFixture(): { dir: string; outside: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orch-compact-")));
  const dir = join(root, "evidence");
  mkdirSync(join(dir, "device", "dumps"), { recursive: true });
  writeFileSync(join(dir, "full.log"), big(400 * 1024));
  writeFileSync(join(dir, "device", "dumps", "ui.xml"), big(300 * 1024));
  writeFileSync(join(dir, "small.log"), "short\n");
  writeFileSync(join(dir, "shot.png"), Buffer.alloc(400 * 1024, 7));
  writeFileSync(join(dir, "device", "app-debug.apk"), Buffer.alloc(50 * 1024, 1));
  const outside = join(root, "outside.log");
  writeFileSync(outside, big(400 * 1024));
  symlinkSync(outside, join(dir, "linked.log"));
  const old = new Date(Date.now() - 3600_000);
  for (const p of ["full.log", "device/dumps/ui.xml", "small.log", "shot.png", "device/app-debug.apk"]) utimesSync(join(dir, p), old, old);
  return { dir, outside };
}

test("evidence compact plan changes nothing; execute gzips text, drops rebuildables, ledgers both", () => {
  const { dir, outside } = evidenceFixture();
  const before = readFileSync(join(dir, "full.log"));
  const xml = readFileSync(join(dir, "device", "dumps", "ui.xml"));
  const mtime = statSync(join(dir, "full.log")).mtimeMs;

  const plan = compactEvidenceDir(dir, { execute: false });
  expect(plan.actions.map((a) => `${a.action}:${a.path}`).sort()).toEqual(["drop:device/app-debug.apk", "gzip:device/dumps/ui.xml", "gzip:full.log"]);
  expect(existsSync(join(dir, "full.log"))).toBe(true);
  expect(existsSync(join(dir, COMPACTION_LEDGER))).toBe(false);

  const done = compactEvidenceDir(dir, { execute: true });
  expect(done.actions.every((a) => a.applied)).toBe(true);
  expect(existsSync(join(dir, "full.log"))).toBe(false);
  expect(gunzipSync(readFileSync(join(dir, "full.log.gz")))).toEqual(before);
  expect(statSync(join(dir, "full.log.gz")).mtimeMs).toBe(mtime);
  expect(gunzipSync(readFileSync(join(dir, "device", "dumps", "ui.xml.gz")))).toEqual(xml);
  expect(existsSync(join(dir, "device", "app-debug.apk"))).toBe(false);
  // Untouched: small text, images, symlinks and what they point at.
  expect(readFileSync(join(dir, "small.log"), "utf8")).toBe("short\n");
  expect(existsSync(join(dir, "shot.png"))).toBe(true);
  expect(existsSync(join(dir, "linked.log"))).toBe(true);
  expect(existsSync(outside)).toBe(true);
  expect(existsSync(`${outside}.gz`)).toBe(false);
  const ledger = readCompactionLedger(dir)!;
  expect(ledger.entries.find((e) => e.path === "full.log")).toMatchObject({ action: "gzip", sha256: sha(before), bytes: before.length, gz_path: "full.log.gz" });
  expect(ledger.entries.find((e) => e.path === "device/app-debug.apk")).toMatchObject({ action: "drop", sha256: sha(Buffer.alloc(50 * 1024, 1)) });
  expect(done.bytes_saved).toBeGreaterThan(50 * 1024);

  // Idempotent: a second pass finds nothing and keeps the ledger.
  const again = compactEvidenceDir(dir, { execute: true });
  expect(again.actions).toEqual([]);
  expect(readCompactionLedger(dir)!.entries.length).toBe(3);
});

test("evidence compact skips fresh files and never clobbers an existing .gz", () => {
  const { dir } = evidenceFixture();
  writeFileSync(join(dir, "fresh.log"), big(300 * 1024)); // mtime now
  writeFileSync(join(dir, "full.log.gz"), "someone else's file");
  const report = compactEvidenceDir(dir, { execute: true, minFileAgeMs: 10 * 60_000 });
  const fresh = report.actions.find((a) => a.path === "fresh.log")!;
  expect([fresh.action, fresh.applied]).toEqual(["skip", undefined]);
  expect(existsSync(join(dir, "fresh.log"))).toBe(true);
  const clash = report.actions.find((a) => a.path === "full.log")!;
  expect(clash.applied).toBe(false);
  expect(clash.error).toContain("already exists");
  expect(existsSync(join(dir, "full.log"))).toBe(true);
  expect(readFileSync(join(dir, "full.log.gz"), "utf8")).toBe("someone else's file");
  expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
});

async function sh(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

test("orch evidence compact: finished runs and control labels only; runs in flight are skipped", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orch-compact-cli-")));
  const worktree = join(root, "repo");
  mkdirSync(worktree);
  const remote = "git@git.example.com:grp/proj.git";
  await sh(["git", "init", "-q"], worktree);
  await sh(["git", "remote", "add", "origin", remote], worktree);
  const stateHome = join(root, "state");
  const mrDir = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", "7");
  const old = new Date(Date.now() - 3600_000);
  const run = (id: string, state: string, pid: number | null) => {
    const dir = join(mrDir, "runs", id);
    mkdirSync(join(dir, "evidence"), { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ run_id: id, mr: "7", state, pid, updated_at: new Date().toISOString() }));
    writeFileSync(join(dir, "evidence", "full.log"), big(300 * 1024));
    utimesSync(join(dir, "evidence", "full.log"), old, old);
    return dir;
  };
  const finished = run("verify-a", "done", null);
  const live = run("verify-b", "running", process.pid);
  const control = join(mrDir, "evidence", "legacy-verify-7");
  mkdirSync(join(control, "android-app-build"), { recursive: true });
  writeFileSync(join(control, "android-app-build", "app.apk"), Buffer.alloc(1024, 2));
  utimesSync(join(control, "android-app-build", "app.apk"), old, old);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: join(root, "config") };
  const orch = (...args: string[]) => sh([process.execPath, join(import.meta.dir, "orch.ts"), "evidence", "compact", "--worktree", worktree, ...args], import.meta.dir, env);

  const plan = JSON.parse((await orch()).stdout);
  expect(plan.executed).toBe(false);
  expect(plan.summary).toMatchObject({ gzip: 1, drop: 1, runs_in_flight_skipped: 1, errors: 0 });
  expect(existsSync(join(finished, "evidence", "full.log"))).toBe(true);

  const applied = await orch("--execute");
  expect(applied.exitCode).toBe(0);
  expect(JSON.parse(applied.stdout).summary).toMatchObject({ gzip: 1, drop: 1, errors: 0 });
  expect(existsSync(join(finished, "evidence", "full.log.gz"))).toBe(true);
  expect(existsSync(join(live, "evidence", "full.log"))).toBe(true);
  expect(existsSync(join(control, "android-app-build", "app.apk"))).toBe(false);
  expect(readCompactionLedger(control)!.entries[0]).toMatchObject({ path: "android-app-build/app.apk", action: "drop" });
});

test("evidence compact keeps an original that a writer keeps changing (no data loss)", async () => {
  // A child compacts a 32 MiB log while this process rewrites bytes in place
  // every millisecond (verify-run-gc-r3 scenario ix). Whatever the interleaving,
  // the original must survive unless the .gz holds exactly its final content.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orch-compact-race-")));
  const dir = join(root, "evidence");
  mkdirSync(dir);
  const path = join(dir, "x.log");
  writeFileSync(path, Buffer.alloc(32 * 1024 * 1024, 65));
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path, old, old);
  const code = `import { compactEvidenceDir } from ${JSON.stringify(join(import.meta.dir, "evidence-compact.ts"))}; console.log(JSON.stringify(compactEvidenceDir(${JSON.stringify(dir)}, { execute: true, now: Date.now() + 3600_000 })))`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const { openSync, writeSync, closeSync, readSync, fstatSync } = await import("node:fs");
  const fd = openSync(path, "r+");
  let n = 0;
  const timer = setInterval(() => {
    try {
      writeSync(fd, Buffer.from([66 + (n++ % 20)]), 0, 1, (n * 4096) % (32 * 1024 * 1024));
    } catch {
      // the file may be gone if compaction won the race
    }
  }, 1);
  const exitCode = await child.exited;
  clearInterval(timer);
  // The inode's final bytes, read through the writer's fd: valid even if the
  // path was unlinked under it.
  const final = Buffer.alloc(fstatSync(fd).size);
  readSync(fd, final, 0, final.length, 0);
  closeSync(fd);
  expect(exitCode).toBe(0);
  const action = JSON.parse(await new Response(child.stdout).text()).actions[0];
  if (existsSync(path)) {
    expect(action.applied).not.toBe(true);
    expect(existsSync(`${path}.gz`)).toBe(false);
  } else {
    // The original is gone only if the .gz holds every byte the writer wrote.
    expect(action.applied).toBe(true);
    expect(gunzipSync(readFileSync(`${path}.gz`)).equals(final)).toBe(true);
  }
}, 30000);

test("evidence compact keeps an original written after it was read (gzip and drop)", () => {
  const { dir } = evidenceFixture();
  const { appendFileSync } = require("node:fs") as typeof import("node:fs");
  compactionTestHooks.beforeUnlinkCheck = (abs) => appendFileSync(abs, "late write\n");
  try {
    const report = compactEvidenceDir(dir, { execute: true });
    for (const path of ["full.log", "device/dumps/ui.xml", "device/app-debug.apk"]) {
      const action = report.actions.find((a) => a.path === path)!;
      expect([action.applied, action.error]).toEqual([false, expect.stringContaining("changed during compaction")]);
      expect(readFileSync(join(dir, path), "utf8").endsWith("late write\n")).toBe(true);
      expect(existsSync(join(dir, `${path}.gz`))).toBe(false);
    }
    expect(existsSync(join(dir, COMPACTION_LEDGER))).toBe(false);
  } finally {
    delete compactionTestHooks.beforeUnlinkCheck;
  }
});
