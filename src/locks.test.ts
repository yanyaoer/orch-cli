import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquirePidfileLock, acquireWorktreeLock, LockHeldError, lockTestHooks, worktreeLockBusy } from "./locks.ts";
import { lockPathForWorktree } from "./paths.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DEAD_PID = 999_999_999;
const locksModule = resolve(import.meta.dir, "locks.ts");

// A separate OS process contending for the lock: waits until `startAt`, tries
// once, prints ok/held, holds a granted lock for `holdMs`, then releases.
function childScript(dir: string): string {
  const path = join(dir, "lock-child.ts");
  writeFileSync(
    path,
    `import { acquireWorktreeLock } from ${JSON.stringify(locksModule)};
const [lockPath, mode, holdMs, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) await Bun.sleep(1);
try {
  const lock = acquireWorktreeLock(lockPath, mode, "child-" + process.pid);
  console.log("ok");
  await Bun.sleep(Number(holdMs));
  lock.release();
} catch (error) {
  console.log(error instanceof Error && error.name === "Error" && /lock held/.test(error.message) ? "held" : "error " + String(error));
}
`,
    "utf8",
  );
  return path;
}

function spawnChild(script: string, lockPath: string, mode: "shared" | "exclusive", holdMs: number, startAt: number) {
  return Bun.spawn([process.execPath, script, lockPath, mode, String(holdMs), String(startAt)], { stdout: "pipe", stderr: "pipe" });
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!.trim();
}

test("readers share a checkout across processes; a writer excludes and is excluded", async () => {
  const dir = tempDir("orch-locks-");
  const lockPath = join(dir, "wt.lock");
  const script = childScript(dir);

  // Another process holds a read lock.
  const reader = spawnChild(script, lockPath, "shared", 1_500, 0);
  expect(await firstLine(reader.stdout)).toBe("ok");
  const mine = acquireWorktreeLock(lockPath, "shared", "reader-2");
  expect(() => acquireWorktreeLock(lockPath, "exclusive", "writer")).toThrow(LockHeldError);
  mine.release();
  expect(() => acquireWorktreeLock(lockPath, "exclusive", "writer")).toThrow(/read lock held/);
  await reader.exited;
  // Reader gone: the writer gets in, and then nobody else does.
  const writer = acquireWorktreeLock(lockPath, "exclusive", "writer");
  const blocked = spawnChild(script, lockPath, "shared", 0, 0);
  expect(await firstLine(blocked.stdout)).toBe("held");
  await blocked.exited;
  expect(() => acquireWorktreeLock(lockPath, "shared", "reader-3")).toThrow(/write lock held/);
  expect(() => acquireWorktreeLock(lockPath, "exclusive", "writer-2")).toThrow(LockHeldError);
  writer.release();
  expect(existsSync(lockPath)).toBe(false);
  acquireWorktreeLock(lockPath, "shared", "reader-4").release();
});

test("racing processes never run a writer alongside anyone", async () => {
  const dir = tempDir("orch-locks-race-");
  const script = childScript(dir);
  for (let round = 0; round < 6; round += 1) {
    const lockPath = join(dir, `race-${round}.lock`);
    const startAt = Date.now() + 400;
    const modes = ["exclusive", "shared", "shared", "exclusive", "shared"] as const;
    const children = modes.map((mode) => spawnChild(script, lockPath, mode, 300, startAt));
    const outcomes = await Promise.all(children.map(async (child) => (await new Response(child.stdout).text()).trim()));
    for (const outcome of outcomes) expect(["ok", "held"]).toContain(outcome);
    const writersOk = outcomes.filter((outcome, index) => outcome === "ok" && modes[index] === "exclusive").length;
    const readersOk = outcomes.filter((outcome, index) => outcome === "ok" && modes[index] === "shared").length;
    expect(writersOk).toBeLessThanOrEqual(1);
    if (writersOk === 1) expect(readersOk).toBe(0);
    // Everything released cleanly.
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(`${lockPath}.owners`)).toEqual([]);
  }
});

test("dead owners are ignored and cleaned without touching live ones; release removes only its own record", () => {
  const dir = tempDir("orch-locks-stale-");
  const lockPath = join(dir, "wt.lock");
  const owners = `${lockPath}.owners`;
  mkdirSync(owners, { recursive: true });
  // Dead reader and dead writer records (crashed supervisors).
  writeFileSync(`${owners}/shared-dead01.json`, JSON.stringify({ pid: DEAD_PID, run_id: "gone-r", ts: "t", nonce: "dead01" }));
  writeFileSync(`${owners}/exclusive-dead02.json`, JSON.stringify({ pid: DEAD_PID, run_id: "gone-w", ts: "t", nonce: "dead02" }));
  const writer = acquireWorktreeLock(lockPath, "exclusive", "w");
  expect(readdirSync(owners).filter((name) => name.includes("dead"))).toEqual([]);
  writer.release();
  expect(readdirSync(owners)).toEqual([]);

  // Two holders in one process: releasing one leaves the other's record.
  const a = acquireWorktreeLock(lockPath, "shared", "a");
  const b = acquireWorktreeLock(lockPath, "shared", "b");
  a.release();
  a.release();
  expect(readdirSync(owners)).toHaveLength(1);
  expect(() => acquireWorktreeLock(lockPath, "exclusive", "w")).toThrow(/read lock held/);
  b.release();
  acquireWorktreeLock(lockPath, "exclusive", "w").release();
});

test("deterministic interleavings: a contender acting between another's announce and check never yields two owners", () => {
  const dir = tempDir("orch-locks-interleave-");
  const cases: Array<{ first: "shared" | "exclusive"; second: "shared" | "exclusive"; dead: boolean }> = [
    { first: "exclusive", second: "exclusive", dead: false },
    { first: "exclusive", second: "exclusive", dead: true },
    { first: "exclusive", second: "shared", dead: false },
    { first: "shared", second: "exclusive", dead: true },
  ];
  cases.forEach((c, index) => {
    const lockPath = join(dir, `case-${index}.lock`);
    if (c.dead) {
      // The F2 setup: a stale record from a dead owner is already there.
      mkdirSync(`${lockPath}.owners`, { recursive: true });
      writeFileSync(`${lockPath}.owners/exclusive-dead.json`, JSON.stringify({ pid: DEAD_PID, run_id: "dead", ts: "t", nonce: "dead" }));
      writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, run_id: "dead", ts: "t", nonce: "dead" }));
    }
    const handles: Array<{ release(): void }> = [];
    let inner: string = "not-run";
    lockTestHooks.afterAnnounce = () => {
      lockTestHooks.afterAnnounce = undefined;
      // The second contender runs its whole acquisition inside the first one's
      // announce->check gap.
      try {
        handles.push(acquireWorktreeLock(lockPath, c.second, "second"));
        inner = "ok";
      } catch (error) {
        inner = error instanceof LockHeldError ? "held" : String(error);
      }
    };
    let outer: string;
    try {
      handles.push(acquireWorktreeLock(lockPath, c.first, "first"));
      outer = "ok";
    } catch (error) {
      outer = error instanceof LockHeldError ? "held" : String(error);
    } finally {
      lockTestHooks.afterAnnounce = undefined;
    }
    // The second contender saw the first's announcement and backed off; the
    // first then proceeds alone.
    expect([outer, inner]).toEqual(["ok", "held"]);
    expect(handles).toHaveLength(1);
    for (const handle of handles) handle.release();
  });
});

test("pre-hardening pidfiles: a live legacy writer excludes everyone; exclusive holders publish one for old writers", () => {
  const dir = tempDir("orch-locks-legacy-");
  const lockPath = join(dir, "wt.lock");
  // <=0.0.13 wrote {pid, run_id, ts} without a nonce.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, run_id: "legacy", ts: "t" }));
  expect(() => acquireWorktreeLock(lockPath, "shared", "r")).toThrow(/write lock held/);
  expect(() => acquireWorktreeLock(lockPath, "exclusive", "w")).toThrow(LockHeldError);
  // The live legacy file is never deleted by new code.
  expect(existsSync(lockPath)).toBe(true);

  // An empty file may be an old writer between create and write: held...
  writeFileSync(lockPath, "");
  expect(() => acquirePidfileLock(lockPath, process.pid, "w")).toThrow(LockHeldError);
  // ...until it is old enough to be a crash leftover; then it is ignored but
  // left in place (deleting it is the steal race), so no marker is published.
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  acquirePidfileLock(lockPath, process.pid, "w").release();
  expect(existsSync(lockPath)).toBe(true);
  rmSync(lockPath);

  // With no legacy file, an exclusive holder publishes one (old writers see a
  // live pid and back off) and removes it on release.
  const writer = acquirePidfileLock(lockPath, process.pid, "w");
  expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid, run_id: "w" });
  writer.release();
  expect(existsSync(lockPath)).toBe(false);
});

test("worktree lock path is canonical: symlinks and subdirectories map to one checkout", () => {
  const stateHome = tempDir("orch-locks-state-");
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  });
  const worktree = tempDir("orch-locks-wt-");
  expect(Bun.spawnSync(["git", "init", "-q", worktree]).exitCode).toBe(0);
  mkdirSync(join(worktree, "sub"));
  const alias = join(tempDir("orch-locks-alias-"), "link");
  symlinkSync(worktree, alias);
  const canonical = lockPathForWorktree(worktree);
  expect(lockPathForWorktree(alias)).toBe(canonical);
  expect(lockPathForWorktree(join(worktree, "sub"))).toBe(canonical);
  expect(lockPathForWorktree(`${alias}/sub`)).toBe(canonical);
  // So a writer through one path blocks a reader through the other.
  const writer = acquireWorktreeLock(lockPathForWorktree(alias), "exclusive", "w");
  expect(() => acquireWorktreeLock(lockPathForWorktree(worktree), "shared", "r")).toThrow(LockHeldError);
  writer.release();
});

test("a contender holding a pre-adoption read never reclaims a record whose dead owner adopted a live provider group", async () => {
  const dir = tempDir("orch-lock-adopt-");
  const lockPath = join(dir, "wt.lock");
  // A: a real supervisor stand-in in its own process, re-parented to init (it
  // is started by a shell that exits at once), so its death is final and
  // never lingers as our zombie. It takes the lock, then waits for a trigger
  // file naming a pgid, adopts it, and dies without releasing.
  const ownerScript = join(dir, "owner.ts");
  writeFileSync(
    ownerScript,
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { acquireWorktreeLock } from ${JSON.stringify(locksModule)};
const [lockPath, dir] = process.argv.slice(2);
const lock = acquireWorktreeLock(lockPath, "exclusive", "owner-a");
writeFileSync(dir + "/owner.pid", String(process.pid));
while (!existsSync(dir + "/adopt")) await Bun.sleep(5);
lock.adoptProcessGroup(Number(readFileSync(dir + "/adopt", "utf8")));
process.exit(0);
`,
    "utf8",
  );
  const provider = Bun.spawn(["sleep", "60"], { detached: true, stdout: "ignore", stderr: "ignore" });
  cleanups.push(() => {
    try {
      process.kill(-provider.pid, "SIGKILL");
    } catch {}
  });
  Bun.spawnSync(["sh", "-c", `"$0" "$1" "$2" "$3" >/dev/null 2>&1 &`, process.execPath, ownerScript, lockPath, dir]);
  for (let i = 0; i < 500 && !existsSync(join(dir, "owner.pid")); i += 1) await Bun.sleep(10);
  const ownerPid = Number(readFileSync(join(dir, "owner.pid"), "utf8"));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive(ownerPid)).toBe(true);
  const ownerRecord = readdirSync(`${lockPath}.owners`).find((name) => name.startsWith("exclusive-"))!;
  const recordPath = join(`${lockPath}.owners`, ownerRecord);
  expect(JSON.parse(readFileSync(recordPath, "utf8")).pgid ?? null).toBeNull();

  // B has read A's record (no pgid yet); before B judges it, A adopts the
  // provider group and dies.
  let interleaved = false;
  lockTestHooks.afterRead = (entry) => {
    if (interleaved || entry !== recordPath) return;
    interleaved = true;
    writeFileSync(join(dir, "adopt"), String(provider.pid));
    const deadline = Date.now() + 10_000;
    while (alive(ownerPid) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  };
  try {
    expect(() => acquireWorktreeLock(lockPath, "exclusive", "contender-b")).toThrow(LockHeldError);
  } finally {
    lockTestHooks.afterRead = undefined;
  }
  expect(interleaved).toBe(true);
  expect(alive(ownerPid)).toBe(false);
  expect(JSON.parse(readFileSync(recordPath, "utf8")).pgid).toBe(provider.pid);

  // Once the provider group is gone the dead record is reclaimed normally.
  process.kill(-provider.pid, "SIGKILL");
  await provider.exited;
  const lock = acquireWorktreeLock(lockPath, "exclusive", "contender-b");
  expect(existsSync(recordPath)).toBe(false);
  lock.release();
}, 30_000);

// Create-time probe used by run create.
test("the probe reports writers and readers by mode and publishes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-lock-probe-"));
  const path = join(dir, "worktree.lock");
  expect(worktreeLockBusy(path, "exclusive")).toBeNull();
  const reader = acquireWorktreeLock(path, "shared", "review-1");
  const before = readdirSync(`${path}.owners`).sort();
  expect(worktreeLockBusy(path, "shared")).toBeNull();
  const busy = worktreeLockBusy(path, "exclusive");
  expect(busy?.holderRunId).toBe("review-1");
  expect(busy?.message).toContain("worktree read lock held (1 reader)");
  expect(readdirSync(`${path}.owners`).sort()).toEqual(before);
  reader.release();
  const writer = acquireWorktreeLock(path, "exclusive", "impl-1");
  expect(worktreeLockBusy(path, "shared")?.message).toContain("worktree write lock held");
  writer.release();
  expect(worktreeLockBusy(path, "shared")).toBeNull();
});

// Codex review of PR #28 (F1): a live pre-hardening pidfile has no nonce; the
// probe must still see it in both modes, and must leave it in place.
test("the probe sees a live nonce-less legacy pidfile and does not touch it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-lock-legacy-probe-"));
  const path = join(dir, "worktree.lock");
  const holder = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    const legacy = `${JSON.stringify({ pid: holder.pid, run_id: "old-orch-impl", ts: new Date().toISOString() })}\n`;
    writeFileSync(path, legacy, "utf8");
    for (const mode of ["shared", "exclusive"] as const) {
      expect(worktreeLockBusy(path, mode)?.holderRunId).toBe("old-orch-impl");
    }
    expect(readFileSync(path, "utf8")).toBe(legacy);
    // The real acquirers agree with the probe.
    expect(() => acquireWorktreeLock(path, "shared", "review")).toThrow(LockHeldError);
  } finally {
    holder.kill("SIGKILL");
    await holder.exited;
  }
  expect(worktreeLockBusy(path, "exclusive")).toBeNull();
});
