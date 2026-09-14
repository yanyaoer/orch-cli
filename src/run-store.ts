// Run-state readers and outbox/forge-ref helpers shared by every command: locating runs, listing an MR's runs, idempotency records, decision and result readers.
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import type { RoleResult, RunSpec, RunState, RunStatus } from "./types.ts";
import { isPidAlive } from "./locks.ts";
import { randomHex } from "./hash.ts";
import { mrStateDir, orchStateRoot } from "./paths.ts";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "./json.ts";
import { findPrivateLeak, privateLeakAllowed, privateLeakErrorMessage } from "./leak.ts";
import { vcsBranch } from "./vcs.ts";
import { CliError, flagString, type ParsedArgs } from "./cli.ts";

export type IdempotencyRecord = {
  run_id: string;
  run_dir: string;
  status_path: string;
  result_path: string;
  created_at: string;
  previous?: IdempotencyRecord[];
};

type RunListRow = Pick<RunStatus, "run_id" | "mr" | "role" | "agent" | "tag" | "state" | "started_at" | "exit_code"> & {
  stale: boolean;
};

type LocatedRun = {
  mr: string;
  run_id: string;
  run_dir: string;
};

export type RunLocation = {
  mr: string;
  run_id: string;
  run_dir: string;
  status: RunStatus | null;
};

// close = "stop tracking this run" — an ack that queues no mirror comment.
// It exists so historical or abandoned runs can leave the overview without
// pretending they were reviewed (accept) or need work (rework).
export type DecisionVerdict = "accept" | "rework" | "close";

export interface DecisionRecord {
  verdict: DecisionVerdict;
  run_id: string;
  reason: string | null;
  ts: string;
}

interface OutboxCommentPayload {
  kind: "comment";
  mr: string;
  body: string;
  created_at: string;
}

export function assertMirrorBodySafe(body: string): void {
  if (privateLeakAllowed()) return;
  const finding = findPrivateLeak(body);
  if (finding) throw new CliError(privateLeakErrorMessage(finding));
}

export function stateDirectoryHint(path: string, error: unknown): CliError {
  const detail = error instanceof Error ? error.message : String(error);
  return new CliError(
    [
      `cannot create orch state directory: ${path}`,
      detail,
      "",
      "orch stores runs under ${XDG_STATE_HOME:-$HOME/.local/state}/orch by default.",
      "If you are running inside a restricted sandbox, either grant write access to that state directory or run with a writable state home, for example:",
      "  XDG_STATE_HOME=/tmp/orch-state orch run create ...",
    ].join("\n"),
  );
}

export function utcCompact(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

export function runId(tag: string): string {
  return `${tag}-${utcCompact()}-${randomHex(3)}`;
}

function mrFromForgeUrl(text: string): string | null {
  return text.match(/\/-\/merge_requests\/(\d+)/)?.[1] ?? text.match(/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/)?.[1] ?? null;
}

// Resolution sources for an omitted --mr, strongest first: an explicit
// "MR: <id-or-url>" line in the task's leading header block (before the first
// blank line, alongside Role:/Goal:), then any GitLab merge-request / GitHub
// pull URL in the task text. Quoted prose later in the task cannot hijack the
// header form.
function mrFromTask(taskText: string): string | null {
  const headBlock = taskText.split(/\r?\n\s*\r?\n/, 1)[0] ?? "";
  const header = headBlock.match(/^\s*MR\s*:\s*(\S+)\s*$/im)?.[1];
  if (header) return mrFromForgeUrl(header) ?? header;
  return mrFromForgeUrl(taskText);
}

type MrSource = "flag" | "task" | "branch" | "resume-from";

export async function resolveMr(args: ParsedArgs, taskText: string, worktree: string): Promise<{ mr: string; source: MrSource }> {
  if (args.flags.has("mr")) return { mr: flagString(args, "mr"), source: "flag" };
  const fromTask = mrFromTask(taskText);
  if (fromTask) return { mr: fromTask, source: "task" };
  const branch = await vcsBranch(worktree);
  if (branch) return { mr: branch, source: "branch" };
  throw new CliError(
    "--mr is required: no MR/PR reference found in the task text and the worktree is not on a branch or jj bookmark (detached HEAD or not a git/jj repo)",
  );
}

export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function pendingOutboxDir(mrDir: string): string {
  return `${mrDir}/outbox/pending`;
}

export function sentOutboxDir(mrDir: string): string {
  return `${mrDir}/outbox/sent`;
}

export function invalidOutboxDir(mrDir: string): string {
  return `${mrDir}/outbox/invalid`;
}

export function pendingOutboxFiles(mrDir: string): string[] {
  const pendingDir = pendingOutboxDir(mrDir);
  if (!existsSync(pendingDir)) return [];
  return readdirSync(pendingDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

// The orch mr id is a local thread name (an `orch new` slug like
// new-<slug>-<hex> is never a valid gh/glab ref); when the originating task
// named a real MR/PR URL, its number is recorded here and wins as the forge
// ref for every mirrored comment.
function forgeRefPath(mrDir: string): string {
  return `${mrDir}/forge_ref`;
}

function readForgeRef(mrDir: string): string | null {
  const ref = readTextFile(forgeRefPath(mrDir))?.trim();
  return ref ? ref : null;
}

export function writeForgeRef(mrDir: string, ref: string): void {
  writeTextAtomic(forgeRefPath(mrDir), `${ref}\n`);
}

export function forgeRefFor(mrDir: string, mr: string): string {
  return readForgeRef(mrDir) ?? mr;
}

export function enqueueComment(mrDir: string, payload: OutboxCommentPayload): string {
  assertMirrorBodySafe(payload.body);
  const filename = `${utcCompact()}-${randomHex(4)}.json`;
  const path = `${pendingOutboxDir(mrDir)}/${filename}`;
  writeJsonAtomic(path, { ...payload, mr: forgeRefFor(mrDir, payload.mr) });
  return path;
}

export const nonTerminalStates = new Set<RunState>(["created", "starting", "running"]);

// The one stale rule (read-side, never writes; `orch run reap` persists it):
// a non-terminal run whose recorded pid is gone, or that never got a pid and
// has not moved in an hour (orphaned before spawn).
export function looksStale(status: RunStatus): boolean {
  if (!nonTerminalStates.has(status.state)) return false;
  if (status.pid !== null) return !isPidAlive(status.pid);
  const ageMs = Date.now() - Date.parse(status.updated_at ?? "");
  return Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000;
}

// Everything a run directory says about itself, read once. Every command that
// walks runs/ (overview, status, list, reap, sweep, fanout --auto, --rework,
// events tail, trajectory, orch new) projects from this record instead of
// re-reading its own subset of the files.
export interface RunRecord {
  mr: string;
  run_id: string;
  run_dir: string;
  spec: RunSpec | null;
  status: RunStatus | null;
  result: RoleResult | null;
  decision: DecisionRecord | null;
  stale: boolean;
}

// Sorted by started_at then run_id; a directory without status.json is a run
// mid-creation and is returned with status null so callers can decide.
export function scanRunsRoot(runsRoot: string, mr: string): RunRecord[] {
  return safeDirEntries(runsRoot)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runDir = `${runsRoot}/${entry.name}`;
      const status = readJsonFile<RunStatus | null>(`${runDir}/status.json`, null);
      return {
        mr: status?.mr ?? mr,
        run_id: status?.run_id ?? entry.name,
        run_dir: runDir,
        spec: readJsonFile<RunSpec | null>(`${runDir}/spec.json`, null),
        status,
        result: readJsonFile<RoleResult | null>(`${runDir}/result.json`, null),
        decision: readJsonFile<DecisionRecord | null>(`${runDir}/decision.json`, null),
        stale: status ? looksStale(status) : false,
      };
    })
    .sort((a, b) => (a.status?.started_at ?? "").localeCompare(b.status?.started_at ?? "") || a.run_id.localeCompare(b.run_id));
}

export function scanMrRuns(repoKey: string, mr: string): RunRecord[] {
  return scanRunsRoot(`${mrStateDir(repoKey, mr)}/runs`, mr);
}

export function runListRows(runsRoot: string): RunListRow[] {
  return scanRunsRoot(runsRoot, "")
    .filter((record): record is RunRecord & { status: RunStatus } => record.status !== null)
    .map(({ status, stale }) => ({
      run_id: status.run_id,
      mr: status.mr,
      role: status.role,
      agent: status.agent,
      tag: status.tag,
      state: status.state,
      started_at: status.started_at,
      exit_code: status.exit_code,
      stale,
    }));
}

export function mrIdsForRepo(repoKey: string): string[] {
  const root = repoMrsRoot(repoKey);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function formatTable(rows: RunListRow[]): string {
  const headers = ["run_id", "mr", "role", "agent", "tag", "state", "started_at", "exit_code"];
  const body = rows.map((row) => [
    row.run_id,
    row.mr,
    row.role,
    row.agent,
    row.tag,
    row.stale ? `${row.state} (stale?)` : row.state,
    row.started_at ?? "-",
    row.exit_code === null ? "-" : String(row.exit_code),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => row[index]!.length)),
  );
  const render = (columns: string[]) => columns.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  return `${render(headers)}\n${body.map(render).join("\n")}${body.length ? "\n" : ""}`;
}

function repoMrsRoot(repoKey: string): string {
  return `${orchStateRoot()}/${repoKey}/mrs`;
}

export function locateRun(repoKey: string, runId: string, mr?: string): LocatedRun {
  if (mr) {
    const runDir = `${mrStateDir(repoKey, mr)}/runs/${runId}`;
    if (!existsSync(runDir)) throw new CliError(`run not found: ${runId} under MR ${mr}`);
    return { mr, run_id: runId, run_dir: runDir };
  }

  const mrsRoot = repoMrsRoot(repoKey);
  if (!existsSync(mrsRoot)) throw new CliError(`no local MR state found for repo_key: ${repoKey}`);
  const matches = readdirSync(mrsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      mr: entry.name,
      run_id: runId,
      run_dir: `${mrsRoot}/${entry.name}/runs/${runId}`,
    }))
    .filter((candidate) => existsSync(candidate.run_dir));

  if (matches.length === 0) throw new CliError(`run not found: ${runId} under repo_key ${repoKey}`);
  if (matches.length > 1) {
    const mrs = matches.map((match) => match.mr).join(", ");
    throw new CliError(`run id ${runId} exists under multiple MRs (${mrs}); pass --mr to disambiguate`);
  }
  const located = matches[0]!;
  // Directory names are sanitized (feature/foo → feature_foo); the run's own
  // status records the raw mr value, which is what downstream consumers
  // (decision bodies, outbox payloads) must carry.
  const recorded = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null)?.mr;
  return recorded ? { ...located, mr: recorded } : located;
}

export function safeDirEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function runLocation(repoKey: string, runId: string, mr?: string): RunLocation {
  const located = locateRun(repoKey, runId, mr);
  const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
  return {
    mr: status?.mr ?? located.mr,
    run_id: status?.run_id ?? located.run_id,
    run_dir: located.run_dir,
    status,
  };
}

export function runLocationsForMr(repoKey: string, mr: string): RunLocation[] {
  return scanMrRuns(repoKey, mr).map(({ mr: recordMr, run_id, run_dir, status }) => ({ mr: recordMr, run_id, run_dir, status }));
}

export function runLocationsForRepo(repoKey: string): RunLocation[] {
  return mrIdsForRepo(repoKey).flatMap((mr) => runLocationsForMr(repoKey, mr));
}

export function scopedRunLocations(repoKey: string, args: ParsedArgs): RunLocation[] {
  if (args.flags.has("run")) return [runLocation(repoKey, flagString(args, "run"), args.flags.has("mr") ? flagString(args, "mr") : undefined)];
  if (args.flags.has("mr")) return runLocationsForMr(repoKey, flagString(args, "mr"));
  return runLocationsForRepo(repoKey);
}

export function orchCommand(): string[] {
  const scriptPath = process.argv[1];
  if (scriptPath?.endsWith(".ts")) return [process.execPath, scriptPath];
  return [process.execPath];
}

export function readIdempotency(path: string): Record<string, IdempotencyRecord> {
  return readJsonFile<Record<string, IdempotencyRecord>>(path, {});
}

export function archivedIdempotency(record: IdempotencyRecord): IdempotencyRecord {
  const { previous: _previous, ...archived } = record;
  return archived;
}

export function statusState(record: IdempotencyRecord): RunState | null {
  const status = readJsonFile<RunStatus | null>(record.status_path, null);
  return status?.state ?? null;
}

export function latestRunId(runsRoot: string): string | null {
  const latest = scanRunsRoot(runsRoot, "")
    .map((record) => ({ id: record.run_dir.slice(record.run_dir.lastIndexOf("/") + 1), updated_at: record.status?.updated_at ?? "" }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))[0];
  return latest?.id ?? null;
}

export function readMirrorResult(runsRoot: string, runId: string): { result: RoleResult; status: RunStatus | null } {
  const runDir = `${runsRoot}/${runId}`;
  if (!existsSync(runDir)) throw new CliError(`run not found: ${runId}`);
  const result = readJsonFile<RoleResult | null>(`${runDir}/result.json`, null);
  if (!result) throw new CliError(`result.json not found for run: ${runId}`);
  const status = readJsonFile<RunStatus | null>(`${runDir}/status.json`, null);
  return { result, status };
}

export function readOutboxComment(path: string): OutboxCommentPayload | null {
  const payload = readJsonFile<Partial<OutboxCommentPayload> | null>(path, null);
  if (
    payload?.kind === "comment" &&
    typeof payload.mr === "string" &&
    typeof payload.body === "string" &&
    typeof payload.created_at === "string"
  ) {
    return payload as OutboxCommentPayload;
  }
  return null;
}
