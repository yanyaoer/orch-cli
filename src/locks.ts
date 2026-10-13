import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomHex } from "./hash.ts";

export class LockHeldError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holderPid: number | null,
    public readonly holderRunId: string | null = null,
    detail = "lock held",
  ) {
    super(
      `${detail}: ${lockPath}${holderPid ? ` by pid ${holderPid}` : ""}${holderRunId ? ` run_id ${holderRunId}` : ""}`,
    );
  }
}

export interface PidfileLock {
  path: string;
  pid: number;
  // Extend the holder to a child process group (the provider): the record
  // stays live while either the owner pid or any member of that group lives.
  adoptProcessGroup(pgid: number): void;
  release(): void;
}

interface OwnerRecord {
  pid: number | null;
  run_id: string | null;
  ts: string | null;
  nonce: string | null;
  mode?: LockMode;
  pgid?: number | null;
}

// Cross-process lock built only from per-owner records, so no process ever
// deletes or renames a path another live owner depends on:
//
//   <path>.owners/<mode>-<nonce>.json   one file per holder, unique name
//
// Acquire = announce (atomically publish my own record) then check (list the
// others). Of any two contenders that overlap, the later checker always sees
// the earlier announcement, so they can never both proceed — at worst both
// back off and retry. A dead holder's record is simply ignored, and may be
// unlinked by anyone: its name is unique to that dead owner, so removing it
// can never touch a live owner. Release unlinks only my own unique name.
//
// Pre-hardening orch (<= 0.0.13) used a single O_EXCL pidfile at <path>. An
// exclusive holder also publishes that pidfile, so old writers see it and
// back off, and a live old holder blocks new contenders. Boundaries: a stale
// legacy pidfile left by a crash is ignored here but never deleted (deleting
// it is exactly the steal race the owner records avoid), and while it sits
// there old writers will "break" it with their own racy logic; old writers
// never look at new shared holders; old reviewers took no lock at all. PID
// reuse after a crash can make a dead record look alive (it then blocks; it
// never lets two owners in).
//
// A worktree holder is a supervisor plus the detached provider process group
// it spawns; killing only the supervisor leaves the provider running in the
// checkout. The supervisor therefore adopts that group into its record
// (`pgid`) before letting the driver proceed, and the record counts as live
// while the group has any member.
export type LockMode = "shared" | "exclusive";
export type WorktreeLockMode = LockMode;

// A record we cannot parse is normally a crashed pre-hardening writer (they
// created the file empty and wrote it afterwards); treat it as held until it
// is old enough that no live writer can still be mid-write.
const UNPARSABLE_STALE_MS = 10_000;

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function isPidAlive(pid: number): boolean {
  return processExists(pid);
}

// Host-observed identity of a live process: its start time and command line
// as `ps` reports them, or null when the process is gone or ps fails. A pid
// number alone can be reused; pid + start time + command cannot plausibly be.
export function processIdentity(pid: number): { started: string; command: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const ps = (field: string): string | null => {
    try {
      const proc = Bun.spawnSync(["ps", "-ww", "-o", `${field}=`, "-p", String(pid)], { stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" } });
      const out = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
      return out || null;
    } catch {
      return null;
    }
  };
  const started = ps("lstart");
  const command = started ? ps("command") : null;
  return started && command ? { started, command } : null;
}

export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(path: string): OwnerRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnerRecord>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      run_id: typeof parsed.run_id === "string" ? parsed.run_id : null,
      ts: typeof parsed.ts === "string" ? parsed.ts : null,
      nonce: typeof parsed.nonce === "string" ? parsed.nonce : null,
      mode: parsed.mode === "shared" || parsed.mode === "exclusive" ? parsed.mode : undefined,
      pgid: typeof parsed.pgid === "number" ? parsed.pgid : null,
    };
  } catch {
    return null;
  }
}

function isLive(path: string, record: OwnerRecord | null): boolean {
  if (record && typeof record.pgid === "number" && isProcessGroupAlive(record.pgid)) return true;
  if (record && record.pid !== null) return processExists(record.pid);
  try {
    return Date.now() - statSync(path).mtimeMs <= UNPARSABLE_STALE_MS;
  } catch {
    return false;
  }
}

function ownersDir(path: string): string {
  return `${path}.owners`;
}

// Publish `record` at `dest` complete or not at all: write a private temp
// file, then rename it onto a name nobody else uses.
function publish(dest: string, record: OwnerRecord): void {
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, dest);
}

interface Holder {
  mode: LockMode;
  record: OwnerRecord | null;
}

// Live holders other than `self`; dead owner records are removed on sight.
function liveHolders(path: string, self: string | null): Holder[] {
  const dir = ownersDir(path);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const holders: Holder[] = [];
  for (const name of names) {
    const match = /^(shared|exclusive)-[0-9a-f]+\.json$/.exec(name);
    if (!match || name === self) continue;
    const entry = `${dir}/${name}`;
    const record = readRecord(entry);
    lockTestHooks.afterRead?.(entry);
    if (isLive(entry, record)) {
      holders.push({ mode: match[1] as LockMode, record });
      continue;
    }
    // The record read above may predate its owner adopting a provider group.
    // Only the owner itself adopts, and it is now confirmed dead, so a re-read
    // after that confirmation is final: nothing can update the record later.
    const current = readRecord(entry);
    if (current && isLive(entry, current)) holders.push({ mode: match[1] as LockMode, record: current });
    else rmSync(entry, { force: true });
  }
  // A live pre-hardening pidfile is an exclusive holder; never deleted here.
  const legacy = readRecord(path);
  let legacyExists = legacy !== null;
  if (!legacyExists) {
    try {
      statSync(path);
      legacyExists = true;
    } catch {
      // No legacy pidfile.
    }
  }
  if (legacyExists && legacy?.nonce !== nonceOf(self) && isLive(path, legacy)) holders.push({ mode: "exclusive", record: legacy });
  return holders;
}

function nonceOf(name: string | null): string | null {
  return name ? name.replace(/^(shared|exclusive)-/, "").replace(/\.json$/, "") : null;
}

// Test seam for deterministic interleavings: called after this contender's
// record is published and before it looks at the others.
// afterRead: called after a contender read another holder's record and before
// it judges that record's liveness.
export const lockTestHooks: { afterAnnounce?: (path: string, mode: LockMode) => void; afterRead?: (entry: string) => void } = {};

export function acquireLock(path: string, mode: LockMode, runId?: string, pid = process.pid): PidfileLock {
  const dir = ownersDir(path);
  mkdirSync(dir, { recursive: true });
  const nonce = randomHex(8);
  const record: OwnerRecord = { pid, run_id: runId ?? null, ts: new Date().toISOString(), nonce, mode };
  const name = `${mode}-${nonce}.json`;
  const own = `${dir}/${name}`;
  publish(own, record);
  // Exclusive holders also announce themselves to pre-hardening orch via the
  // legacy pidfile (atomic create-if-absent). An existing file is left alone:
  // live -> the check below backs off; dead -> ignored, never deleted.
  let legacyMarker = false;
  if (mode === "exclusive") {
    const tmp = `${dir}/legacy-${nonce}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      linkSync(tmp, path);
      legacyMarker = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        rmSync(own, { force: true });
        throw error;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  lockTestHooks.afterAnnounce?.(path, mode);

  const releaseOwn = (): void => {
    rmSync(own, { force: true });
    // Nobody else deletes a live parseable legacy record, so if it still
    // carries my nonce it is still mine.
    if (legacyMarker && readRecord(path)?.nonce === nonce) rmSync(path, { force: true });
  };
  const conflicts = liveHolders(path, name).filter((holder) => mode === "exclusive" || holder.mode === "exclusive");
  if (conflicts.length > 0) {
    releaseOwn();
    const first = conflicts[0]!;
    const detail =
      first.mode === "exclusive" ? (mode === "shared" ? "worktree write lock held" : "lock held") : `worktree read lock held (${conflicts.length} reader${conflicts.length > 1 ? "s" : ""})`;
    throw new LockHeldError(path, first.record?.pid ?? null, first.record?.run_id ?? null, detail);
  }
  let released = false;
  return {
    path: own,
    pid,
    adoptProcessGroup(pgid: number) {
      if (released) return;
      // Contenders rely on "a dead owner never updates its record" (see
      // liveHolders), so only the recorded pid may adopt.
      if (pid !== process.pid) throw new Error(`lock owner pid ${pid} is not this process; cannot adopt a process group`);
      publish(own, { ...record, pgid });
    },
    release() {
      if (released) return;
      released = true;
      releaseOwn();
    },
  };
}

export function acquirePidfileLock(path: string, pid = process.pid, runId?: string): PidfileLock {
  mkdirSync(dirname(path), { recursive: true });
  return acquireLock(path, "exclusive", runId, pid);
}

// Bounded-wait variant for locks that guard short critical sections (mr lock,
// mail route/fanout locks): a live contender is expected to release within
// milliseconds, so waiting briefly beats failing the whole command. The
// jitter breaks the symmetric case where two contenders keep backing off.
export async function acquirePidfileLockWait(
  path: string,
  waitMs: number,
  pid = process.pid,
  runId?: string,
): Promise<PidfileLock> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return acquirePidfileLock(path, pid, runId);
    } catch (error) {
      if (!(error instanceof LockHeldError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));
    }
  }
}

// Worktree reader/writer lock: reviewers share, implementer/verifier exclude.
export function acquireWorktreeLock(path: string, mode: WorktreeLockMode, runId?: string, pid = process.pid): PidfileLock {
  mkdirSync(dirname(path), { recursive: true });
  return acquireLock(path, mode, runId, pid);
}
