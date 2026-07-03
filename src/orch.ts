#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { $ } from "bun";
import type {
  AgentName,
  ImplementerResult,
  ProviderSessionMode,
  ReviewerResult,
  RoleResult,
  RunRole,
  RunSpec,
  RunState,
  RunStatus,
  VerifierResult,
} from "./types.ts";
import { isResultRole, writeRoles } from "./types.ts";
import { acquirePidfileLock, acquirePidfileLockWait, isPidAlive, LockHeldError } from "./locks.ts";
import { randomHex, sha256 } from "./hash.ts";
import { ensureStateLayout, getRepoIdentity, lockPathForWorktree, mrStateDir, orchStateRoot, type RepoIdentity } from "./paths.ts";
import { appendJsonLine, countLines, jsonBytes, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./json.ts";
import { argvForDisplay, createForgeAdapter, detectForge } from "./forge.ts";
import { findPrivateLeak, privateLeakAllowed, privateLeakErrorMessage } from "./leak.ts";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
import {
  HELP_TOPICS,
  chatgptBridgeHelp,
  handoffProHelp,
  decisionHelp,
  eventsTailHelp,
  fanoutHelp,
  mirrorHelp,
  mirrorSyncHelp,
  mailHelp,
  workspaceHelp,
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
import { deployWorker, locateBridgeDir, runChatgptBridge } from "../drivers/chatgpt-bridge.ts";
import { runPiDriver } from "../drivers/pi-headless.ts";
import { runAgyDriver } from "../drivers/agy-headless.ts";
import { addWorkspace, chatgptBridgeConfigPath, readBridgeConfig, writeBridgeConfig } from "./config.ts";
import { buildBundle, type BundleOptions } from "./handoff-pro.ts";
import { mail, mailFanout, type MailCliContext } from "./mail-cli.ts";
import { workspace } from "./workspace-cli.ts";
import { assertKnownFlags, CliError, collectFlags, flagBool, flagNumber, flagString, hasHelp, parseArgs, printJson, type ParsedArgs } from "./cli.ts";
import { buildPrompt, buildProviderArgv } from "../drivers/driver-common.ts";

type IdempotencyRecord = {
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

type DecisionVerdict = "accept" | "rework";

interface DecisionRecord {
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

function assertMirrorBodySafe(body: string): void {
  if (privateLeakAllowed()) return;
  const finding = findPrivateLeak(body);
  if (finding) throw new CliError(privateLeakErrorMessage(finding));
}

function stateDirectoryHint(path: string, error: unknown): CliError {
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

function isHelpTopic(value: string): value is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(value);
}

function utcCompact(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

function runId(tag: string): string {
  return `${tag}-${utcCompact()}-${randomHex(3)}`;
}

function isProviderSessionMode(value: string): value is ProviderSessionMode {
  return value === "ephemeral" || value === "fresh_persistent" || value === "resume_exact";
}

function defaultProviderSessionMode(agent: AgentName): ProviderSessionMode {
  return agent === "pi" || agent === "agy" ? "ephemeral" : "fresh_persistent";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type ProviderSessionConfig = Pick<
  RunSpec,
  "provider_session_name" | "provider_session_id" | "provider_session_mode" | "model"
>;

function providerSessionConfig(args: ParsedArgs, agent: AgentName): ProviderSessionConfig {
  const modeValue = flagString(args, "session-mode", defaultProviderSessionMode(agent));
  if (!isProviderSessionMode(modeValue)) {
    throw new CliError("--session-mode must be ephemeral|fresh_persistent|resume_exact");
  }
  const name = args.flags.has("session-name") ? flagString(args, "session-name").trim() : null;
  const id = args.flags.has("session-id") ? flagString(args, "session-id").trim() : null;
  const model = args.flags.has("model") ? flagString(args, "model").trim() : null;

  if (name === "") throw new CliError("--session-name must not be empty");
  if (id === "") throw new CliError("--session-id must not be empty");
  if (model === "") throw new CliError("--model must not be empty");
  if (modeValue === "resume_exact" && !id) throw new CliError("--session-mode resume_exact requires --session-id");
  if (id && modeValue !== "resume_exact") throw new CliError("--session-id requires --session-mode resume_exact");
  if (agent === "pi" && modeValue === "ephemeral" && name) {
    throw new CliError("pi --session-name requires --session-mode fresh_persistent or resume_exact");
  }
  if (agent === "codex" && name) {
    throw new CliError("codex does not support --session-name in headless exec; use --session-id with --session-mode resume_exact");
  }
  if (agent === "claude" && id && !isUuid(id)) {
    throw new CliError("claude --session-id/--resume requires a UUID");
  }

  return { provider_session_name: name, provider_session_id: id, provider_session_mode: modeValue, model };
}

function providerSessionFingerprint(session: ProviderSessionConfig): string {
  const sessionKey = `${session.provider_session_mode}:${session.provider_session_name ?? ""}:${session.provider_session_id ?? ""}`;
  const modelKey = session.model ? `${sessionKey}:model:${session.model}` : sessionKey;
  return sha256(modelKey).slice(0, 12);
}

function providerSessionFromValue(value: unknown, fallbackAgent: AgentName): ProviderSessionConfig {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<RunSpec>) : {};
  const agent =
    obj.agent === "codex" || obj.agent === "claude" || obj.agent === "pi" || obj.agent === "agy"
      ? obj.agent
      : fallbackAgent;
  const mode =
    typeof obj.provider_session_mode === "string" && isProviderSessionMode(obj.provider_session_mode)
      ? obj.provider_session_mode
      : defaultProviderSessionMode(agent);
  return {
    provider_session_name: typeof obj.provider_session_name === "string" ? obj.provider_session_name : null,
    provider_session_id: typeof obj.provider_session_id === "string" ? obj.provider_session_id : null,
    provider_session_mode: mode,
    model: typeof obj.model === "string" ? obj.model : null,
  };
}

function existingProviderSession(existing: IdempotencyRecord, fallbackAgent: AgentName): ProviderSessionConfig {
  const spec = readJsonFile<Partial<RunSpec> | null>(`${existing.run_dir}/spec.json`, null);
  if (spec) return providerSessionFromValue(spec, fallbackAgent);
  const status = readJsonFile<Partial<RunStatus> | null>(existing.status_path, null);
  return providerSessionFromValue(status, fallbackAgent);
}

function assertProviderSessionCompatible(
  existing: IdempotencyRecord,
  requested: ProviderSessionConfig,
  fallbackAgent: AgentName,
): ProviderSessionConfig {
  const stored = existingProviderSession(existing, fallbackAgent);
  if (
    stored.provider_session_name !== requested.provider_session_name ||
    stored.provider_session_id !== requested.provider_session_id ||
    stored.provider_session_mode !== requested.provider_session_mode ||
    stored.model !== requested.model
  ) {
    throw new CliError(
      [
        "idempotent run already exists with different provider session/model settings",
        `existing: ${stored.provider_session_mode}/${stored.provider_session_name ?? "none"}/${stored.provider_session_id ?? "none"}/model-${stored.model ?? "default"}`,
        `requested: ${requested.provider_session_mode}/${requested.provider_session_name ?? "none"}/${requested.provider_session_id ?? "none"}/model-${requested.model ?? "default"}`,
        "Pass --retry to create a new run with different provider session/model settings.",
      ].join("\n"),
    );
  }
  return stored;
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

async function gitBranch(worktree: string): Promise<string | null> {
  try {
    const branch = (await $`git -C ${worktree} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
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

type MrSource = "flag" | "task" | "branch";

async function resolveMr(args: ParsedArgs, taskText: string, worktree: string): Promise<{ mr: string; source: MrSource }> {
  if (args.flags.has("mr")) return { mr: flagString(args, "mr"), source: "flag" };
  const fromTask = mrFromTask(taskText);
  if (fromTask) return { mr: fromTask, source: "task" };
  const branch = await gitBranch(worktree);
  if (branch) return { mr: branch, source: "branch" };
  throw new CliError(
    "--mr is required: no MR/PR reference found in the task text and the worktree is not on a branch (detached HEAD or not a git repo)",
  );
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function pendingOutboxDir(mrDir: string): string {
  return `${mrDir}/outbox/pending`;
}

function sentOutboxDir(mrDir: string): string {
  return `${mrDir}/outbox/sent`;
}

function invalidOutboxDir(mrDir: string): string {
  return `${mrDir}/outbox/invalid`;
}

function pendingOutboxFiles(mrDir: string): string[] {
  const pendingDir = pendingOutboxDir(mrDir);
  if (!existsSync(pendingDir)) return [];
  return readdirSync(pendingDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function enqueueComment(mrDir: string, payload: OutboxCommentPayload): string {
  assertMirrorBodySafe(payload.body);
  const filename = `${utcCompact()}-${randomHex(4)}.json`;
  const path = `${pendingOutboxDir(mrDir)}/${filename}`;
  writeJsonAtomic(path, payload);
  return path;
}

const nonTerminalStates = new Set<RunState>(["created", "starting", "running"]);

// Read-side reconcile (A7: display-only, never writes): a run whose recorded
// pid is gone but whose state never reached a terminal one is flagged stale.
// `orch run reap` persists the verdict.
function looksStale(status: RunStatus): boolean {
  return nonTerminalStates.has(status.state) && status.pid !== null && !isPidAlive(status.pid);
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
      mr: status.mr,
      role: status.role,
      agent: status.agent,
      tag: status.tag,
      state: status.state,
      started_at: status.started_at,
      exit_code: status.exit_code,
      stale: looksStale(status),
    }));
}

// Directory names under mrs/ (already sanitized at write time); used by the
// aggregate views when --mr is omitted.
function mrIdsForRepo(repoKey: string): string[] {
  const root = repoMrsRoot(repoKey);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function formatTable(rows: RunListRow[]): string {
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
  const located = matches[0]!;
  // Directory names are sanitized (feature/foo → feature_foo); the run's own
  // status records the raw mr value, which is what downstream consumers
  // (decision bodies, outbox payloads) must carry.
  const recorded = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null)?.mr;
  return recorded ? { ...located, mr: recorded } : located;
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

function printFindings(label: string, findings: ReviewerResult["non_blocking_findings"]): void {
  process.stdout.write(`\n${label}:\n`);
  if (findings.length === 0) {
    process.stdout.write("  - none\n");
    return;
  }
  for (const finding of findings) {
    const head = [finding.severity, finding.id, finding.file].filter(Boolean).join(" | ");
    process.stdout.write(`  - [${head || "finding"}]\n    ${finding.body.replaceAll("\n", "\n    ")}\n`);
  }
}

function printResultSummary(result: RoleResult): void {
  process.stdout.write(`schema: ${result.schema}\n`);
  process.stdout.write(`verdict: ${resultVerdict(result)}\n`);
  process.stdout.write(`summary: ${resultSummary(result)}\n`);

  if (result.schema === "orch.result/reviewer/v1") {
    const reviewer = result as ReviewerResult;
    printFindings("blocking_findings", reviewer.blocking_findings);
    printFindings("non_blocking_findings", reviewer.non_blocking_findings);
    process.stdout.write("\nsuggested_tests:\n");
    if (reviewer.suggested_tests.length === 0) {
      process.stdout.write("  - none\n");
    } else {
      for (const test of reviewer.suggested_tests) process.stdout.write(`  - ${test}\n`);
    }
    return;
  }

  if (result.schema === "orch.result/verifier/v1") {
    const verifier = result as VerifierResult;
    process.stdout.write("\ncommands:\n");
    if (verifier.commands.length === 0) {
      process.stdout.write("  - none\n");
    } else {
      for (const command of verifier.commands) {
        process.stdout.write(`  - ${command.cmd} (exit ${command.exit_code}): ${command.summary}\n`);
      }
    }
    process.stdout.write("\nacceptance:\n");
    if (verifier.acceptance.length === 0) {
      process.stdout.write("  - none\n");
    } else {
      for (const item of verifier.acceptance) process.stdout.write(`  - ${item.id}: ${item.status}\n`);
    }
    return;
  }

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

function archivedIdempotency(record: IdempotencyRecord): IdempotencyRecord {
  const { previous: _previous, ...archived } = record;
  return archived;
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
  if (!existsSync(runDir)) throw new CliError(`run not found: ${runId}`);
  const result = readJsonFile<RoleResult | null>(`${runDir}/result.json`, null);
  if (!result) throw new CliError(`result.json not found for run: ${runId}`);
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

function decisionBody(
  mr: string,
  runId: string,
  decision: DecisionRecord,
  result: RoleResult,
  status: RunStatus | null,
): string {
  return [
    "### orch decision",
    "",
    `- MR/PR: ${mr}`,
    `- Run: ${runId}`,
    `- Decision: ${decision.verdict}`,
    `- Reason: ${decision.reason ?? "none"}`,
    `- Created: ${decision.ts}`,
    "",
    mirrorBody(mr, runId, result, status),
  ].join("\n");
}

const VALID_AGENTS: readonly AgentName[] = ["codex", "claude", "pi", "agy"];

function validateRunAgent(agent: AgentName, role: RunRole): void {
  if (!VALID_AGENTS.includes(agent)) throw new CliError(`unsupported agent: ${agent}`);
  // agy = gemini-3.1-pro runs read-only (sandboxed), so it only fits the pure
  // analysis role; verifier needs to execute and write roles edit the worktree.
  if (agent === "agy" && role !== "reviewer") {
    throw new CliError(`agy (gemini-3.1-pro) is read-only; use it for reviewer analysis only, not ${role}`);
  }
}

const RUN_CREATE_FLAGS = [
  "mr",
  "role",
  "agent",
  "tag",
  "model",
  "worktree",
  "task",
  "idempotency-key",
  "retry",
  "allow-dirty",
  "timeout-sec",
  "session-mode",
  "session-name",
  "session-id",
  "dry-run",
  "json",
] as const;

async function createRun(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "run create", RUN_CREATE_FLAGS);
  const role = flagString(args, "role") as RunRole;
  const agent = flagString(args, "agent") as AgentName;
  const tag = flagString(args, "tag", role);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const taskPath = args.flags.has("task") ? resolve(flagString(args, "task")) : null;
  const taskText = taskPath ? readFileSync(taskPath, "utf8") : "";
  const { mr, source: mrSource } = await resolveMr(args, taskText, worktree);
  // Reviewer runs finish in minutes in practice (52/67 recorded runs override
  // the old 4h default); keep the long default only for roles that build/test.
  const timeoutSec = Number(flagString(args, "timeout-sec", role === "reviewer" ? "3600" : "14400"));

  if (!isResultRole(role)) {
    throw new CliError(`P1 only supports result-schema roles: implementer, reviewer, verifier (got ${role})`);
  }
  validateRunAgent(agent, role);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new CliError("--timeout-sec must be positive");
  const providerSession = providerSessionConfig(args, agent);

  const repo = await getRepoIdentity(worktree);
  const mrDir = mrStateDir(repo.repo_key, mr);
  const taskSha = sha256(taskText);
  const defaultIdempotencyKey = `mr${mr}:${tag}:${taskSha}:session-${providerSessionFingerprint(providerSession)}`;
  const idempotencyKey = flagString(args, "idempotency-key", defaultIdempotencyKey);
  const idempotencyPath = `${mrDir}/idempotency.json`;
  const dryRun = flagBool(args, "dry-run");
  if (dryRun) {
    const retry = flagBool(args, "retry");
    const dirty = await gitDirty(worktree);
    const baseSha = await gitHead(worktree);
    const existing = readIdempotency(idempotencyPath)[idempotencyKey];
    const existingSession = existing && !retry ? assertProviderSessionCompatible(existing, providerSession, agent) : null;
    const effectiveSession = existingSession ?? providerSession;
    const idempotent = Boolean(existing && !retry);
    const id = idempotent ? existing!.run_id : runId(tag);
    const runDir = idempotent ? existing!.run_dir : `${mrDir}/runs/${id}`;
    const specPath = `${runDir}/spec.json`;
    const specPreview: RunSpec = {
      version: 1,
      run_id: id,
      mr,
      role,
      agent,
      tag,
      ...effectiveSession,
      idempotency_key: idempotencyKey,
      repo_key: repo.repo_key,
      worktree,
      task_path: taskPath,
      task_text: taskText,
      task_sha: taskSha,
      base_sha: baseSha,
      timeout_sec: timeoutSec,
      created_at: new Date().toISOString(),
    };
    const payload = {
      dry_run: true,
      mr,
      mr_source: mrSource,
      role,
      agent,
      model: effectiveSession.model,
      tag,
      provider_session_name: effectiveSession.provider_session_name,
      provider_session_id: effectiveSession.provider_session_id,
      provider_session_mode: effectiveSession.provider_session_mode,
      repo,
      repo_key: repo.repo_key,
      mr_dir: mrDir,
      task_path: taskPath,
      task_sha: taskSha,
      idempotency_key: idempotencyKey,
      idempotent,
      existing_run_id: existing?.run_id ?? null,
      state: idempotent ? statusState(existing!) : "would_start",
      run_id: id,
      run_id_preview: idempotent ? null : id,
      run_dir: runDir,
      status_path: idempotent ? existing!.status_path : `${runDir}/status.json`,
      result_path: idempotent ? existing!.result_path : `${runDir}/result.json`,
      events_path: idempotent ? null : `${runDir}/events.jsonl`,
      worktree_lock: lockPathForWorktree(worktree),
      dirty: dirty.length > 0,
      base_sha: baseSha,
      timeout_sec: timeoutSec,
      supervisor_plan: idempotent
        ? null
        : {
            argv: [...orchCommand(), "__supervisor", "--run-dir", runDir],
            cwd: worktree,
            spawn: false,
          },
      driver_plan: idempotent
        ? null
        : {
            argv: [...orchCommand(), `__driver-${agent}`, "--spec", specPath, "--run-dir", runDir, "--worktree", worktree],
            cwd: worktree,
            spawn: false,
          },
      provider_plan: idempotent
        ? null
        : {
            argv: buildProviderArgv(agent, specPreview, runDir, worktree, buildPrompt(specPreview, agent)),
            cwd: worktree,
            spawn: false,
          },
    };
    if (flagBool(args, "json")) {
      printJson(payload);
    } else {
      const lines = [
        `dry-run: orch run create ${payload.run_id_preview ?? payload.run_id}`,
        `repo: ${repo.repo_key}`,
        `mr: ${mr} (${mrSource})`,
        `mr_dir: ${mrDir}`,
        `task_sha: ${taskSha}`,
        `idempotency_key: ${idempotencyKey}`,
        `idempotent: ${payload.idempotent}`,
        `state: ${payload.state}`,
        `model: ${payload.model ?? "default"}`,
        `provider_session_mode: ${payload.provider_session_mode}`,
        `provider_session_name: ${payload.provider_session_name ?? "none"}`,
        `provider_session_id: ${payload.provider_session_id ?? "none"}`,
        `worktree_lock: ${payload.worktree_lock}`,
        `dirty: ${payload.dirty}`,
        `base_sha: ${baseSha}`,
        `timeout_sec: ${timeoutSec}`,
      ];
      if (payload.supervisor_plan) lines.push(`supervisor: ${payload.supervisor_plan.argv.join(" ")}`);
      if (payload.driver_plan) lines.push(`driver: ${payload.driver_plan.argv.join(" ")}`);
      if (payload.provider_plan) lines.push(`provider: ${payload.provider_plan.argv.join(" ")}`);
      process.stdout.write(lines.join("\n") + "\n");
    }
    return 0;
  }
  printJson({
    mr,
    mr_source: mrSource,
    ...(await startRun({
      args,
      mr,
      role,
      agent,
      tag,
      worktree,
      taskPath,
      taskText,
      taskSha,
      timeoutSec,
      providerSession,
      repo,
      mrDir,
      idempotencyKey,
      idempotencyPath,
    })),
  });
  return 0;
}

interface StartRunInput {
  args: ParsedArgs;
  mr: string;
  role: RunRole;
  agent: AgentName;
  tag: string;
  worktree: string;
  taskPath: string | null;
  taskText: string;
  taskSha: string;
  timeoutSec: number;
  providerSession: ProviderSessionConfig;
  repo: RepoIdentity;
  mrDir: string;
  idempotencyKey: string;
  idempotencyPath: string;
}

// Spawns a single supervised run and returns its create payload. Shared by
// `run create` and the fan-out commands (cross-review / fanout / investigate).
async function startRun(input: StartRunInput): Promise<Record<string, unknown>> {
  const { args, mr, role, agent, tag, worktree, taskPath, taskText, taskSha, timeoutSec } = input;
  const { providerSession, repo, mrDir, idempotencyKey, idempotencyPath } = input;

  try {
    ensureStateLayout(mrDir);
  } catch (error) {
    throw stateDirectoryHint(mrDir, error);
  }
  // Concurrent same-MR creates are routine (fan-out claims one run per agent);
  // the lock only guards the idempotency read-modify-write + spawn, so wait
  // briefly instead of failing the whole create on contention.
  const mrLock = await acquirePidfileLockWait(`${mrDir}/locks/mr.lock`, 10_000);
  try {
    const idempotency = readIdempotency(idempotencyPath);
    const existing = idempotency[idempotencyKey];
    if (existing && !flagBool(args, "retry")) {
      const existingSession = assertProviderSessionCompatible(existing, providerSession, agent);
      const existingState = statusState(existing);
      if (existingState === "failed" || existingState === "timeout") {
        process.stderr.write(
          `warn: idempotent run ${existing.run_id} is ${existingState}; pass --retry to dispatch a new run\n`,
        );
      }
      return {
        run_id: existing.run_id,
        state: existingState,
        idempotent: true,
        model: existingSession.model,
        provider_session_name: existingSession.provider_session_name,
        provider_session_id: existingSession.provider_session_id,
        provider_session_mode: existingSession.provider_session_mode,
        status_path: existing.status_path,
        result_path: existing.result_path,
      };
    }

    const dirty = await gitDirty(worktree);
    if (dirty.length > 0 && writeRoles.has(role) && !flagBool(args, "allow-dirty")) {
      process.stderr.write(
        `warn: worktree has uncommitted changes; write-role run will proceed. Pass --allow-dirty to acknowledge.\n`,
      );
    }
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
      ...providerSession,
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
    const specBytes = jsonBytes(spec);
    writeTextAtomic(`${runDir}/spec.json`, specBytes);
    writeJsonAtomic(`${runDir}/spec.sha256`, { sha256: sha256(specBytes) });
    writeInitialRunFiles(runDir, spec);

    const proc = Bun.spawn(
      [...orchCommand(), "__supervisor", "--run-dir", runDir],
      {
        cwd: worktree,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        // The supervisor is an orch process; AI/tool subprocess env is sanitized
        // at the supervisor→driver and driver→provider boundaries.
        env: process.env,
      },
    );

    idempotency[idempotencyKey] = {
      run_id: id,
      run_dir: runDir,
      status_path: `${runDir}/status.json`,
      result_path: `${runDir}/result.json`,
      created_at: createdAt,
      previous: existing ? [...(existing.previous ?? []), archivedIdempotency(existing)] : undefined,
    };
    try {
      writeJsonAtomic(idempotencyPath, idempotency);
    } catch (error) {
      // Without the idempotency record a same-key retry would double-dispatch;
      // reap the just-spawned supervisor's process group before surfacing.
      // Residual risk (accepted): the driver is spawned detached in its own
      // group, so if the supervisor already reached its driver-spawn in this
      // sub-millisecond window, the driver survives as an orphan.
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // already exited
      }
      throw error;
    }

    return {
      run_id: id,
      state: "starting",
      model: providerSession.model,
      provider_session_name: providerSession.provider_session_name,
      provider_session_id: providerSession.provider_session_id,
      provider_session_mode: providerSession.provider_session_mode,
      supervisor_pid: proc.pid,
      repo_key: repo.repo_key,
      mr_dir: mrDir,
      run_dir: runDir,
      status_path: `${runDir}/status.json`,
      events_path: `${runDir}/events.jsonl`,
      worktree_lock: lockPathForWorktree(worktree),
      dirty: dirty.length > 0,
    };
  } finally {
    mrLock.release();
  }
}

// The fan-out commands route through the mail layer: the thread carries the mr
// and workspace context, so no --mr is needed. Each derives its role/agents and
// delegates to mailFanout (publish one task per agent → claim+run).
function mailFanoutContext(): MailCliContext {
  return { orchCommand, locateRun, readMirrorResult };
}

// cross-review: one diff reviewed in parallel by distinct model families.
async function crossReview(args: ParsedArgs): Promise<number> {
  return mailFanout(args, mailFanoutContext(), {
    command: "cross-review",
    role: "reviewer",
    defaultAgentIds: ["claude-reviewer", "agy-reviewer"],
  });
}

// fanout: generic — run any result role across --to-agent / auto-invited agents.
async function fanout(args: ParsedArgs): Promise<number> {
  return mailFanout(args, mailFanoutContext(), { command: "fanout" });
}

// investigate: read-only research/analysis, defaults to the gemini + claude reviewers.
async function investigate(args: ParsedArgs): Promise<number> {
  return mailFanout(args, mailFanoutContext(), {
    command: "investigate",
    role: "reviewer",
    defaultAgentIds: ["agy-reviewer", "claude-reviewer"],
  });
}

function mrStatusSection(repoKey: string, mr: string): { mr: string; state_dir: string; runs: Array<RunStatus & { stale: boolean }> } {
  const root = mrStateDir(repoKey, mr);
  const runsRoot = `${root}/runs`;
  const runs = existsSync(runsRoot)
    ? readdirSync(runsRoot)
        .map((id) => readJsonFile<RunStatus | null>(`${runsRoot}/${id}/status.json`, null))
        .filter((item): item is RunStatus => item !== null)
        .map((run) => ({ ...run, stale: looksStale(run) }))
    : [];
  // Prefer the raw mr recorded in the runs over the sanitized directory name.
  return { mr: runs[0]?.mr ?? mr, state_dir: root, runs };
}

async function status(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const explicitMr = args.flags.has("mr") ? flagString(args, "mr") : null;
  // Aggregate view hides MRs without runs (empty dirs from aborted creates);
  // an explicit --mr always shows its section, even when empty.
  const sections = (explicitMr ? [explicitMr] : mrIdsForRepo(repo.repo_key))
    .map((mr) => mrStatusSection(repo.repo_key, mr))
    .filter((section) => explicitMr !== null || section.runs.length > 0);

  if (flagBool(args, "json")) {
    if (explicitMr) {
      const section = sections[0]!;
      printJson({ repo_key: repo.repo_key, mr: section.mr, state_dir: section.state_dir, runs: section.runs });
    } else {
      printJson({ repo_key: repo.repo_key, mrs: sections });
    }
    return 0;
  }
  for (const section of sections) {
    process.stdout.write(`MR ${section.mr} (${repo.repo_key})\n`);
    for (const run of section.runs) {
      const state = run.stale ? `${run.state} (stale?)` : run.state;
      process.stdout.write(`${run.run_id}\t${state}\t${run.role}\t${run.agent}\t${run.updated_at}\n`);
    }
  }
  return 0;
}

// Persist the read-side stale verdict: non-terminal runs whose pid is dead (or
// that never got a pid and stopped updating an hour ago) are moved to `stale`.
async function runReap(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const mrIds = args.flags.has("mr") ? [flagString(args, "mr")] : mrIdsForRepo(repo.repo_key);
  const reaped: Array<{ mr: string; run_id: string }> = [];
  const running: Array<{ mr: string; run_id: string }> = [];
  for (const mr of mrIds) {
    const runsRoot = `${mrStateDir(repo.repo_key, mr)}/runs`;
    if (!existsSync(runsRoot)) continue;
    for (const id of readdirSync(runsRoot).sort()) {
      const statusPath = `${runsRoot}/${id}/status.json`;
      const status = readJsonFile<RunStatus | null>(statusPath, null);
      if (!status || !nonTerminalStates.has(status.state)) continue;
      const ageMs = Date.now() - Date.parse(status.updated_at ?? "");
      const orphanedBeforeSpawn = status.pid === null && Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000;
      if (!looksStale(status) && !orphanedBeforeSpawn) {
        running.push({ mr: status.mr, run_id: id });
        continue;
      }
      writeJsonAtomic(statusPath, { ...status, state: "stale", updated_at: new Date().toISOString() });
      const eventsPath = `${runsRoot}/${id}/events.jsonl`;
      appendJsonLine(eventsPath, { type: "stale", seq: countLines(eventsPath), ts: new Date().toISOString() });
      reaped.push({ mr: status.mr, run_id: id });
    }
  }
  printJson({ reaped, still_running: running });
  return 0;
}

async function runList(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const mrIds = args.flags.has("mr") ? [flagString(args, "mr")] : mrIdsForRepo(repo.repo_key);
  const rows = mrIds
    .flatMap((mr) => runListRows(`${mrStateDir(repo.repo_key, mr)}/runs`))
    .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "") || a.run_id.localeCompare(b.run_id));
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

  // --wait blocks until the run reaches a terminal state, so agent controllers
  // don't have to hand-roll a polling loop between create and result.
  if (flagBool(args, "wait")) {
    const waitSec = flagNumber(args, "wait-sec") ?? 900;
    const deadline = Date.now() + waitSec * 1000;
    for (;;) {
      const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
      if (status && !nonTerminalStates.has(status.state)) break;
      if (status && looksStale(status)) {
        throw new CliError(`run ${runId} looks stale (pid ${status.pid} is gone); run: orch run reap --mr ${located.mr}`);
      }
      if (Date.now() >= deadline) {
        throw new CliError(`run ${runId} did not reach a terminal state within ${waitSec}s (state: ${status?.state ?? "unknown"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

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
  if (args.positionals[1] === "sync") return mirrorSync(args);

  const mr = flagString(args, "mr");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const execute = flagBool(args, "execute");
  const repo = await getRepoIdentity(worktree);
  const forge = detectForge(repo.remote_url);
  if (forge === "none") {
    process.stdout.write("本仓库无 github/gitlab remote，跳过 mirror\n");
    return 0;
  }

  const adapter = createForgeAdapter(forge, execute, worktree);
  if (!adapter) throw new CliError(`unsupported forge: ${forge}`);

  const root = mrStateDir(repo.repo_key, mr);
  const runsRoot = `${root}/runs`;
  const runId = args.flags.has("run") ? flagString(args, "run") : latestRunId(runsRoot);
  if (!runId) throw new CliError(`no local runs found for MR ${mr}`);

  const { result, status } = readMirrorResult(runsRoot, runId);
  const body = mirrorBody(mr, runId, result, status);
  assertMirrorBodySafe(body);
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

async function decision(args: ParsedArgs): Promise<number> {
  const verdict = args.positionals[1];
  if (verdict !== "accept" && verdict !== "rework") {
    throw new CliError("usage: orch decision accept|rework --run <run_id> [--mr <id>] [--reason <text>] [--worktree <path>]");
  }
  const runId = flagString(args, "run");
  const reason = args.flags.has("reason") ? flagString(args, "reason") : null;
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  // --mr optional: the run id is unique enough to locate its MR by scanning.
  const mr = locateRun(repo.repo_key, runId, args.flags.has("mr") ? flagString(args, "mr") : undefined).mr;
  const mrDir = mrStateDir(repo.repo_key, mr);
  ensureStateLayout(mrDir);

  const runsRoot = `${mrDir}/runs`;
  const { result, status } = readMirrorResult(runsRoot, runId);
  const ts = new Date().toISOString();
  const record: DecisionRecord = { verdict, run_id: runId, reason, ts };
  const body = decisionBody(mr, runId, record, result, status);
  assertMirrorBodySafe(body);
  const runDir = `${runsRoot}/${runId}`;
  writeJsonAtomic(`${runDir}/decision.json`, record);

  const outboxPath = enqueueComment(mrDir, {
    kind: "comment",
    mr,
    body,
    created_at: ts,
  });

  printJson({
    decision: verdict,
    mr,
    run_id: runId,
    decision_path: `${runDir}/decision.json`,
    outbox_path: outboxPath,
  });
  return 0;
}

function readOutboxComment(path: string): OutboxCommentPayload | null {
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

async function mirrorSync(args: ParsedArgs): Promise<number> {
  const mr = flagString(args, "mr");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const execute = flagBool(args, "execute");
  const repo = await getRepoIdentity(worktree);
  const forge = detectForge(repo.remote_url);
  if (forge === "none") {
    process.stdout.write("本仓库无 github/gitlab remote，跳过 mirror sync\n");
    return 0;
  }

  const adapter = createForgeAdapter(forge, execute, worktree);
  if (!adapter) throw new CliError(`unsupported forge: ${forge}`);

  const mrDir = mrStateDir(repo.repo_key, mr);
  ensureStateLayout(mrDir);
  const pending = pendingOutboxFiles(mrDir);
  let failed = 0;
  for (const file of pending) {
    const pendingPath = `${pendingOutboxDir(mrDir)}/${file}`;
    const payload = readOutboxComment(pendingPath);
    if (!payload) {
      // Quarantine poison payloads on execute: leaving them pending would make
      // every future mirror sync fail without ever reaching all-clear. Dry-run
      // stays read-only and only reports.
      let outboxPath = pendingPath;
      if (execute) {
        mkdirSync(invalidOutboxDir(mrDir), { recursive: true });
        outboxPath = `${invalidOutboxDir(mrDir)}/${file}`;
        renameSync(pendingPath, outboxPath);
      }
      printJson({
        mirror: execute ? "invalid" : "dry-run",
        forge,
        mr,
        outbox_path: outboxPath,
        error: execute ? "invalid outbox payload; moved to outbox/invalid" : "invalid outbox payload",
      });
      failed += 1;
      continue;
    }

    try {
      assertMirrorBodySafe(payload.body);
    } catch (error) {
      printJson({
        mirror: execute ? "failed" : "dry-run",
        forge,
        mr: payload.mr,
        outbox_path: pendingPath,
        error: error instanceof Error ? error.message : String(error),
      });
      failed += 1;
      continue;
    }
    const command = await adapter.postComment(payload.mr, payload.body);
    const success = command.exit_code === 0;
    printJson({
      mirror: execute ? (success ? "sent" : "failed") : "dry-run",
      forge,
      mr: payload.mr,
      outbox_path: pendingPath,
      argv: command.argv,
      command: argvForDisplay(command.argv),
      exit_code: command.exit_code,
    });
    if (command.stdout) process.stdout.write(command.stdout);
    if (command.stderr) process.stderr.write(command.stderr);

    if (execute && success) {
      renameSync(pendingPath, `${sentOutboxDir(mrDir)}/${file}`);
    } else if (execute) {
      failed += 1;
    }
  }

  if (pending.length === 0) {
    printJson({ mirror: execute ? "sent" : "dry-run", forge, mr, pending: 0 });
  }
  return failed > 0 ? 1 : 0;
}

// Only one local agent may bind a given Worker bridge at a time. A second one
// would fight the first over the singleton BridgeDO ("newest wins" → endless
// reconnect loop). Guard with a pidfile lock keyed by the bridge host; stale
// locks (dead holder) are reclaimed automatically by acquirePidfileLock.
async function connectWithLock(url: string, token: string, worktree: string): Promise<number> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const lockPath = `${orchStateRoot()}/chatgpt-bridge-locks/${sha256(host)}.lock`;
  let lock;
  try {
    lock = acquirePidfileLock(lockPath);
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new CliError(
        [
          `another orch chatgpt-bridge is already connected to ${host}${error.holderPid ? ` (pid ${error.holderPid})` : ""}.`,
          "Only one local agent may bind a Worker bridge at a time.",
          error.holderPid ? `Stop the other one first:  kill ${error.holderPid}` : "Stop the other instance first.",
        ].join("\n"),
      );
    }
    throw error;
  }
  try {
    return await runChatgptBridge({ url, token, worktree });
  } finally {
    lock.release();
  }
}

async function chatgptBridge(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const now = new Date().toISOString();

  // Direct mode: explicit --url + --token connect to an already-running Worker
  // (e.g. local `wrangler dev`). We never deploy or overwrite the saved worker.
  if (args.flags.has("url") && args.flags.has("token")) {
    const url = flagString(args, "url");
    const token = flagString(args, "token");
    writeBridgeConfig(addWorkspace(readBridgeConfig(), worktree, now));
    if (flagBool(args, "no-connect")) {
      printJson({ mode: "direct", ws_url: url, worktree, connected: false });
      return 0;
    }
    return connectWithLock(url, token, worktree);
  }

  // Managed mode: deploy the Worker on demand, persist worker + token, reuse next time.
  let cfg = readBridgeConfig();
  if (!cfg.worker || !cfg.token || flagBool(args, "redeploy")) {
    const bridgeDir = locateBridgeDir(args.flags.has("bridge-dir") ? flagString(args, "bridge-dir") : undefined);
    const deployed = await deployWorker(bridgeDir);
    cfg = { ...cfg, worker: deployed.worker, token: deployed.token };
  }
  const worker = cfg.worker!;
  const token = cfg.token!;
  cfg = addWorkspace(cfg, worktree, now);
  writeBridgeConfig(cfg);

  printJson({
    mode: "managed",
    worker: worker.name,
    mcp_url: worker.mcp_url,
    ws_url: worker.ws_url,
    worktree,
    config_path: chatgptBridgeConfigPath(),
    hint: "Paste mcp_url into ChatGPT → Settings → Apps → Developer mode → Create.",
  });

  if (flagBool(args, "no-connect")) return 0;
  return connectWithLock(worker.ws_url, token, worktree);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function handoffPro(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const options: BundleOptions = {
    worktree,
    title: args.flags.has("title") ? flagString(args, "title") : undefined,
    selectedPaths: collectFlags(args, "path"),
    extraGlobs: collectFlags(args, "glob"),
    includeImportantFiles: !flagBool(args, "no-important-files"),
    includeChangedFiles: !flagBool(args, "no-changed-files"),
    includeDiff: !flagBool(args, "no-diff"),
    maxFiles: flagNumber(args, "max-files"),
    maxFileBytes: flagNumber(args, "max-file-bytes"),
    maxDiffBytes: flagNumber(args, "max-diff-bytes"),
    maxTotalBytes: flagNumber(args, "max-total-bytes"),
  };

  const built = await buildBundle(options);
  // Default output lives under XDG_STATE (per-repo), never inside the worktree:
  // the bundle holds full source + diff and must not risk being committed or
  // swept up by project-level sync/share tooling.
  let outPath: string;
  if (args.flags.has("out")) {
    outPath = resolve(flagString(args, "out"));
  } else {
    const repo = await getRepoIdentity(worktree);
    outPath = `${orchStateRoot()}/${repo.repo_key}/handoffs/context-${utcCompact()}.md`;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeTextAtomic(outPath, built.markdown);

  let copied = false;
  if (flagBool(args, "copy")) {
    copied = await copyToClipboard(built.markdown);
    if (!copied) process.stderr.write("warn: clipboard copy failed (pbcopy unavailable); bundle was still written.\n");
  }

  printJson({
    out: outPath,
    bytes: built.bytes,
    files_included: built.filesIncluded.length,
    files_skipped: built.filesSkipped.length,
    truncated: built.truncated,
    copied,
  });
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [first, second] = args.positionals;
  if (first === "__supervisor") return runSupervisor(flagString(args, "run-dir"), orchCommand());
  if (first === "__driver-codex") return runCodexDriver(process.argv.slice(3));
  if (first === "__driver-claude") return runClaudeDriver(process.argv.slice(3));
  if (first === "__driver-pi") return runPiDriver(process.argv.slice(3));
  if (first === "__driver-agy") return runAgyDriver(process.argv.slice(3));

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
    if (first === "cross-review" || first === "fanout" || first === "investigate") {
      process.stdout.write(fanoutHelp());
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
    if (first === "decision") {
      process.stdout.write(decisionHelp());
      return 0;
    }
    if (first === "mail") {
      process.stdout.write(mailHelp());
      return 0;
    }
    if (first === "workspace") {
      process.stdout.write(workspaceHelp());
      return 0;
    }
    if (first === "mirror" && second === "sync") {
      process.stdout.write(mirrorSyncHelp());
      return 0;
    }
    if (first === "mirror") {
      process.stdout.write(mirrorHelp());
      return 0;
    }
    if (first === "chatgpt-bridge") {
      process.stdout.write(chatgptBridgeHelp());
      return 0;
    }
    if (first === "handoff-pro") {
      process.stdout.write(handoffProHelp());
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
  if (first === "run" && second === "reap") return runReap(args);
  if (first === "cross-review") return crossReview(args);
  if (first === "fanout") return fanout(args);
  if (first === "investigate") return investigate(args);
  if (first === "events" && second === "tail") return eventsTail(args);
  if (first === "result") return result(args);
  if (first === "status") return status(args);
  if (first === "decision") return decision(args);
  if (first === "mirror") return mirror(args);
  if (first === "mail") return mail(args, { orchCommand, locateRun, readMirrorResult });
  if (first === "workspace") return workspace(args);
  if (first === "chatgpt-bridge") return chatgptBridge(args);
  if (first === "handoff-pro") return handoffPro(args);
  process.stderr.write(`unknown command: ${[first, second].filter(Boolean).join(" ")}\n\n`);
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
