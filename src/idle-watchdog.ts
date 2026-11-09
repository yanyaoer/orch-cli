// Run idle watchdog. A worker that has finished its work but never exits (a
// session waiting on nothing, a provider that did not shut down) used to sit
// until the total timeout; 2026-11-04..09 timeout runs spent 82% of their
// time after their last test command. The watchdog ends such a run after
// ORCH_IDLE_TIMEOUT_MIN (default 90 = p99 of the "after the last test"
// tail of completed runs) without activity.
//
// "No activity" needs every signal to agree, because a verifier routinely
// waits 1-2 hours on a background full test suite with no orch or native
// event at all:
//   a. events.jsonl (minus the supervisor's own heartbeats), native.jsonl and
//      the driver's stdout/stderr logs have not grown for N minutes;
//   b. no process below the agent is still running (a test runner, make,
//      ssh to a test host, ...) — found by walking the process tree from the
//      driver pid, because providers start tool commands in sessions and
//      process groups of their own;
//   c. nothing under the run's evidence dir was written for N minutes.
// Any one of them saying "still working" keeps the run alive; a process
// table that cannot be read counts as working (fail safe).

import { existsSync, lstatSync, readdirSync, readSync, openSync, closeSync, statSync } from "node:fs";
import { basename } from "node:path";

export const IDLE_TIMEOUT_MIN_DEFAULT = 90;

// Minutes without activity before the watchdog ends a run; 0 turns it off.
// Fractions are accepted (tests). Unset/blank/invalid falls back to the
// default, like the other ORCH_* numeric knobs.
export function idleTimeoutMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCH_IDLE_TIMEOUT_MIN;
  if (raw === undefined || raw.trim() === "") return IDLE_TIMEOUT_MIN_DEFAULT;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : IDLE_TIMEOUT_MIN_DEFAULT;
}

// How often the supervisor asks: once a minute, sooner for tiny test values.
export function idleCheckIntervalMs(idleMs: number): number {
  return Math.max(50, Math.min(60_000, Math.floor(idleMs / 4)));
}

// Long-lived helpers a provider keeps for its whole session; they are not
// work. Matched on the basename of argv[0]; the helper's whole subtree is
// skipped. Any basename containing "mcp" (an MCP server binary) is a helper
// too. ORCH_IDLE_IGNORE_PROCS adds comma-separated basenames.
export const DEFAULT_IGNORED_PROCS = ["node_repl", "codex-code-mode-host", "caffeinate"];

// Provider executables a driver may sit behind (a wrapper, sandbox-exec):
// part of the agent itself when their parent already is.
const AGENT_BINARIES = new Set(["claude", "codex", "pi", "agy", "omp", "sandbox-exec"]);

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);

export function ignoredProcNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.ORCH_IDLE_IGNORE_PROCS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return [...DEFAULT_IGNORED_PROCS, ...extra];
}

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  stat: string;
  args: string;
}

// `ps -A -o pid=,ppid=,pgid=,stat=,args=` (macOS and procps agree on it).
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), stat: match[4]!, args: match[5]!.trim() });
  }
  return rows;
}

function argv0Name(args: string): string {
  const first = args.split(/\s+/)[0] ?? "";
  return basename(first).replace(/^-/, "");
}

export interface ProcessVerdict {
  // Processes that count as work; any one keeps the run alive.
  busy: Array<{ pid: number; args: string }>;
  // Helper subtrees skipped (named, so the snapshot shows what was ignored).
  ignored: Array<{ pid: number; name: string }>;
  // Processes treated as the agent itself (driver, provider, wrappers).
  agent: number[];
}

function isIgnoredHelper(name: string, ignore: readonly string[]): boolean {
  if (SHELLS.has(name)) return false;
  return ignore.includes(name) || /mcp/i.test(name);
}

// Classify everything below the driver. The driver and its direct children
// (the provider, or a wrapper in front of it) are the agent; a provider
// binary whose parent is agent is agent too. Every other live descendant is
// work unless it roots a known helper subtree. Members of the driver's
// process group outside the tree (reparented orphans) are work as well.
export function classifyProcesses(rows: readonly ProcRow[], driverPid: number, ignore: readonly string[]): ProcessVerdict {
  const children = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const verdict: ProcessVerdict = { busy: [], ignored: [], agent: [] };
  const seen = new Set<number>();
  const driver = rows.find((row) => row.pid === driverPid);
  if (!driver) return verdict;
  verdict.agent.push(driverPid);
  seen.add(driverPid);

  const walk = (row: ProcRow, parentIsAgent: boolean, depthFromDriver: number): void => {
    if (seen.has(row.pid)) return;
    seen.add(row.pid);
    if (row.stat.startsWith("Z")) return;
    const name = argv0Name(row.args);
    let isAgent = false;
    if (parentIsAgent && (depthFromDriver === 1 || AGENT_BINARIES.has(name))) {
      isAgent = true;
      verdict.agent.push(row.pid);
    } else if (parentIsAgent && isIgnoredHelper(name, ignore)) {
      verdict.ignored.push({ pid: row.pid, name });
      markSubtree(row.pid);
      return;
    } else {
      verdict.busy.push({ pid: row.pid, args: row.args.slice(0, 160) });
    }
    for (const child of children.get(row.pid) ?? []) walk(child, isAgent, depthFromDriver + 1);
  };
  const markSubtree = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      markSubtree(child.pid);
    }
  };
  for (const child of children.get(driverPid) ?? []) walk(child, true, 1);

  for (const row of rows) {
    if (row.pgid === driver.pgid && !seen.has(row.pid) && !row.stat.startsWith("Z")) {
      seen.add(row.pid);
      verdict.busy.push({ pid: row.pid, args: row.args.slice(0, 160) });
    }
  }
  return verdict;
}

// Returns ps output, or null when the table cannot be read.
export type PsRunner = () => Promise<string | null>;

export const defaultPsRunner: PsRunner = async () => {
  try {
    const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat=,args="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return code === 0 ? text : null;
  } catch {
    return null;
  }
};

// Driver progress files: native.jsonl is every driver's provider stream (the
// claude TUI driver translates its transcript into it), stdout/stderr.log are
// the driver's own output.
export const NATIVE_ACTIVITY_FILES = ["native.jsonl", "stdout.log", "stderr.log"];

// Supervisor-written events that are not activity of the worker.
const PASSIVE_EVENT_TYPES = new Set(["heartbeat", "idle_watchdog"]);

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// Newest mtime under dir (files and dirs, symlinks not followed), bounded so a
// huge evidence tree cannot stall the supervisor; past the bound the newest
// seen so far stands.
export function newestMtimeUnder(dir: string, maxEntries = 20_000): number | null {
  if (!existsSync(dir)) return null;
  let newest: number | null = null;
  let visited = 0;
  const stack = [dir];
  while (stack.length > 0 && visited < maxEntries) {
    const current = stack.pop()!;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    visited += 1;
    if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
    if (!stat.isDirectory()) continue;
    try {
      for (const entry of readdirSync(current)) stack.push(`${current}/${entry}`);
    } catch {
      // unreadable dir: its own mtime still counts
    }
  }
  return newest;
}

export interface IdleSnapshot {
  idle_timeout_min: number;
  checked_at: string;
  last_activity_at: string;
  last_activity_source: string;
  idle_for_sec: number;
  events_last_at: string | null;
  native_last_at: string | null;
  evidence_last_at: string | null;
  processes:
    | { checked: true; busy: ProcessVerdict["busy"]; ignored: ProcessVerdict["ignored"]; agent: number[] }
    | { checked: false; error: string };
  result_json_present: boolean;
}

export interface IdleCheck {
  idle: boolean;
  snapshot: IdleSnapshot;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export interface IdleWatchdogOptions {
  runDir: string;
  driverPid: number;
  idleMs: number;
  startedAtMs: number;
  ps?: PsRunner;
  now?: () => number;
  ignore?: readonly string[];
}

export class IdleWatchdog {
  private eventsOffset = 0;
  private eventsLastMs: number | null = null;
  private readonly ps: PsRunner;
  private readonly now: () => number;
  private readonly ignore: readonly string[];

  constructor(private readonly opts: IdleWatchdogOptions) {
    this.ps = opts.ps ?? defaultPsRunner;
    this.now = opts.now ?? Date.now;
    this.ignore = opts.ignore ?? ignoredProcNames();
  }

  // Reads the events appended since the last call; a worker event (anything
  // but heartbeats and the watchdog's own) moves the activity clock to its ts.
  private scanEvents(): void {
    const path = `${this.opts.runDir}/events.jsonl`;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    try {
      const size = statSync(path).size;
      if (size < this.eventsOffset) this.eventsOffset = 0;
      if (size === this.eventsOffset) return;
      const buffer = Buffer.alloc(size - this.eventsOffset);
      readSync(fd, buffer, 0, buffer.length, this.eventsOffset);
      const text = buffer.toString("utf8");
      const complete = text.lastIndexOf("\n");
      if (complete < 0) return;
      this.eventsOffset += Buffer.byteLength(text.slice(0, complete + 1), "utf8");
      for (const line of text.slice(0, complete).split("\n")) {
        if (!line.trim()) continue;
        let event: { type?: unknown; ts?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof event.type === "string" && PASSIVE_EVENT_TYPES.has(event.type)) continue;
        const ts = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;
        const at = Number.isFinite(ts) ? ts : this.now();
        if (this.eventsLastMs === null || at > this.eventsLastMs) this.eventsLastMs = at;
      }
    } finally {
      closeSync(fd);
    }
  }

  async check(): Promise<IdleCheck> {
    const nowMs = this.now();
    const runDir = this.opts.runDir;
    this.scanEvents();
    let nativeLast: number | null = null;
    let nativeSource = "";
    for (const name of NATIVE_ACTIVITY_FILES) {
      const ms = mtimeMs(`${runDir}/${name}`);
      if (ms !== null && (nativeLast === null || ms > nativeLast)) {
        nativeLast = ms;
        nativeSource = name;
      }
    }
    const evidenceLast = newestMtimeUnder(`${runDir}/evidence`);
    const candidates: Array<[string, number | null]> = [
      ["start", this.opts.startedAtMs],
      ["events.jsonl", this.eventsLastMs],
      [nativeSource || "native.jsonl", nativeLast],
      ["evidence", evidenceLast],
    ];
    let lastMs = this.opts.startedAtMs;
    let lastSource = "start";
    for (const [source, ms] of candidates) {
      if (ms !== null && ms > lastMs) {
        lastMs = ms;
        lastSource = source;
      }
    }
    const filesIdle = nowMs - lastMs >= this.opts.idleMs;
    // The process table is read only once the files are quiet: it is the
    // costlier probe, and it can only veto.
    let processes: IdleSnapshot["processes"] = { checked: false, error: "not checked: recent activity" };
    if (filesIdle) {
      const text = await this.ps();
      if (text === null) processes = { checked: false, error: "ps failed" };
      else {
        const verdict = classifyProcesses(parsePs(text), this.opts.driverPid, this.ignore);
        processes =
          verdict.agent.length === 0
            ? { checked: false, error: `driver pid ${this.opts.driverPid} not in process table` }
            : { checked: true, ...verdict };
      }
    }
    const idle = filesIdle && processes.checked && processes.busy.length === 0;
    return {
      idle,
      snapshot: {
        idle_timeout_min: this.opts.idleMs / 60_000,
        checked_at: new Date(nowMs).toISOString(),
        last_activity_at: new Date(lastMs).toISOString(),
        last_activity_source: lastSource,
        idle_for_sec: Math.max(0, Math.floor((nowMs - lastMs) / 1000)),
        events_last_at: iso(this.eventsLastMs),
        native_last_at: iso(nativeLast),
        evidence_last_at: iso(evidenceLast),
        processes,
        result_json_present: existsSync(`${runDir}/result.json`),
      },
    };
  }
}
