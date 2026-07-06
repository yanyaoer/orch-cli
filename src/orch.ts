#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import pkg from "../package.json";
import { basename, dirname, resolve } from "node:path";
import { $ } from "bun";
import type {
  AgentName,
  ControllerResult,
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
import {
  appendJsonLine,
  countLines,
  createFileFollower,
  jsonBytes,
  readJsonFile,
  writeJsonAtomic,
  writeJsonExclusive,
  writeTextAtomic,
} from "./json.ts";
import { argvForDisplay, createForgeAdapter, detectForge } from "./forge.ts";
import { findPrivateLeak, privateLeakAllowed, privateLeakErrorMessage } from "./leak.ts";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
import { createNativeNormalizer } from "./native-events.ts";
import {
  buildOverview,
  collectMrRuns,
  collectRepoKeys,
  DEFAULT_ATTENTION_DAYS,
  isGoodVerdict,
  isTerminal,
  mergedBranchMrs,
  mrDirsForRepo,
  renderArgv,
  renderOverview,
  suggestedRunAction,
} from "./overview.ts";
import {
  HELP_TOPICS,
  chatgptBridgeHelp,
  handoffProHelp,
  updateHelp,
  decisionHelp,
  eventsTailHelp,
  verdictHelp,
  waitHelp,
  fanoutHelp,
  mirrorHelp,
  mirrorSyncHelp,
  mailHelp,
  mailctlHelp,
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
import { runOmpDriver } from "../drivers/omp-headless.ts";
import { addWorkspace, chatgptBridgeConfigPath, readBridgeConfig, readMailControlConfig, validateMailControlConfig, writeBridgeConfig } from "./config.ts";
import { buildBundle, type BundleOptions } from "./handoff-pro.ts";
import { mail, mailFanout, type MailCliContext } from "./mail-cli.ts";
import {
  createMailTransport,
  mailctlAck,
  mailctlAttachmentPromote,
  mailctlAttachments,
  mailctlAttachmentShow,
  mailctlGuidance,
  mailctlInit,
  mailctlPoll,
  mailctlReply,
  mailctlStatus,
  mailctlWatch,
  renderMailctlAttachments,
  renderMailctlGuidance,
  renderMailctlStatus,
  type MailCursor,
  type MailMessageRef,
  type MailTransport,
  type MailctlContext,
} from "./mailctl.ts";
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

// close = "stop tracking this run" — an ack that queues no mirror comment.
// It exists so historical or abandoned runs can leave the overview without
// pretending they were reviewed (accept) or need work (rework).
type DecisionVerdict = "accept" | "rework" | "close";

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
  return agent === "pi" || agent === "omp" ? "ephemeral" : "fresh_persistent";
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
  if (agent === "omp" && name) {
    throw new CliError("omp does not support --session-name; use --session-id with --session-mode resume_exact");
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
    obj.agent === "codex" || obj.agent === "claude" || obj.agent === "pi" || obj.agent === "omp"
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

  if (result.schema === "orch.result/controller/v1") {
    const controller = result as ControllerResult;
    process.stdout.write("\nactions:\n");
    if (controller.actions.length === 0) {
      process.stdout.write("  - none\n");
    } else {
      for (const action of controller.actions) process.stdout.write(`  - ${action}\n`);
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

function evidencePaths(runDir: string): string[] {
  const artifactsDir = `${runDir}/artifacts`;
  if (!existsSync(`${artifactsDir}/diff.patch`)) return [];
  return ["git-status.txt", "diff.patch", "changed-files.txt"]
    .map((name) => `${artifactsDir}/${name}`)
    .filter((path) => existsSync(path));
}

function printEvidenceSummary(runDir: string): void {
  const paths = evidencePaths(runDir);
  if (paths.length === 0) return;
  process.stdout.write("\nevidence:\n");
  for (const path of paths) process.stdout.write(`  - ${path}\n`);
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

// GitHub caps issue comments at 65536 chars; stay under it with room for the
// forge CLI's own wrapping. One pathological finding must not eat the budget.
const MIRROR_BODY_MAX_CHARS = 60_000;
const MIRROR_FINDING_MAX_CHARS = 4_000;

function mirrorListLines(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [`${title} (${items.length}):`, "", ...items.map((item) => `- ${item}`), ""];
}

// Findings render as plain paragraphs, not markdown list items: multi-line
// finding bodies (blank lines included) survive GitHub/GitLab rendering intact.
function mirrorFindingLines(title: string, findings: Array<{ id: string; severity?: string; file?: string; body: string }>): string[] {
  if (findings.length === 0) return [];
  const lines = [`${title} (${findings.length}):`, ""];
  for (const finding of findings) {
    const meta = [finding.severity, finding.id, finding.file].filter(Boolean).join(" | ");
    const body = finding.body.length > MIRROR_FINDING_MAX_CHARS ? `${finding.body.slice(0, MIRROR_FINDING_MAX_CHARS)}…(finding truncated)` : finding.body;
    lines.push(`**[${meta}]**`, body, "");
  }
  return lines;
}

function commandLine(command: { cmd: string; exit_code: number; summary: string }): string {
  return `exit=${command.exit_code} \`${command.cmd}\` — ${command.summary}`;
}

// The comment is the human-facing mirror of result.json: every structured
// field a decision was based on belongs in it, not just the summary line.
function resultDetailLines(result: RoleResult): string[] {
  switch (result.schema) {
    case "orch.result/reviewer/v1":
      return [
        ...mirrorFindingLines("Blocking findings", result.blocking_findings),
        ...mirrorFindingLines("Non-blocking findings", result.non_blocking_findings),
        ...mirrorListLines("Suggested tests", result.suggested_tests),
      ];
    case "orch.result/verifier/v1":
      return [
        ...mirrorListLines("Commands", result.commands.map(commandLine)),
        ...mirrorListLines("Acceptance", result.acceptance.map((item) => `${item.id}: ${item.status}`)),
      ];
    case "orch.result/implementer/v1":
      return [
        ...mirrorListLines("Tests", result.tests.map(commandLine)),
        ...mirrorListLines("Acceptance", result.acceptance.map((item) => `${item.id}: ${item.status}${item.evidence ? ` — ${item.evidence}` : ""}`)),
        ...mirrorListLines("Risks", result.risks),
      ];
    case "orch.result/controller/v1":
      return mirrorListLines("Actions", result.actions);
    default:
      return [];
  }
}

function mirrorBody(mr: string, runId: string, result: RoleResult, status: RunStatus | null): string {
  const lines = [
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
  ];
  const detail = resultDetailLines(result);
  if (detail.length > 0) lines.push("", ...detail);
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (body.length <= MIRROR_BODY_MAX_CHARS) return body;
  return `${body.slice(0, MIRROR_BODY_MAX_CHARS)}\n\n…(comment truncated; run \`orch result --run ${runId}\` for the full result)`;
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

const VALID_AGENTS: readonly AgentName[] = ["codex", "claude", "pi", "omp"];

function validateRunAgent(agent: AgentName, _role: RunRole): void {
  if (!VALID_AGENTS.includes(agent)) throw new CliError(`unsupported agent: ${agent}`);
  if (_role === "controller" && agent !== "claude") {
    throw new CliError("controller role only supports the claude agent");
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
    throw new CliError(`P1 only supports result-schema roles: implementer, reviewer, verifier, controller (got ${role})`);
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

function dryRunMailTransport(): MailTransport {
  return {
    async listNew(_sinceDays: number, _cursor: MailCursor | null): Promise<MailMessageRef[]> {
      return [];
    },
    async fetchRaw(ref: MailMessageRef): Promise<string> {
      throw new Error(`dry-run transport cannot fetch UID ${ref.uid}`);
    },
    async markProcessed(_ref: MailMessageRef): Promise<void> {},
    async sendReply(_rfc822: string): Promise<void> {},
    async idleOnce(_timeoutMs: number, _cursor: MailCursor | null): Promise<void> {},
  };
}

function mailctlContext(context: MailCliContext, transport?: MailTransport): MailctlContext {
  const config = readMailControlConfig();
  try {
    validateMailControlConfig(config);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
  return {
    config,
    transport: transport ?? createMailTransport(config),
    now: () => Date.now(),
    orch: context,
  };
}

function mailctlBody(args: ParsedArgs): string {
  const hasBody = args.flags.has("body");
  const hasBodyFile = args.flags.has("body-file");
  if (hasBody === hasBodyFile) throw new CliError("mailctl reply requires exactly one of --body or --body-file");
  return hasBody ? flagString(args, "body") : readFileSync(resolve(flagString(args, "body-file")), "utf8");
}

function pollSummary(result: Awaited<ReturnType<typeof mailctlPoll>>, dryRun: boolean): string {
  const reconcile = result.reconciled
    ? ` reconciled_spawned=${result.reconciled.spawned.length} reconciled_live=${result.reconciled.live.length} retried_reports=${result.reconciled.retried_reports}`
    : "";
  return `mailctl poll${dryRun ? " dry-run" : ""}: listed=${result.listed} fetched=${result.fetched} accepted=${result.accepted} rejected=${result.rejected} duplicate=${result.duplicate} errors=${result.errors} skipped=${result.skipped}${reconcile}\n`;
}

export async function mailctl(args: ParsedArgs, context: MailCliContext): Promise<number> {
  const mode = args.positionals[1];
  try {
    if (mode === "init") {
      const result = mailctlInit(args);
      if (flagBool(args, "json")) printJson({ mailctl: "init", ...result });
      else {
        process.stdout.write(`${result.config_path}\n`);
        process.stdout.write(`trusted_authserv_id=${result.trusted_authserv_id} (confirm with your mail provider)\n`);
      }
      return 0;
    }

    if (mode === "poll") {
      assertKnownFlags(args, "mailctl poll", ["json", "dry-run"]);
      const dryRun = flagBool(args, "dry-run");
      const ctx = mailctlContext(context, dryRun ? dryRunMailTransport() : undefined);
      const result = await mailctlPoll(ctx, { reconcile: !dryRun });
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(pollSummary(result, dryRun));
      return 0;
    }

    if (mode === "watch") {
      assertKnownFlags(args, "mailctl watch", ["iterations", "json"]);
      const iterations = flagNumber(args, "iterations");
      if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 0)) {
        throw new CliError("--iterations must be a non-negative integer");
      }
      const result = await mailctlWatch(mailctlContext(context), { iterations });
      if (flagBool(args, "json")) printJson({ mailctl: "watch", ...result });
      else process.stdout.write(`mailctl watch: iterations=${result.iterations} stopped=${result.stopped}\n`);
      return 0;
    }

    if (mode === "status") {
      assertKnownFlags(args, "mailctl status", ["json"]);
      const result = mailctlStatus(mailctlContext(context), { json: flagBool(args, "json") });
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(renderMailctlStatus(result));
      return 0;
    }

    if (mode === "reply") {
      assertKnownFlags(args, "mailctl reply", ["thread", "report-key", "body", "body-file", "dry-run"]);
      const dryRun = flagBool(args, "dry-run");
      const result = await mailctlReply(mailctlContext(context), {
        thread: flagString(args, "thread"),
        reportKey: flagString(args, "report-key"),
        body: mailctlBody(args),
        dryRun,
      });
      if (dryRun) {
        process.stdout.write(result.rawMessage ?? "");
        return 0;
      }
      printJson({
        mailctl: "reply",
        duplicate: result.duplicate,
        sent: result.sent,
        pending: result.pending,
        message_id: result.messageId ?? null,
        next_attempt_at: result.nextAttemptAt ?? null,
      });
      return 0;
    }

    if (mode === "ack") {
      assertKnownFlags(args, "mailctl ack", ["thread", "attention", "json"]);
      const result = mailctlAck(mailctlContext(context), { thread: flagString(args, "thread"), attention: flagString(args, "attention") });
      if (flagBool(args, "json")) printJson({ mailctl: "ack", ...result });
      else process.stdout.write(`mailctl ack: thread=${result.thread} attention=${result.attention} done=${result.done} acknowledged=${result.acknowledged}\n`);
      return 0;
    }

    if (mode === "guidance") {
      assertKnownFlags(args, "mailctl guidance", ["thread", "json"]);
      const result = mailctlGuidance(mailctlContext(context), { thread: flagString(args, "thread"), json: flagBool(args, "json") });
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(renderMailctlGuidance(result));
      return 0;
    }

    if (mode === "attachments") {
      assertKnownFlags(args, "mailctl attachments", ["thread", "json"]);
      const result = mailctlAttachments({ thread: args.flags.has("thread") ? flagString(args, "thread") : undefined });
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(renderMailctlAttachments(result));
      return 0;
    }

    if (mode === "attachment") {
      const action = args.positionals[2];
      if (action === "show") {
        assertKnownFlags(args, "mailctl attachment show", ["id"]);
        process.stdout.write(mailctlAttachmentShow(flagString(args, "id")));
        return 0;
      }
      if (action === "promote") {
        assertKnownFlags(args, "mailctl attachment promote", ["id", "dest", "json"]);
        const result = mailctlAttachmentPromote(mailctlContext(context), {
          id: flagString(args, "id"),
          dest: args.flags.has("dest") ? resolve(flagString(args, "dest")) : undefined,
        });
        if (flagBool(args, "json")) printJson({ mailctl: "attachment-promote", ...result });
        else process.stdout.write(`${result.path}\n`);
        return 0;
      }
      process.stderr.write("usage: orch mailctl attachment show|promote --id att-<id> [--dest <dir>]\n");
      return 2;
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  process.stderr.write("usage: orch mailctl init|poll|watch|status|reply|ack|guidance|attachments|attachment [flags]\n");
  return 2;
}

// cross-review: one diff reviewed in parallel by distinct model families.
async function crossReview(args: ParsedArgs): Promise<number> {
  return mailFanout(args, mailFanoutContext(), {
    command: "cross-review",
    role: "reviewer",
    defaultAgentIds: ["claude-reviewer", "omp-reviewer"],
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
    defaultAgentIds: ["omp-reviewer", "claude-reviewer"],
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

// Bare `orch`: the shared status + pending-actions view. Text and --json are
// projections of the same aggregation, and every suggested action is a
// runnable orch command line — humans copy it, agents spawn it.
async function overviewCommand(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const all = flagBool(args, "all");
  const attentionDays = flagNumber(args, "attention-days") ?? DEFAULT_ATTENTION_DAYS;
  if (!Number.isFinite(attentionDays) || attentionDays < 0) {
    throw new CliError("--attention-days must be a non-negative number (0 disables the window)");
  }
  const repoIdentity = await getRepoIdentity(worktree);
  const repoKeys = all ? collectRepoKeys() : [repoIdentity.repo_key];
  // Branch lifecycle only applies to the repo we have a worktree for; other
  // repos in --all mode have no local branch context to consult.
  const mergedMrs = await mergedBranchMrs(worktree);
  const archived = mergedMrs ? { repoKey: repoIdentity.repo_key, mrs: mergedMrs } : null;
  // Cross-repo suggestions need --worktree to resolve the right repo_key when
  // they are executed from elsewhere; same-repo suggestions stay short.
  const overview = buildOverview(repoKeys, all, { attentionDays, archived });
  if (flagBool(args, "json")) {
    printJson(overview);
  } else {
    process.stdout.write(renderOverview(overview));
  }
  return 0;
}

function threadMr(args: ParsedArgs): string {
  if (args.flags.has("thread")) return flagString(args, "thread");
  if (args.flags.has("mr")) return flagString(args, "mr");
  throw new CliError("missing --thread (or --mr)");
}

async function verdictCommand(args: ParsedArgs): Promise<number> {
  const mr = threadMr(args);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const waitSec = flagNumber(args, "wait-sec") ?? 900;
  const deadline = Date.now() + waitSec * 1000;

  let runs = collectMrRuns(repo.repo_key, mr);
  if (flagBool(args, "wait")) {
    for (;;) {
      runs = collectMrRuns(repo.repo_key, mr);
      if (runs.length > 0 && runs.every((run) => isTerminal(run.state) || run.stale)) break;
      if (Date.now() >= deadline) {
        throw new CliError(`thread ${mr} did not settle within ${waitSec}s (${runs.filter((r) => isTerminal(r.state)).length}/${runs.length} terminal)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (runs.length === 0) throw new CliError(`no runs found for thread: ${mr}`);

  const staleRuns = runs.filter((run) => run.stale);
  const allTerminal = runs.every((run) => isTerminal(run.state));
  const suggestion = staleRuns.length > 0
    ? "reap"
    : !allTerminal
      ? "pending"
      : runs.some((run) => run.state === "failed" || run.state === "timeout")
        ? "inspect"
        : runs.some((run) => (run.blocking ?? 0) > 0 || (run.verdict !== null && !isGoodVerdict(run.verdict)))
          ? "rework"
          : "accept";

  const actions = runs.map((run) => suggestedRunAction(run, false)).filter((action) => action !== null);
  if (staleRuns.length > 0) {
    actions.unshift({
      kind: "reap",
      reason: `${staleRuns.length} stale run${staleRuns.length > 1 ? "s" : ""}`,
      argv: ["orch", "run", "reap", "--mr", mr],
      repo_key: repo.repo_key,
      mr,
    });
  }

  if (flagBool(args, "json")) {
    printJson({ thread: mr, all_terminal: allTerminal, suggestion, runs, actions });
    return 0;
  }

  const lines: string[] = [];
  lines.push(`thread ${mr}: ${runs.filter((run) => isTerminal(run.state)).length}/${runs.length} terminal`);
  for (const run of runs) {
    const verdict = run.verdict ?? "-";
    const blocking = run.blocking !== null ? `blocking ${run.blocking}` : "";
    const marks = [run.stale ? "stale?" : "", run.decided ? "decided" : ""].filter(Boolean).join(" ");
    lines.push(`  ${run.run_id}  ${run.role}/${run.agent}  ${run.state}  ${verdict}  ${[blocking, marks].filter(Boolean).join("  ")}`.trimEnd());
  }
  lines.push(`suggestion: ${suggestion}`);
  actions.forEach((action, index) => {
    lines.push(`  ${index + 1}. ${renderArgv(action.argv)}`);
  });
  if (actions.length === 0) lines.push("  nothing left to do — all runs decided");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

// Wait-any: block until some run in the thread needs attention. A decision is
// the natural ack — decided runs are never returned again, so the agent loop
// is `orch wait` -> handle -> `orch wait` until it reports settled.
async function waitCommand(args: ParsedArgs): Promise<number> {
  const mr = threadMr(args);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const timeoutSec = flagNumber(args, "timeout-sec") ?? 900;
  const deadline = Date.now() + timeoutSec * 1000;

  for (;;) {
    const runs = collectMrRuns(repo.repo_key, mr);
    if (runs.length === 0) throw new CliError(`no runs found for thread: ${mr}`);

    const stale = runs.find((run) => run.stale);
    if (stale) {
      printJson({
        kind: "stale",
        thread: mr,
        run_id: stale.run_id,
        suggested_argv: ["orch", "run", "reap", "--mr", mr],
      });
      return 0;
    }

    for (const run of runs) {
      const action = suggestedRunAction(run, false);
      if (action) {
        printJson({ kind: "run_terminal", thread: mr, run, reason: action.reason, suggested_argv: action.argv });
        return 0;
      }
    }

    if (runs.every((run) => isTerminal(run.state))) {
      printJson({ kind: "settled", thread: mr, runs: runs.length });
      return 0;
    }

    if (Date.now() >= deadline) {
      throw new CliError(`no run reached a terminal state within ${timeoutSec}s (thread: ${mr})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const FOLLOW_POLL_MS = 500;

// Without --run, -f multiplexes every active run in the repo (or one mr, or
// every repo with --all): existing active runs stream from their current end
// (-n replays that much context first), runs created while following stream
// from the top, and a tail(1)-style "==> mr/run <==" header marks every
// source switch (prefixed with the repo's short name under --all). Runs are
// dropped once terminal or stale; the loop itself runs until Ctrl-C, since
// waiting for runs that don't exist yet is the point.
async function eventsTailAll(args: ParsedArgs, repoKeys: string[]): Promise<number> {
  const lines = parseTailLines(args);
  const fileName = flagBool(args, "native") ? "native.jsonl" : "events.jsonl";
  const mrNamesFor = (repoKey: string): string[] => (args.flags.has("mr") ? [flagString(args, "mr")] : mrDirsForRepo(repoKey));
  const labelPrefix = (repoKey: string): string => (repoKeys.length > 1 ? `${basename(repoKey)}:` : "");

  type Tracked = { label: string; runDir: string; follower: ReturnType<typeof createFileFollower>; render: (line: string) => string };
  const tracked = new Map<string, Tracked>();
  const seen = new Set<string>();
  let currentLabel = "";
  const write = (label: string, out: string): void => {
    if (!out) return;
    if (currentLabel !== label) {
      currentLabel = label;
      process.stdout.write(`==> ${label} <==\n`);
    }
    process.stdout.write(out);
  };
  const makeRender = (): ((line: string) => string) => {
    const normalize = fileName === "native.jsonl" ? createNativeNormalizer() : null;
    return (line) =>
      normalize
        ? normalize(line)
            .map((event) => `${JSON.stringify(event)}\n`)
            .join("")
        : line
          ? `${line}\n`
          : "";
  };

  const track = (label: string, runDir: string, preexisting: boolean): void => {
    const render = makeRender();
    let offset = 0;
    if (preexisting) {
      // Pre-existing active run: skip its history (replay -n lines of it as
      // context), follow from the last complete line.
      const text = readTextFile(`${runDir}/${fileName}`) ?? "";
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      offset = Buffer.byteLength(complete, "utf8");
      if (lines !== null) write(label, tailText(complete.split("\n").map(render).join(""), lines));
    }
    tracked.set(runDir, { label, runDir, follower: createFileFollower(`${runDir}/${fileName}`, offset), render });
  };

  const discover = (firstPass: boolean): void => {
    for (const repoKey of repoKeys) {
      for (const mrName of mrNamesFor(repoKey)) {
        const runsRoot = `${mrStateDir(repoKey, mrName)}/runs`;
        if (!existsSync(runsRoot)) continue;
        for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const runDir = `${runsRoot}/${entry.name}`;
          if (seen.has(runDir)) continue;
          const status = readJsonFile<RunStatus | null>(`${runDir}/status.json`, null);
          // A run mid-creation (directory exists, status.json not yet written)
          // stays out of `seen` so the next pass re-examines it instead of
          // skipping it for its whole lifetime.
          if (status === null) continue;
          seen.add(runDir);
          const active = nonTerminalStates.has(status.state) && !looksStale(status);
          // On the first pass terminal runs are history; later they are news.
          if (firstPass && !active) continue;
          track(`${labelPrefix(repoKey)}${mrName}/${entry.name}`, runDir, firstPass);
        }
      }
    }
  };

  let firstPass = true;
  for (;;) {
    discover(firstPass);
    if (firstPass) {
      // Say what is being followed up front: an empty scope otherwise looks
      // like a hang (the classic miss is running this from the wrong repo).
      const scope = repoKeys.length === 1 ? repoKeys[0] : `${repoKeys.length} repos`;
      process.stderr.write(
        `following ${scope} · ${tracked.size} active run(s); waiting for new runs (Ctrl-C to stop${repoKeys.length === 1 ? ", --all for every repo" : ""})\n`,
      );
    }
    firstPass = false;
    for (const t of tracked.values()) {
      const emit = (): void => {
        for (const line of t.follower.drain()) write(t.label, t.render(line));
      };
      emit();
      const status = readJsonFile<RunStatus | null>(`${t.runDir}/status.json`, null);
      if (status && (!nonTerminalStates.has(status.state) || looksStale(status))) {
        emit(); // the worker may flush final lines right before going terminal
        tracked.delete(t.runDir);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
  }
}

async function eventsTail(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const follow = flagBool(args, "follow");
  if (!args.flags.has("run")) {
    if (!follow) throw new CliError("missing --run (with -f, --run may be omitted to follow every active run)");
    if (flagBool(args, "all")) return eventsTailAll(args, collectRepoKeys());
    const repo = await getRepoIdentity(worktree);
    return eventsTailAll(args, [repo.repo_key]);
  }
  if (flagBool(args, "all")) throw new CliError("--all follows every active run; drop --run to use it");
  const runId = flagString(args, "run");
  const mr = args.flags.has("mr") ? flagString(args, "mr") : undefined;
  const lines = parseTailLines(args);
  const repo = await getRepoIdentity(worktree);
  const located = locateRun(repo.repo_key, runId, mr);

  // --native renders provider-native stream output as normalized progress
  // events (session/assistant/tool_use/tool_result/usage/final/raw) — a
  // read-side view of what the worker is doing; orch lifecycle events stay in
  // events.jsonl and remain the state authority.
  const fileName = flagBool(args, "native") ? "native.jsonl" : "events.jsonl";
  const filePath = `${located.run_dir}/${fileName}`;
  const normalize = fileName === "native.jsonl" ? createNativeNormalizer() : null;
  const renderLine = (line: string): string =>
    normalize
      ? normalize(line)
          .map((event) => `${JSON.stringify(event)}\n`)
          .join("")
      : line
        ? `${line}\n`
        : "";

  const text = readTextFile(filePath);
  if (text === null && !follow) throw new CliError(`${fileName} not found for run: ${runId}`);

  // The snapshot stops at the last newline so a trailing half-written line is
  // not rendered twice; in follow mode it stays buffered until complete.
  const snapshot = follow ? (text ?? "").slice(0, (text ?? "").lastIndexOf("\n") + 1) : (text ?? "");
  process.stdout.write(tailText(snapshot.split("\n").map(renderLine).join(""), lines));
  if (!follow) return 0;

  // -f/--follow: stream lines as the worker appends them, then exit once the
  // run is terminal (or stale: pid gone) and the file is drained.
  const follower = createFileFollower(filePath, Buffer.byteLength(snapshot, "utf8"));
  const emit = (): void => {
    for (const line of follower.drain()) process.stdout.write(renderLine(line));
  };
  for (;;) {
    emit();
    const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
    if (status && (!nonTerminalStates.has(status.state) || looksStale(status))) {
      emit(); // the worker may flush final lines right before going terminal
      if (text === null && !follower.sawFile()) throw new CliError(`${fileName} not found for run: ${runId}`);
      if (nonTerminalStates.has(status.state)) {
        process.stderr.write(`orch events tail: run ${runId} looks stale (pid ${status.pid} is gone); stopping\n`);
      }
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
  }
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
  printEvidenceSummary(located.run_dir);
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
  if (verdict === "sweep") return decisionSweep(args);
  if (verdict !== "accept" && verdict !== "rework" && verdict !== "close") {
    throw new CliError("usage: orch decision accept|rework|close --run <run_id> [--mr <id>] [--reason <text>] [--worktree <path>], or orch decision sweep [--mr <id>] [--execute]");
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
  const ts = new Date().toISOString();
  const record: DecisionRecord = { verdict, run_id: runId, reason, ts };
  // close is a pure ack: no PR/MR comment rides on it, so no body is built.
  let body: string | null = null;
  if (verdict !== "close") {
    const { result, status } = readMirrorResult(runsRoot, runId);
    body = decisionBody(mr, runId, record, result, status);
    assertMirrorBodySafe(body);
  }
  const runDir = `${runsRoot}/${runId}`;
  writeDecisionExclusive(runDir, record);

  const outboxPath =
    body === null
      ? null
      : enqueueComment(mrDir, {
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

// decision.json is the run's atomic ack: O_EXCL create-or-fail, so two
// controllers racing on the same run get one winner and one clear error —
// never a silent overwrite plus a second queued mirror comment.
function writeDecisionExclusive(runDir: string, record: DecisionRecord): void {
  try {
    writeJsonExclusive(`${runDir}/decision.json`, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const prior = readJsonFile<DecisionRecord | null>(`${runDir}/decision.json`, null);
      throw new CliError(
        `run ${record.run_id} already decided (${prior?.verdict ?? "unknown"}${prior?.ts ? ` at ${prior.ts}` : ""}); not queueing another mirror comment`,
      );
    }
    throw error;
  }
}

// Batch-ack the backlog: record the obvious decision for every undecided
// terminal run, following the same rubric the overview suggests. Sweep never
// queues mirror comments — it clears attention debt; runs that deserve a PR
// comment should go through a single `orch decision accept|rework`.
async function decisionSweep(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const execute = flagBool(args, "execute");
  const repo = await getRepoIdentity(worktree);
  const mrFilter = args.flags.has("mr") ? flagString(args, "mr") : null;
  const mrDirNames = mrFilter ? [basename(mrStateDir(repo.repo_key, mrFilter))] : mrDirsForRepo(repo.repo_key);

  const planned: Array<{ mr: string; run_id: string; verdict: DecisionVerdict; reason: string }> = [];
  for (const mrDirName of mrDirNames) {
    for (const run of collectMrRuns(repo.repo_key, mrDirName)) {
      if (!isTerminal(run.state) || run.decided) continue;
      // stale/cancelled runs are already retired by reap/cancel; leave them out
      // of the decision ledger, mirroring suggestedRunAction.
      if (run.state === "stale" || run.state === "cancelled") continue;
      const plan =
        run.state === "done"
          ? run.verdict === null
            ? { verdict: "close" as const, reason: "sweep: done without result" }
            : isGoodVerdict(run.verdict) && (run.blocking ?? 0) === 0
              ? { verdict: "accept" as const, reason: `sweep: ${run.role} ${run.verdict}` }
              : { verdict: "rework" as const, reason: `sweep: ${run.role} ${run.verdict}${run.blocking ? ` · blocking ${run.blocking}` : ""}` }
          : { verdict: "close" as const, reason: `sweep: run ${run.state}` };
      planned.push({ mr: run.mr, run_id: run.run_id, ...plan });
    }
  }

  if (!execute) {
    printJson({ sweep: "dry-run", repo_key: repo.repo_key, planned, hint: "re-run with --execute to record these decisions (no mirror comments are queued)" });
    return 0;
  }

  const decided: typeof planned = [];
  const skipped: Array<{ mr: string; run_id: string; error: string }> = [];
  const ts = new Date().toISOString();
  for (const plan of planned) {
    const runDir = `${mrStateDir(repo.repo_key, plan.mr)}/runs/${plan.run_id}`;
    try {
      writeJsonExclusive(`${runDir}/decision.json`, { verdict: plan.verdict, run_id: plan.run_id, reason: plan.reason, ts });
      decided.push(plan);
    } catch (error) {
      skipped.push({
        mr: plan.mr,
        run_id: plan.run_id,
        error: (error as NodeJS.ErrnoException).code === "EEXIST" ? "already decided" : String(error),
      });
    }
  }
  printJson({ sweep: "executed", repo_key: repo.repo_key, decided, skipped });
  return skipped.length > 0 ? 1 : 0;
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
  // Concurrent --execute runs would each send the same pending comment before
  // either renames it into sent/; serialize senders per MR outbox. Dry-run
  // stays lock-free read-only.
  const outboxLock = execute ? await acquirePidfileLockWait(`${mrDir}/locks/outbox.lock`, 10_000) : null;
  try {
    return await mirrorSyncPending(mrDir, adapter, forge, mr, execute);
  } finally {
    outboxLock?.release();
  }
}

async function mirrorSyncPending(
  mrDir: string,
  adapter: NonNullable<ReturnType<typeof createForgeAdapter>>,
  forge: string,
  mr: string,
  execute: boolean,
): Promise<number> {
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

const GITHUB_REPO = "yanyaoer/orch-cli";

// The compiled single-file binary runs its entry module from bun's virtual
// filesystem; a source checkout (bun run src/orch.ts) does not.
function isCompiledBinary(): boolean {
  return Bun.main.startsWith("/$bunfs/");
}

const UPDATE_FLAGS = ["check", "json"] as const;

// Self-update from the latest GitHub release. `--check` only reports versions.
async function updateCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "update", UPDATE_FLAGS);
  const current = `v${pkg.version}`;
  const headers: Record<string, string> = { "user-agent": `orch-cli/${pkg.version}`, accept: "application/vnd.github+json" };
  // Unauthenticated GitHub API calls are rate-limited to 60/hour per IP; use
  // ambient credentials when present.
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const api = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers });
  if (!api.ok) throw new CliError(`failed to query the latest release: HTTP ${api.status} from api.github.com${api.status === 403 ? " (rate limit? set GH_TOKEN)" : ""}`);
  const release = (await api.json()) as { tag_name?: string };
  const latest = release.tag_name;
  if (!latest) throw new CliError("latest release carries no tag_name");

  if (flagBool(args, "check") || latest === current) {
    printJson({ current, latest, up_to_date: latest === current });
    return 0;
  }
  if (!isCompiledBinary()) {
    throw new CliError("orch update self-replaces the compiled binary; in a source checkout run: git pull && bun run install:local");
  }
  const platform = process.platform;
  const arch = process.arch;
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) {
    throw new CliError(`no prebuilt release asset for ${platform}-${arch}; build from source: bun run install:local`);
  }
  const asset = `orch-${platform}-${arch}`;
  const url = `https://github.com/${GITHUB_REPO}/releases/download/${latest}/${asset}`;
  const download = await fetch(url, { headers: { "user-agent": `orch-cli/${pkg.version}` } });
  if (!download.ok) throw new CliError(`failed to download ${url}: HTTP ${download.status}`);
  // Buffer the body explicitly: Bun.write(path, response) can hang on these
  // release downloads, and a starved event loop then exits 0 silently.
  const binary = await download.arrayBuffer();

  // Write next to the real binary so the final rename is atomic on one fs.
  const targetPath = realpathSync(process.execPath);
  const stagedPath = `${targetPath}.update-${process.pid}`;
  try {
    await Bun.write(stagedPath, binary);
    chmodSync(stagedPath, 0o755);
    // The new binary must at least run before it replaces this one.
    const probe = Bun.spawn([stagedPath, "--version"], { stdout: "ignore", stderr: "ignore" });
    if ((await probe.exited) !== 0) throw new CliError(`downloaded ${asset} failed its --version probe; keeping ${current}`);
    renameSync(stagedPath, targetPath);
  } catch (error) {
    rmSync(stagedPath, { force: true });
    throw error;
  }
  printJson({ updated: true, from: current, to: latest, path: targetPath });
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const [first, second] = args.positionals;
  if (!first && flagBool(args, "version")) {
    process.stdout.write(`orch v${pkg.version}\n`);
    return 0;
  }
  if (first === "__supervisor") return runSupervisor(flagString(args, "run-dir"), orchCommand());
  if (first === "__driver-codex") return runCodexDriver(process.argv.slice(3));
  if (first === "__driver-claude") return runClaudeDriver(process.argv.slice(3));
  if (first === "__driver-pi") return runPiDriver(process.argv.slice(3));
  if (first === "__driver-omp") return runOmpDriver(process.argv.slice(3));

  // Bare `orch` is the overview: current state + runnable pending actions.
  // `orch --help` keeps printing the command reference.
  if (!first && !hasHelp(args)) return overviewCommand(args);

  if (!first || hasHelp(args)) {
    if (!first) {
      process.stdout.write(topLevelHelp());
      return 0;
    }
    if (first === "verdict") {
      process.stdout.write(verdictHelp());
      return 0;
    }
    if (first === "wait") {
      process.stdout.write(waitHelp());
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
    if (first === "mailctl") {
      process.stdout.write(mailctlHelp());
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
    if (first === "update") {
      process.stdout.write(updateHelp());
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

  if (first === "verdict") return verdictCommand(args);
  if (first === "wait") return waitCommand(args);
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
  if (first === "mailctl") return mailctl(args, { orchCommand, locateRun, readMirrorResult });
  if (first === "workspace") return workspace(args);
  if (first === "chatgpt-bridge") return chatgptBridge(args);
  if (first === "handoff-pro") return handoffPro(args);
  if (first === "update") return updateCommand(args);
  process.stderr.write(`unknown command: ${[first, second].filter(Boolean).join(" ")}\n\n`);
  process.stderr.write(topLevelHelp());
  return 2;
}

if (import.meta.main) {
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
}
