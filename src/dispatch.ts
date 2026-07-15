import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { readJsonFile, writeJsonAtomic, writeJsonAtomicExclusive } from "./json.ts";
import { orchStateRoot, statePathSegment } from "./paths.ts";
import { randomHex } from "./hash.ts";
import { parseArgs } from "./cli.ts";
import { acquirePidfileLock, isPidAlive, LockHeldError } from "./locks.ts";
import type { RunSpec, RunStatus } from "./types.ts";
import {
  ORCH_SANDBOX_RUN_DIR_ENV,
  ORCH_SANDBOX_RUN_ID_ENV,
  SEATBELT_ENV_MARKER,
} from "../drivers/driver-common.ts";

// File-first boundary between a sandboxed controller and an unsandboxed host.
// Only dispatch/pending/<controller-run-id> is controller-writable. Claims and
// results are host-owned; every request is rebound to host-owned spec/status.

export function dispatchDir(stateRoot = orchStateRoot()): string {
  return `${stateRoot}/dispatch`;
}
function queueRoot(kind: "pending" | "claims" | "done", stateRoot?: string): string {
  return `${dispatchDir(stateRoot)}/${kind}`;
}
function controllerQueue(kind: "pending" | "claims" | "done", controllerRunId: string, stateRoot?: string): string {
  return `${queueRoot(kind, stateRoot)}/${controllerRunId}`;
}

export interface DispatchRequest {
  schema: "orch.dispatch/request/v1";
  argv: string[];
  stdin: string;
  controller_run_dir: string;
}

export interface DispatchResult {
  schema: "orch.dispatch/result/v1";
  id: string;
  state: "completed" | "rejected" | "outcome_unknown";
  exit_code: number;
  stdout: string;
  stderr: string;
}

interface ValidatedDispatchRequest {
  request: DispatchRequest;
  argv: string[];
  cwd: string;
}

interface ClaimedRequest {
  controllerRunId: string;
  id: string;
  path: string;
  raw: unknown;
}

const REQUEST_ID = /^[0-9]{10,16}-[0-9a-f]{12}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const CLAIMED_FILE = /^([0-9]{10,16}-[0-9a-f]{12})\.json\.claimed-([0-9]+)$/;
const MAX_ARGV_ITEMS = 256;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;

export function insideSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SEATBELT_ENV_MARKER]);
}

// Exact controller mutation set. Reads run locally. Host validation below is
// authoritative and additionally pins flags, referenced runs, and cwd.
export function shouldProxyToHost(positionals: string[]): boolean {
  const [first, second] = positionals;
  if (first === "run") return second === "create" || second === "cancel";
  if (first === "decision") return second === "accept" || second === "rework";
  if (first === "mailctl") return second === "reply" || second === "ack";
  return first === "fanout" || first === "cross-review" || first === "investigate";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultFromJson(raw: unknown, id: string): DispatchResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.schema !== "orch.dispatch/result/v1" ||
    value.id !== id ||
    (value.state !== "completed" && value.state !== "rejected" && value.state !== "outcome_unknown") ||
    !Number.isInteger(value.exit_code) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    return null;
  }
  return value as unknown as DispatchResult;
}

export async function proxyToHost(
  request: Pick<DispatchRequest, "argv" | "stdin">,
  opts: { timeoutMs?: number; pollMs?: number; stateRoot?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DispatchResult> {
  const env = opts.env ?? process.env;
  const controllerRunId = env[ORCH_SANDBOX_RUN_ID_ENV];
  const controllerRunDir = env[ORCH_SANDBOX_RUN_DIR_ENV];
  if (!controllerRunId || !RUN_ID.test(controllerRunId) || !controllerRunDir) {
    throw new Error("dispatch: sandbox controller context is missing or invalid");
  }
  const stateRoot = opts.stateRoot ?? orchStateRoot();
  const pending = controllerQueue("pending", controllerRunId, stateRoot);
  const done = controllerQueue("done", controllerRunId, stateRoot);
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  if (!existsSync(done)) throw new Error("dispatch: host-owned result directory is missing");
  const id = `${Date.now()}-${randomHex(6)}`;
  const payload: DispatchRequest = {
    schema: "orch.dispatch/request/v1",
    argv: request.argv,
    stdin: request.stdin,
    controller_run_dir: controllerRunDir,
  };
  writeJsonAtomicExclusive(`${pending}/${id}.json`, payload, 0o600);
  const donePath = `${done}/${id}.json`;
  const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
  while (Date.now() < deadline) {
    if (existsSync(donePath)) {
      const result = resultFromJson(readJsonFile<unknown>(donePath, null), id);
      if (result) return result;
    }
    await sleep(opts.pollMs ?? 150);
  }
  throw new Error("dispatch: no unsandboxed host reconciler fulfilled this request in time");
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function hostCommandReason(command: string[], worktree: string): string | null {
  if (command.length === 0) return "host orch command is empty";
  const executablePaths = [command[0]!, ...(command[1] && !command[1].startsWith("-") ? [command[1]] : [])];
  for (const path of executablePaths) {
    if (!isAbsolute(path)) return "host orch executable and source entrypoint must use absolute paths";
    let canonical: string;
    try {
      canonical = realpathSync(path);
    } catch {
      return `host orch executable is unavailable: ${path}`;
    }
    if (canonical === worktree || pathIsInside(worktree, canonical)) {
      return "host orch executable must live outside the controller worktree";
    }
  }
  return null;
}

function mailControllerThread(spec: RunSpec): string | null {
  const mailThread = spec.mr.startsWith("mailctl-") ? spec.mr.slice("mailctl-".length) : null;
  return mailThread && spec.tag === "mailctl" && spec.idempotency_key.startsWith(`ctrl:${mailThread}:`) ? mailThread : null;
}

function expectedThread(spec: RunSpec): string {
  return mailControllerThread(spec) ?? spec.mr;
}

function targetRunReason(stateRoot: string, spec: RunSpec, thread: string, runId: string): string | null {
  if (!RUN_ID.test(runId)) return "referenced run id is invalid";
  const runDir = `${stateRoot}/${spec.repo_key}/mrs/${statePathSegment(thread, "mr")}/runs/${runId}`;
  const target = readJsonFile<RunStatus | null>(`${runDir}/status.json`, null);
  if (!target || target.run_id !== runId || target.mr !== thread) return "referenced run is outside the controller thread";
  try {
    if (realpathSync(target.worktree) !== realpathSync(spec.worktree)) return "referenced run uses another worktree";
  } catch {
    return "referenced run worktree is unavailable";
  }
  return null;
}

function dispatchCommand(argv: string[], spec: RunSpec, stateRoot: string): string[] {
  const parsed = parseArgs(argv);
  const [first, second] = parsed.positionals;
  if (!shouldProxyToHost(parsed.positionals)) throw new Error("operation is not in the host dispatch allow-list");

  const operation = first === "run" || first === "decision" || first === "mailctl" ? `${first} ${second}` : first!;
  const expectedPositionals = operation.includes(" ") ? operation.split(" ") : [operation];
  if (parsed.positionals.length !== expectedPositionals.length || parsed.positionals.some((value, index) => value !== expectedPositionals[index])) {
    throw new Error(`unexpected positional arguments for ${operation}`);
  }
  const booleanFlags = new Set(["allow-dirty", "force", "json"]);
  const repeatableFlags = new Set(["to-agent"]);
  const flagCounts = new Map<string, number>();
  for (const arg of argv) {
    const name = arg.startsWith("--") ? arg.slice(2).split("=", 1)[0]! : arg === "-n" ? "n" : arg === "-f" ? "follow" : null;
    if (name !== null) flagCounts.set(name, (flagCounts.get(name) ?? 0) + 1);
  }
  const allowedByOperation: Record<string, readonly string[]> = {
    "run create": ["mr", "role", "agent", "tag", "model", "task", "resume-from", "allow-dirty", "timeout-sec", "json"],
    "run cancel": ["mr", "run", "reason", "force"],
    "decision accept": ["mr", "run", "reason"],
    "decision rework": ["mr", "run", "reason"],
    fanout: ["thread", "role", "to-agent", "task", "model", "timeout-sec", "allow-dirty", "json"],
    "cross-review": ["thread", "to-agent", "task", "model", "timeout-sec", "json"],
    investigate: ["thread", "to-agent", "task", "model", "timeout-sec", "json"],
    "mailctl reply": ["thread", "report-key", "body"],
    "mailctl ack": ["thread", "attention", "json"],
  };
  const allowed = new Set(allowedByOperation[operation] ?? []);
  for (const [name, value] of parsed.flags) {
    if (!allowed.has(name)) throw new Error(`--${name} is not allowed for controller ${operation}`);
    if (booleanFlags.has(name)) {
      if (value !== true) throw new Error(`--${name} must be a boolean flag`);
    } else if (typeof value !== "string" || value.length === 0) {
      throw new Error(`--${name} requires a value`);
    }
    const count = flagCounts.get(name) ?? 0;
    if (!repeatableFlags.has(name) && count > 1) throw new Error(`--${name} may be provided only once`);
  }

  const required = (name: string): string => {
    const value = parsed.flags.get(name);
    if (typeof value !== "string" || value.length === 0) throw new Error(`${operation} requires --${name}`);
    return value;
  };
  const optional = (name: string): string | null => {
    const value = parsed.flags.get(name);
    return typeof value === "string" ? value : null;
  };
  const canonical: string[] = [...expectedPositionals];
  const pushValue = (name: string, value: string | null): void => {
    // Equals form preserves values beginning with "--" as data when the host
    // process parses the reconstructed argv; split flag/value form would turn
    // such a value into a second flag.
    if (value !== null) canonical.push(`--${name}=${value}`);
  };
  const pushBoolean = (name: string): void => {
    if (parsed.flags.get(name) === true) canonical.push(`--${name}`);
  };

  const thread = expectedThread(spec);
  if (operation === "run create") {
    const resume = optional("resume-from");
    if (resume !== null) {
      const reason = targetRunReason(stateRoot, spec, thread, resume);
      if (reason) throw new Error(reason);
      pushValue("resume-from", resume);
    } else {
      const role = required("role");
      if (role !== "implementer" && role !== "reviewer" && role !== "verifier") throw new Error("run create role is not controller-dispatchable");
      if (required("mr") !== thread) throw new Error(`run create must name controller thread ${thread}`);
      pushValue("mr", thread);
      pushValue("role", role);
      pushValue("agent", optional("agent"));
    }
    if (required("task") !== "-") throw new Error("controller run create must provide its task through --task -");
    pushValue("tag", optional("tag"));
    pushValue("model", optional("model"));
    pushValue("task", "-");
    pushValue("timeout-sec", optional("timeout-sec"));
    pushBoolean("allow-dirty");
    pushBoolean("json");
    return canonical;
  }

  if (operation === "run cancel" || operation === "decision accept" || operation === "decision rework") {
    if (required("mr") !== thread) throw new Error(`${operation} must name controller thread ${thread}`);
    const runId = required("run");
    const reason = targetRunReason(stateRoot, spec, thread, runId);
    if (reason) throw new Error(reason);
    pushValue("mr", thread);
    pushValue("run", runId);
    pushValue("reason", optional("reason"));
    if (operation === "run cancel") pushBoolean("force");
    return canonical;
  }

  if (operation === "fanout" || operation === "cross-review" || operation === "investigate") {
    if (required("thread") !== thread) throw new Error(`${operation} must name controller thread ${thread}`);
    pushValue("thread", thread);
    if (operation === "fanout") {
      const role = required("role");
      if (role !== "implementer" && role !== "reviewer" && role !== "verifier") throw new Error("fanout role is not controller-dispatchable");
      pushValue("role", role);
    }
    for (const agent of parsed.flagValues.get("to-agent") ?? []) pushValue("to-agent", agent);
    if (required("task") !== "-") throw new Error(`${operation} must provide its task through --task -`);
    pushValue("task", "-");
    pushValue("model", optional("model"));
    pushValue("timeout-sec", optional("timeout-sec"));
    if (operation === "fanout") pushBoolean("allow-dirty");
    pushBoolean("json");
    return canonical;
  }

  if (operation === "mailctl reply") {
    if (!mailControllerThread(spec)) throw new Error("mailctl mutations require a host-created mail controller");
    if (required("thread") !== thread) throw new Error(`mailctl reply must name controller thread ${thread}`);
    pushValue("thread", thread);
    pushValue("report-key", required("report-key"));
    pushValue("body", required("body"));
    return canonical;
  }

  if (operation === "mailctl ack") {
    if (!mailControllerThread(spec)) throw new Error("mailctl mutations require a host-created mail controller");
    if (required("thread") !== thread) throw new Error(`mailctl ack must name controller thread ${thread}`);
    pushValue("thread", thread);
    pushValue("attention", required("attention"));
    pushBoolean("json");
    return canonical;
  }

  throw new Error("operation is not in the host dispatch allow-list");
}

function validateDispatchRequest(raw: unknown, controllerRunId: string, stateRoot: string): ValidatedDispatchRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("request must be a JSON object");
  const value = raw as Record<string, unknown>;
  if (value.schema !== "orch.dispatch/request/v1") throw new Error("request schema is invalid");
  if (Object.keys(value).some((key) => !["schema", "argv", "stdin", "controller_run_dir"].includes(key))) {
    throw new Error("request contains unknown fields");
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > MAX_ARGV_ITEMS || !value.argv.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    throw new Error("request argv must be a bounded non-empty string array");
  }
  const argv = value.argv as string[];
  if (argv.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > MAX_ARG_BYTES) throw new Error("request argv is too large");
  if (typeof value.stdin !== "string" || value.stdin.includes("\0") || Buffer.byteLength(value.stdin) > MAX_STDIN_BYTES) {
    throw new Error("request stdin must be a bounded string");
  }
  if (typeof value.controller_run_dir !== "string") throw new Error("request is missing controller run context");

  const canonicalStateRoot = realpathSync(stateRoot);
  const canonicalRunDir = realpathSync(value.controller_run_dir);
  if (!pathIsInside(canonicalStateRoot, canonicalRunDir)) throw new Error("controller run dir is outside orch state");
  const spec = readJsonFile<RunSpec | null>(`${canonicalRunDir}/spec.json`, null);
  const status = readJsonFile<RunStatus | null>(`${canonicalRunDir}/status.json`, null);
  if (!spec || spec.run_id !== controllerRunId || spec.role !== "controller" || spec.agent !== "claude" || spec.sandbox_engine !== "seatbelt-v1") {
    throw new Error("request is not bound to this sandboxed controller spec");
  }
  if (!status || status.run_id !== spec.run_id || status.role !== "controller" || status.state !== "running" || !status.pid || !isPidAlive(status.pid)) {
    throw new Error("controller run is not active");
  }
  const expectedRunDir = realpathSync(`${stateRoot}/${spec.repo_key}/mrs/${statePathSegment(spec.mr, "mr")}/runs/${controllerRunId}`);
  if (canonicalRunDir !== expectedRunDir) throw new Error("controller run dir does not match its host-owned state location");
  const cwd = realpathSync(spec.worktree);
  if (realpathSync(status.worktree) !== cwd) throw new Error("controller status worktree does not match its spec");
  return { request: value as unknown as DispatchRequest, argv: dispatchCommand(argv, spec, stateRoot), cwd };
}

function failureResult(id: string, state: "rejected" | "outcome_unknown", error: unknown): DispatchResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    schema: "orch.dispatch/result/v1",
    id,
    state,
    exit_code: state === "outcome_unknown" ? 75 : 1,
    stdout: "",
    stderr: `dispatch ${state}: ${message}\n`,
  };
}

function writeResult(stateRoot: string, controllerRunId: string, result: DispatchResult): void {
  const dir = controllerQueue("done", controllerRunId, stateRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/${result.id}.json`;
  // A prior host may have persisted the result and died before deleting its
  // claim. Preserve a valid terminal outcome. An invalid/partial file is not a
  // result and is atomically replaced, so a crash during result serialization
  // cannot strand the controller behind a permanent EEXIST.
  if (resultFromJson(readJsonFile<unknown>(path, null), result.id)) return;
  writeJsonAtomic(path, result);
}

function recoverClaims(stateRoot: string): void {
  const claimsRoot = queueRoot("claims", stateRoot);
  if (!existsSync(claimsRoot)) return;
  for (const controller of readdirSync(claimsRoot, { withFileTypes: true })) {
    if (!controller.isDirectory() || !RUN_ID.test(controller.name)) continue;
    const dir = `${claimsRoot}/${controller.name}`;
    for (const file of readdirSync(dir)) {
      const match = file.match(CLAIMED_FILE);
      if (!match?.[1] || !match[2] || isPidAlive(Number(match[2]))) continue;
      const id = match[1];
      writeResult(stateRoot, controller.name, failureResult(id, "outcome_unknown", "the previous host reconciler stopped before persisting an outcome"));
      rmSync(`${dir}/${file}`, { recursive: true, force: true });
    }
  }
}

function claimPending(stateRoot: string, controllerRunId: string, file: string): ClaimedRequest | null {
  const id = file.endsWith(".json") ? file.slice(0, -5) : "";
  const src = `${controllerQueue("pending", controllerRunId, stateRoot)}/${file}`;
  if (!REQUEST_ID.test(id)) {
    rmSync(src, { recursive: true, force: true });
    return null;
  }
  // Atomic-exclusive publication creates the complete final entry with
  // link(2), then removes its non-.json temporary name. During that tiny
  // interval nlink is 2: leave the request pending instead of claiming and
  // terminally rejecting a valid envelope. The post-claim nlink===1 check
  // below remains authoritative once publication has settled.
  try {
    const sourceStat = lstatSync(src);
    if (sourceStat.isFile() && sourceStat.nlink > 1) return null;
  } catch {
    return null;
  }
  const claims = controllerQueue("claims", controllerRunId, stateRoot);
  mkdirSync(claims, { recursive: true, mode: 0o700 });
  const claimed = `${claims}/${id}.json.claimed-${process.pid}`;
  try {
    renameSync(src, claimed);
  } catch {
    return null;
  }
  const stat = lstatSync(claimed);
  const maxEnvelopeBytes = MAX_ARG_BYTES + MAX_STDIN_BYTES + 1024 * 1024;
  const raw = stat.isFile() && stat.nlink === 1 && stat.size <= maxEnvelopeBytes
    ? readJsonFile<unknown>(claimed, null)
    : null;
  return { controllerRunId, id, path: claimed, raw };
}

export async function reconcileDispatchOnce(
  orchCommand: string[],
  opts: { stateRoot?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const stateRoot = opts.stateRoot ?? orchStateRoot();
  for (const kind of ["pending", "claims", "done"] as const) mkdirSync(queueRoot(kind, stateRoot), { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = acquirePidfileLock(`${dispatchDir(stateRoot)}/reconcile.lock`, process.pid, "dispatch-reconcile");
  } catch (error) {
    if (error instanceof LockHeldError) return 0;
    throw error;
  }
  try {
    recoverClaims(stateRoot);
    const baseEnv = opts.env ?? process.env;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) env[key] = value;
    delete env[SEATBELT_ENV_MARKER];
    delete env[ORCH_SANDBOX_RUN_ID_ENV];
    delete env[ORCH_SANDBOX_RUN_DIR_ENV];
    let handled = 0;
    for (const controller of readdirSync(queueRoot("pending", stateRoot), { withFileTypes: true })) {
      if (!controller.isDirectory() || !RUN_ID.test(controller.name)) continue;
      const dir = controllerQueue("pending", controller.name, stateRoot);
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        const claim = claimPending(stateRoot, controller.name, file);
        if (!claim) continue;
        let result: DispatchResult;
        try {
          const validated = validateDispatchRequest(claim.raw, claim.controllerRunId, stateRoot);
          const commandReason = hostCommandReason(orchCommand, validated.cwd);
          if (commandReason) throw new Error(commandReason);
          const proc = Bun.spawn([...orchCommand, ...validated.argv], {
            cwd: validated.cwd,
            stdin: Buffer.from(validated.request.stdin),
            stdout: "pipe",
            stderr: "pipe",
            env,
          });
          const [stdout, stderr, exit_code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          result = { schema: "orch.dispatch/result/v1", id: claim.id, state: "completed", exit_code, stdout, stderr };
        } catch (error) {
          result = failureResult(claim.id, "rejected", error);
        }
        writeResult(stateRoot, claim.controllerRunId, result);
        rmSync(claim.path, { recursive: true, force: true });
        handled += 1;
      }
    }
    return handled;
  } finally {
    lock.release();
  }
}

export async function reconcileDispatchWatch(
  orchCommand: string[],
  stop: () => boolean,
  opts: { stateRoot?: string; intervalMs?: number } = {},
): Promise<void> {
  while (!stop()) {
    await reconcileDispatchOnce(orchCommand, { stateRoot: opts.stateRoot });
    await sleep(opts.intervalMs ?? 200);
  }
  await reconcileDispatchOnce(orchCommand, { stateRoot: opts.stateRoot });
}
