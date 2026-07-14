import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readJsonFile, writeJsonAtomic } from "./json.ts";
import { orchStateRoot } from "./paths.ts";
import { randomHex } from "./hash.ts";
import { SEATBELT_ENV_MARKER } from "../drivers/driver-common.ts";

// Host-side dispatch boundary (docs/sandbox-design.md §4.1 controller).
//
// A sandboxed controller cannot spawn a working worker: any process it spawns
// inherits its Seatbelt (read-only posture), and macOS cannot nest
// sandbox_apply — so the worker could never obtain project-write. The fix is a
// file-first request queue: state-mutating orch subcommands issued from inside
// the sandbox are written to a narrow dispatch outbox (the controller's ONLY
// writable orch path) and executed by an unsandboxed host reconciler, whose
// spawned workers each apply a FRESH sandbox with the correct posture. This
// also keeps the controller off every run's formal artifacts (spec/status/
// result/sandbox.json), which live outside the dispatch dir.

export function dispatchDir(stateRoot = orchStateRoot()): string {
  return `${stateRoot}/dispatch`;
}
function pendingDir(stateRoot?: string): string {
  return `${dispatchDir(stateRoot)}/pending`;
}
function doneDir(stateRoot?: string): string {
  return `${dispatchDir(stateRoot)}/done`;
}

export interface DispatchRequest {
  id: string;
  argv: string[]; // orch subcommand argv, without the orch binary
  stdin: string; // captured stdin (e.g. a --task - heredoc)
  cwd: string;
}

export interface DispatchResult {
  id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

// True when this process is a descendant of a sandboxed provider (the driver
// sets the marker in the worker env). Reads run locally; only mutations proxy.
export function insideSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SEATBELT_ENV_MARKER]);
}

// Top-level orch operations that mutate host state or must spawn a host-side
// worker, and so must be proxied when issued from inside the sandbox. Pure
// reads (wait, result, status, overview, run list, help) are intentionally
// absent: they run locally under the jail. A command missing from this set that
// does try to write simply fails closed under Seatbelt — never a silent hole.
export function shouldProxyToHost(positionals: string[]): boolean {
  const [first, second] = positionals;
  if (first === "run") return second === "create" || second === "cancel" || second === "reap";
  return ["fanout", "cross-review", "investigate", "decision", "mirror", "mail"].includes(first ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sandboxed side: enqueue the request, block until the host reconciler writes
// the result, then relay its stdout/stderr/exit to the controller unchanged.
// Fails closed if no reconciler fulfills it within the timeout (default 1h,
// matching a long-running worker) rather than silently doing nothing.
export async function proxyToHost(
  request: Omit<DispatchRequest, "id">,
  opts: { timeoutMs?: number; pollMs?: number; stateRoot?: string } = {},
): Promise<DispatchResult> {
  const id = `${Date.now()}-${randomHex(6)}`;
  const stateRoot = opts.stateRoot ?? orchStateRoot();
  mkdirSync(pendingDir(stateRoot), { recursive: true, mode: 0o700 });
  mkdirSync(doneDir(stateRoot), { recursive: true, mode: 0o700 });
  const donePath = `${doneDir(stateRoot)}/${id}.json`;
  writeJsonAtomic(`${pendingDir(stateRoot)}/${id}.json`, { id, ...request } satisfies DispatchRequest);
  const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
  const pollMs = opts.pollMs ?? 150;
  while (Date.now() < deadline) {
    if (existsSync(donePath)) {
      const result = readJsonFile<DispatchResult | null>(donePath, null);
      if (result) {
        rmSync(donePath, { force: true });
        return result;
      }
    }
    await sleep(pollMs);
  }
  throw new Error(
    "dispatch: no unsandboxed host reconciler fulfilled this request in time. When config sandbox is on, run `orch dispatch reconcile --watch` from an unsandboxed process (orch new does this automatically).",
  );
}

// Host side: claim a pending request atomically so two reconcilers can't run it
// twice. A rename that loses the race (ENOENT) just means another reconciler
// took it.
function claimPending(stateRoot: string, file: string): DispatchRequest | null {
  const src = `${pendingDir(stateRoot)}/${file}`;
  const claimed = `${src}.claimed`;
  try {
    renameSync(src, claimed);
  } catch {
    return null;
  }
  const req = readJsonFile<DispatchRequest | null>(claimed, null);
  rmSync(claimed, { force: true });
  return req;
}

// Host side: execute every pending request unsandboxed (marker stripped, so the
// spawned `orch` runs locally and its workers apply fresh sandboxes) and record
// the result for the blocked caller. Returns how many it handled.
export async function reconcileDispatchOnce(
  orchCommand: string[],
  opts: { stateRoot?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const stateRoot = opts.stateRoot ?? orchStateRoot();
  const dir = pendingDir(stateRoot);
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const baseEnv = opts.env ?? process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) env[key] = value;
  delete env[SEATBELT_ENV_MARKER]; // the host runs unsandboxed: never re-proxy
  let handled = 0;
  for (const file of files) {
    const req = claimPending(stateRoot, file);
    if (!req) continue;
    const proc = Bun.spawn([...orchCommand, ...req.argv], {
      cwd: req.cwd,
      stdin: Buffer.from(req.stdin ?? ""),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, exit_code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    mkdirSync(doneDir(stateRoot), { recursive: true, mode: 0o700 });
    writeJsonAtomic(`${doneDir(stateRoot)}/${req.id}.json`, { id: req.id, exit_code, stdout, stderr } satisfies DispatchResult);
    handled += 1;
  }
  return handled;
}

// Host side: drain pending requests until `stop()` returns true. Used by
// orch new (concurrently with the controller run) and `orch dispatch reconcile
// --watch` (the standalone companion for the mailctl controller).
export async function reconcileDispatchWatch(
  orchCommand: string[],
  stop: () => boolean,
  opts: { stateRoot?: string; intervalMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 200;
  while (!stop()) {
    await reconcileDispatchOnce(orchCommand, { stateRoot: opts.stateRoot });
    await sleep(intervalMs);
  }
  await reconcileDispatchOnce(orchCommand, { stateRoot: opts.stateRoot });
}
