#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import type { AgentName, ImplementerResult, RoleResult, RunRole, RunSpec, RunState, RunStatus } from "./types.ts";
import { isResultRole } from "./types.ts";
import { acquirePidfileLock } from "./locks.ts";
import { randomHex, sha256 } from "./hash.ts";
import { ensureStateLayout, getRepoIdentity, lockPathForWorktree, mrStateDir, orchStateRoot } from "./paths.ts";
import { readJsonFile, writeJsonAtomic } from "./json.ts";
import { argvForDisplay, createForgeAdapter, detectForge } from "./forge.ts";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
import {
  HELP_TOPICS,
  eventsTailHelp,
  mirrorHelp,
  resultCommandHelp,
  runCreateHelp,
  runHelp,
  runListHelp,
  statusHelp,
  topicHelp,
  topLevelHelp,
  unknownTopicHelp,
  type HelpTopic,
} from "./help.ts";
import { runCodexDriver } from "../drivers/codex-headless.ts";
import { runClaudeDriver } from "../drivers/claude-headless.ts";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

type IdempotencyRecord = {
  run_id: string;
  run_dir: string;
  status_path: string;
  result_path: string;
  created_at: string;
};

type RunListRow = Pick<RunStatus, "run_id" | "role" | "agent" | "tag" | "state" | "started_at" | "exit_code">;

type LocatedRun = {
  mr: string;
  run_id: string;
  run_dir: string;
};

class CliError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-n") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        flags.set("n", true);
      } else {
        flags.set("n", next);
        i += 1;
      }
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i += 1;
    }
  }
  return { positionals, flags };
}

function flagString(args: ParsedArgs, name: string, fallback?: string): string {
  const value = args.flags.get(name);
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function hasHelp(args: ParsedArgs): boolean {
  return args.flags.has("help");
}

function isHelpTopic(value: string): value is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(value);
}

function utcCompact(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

function runId(tag: string): string {
  return `${tag}-${utcCompact()}-${randomHex(3)}`;
}

async function gitHead(worktree: string): Promise<string> {
  return (await $`git -C ${worktree} rev-parse HEAD`.quiet().text()).trim();
}

async function gitDirty(worktree: string): Promise<string> {
  try {
    return (await $`git -C ${worktree} status --porcelain`.quiet().text()).trim();
  } catch {
    return "";
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function runListRows(runsRoot: string): RunListRow[] {
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJsonFile<RunStatus | null>(`${runsRoot}/${entry.name}/status.json`, null))
    .filter((status): status is RunStatus => status !== null)
    .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "") || a.run_id.localeCompare(b.run_id))
    .map((status) => ({
      run_id: status.run_id,
      role: status.role,
      agent: status.agent,
      tag: status.tag,
      state: status.state,
      started_at: status.started_at,
      exit_code: status.exit_code,
    }));
}

function formatTable(rows: RunListRow[]): string {
  const headers = ["run_id", "role", "agent", "tag", "state", "started_at", "exit_code"];
  const body = rows.map((row) => [
    row.run_id,
    row.role,
    row.agent,
    row.tag,
    row.state,
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

function locateRun(repoKey: string, runId: string, mr?: string): LocatedRun {
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
  return matches[0]!;
}

function parseTailLines(args: ParsedArgs): number | null {
  if (!args.flags.has("n")) return null;
  const rawValue = args.flags.get("n");
  if (typeof rawValue !== "string") throw new CliError("-n <lines> must be a non-negative integer");
  const raw = rawValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new CliError("-n <lines> must be a non-negative integer");
  return value;
}

function tailText(text: string, lines: number | null): string {
  if (lines === null) return text;
  if (lines === 0) return "";
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === "") parts.pop();
  const selected = parts.slice(-lines);
  return selected.length ? `${selected.join("\n")}\n` : "";
}

function printResultSummary(result: RoleResult): void {
  process.stdout.write(`schema: ${result.schema}\n`);
  process.stdout.write(`verdict: ${resultVerdict(result)}\n`);
  process.stdout.write(`summary: ${resultSummary(result)}\n`);

  if (result.schema !== "orch.result/implementer/v1") return;
  const implementer = result as ImplementerResult;
  process.stdout.write("\nchanged_files:\n");
  if (implementer.changed_files.length === 0) {
    process.stdout.write("  - none\n");
  } else {
    for (const file of implementer.changed_files) process.stdout.write(`  - ${file}\n`);
  }

  process.stdout.write("\ntests:\n");
  if (implementer.tests.length === 0) {
    process.stdout.write("  - none\n");
  } else {
    for (const test of implementer.tests) {
      process.stdout.write(`  - ${test.cmd} (exit ${test.exit_code}): ${test.summary}\n`);
    }
  }
}

function orchCommand(): string[] {
  const scriptPath = process.argv[1];
  if (scriptPath?.endsWith(".ts")) return [process.execPath, scriptPath];
  return [process.execPath];
}

function readIdempotency(path: string): Record<string, IdempotencyRecord> {
  return readJsonFile<Record<string, IdempotencyRecord>>(path, {});
}

function statusState(record: IdempotencyRecord): RunState | null {
  const status = readJsonFile<RunStatus | null>(record.status_path, null);
  return status?.state ?? null;
}

function resultSummary(result: RoleResult): string {
  if ("summary" in result && typeof result.summary === "string") return result.summary;
  if (result.schema === "orch.result/reviewer/v1") {
    return `${result.blocking_findings.length} blocking finding(s), ${result.non_blocking_findings.length} non-blocking finding(s).`;
  }
  if (result.schema === "orch.result/verifier/v1") {
    return `${result.commands.length} command(s), ${result.acceptance.length} acceptance item(s).`;
  }
  return "No summary in result.json.";
}

function resultVerdict(result: RoleResult): string {
  return "verdict" in result && typeof result.verdict === "string" ? result.verdict : "unknown";
}

function latestRunId(runsRoot: string): string | null {
  if (!existsSync(runsRoot)) return null;
  const candidates = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const status = readJsonFile<RunStatus | null>(`${runsRoot}/${entry.name}/status.json`, null);
      return { id: entry.name, updated_at: status?.updated_at ?? "" };
    });
  candidates.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
  return candidates[0]?.id ?? null;
}

function readMirrorResult(runsRoot: string, runId: string): { result: RoleResult; status: RunStatus | null } {
  const runDir = `${runsRoot}/${runId}`;
  if (!existsSync(runDir)) throw new Error(`run not found: ${runId}`);
  const result = readJsonFile<RoleResult | null>(`${runDir}/result.json`, null);
  if (!result) throw new Error(`result.json not found for run: ${runId}`);
  const status = readJsonFile<RunStatus | null>(`${runDir}/status.json`, null);
  return { result, status };
}

function mirrorBody(mr: string, runId: string, result: RoleResult, status: RunStatus | null): string {
  return [
    "### orch run result",
    "",
    `- MR/PR: ${mr}`,
    `- Run: ${runId}`,
    `- State: ${status?.state ?? "unknown"}`,
    `- Verdict: ${resultVerdict(result)}`,
    "",
    "Summary:",
    "",
    resultSummary(result),
  ].join("\n");
}

async function createRun(args: ParsedArgs): Promise<number> {
  const mr = flagString(args, "mr");
  const role = flagString(args, "role") as RunRole;
  const agent = flagString(args, "agent") as AgentName;
  const tag = flagString(args, "tag", role);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const taskPath = args.flags.has("task") ? resolve(flagString(args, "task")) : null;
  const taskText = taskPath ? readFileSync(taskPath, "utf8") : "";
  const timeoutSec = Number(flagString(args, "timeout-sec", "14400"));

  if (!isResultRole(role)) {
    throw new Error(`P1 only supports result-schema roles: implementer, reviewer, verifier (got ${role})`);
  }
  if (agent !== "codex" && agent !== "claude") throw new Error(`unsupported agent: ${agent}`);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error("--timeout-sec must be positive");

  const repo = await getRepoIdentity(worktree);
  const mrDir = mrStateDir(repo.repo_key, mr);
  ensureStateLayout(mrDir);
  const mrLock = acquirePidfileLock(`${mrDir}/locks/mr.lock`);
  try {
    const taskSha = sha256(taskText);
    const idempotencyKey = flagString(args, "idempotency-key", `mr${mr}:${tag}:${taskSha}`);
    const idempotencyPath = `${mrDir}/idempotency.json`;
    const idempotency = readIdempotency(idempotencyPath);
    const existing = idempotency[idempotencyKey];
    if (existing && !flagBool(args, "retry")) {
      const state = statusState(existing);
      printJson({
        run_id: existing.run_id,
        state,
        idempotent: true,
        status_path: existing.status_path,
        result_path: existing.result_path,
      });
      return 0;
    }

    const dirty = await gitDirty(worktree);
    const baseSha = await gitHead(worktree);
    const id = runId(tag);
    const runDir = `${mrDir}/runs/${id}`;
    mkdirSync(runDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const spec: RunSpec = {
      version: 1,
      run_id: id,
      mr,
      role,
      agent,
      tag,
      idempotency_key: idempotencyKey,
      repo_key: repo.repo_key,
      worktree,
      task_path: taskPath,
      task_text: taskText,
      task_sha: taskSha,
      base_sha: baseSha,
      timeout_sec: timeoutSec,
      created_at: createdAt,
    };
    writeJsonAtomic(`${runDir}/spec.yml`, spec);
    writeJsonAtomic(`${runDir}/spec.sha256`, { sha256: sha256(JSON.stringify(spec)) });
    writeInitialRunFiles(runDir, spec);

    idempotency[idempotencyKey] = {
      run_id: id,
      run_dir: runDir,
      status_path: `${runDir}/status.json`,
      result_path: `${runDir}/result.json`,
      created_at: createdAt,
    };
    writeJsonAtomic(idempotencyPath, idempotency);

    const proc = Bun.spawn(
      [...orchCommand(), "__supervisor", "--run-dir", runDir],
      {
        cwd: worktree,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: process.env,
      },
    );

    printJson({
      run_id: id,
      state: "starting",
      supervisor_pid: proc.pid,
      repo_key: repo.repo_key,
      mr_dir: mrDir,
      run_dir: runDir,
      status_path: `${runDir}/status.json`,
      events_path: `${runDir}/events.jsonl`,
      worktree_lock: lockPathForWorktree(mrDir, worktree),
      dirty: dirty.length > 0,
    });
    return 0;
  } finally {
    mrLock.release();
  }
}

async function status(args: ParsedArgs): Promise<number> {
  const mr = flagString(args, "mr");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const root = mrStateDir(repo.repo_key, mr);
  const runsRoot = `${root}/runs`;
  const runs = existsSync(runsRoot)
    ? readdirSync(runsRoot)
        .map((id) => readJsonFile<RunStatus | null>(`${runsRoot}/${id}/status.json`, null))
        .filter((item): item is RunStatus => item !== null)
    : [];
  const payload = { repo_key: repo.repo_key, mr, state_dir: root, runs };
  if (flagBool(args, "json")) printJson(payload);
  else {
    process.stdout.write(`MR ${mr} (${repo.repo_key})\n`);
    for (const run of runs) {
      process.stdout.write(`${run.run_id}\t${run.state}\t${run.role}\t${run.agent}\t${run.updated_at}\n`);
    }
  }
  return 0;
}

async function runList(args: ParsedArgs): Promise<number> {
  const mr = flagString(args, "mr");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const root = mrStateDir(repo.repo_key, mr);
  const rows = runListRows(`${root}/runs`);
  if (flagBool(args, "json")) {
    printJson(rows);
  } else {
    process.stdout.write(formatTable(rows));
  }
  return 0;
}

async function eventsTail(args: ParsedArgs): Promise<number> {
  const runId = flagString(args, "run");
  const mr = args.flags.has("mr") ? flagString(args, "mr") : undefined;
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const lines = parseTailLines(args);
  const repo = await getRepoIdentity(worktree);
  const located = locateRun(repo.repo_key, runId, mr);
  const eventsPath = `${located.run_dir}/events.jsonl`;
  const text = readTextFile(eventsPath);
  if (text === null) throw new CliError(`events.jsonl not found for run: ${runId}`);
  process.stdout.write(tailText(text, lines));
  return 0;
}

async function result(args: ParsedArgs): Promise<number> {
  const runId = flagString(args, "run");
  const mr = args.flags.has("mr") ? flagString(args, "mr") : undefined;
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const located = locateRun(repo.repo_key, runId, mr);
  const resultPath = `${located.run_dir}/result.json`;
  const raw = readTextFile(resultPath);
  if (raw === null) throw new CliError(`result.json not found for run: ${runId}`);
  if (flagBool(args, "json")) {
    process.stdout.write(raw.endsWith("\n") ? raw : `${raw}\n`);
    return 0;
  }
  let parsed: RoleResult;
  try {
    parsed = JSON.parse(raw) as RoleResult;
  } catch {
    throw new CliError(`result.json is not valid JSON for run: ${runId}`);
  }
  printResultSummary(parsed);
  return 0;
}

async function mirror(args: ParsedArgs): Promise<number> {
  const mr = flagString(args, "mr");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const execute = flagBool(args, "execute");
  const repo = await getRepoIdentity(worktree);
  const forge = detectForge(repo.remote_url);
  if (forge === "none") {
    process.stdout.write("本仓库无 github/gitlab remote，跳过 mirror\n");
    return 0;
  }

  const adapter = createForgeAdapter(forge, execute);
  if (!adapter) throw new Error(`unsupported forge: ${forge}`);

  const root = mrStateDir(repo.repo_key, mr);
  const runsRoot = `${root}/runs`;
  const runId = args.flags.has("run") ? flagString(args, "run") : latestRunId(runsRoot);
  if (!runId) throw new Error(`no local runs found for MR ${mr}`);

  const { result, status } = readMirrorResult(runsRoot, runId);
  const body = mirrorBody(mr, runId, result, status);
  const command = await adapter.postComment(mr, body);

  printJson({
    mirror: execute ? "executed" : "dry-run",
    forge,
    mr,
    run_id: runId,
    argv: command.argv,
    command: argvForDisplay(command.argv),
    exit_code: command.exit_code,
  });
  if (command.stdout) process.stdout.write(command.stdout);
  if (command.stderr) process.stderr.write(command.stderr);
  return command.exit_code && command.exit_code !== 0 ? command.exit_code : 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [first, second] = args.positionals;
  if (first === "__supervisor") return runSupervisor(flagString(args, "run-dir"), orchCommand());
  if (first === "__driver-codex") return runCodexDriver(process.argv.slice(3));
  if (first === "__driver-claude") return runClaudeDriver(process.argv.slice(3));

  if (!first || hasHelp(args)) {
    if (!first) {
      process.stdout.write(topLevelHelp());
      return 0;
    }
    if (first === "run" && second === "create") {
      process.stdout.write(runCreateHelp());
      return 0;
    }
    if (first === "run" && second === "list") {
      process.stdout.write(runListHelp());
      return 0;
    }
    if (first === "run") {
      process.stdout.write(runHelp());
      return 0;
    }
    if (first === "events" && second === "tail") {
      process.stdout.write(eventsTailHelp());
      return 0;
    }
    if (first === "result") {
      process.stdout.write(resultCommandHelp());
      return 0;
    }
    if (first === "status") {
      process.stdout.write(statusHelp());
      return 0;
    }
    if (first === "mirror") {
      process.stdout.write(mirrorHelp());
      return 0;
    }
    if (first === "help") {
      process.stdout.write(second && isHelpTopic(second) ? topicHelp(second) : topLevelHelp());
      return 0;
    }
    process.stdout.write(topLevelHelp());
    return 0;
  }

  if (first === "help") {
    if (!second) {
      process.stdout.write(topLevelHelp());
      return 0;
    }
    if (isHelpTopic(second)) {
      process.stdout.write(topicHelp(second));
      return 0;
    }
    process.stderr.write(unknownTopicHelp(second));
    return 2;
  }

  if (first === "run" && second === "create") return createRun(args);
  if (first === "run" && second === "list") return runList(args);
  if (first === "events" && second === "tail") return eventsTail(args);
  if (first === "result") return result(args);
  if (first === "status") return status(args);
  if (first === "mirror") return mirror(args);
  process.stderr.write(topLevelHelp());
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
