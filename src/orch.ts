#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, type Dirent } from "node:fs";
import pkg from "../package.json";
import { basename, dirname, resolve } from "node:path";
import { $ } from "bun";
import type {
  AgentName,
  ControllerResult,
  ImplementerResult,
  ProviderSessionMode,
  ResearcherResult,
  ReviewerResult,
  RoleResult,
  RunRole,
  RunSpec,
  RunState,
  RunStatus,
  VerifierResult,
} from "./types.ts";
import { isRunRole, writeRoles } from "./types.ts";
import { acquirePidfileLock, acquirePidfileLockWait, isPidAlive, LockHeldError } from "./locks.ts";
import { randomHex, sha256 } from "./hash.ts";
import { claimNewMrDir, ensureStateLayout, getRepoIdentity, lockPathForWorktree, mrStateDir, orchStateRoot, type RepoIdentity } from "./paths.ts";
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
import { argvForDisplay, createForgeAdapter, detectForge, mrRefFromText } from "./forge.ts";
import { findPrivateLeak, privateLeakAllowed, privateLeakErrorMessage } from "./leak.ts";
import { runSupervisor, writeInitialRunFiles } from "./supervisor.ts";
import { createNativeNormalizer, normalizeNativeLine } from "./native-events.ts";
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
  newHelp,
  workspaceHelp,
  resultCommandHelp,
  runCancelHelp,
  runCreateHelp,
  runHelp,
  runListHelp,
  searchHelp,
  statusHelp,
  topicHelp,
  topLevelHelp,
  usageHelp,
  unknownTopicHelp,
  type HelpTopic,
} from "./help.ts";
import { runCodexDriver } from "../drivers/codex-headless.ts";
import { runClaudeDriver } from "../drivers/claude-headless.ts";
import { deployWorker, locateBridgeDir, runChatgptBridge } from "../drivers/chatgpt-bridge.ts";
import { runPiDriver } from "../drivers/pi-headless.ts";
import { runOmpDriver } from "../drivers/omp-headless.ts";
import { addWorkspace, chatgptBridgeConfigPath, orchLanguage, readBridgeConfig, readMailAgentsConfig, readMailControlConfig, readOrchConfig, validateMailControlConfig, writeBridgeConfig, type RoleDefaults } from "./config.ts";
import { createInterface, type Interface as ReadlineInterface, type ReadLineOptions } from "node:readline";
import { buildBundle, type BundleOptions } from "./handoff-pro.ts";
import { mail, mailFanout, type MailCliContext, type MailFanoutOutcome } from "./mail-cli.ts";
import { fallbackRawReview, planAutoDecision, sanitizeCommentBody, withheldSection } from "./review-auto.ts";
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
  mailctlSync,
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
import { assertKnownFlags, CliError, collectFlags, flagBool, flagNumber, flagString, hasHelp, parseArgs, printJson, readStdinText, type ParsedArgs } from "./cli.ts";
import { buildPrompt, buildProviderExecutionPlan, type ProviderExecutionPlan } from "../drivers/driver-common.ts";
import { sandboxPosture, sandboxRunIdentity, SEATBELT_ENGINE, seatbeltUnsupportedReason } from "../drivers/sandbox.ts";
import { insideSandbox, proxyToHost, reconcileDispatchOnce, reconcileDispatchWatch, shouldProxyToHost } from "./dispatch.ts";
import { classifyNewOpenQuestions, evaluateNewExecution, validateNewPlanMarkdown, type NewExecutionRun } from "./new-flow.ts";

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

type RunLocation = {
  mr: string;
  run_id: string;
  run_dir: string;
  status: RunStatus | null;
};

type SearchSource = "run" | "mail";

type SearchFileCandidate = {
  source: SearchSource;
  mr: string | null;
  run_id: string | null;
  thread: string | null;
  file: string;
  path: string;
};

type SearchHit = {
  source: SearchSource;
  mr: string | null;
  run_id: string | null;
  thread: string | null;
  file: string;
  path: string;
  line: number;
  context: string;
};

type TokenUsageMap = Record<string, number>;

type UsageSummary = {
  has_token_data: boolean;
  usage: TokenUsageMap | null;
  estimated_cost_usd: null;
  unpriced_models: string[];
};

type RunUsageSummary = UsageSummary & {
  mr: string;
  run_id: string;
  usage_events: number;
  source_file: string;
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

function providerSessionConfig(args: ParsedArgs, agent: AgentName, defaultModel: string | null = null): ProviderSessionConfig {
  const modeValue = flagString(args, "session-mode", defaultProviderSessionMode(agent));
  if (!isProviderSessionMode(modeValue)) {
    throw new CliError("--session-mode must be ephemeral|fresh_persistent|resume_exact");
  }
  const name = args.flags.has("session-name") ? flagString(args, "session-name").trim() : null;
  const id = args.flags.has("session-id") ? flagString(args, "session-id").trim() : null;
  const model = args.flags.has("model") ? flagString(args, "model").trim() : defaultModel;

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

// config sandbox:true resolves to the versioned engine, validated fail-closed
// before any run state is created or reused: a platform that cannot apply the
// sandbox must refuse the run, never silently downgrade it. Extra write dirs
// come from the SAME config read (F6: engine and dirs must not split across
// two reads); shape-checked here for early feedback, authoritatively re-vetted
// by the driver against canonical paths.
function requestedSandboxEngine(): { engine: typeof SEATBELT_ENGINE | null; writeDirs: string[] } {
  const cfg = readOrchConfig();
  if (cfg.sandbox !== true) return { engine: null, writeDirs: [] };
  const reason = seatbeltUnsupportedReason();
  if (reason) throw new CliError(reason);
  const writeDirs = [...new Set((cfg.sandbox_write_dirs ?? []).map((dir) => dir.trim()).filter((dir) => dir.length > 0))];
  for (const dir of writeDirs) {
    if (!dir.startsWith("/")) {
      throw new CliError(`config sandbox_write_dirs entries must be absolute paths (no ~ or relative): ${JSON.stringify(dir)}`);
    }
  }
  return { engine: SEATBELT_ENGINE, writeDirs };
}

// An idempotency hit (notably an explicit --idempotency-key) must never hand
// back a run that executed under different sandbox semantics: engine and the
// role-derived posture both have to match. A missing spec.json (legacy run)
// means engine none.
function assertSandboxCompatible(existing: IdempotencyRecord, engine: typeof SEATBELT_ENGINE | null, role: RunRole): void {
  const spec = readJsonFile<Partial<RunSpec> | null>(`${existing.run_dir}/spec.json`, null);
  const storedEngine = spec?.sandbox_engine === SEATBELT_ENGINE ? SEATBELT_ENGINE : null;
  const storedRole = typeof spec?.role === "string" && isRunRole(spec.role) ? spec.role : role;
  if (storedEngine === engine && sandboxPosture(storedRole) === sandboxPosture(role)) return;
  throw new CliError(
    [
      "idempotent run already exists with different sandbox settings",
      `existing: engine=${storedEngine ?? "none"} posture=${sandboxPosture(storedRole)}`,
      `requested: engine=${engine ?? "none"} posture=${sandboxPosture(role)}`,
      "Pass --retry to create a new run under the requested sandbox settings.",
    ].join("\n"),
  );
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

type MrSource = "flag" | "task" | "branch" | "resume-from";

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

function writeForgeRef(mrDir: string, ref: string): void {
  writeTextAtomic(forgeRefPath(mrDir), `${ref}\n`);
}

function forgeRefFor(mrDir: string, mr: string): string {
  return readForgeRef(mrDir) ?? mr;
}

function enqueueComment(mrDir: string, payload: OutboxCommentPayload): string {
  assertMirrorBodySafe(payload.body);
  const filename = `${utcCompact()}-${randomHex(4)}.json`;
  const path = `${pendingOutboxDir(mrDir)}/${filename}`;
  writeJsonAtomic(path, { ...payload, mr: forgeRefFor(mrDir, payload.mr) });
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

function safeDirEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function runLocation(repoKey: string, runId: string, mr?: string): RunLocation {
  const located = locateRun(repoKey, runId, mr);
  const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
  return {
    mr: status?.mr ?? located.mr,
    run_id: status?.run_id ?? located.run_id,
    run_dir: located.run_dir,
    status,
  };
}

function runLocationsForMr(repoKey: string, mr: string): RunLocation[] {
  const runsRoot = `${mrStateDir(repoKey, mr)}/runs`;
  return safeDirEntries(runsRoot)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runDir = `${runsRoot}/${entry.name}`;
      const status = readJsonFile<RunStatus | null>(`${runDir}/status.json`, null);
      return {
        mr: status?.mr ?? mr,
        run_id: status?.run_id ?? entry.name,
        run_dir: runDir,
        status,
      };
    })
    .sort((a, b) => (a.status?.started_at ?? "").localeCompare(b.status?.started_at ?? "") || a.run_id.localeCompare(b.run_id));
}

function runLocationsForRepo(repoKey: string): RunLocation[] {
  return mrIdsForRepo(repoKey).flatMap((mr) => runLocationsForMr(repoKey, mr));
}

function scopedRunLocations(repoKey: string, args: ParsedArgs): RunLocation[] {
  if (args.flags.has("run")) return [runLocation(repoKey, flagString(args, "run"), args.flags.has("mr") ? flagString(args, "mr") : undefined)];
  if (args.flags.has("mr")) return runLocationsForMr(repoKey, flagString(args, "mr"));
  return runLocationsForRepo(repoKey);
}

function searchFilesForRun(run: RunLocation): SearchFileCandidate[] {
  const candidates: SearchFileCandidate[] = ["result.json", "events.jsonl", "native.jsonl"].map((file) => ({
    source: "run",
    mr: run.mr,
    run_id: run.run_id,
    thread: null,
    file,
    path: `${run.run_dir}/${file}`,
  }));

  const artifactsDir = `${run.run_dir}/artifacts`;
  for (const entry of safeDirEntries(artifactsDir)) {
    if (!entry.isFile()) continue;
    if (!/\.(txt|log|patch)$/.test(entry.name)) continue;
    candidates.push({
      source: "run",
      mr: run.mr,
      run_id: run.run_id,
      thread: null,
      file: `artifacts/${entry.name}`,
      path: `${artifactsDir}/${entry.name}`,
    });
  }
  return candidates.filter((candidate) => existsSync(candidate.path));
}

function searchFilesForMail(repoKey: string, args: ParsedArgs): SearchFileCandidate[] {
  // Default search scans repo runs plus repo mail diagnostics. A run/MR scoped
  // search stays run-scoped unless --thread explicitly asks for a mail thread.
  if ((args.flags.has("mr") || args.flags.has("run")) && !args.flags.has("thread")) return [];
  const threadsRoot = `${orchStateRoot()}/${repoKey}/mail/threads`;
  const threadIds = args.flags.has("thread")
    ? [flagString(args, "thread")]
    : safeDirEntries(threadsRoot)
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
  return threadIds
    .map((thread) => ({
      source: "mail" as const,
      mr: null,
      run_id: null,
      thread,
      file: "mail-events.jsonl",
      path: `${threadsRoot}/${thread}/inbox/events/mail-events.jsonl`,
    }))
    .filter((candidate) => existsSync(candidate.path));
}

function compileSearchRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new CliError(`invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function searchCandidate(regex: RegExp, candidate: SearchFileCandidate): SearchHit[] {
  const text = readTextFile(candidate.path);
  if (text === null) return [];
  const hits: SearchHit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!regex.test(line)) return;
    hits.push({
      source: candidate.source,
      mr: candidate.mr,
      run_id: candidate.run_id,
      thread: candidate.thread,
      file: candidate.file,
      path: candidate.path,
      line: index + 1,
      context: line,
    });
  });
  return hits;
}

function renderSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "no matches\n";
  return hits
    .map((hit) => {
      const owner = hit.source === "run" ? `MR ${hit.mr ?? "-"} run ${hit.run_id ?? "-"}` : `thread ${hit.thread ?? "-"}`;
      return `${owner} ${hit.file}:${hit.line}: ${hit.context}`;
    })
    .join("\n") + "\n";
}

function addUsage(target: TokenUsageMap, usage: TokenUsageMap): void {
  for (const [key, value] of Object.entries(usage)) target[key] = (target[key] ?? 0) + value;
}

function sortedUsage(usage: TokenUsageMap): TokenUsageMap {
  return Object.fromEntries(Object.entries(usage).sort(([a], [b]) => a.localeCompare(b)));
}

function tokenUsageOnly(usage: Record<string, number>): TokenUsageMap {
  return Object.fromEntries(Object.entries(usage).filter(([key]) => key.toLowerCase().includes("token")));
}

function addModel(models: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.trim()) models.add(value.trim());
}

function modelsFromNativeLine(line: string): string[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return [];
  const obj = event as Record<string, unknown>;
  const response = obj.response && typeof obj.response === "object" && !Array.isArray(obj.response)
    ? (obj.response as Record<string, unknown>)
    : {};
  const message = obj.message && typeof obj.message === "object" && !Array.isArray(obj.message)
    ? (obj.message as Record<string, unknown>)
    : {};
  return [obj.model, obj.model_name, obj.model_id, response.model, message.model].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function runUsageSummary(run: RunLocation): RunUsageSummary {
  const usage: TokenUsageMap = {};
  const models = new Set<string>();
  const spec = readJsonFile<Partial<RunSpec> | null>(`${run.run_dir}/spec.json`, null);
  addModel(models, spec?.model);
  const nativePath = `${run.run_dir}/native.jsonl`;
  const native = readTextFile(nativePath);
  let usageEvents = 0;
  if (native !== null) {
    for (const line of native.split(/\r?\n/)) {
      if (!line.trim()) continue;
      for (const model of modelsFromNativeLine(line)) models.add(model);
      for (const event of normalizeNativeLine(line)) {
        if (event.kind !== "usage" || !event.usage) continue;
        const tokenUsage = tokenUsageOnly(event.usage);
        if (Object.keys(tokenUsage).length === 0) continue;
        addUsage(usage, tokenUsage);
        usageEvents += 1;
      }
    }
  }
  const hasTokenData = Object.keys(usage).length > 0;
  return {
    mr: run.mr,
    run_id: run.run_id,
    has_token_data: hasTokenData,
    usage: hasTokenData ? sortedUsage(usage) : null,
    estimated_cost_usd: null,
    unpriced_models: [...models].sort(),
    usage_events: usageEvents,
    source_file: nativePath,
  };
}

function aggregateRunUsage(runs: RunUsageSummary[]): UsageSummary & {
  run_count: number;
  runs_with_token_data: number;
  missing_runs: string[];
} {
  const usage: TokenUsageMap = {};
  const models = new Set<string>();
  const missingRuns: string[] = [];
  let runsWithTokenData = 0;
  for (const run of runs) {
    for (const model of run.unpriced_models) models.add(model);
    if (!run.has_token_data || !run.usage) {
      missingRuns.push(run.run_id);
      continue;
    }
    addUsage(usage, run.usage);
    runsWithTokenData += 1;
  }
  const hasTokenData = Object.keys(usage).length > 0;
  return {
    run_count: runs.length,
    runs_with_token_data: runsWithTokenData,
    missing_runs: missingRuns,
    has_token_data: hasTokenData,
    usage: hasTokenData ? sortedUsage(usage) : null,
    estimated_cost_usd: null,
    unpriced_models: [...models].sort(),
  };
}

function renderUsageLine(label: string, summary: UsageSummary): string {
  const usage = summary.has_token_data && summary.usage
    ? Object.entries(summary.usage).map(([key, value]) => `${key}=${value}`).join(" ")
    : "token data missing";
  const models = summary.unpriced_models.length > 0 ? ` unpriced_models=${summary.unpriced_models.join(",")}` : "";
  return `${label}: ${usage} estimated_cost_usd=null${models}\n`;
}

function runUsageDate(run: RunLocation): string | null {
  const raw = run.status?.started_at ?? run.status?.updated_at ?? null;
  if (!raw) return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
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
      for (const item of verifier.acceptance) {
        process.stdout.write(`  - ${item.id}: ${item.status}${item.evidence ? ` — ${item.evidence}` : ""}\n`);
      }
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

  if (result.schema === "orch.result/researcher/v1") {
    const researcher = result as ResearcherResult;
    process.stdout.write(`\nrecommendation:\n  ${researcher.recommendation.replaceAll("\n", "\n  ")}\n`);
    const sections: Array<[string, string[]]> = [
      ["alternatives", researcher.alternatives],
      ["sources", researcher.sources],
      ["open_questions", researcher.open_questions],
      ["risks", researcher.risks],
    ];
    for (const [label, items] of sections) {
      process.stdout.write(`\n${label}:\n`);
      if (items.length === 0) {
        process.stdout.write("  - none\n");
      } else {
        for (const item of items) process.stdout.write(`  - ${item}\n`);
      }
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
  const zh = zhComments();
  if (result.schema === "orch.result/reviewer/v1") {
    return zh
      ? `阻断性发现 ${result.blocking_findings.length} 条,非阻断性发现 ${result.non_blocking_findings.length} 条。`
      : `${result.blocking_findings.length} blocking finding(s), ${result.non_blocking_findings.length} non-blocking finding(s).`;
  }
  if (result.schema === "orch.result/verifier/v1") {
    return zh
      ? `命令 ${result.commands.length} 条,验收项 ${result.acceptance.length} 项。`
      : `${result.commands.length} command(s), ${result.acceptance.length} acceptance item(s).`;
  }
  return zh ? "result.json 中无摘要。" : "No summary in result.json.";
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

// Comment-skeleton language, read at assembly time (mirror, decision outbox,
// cross-review --auto). The english branch must stay byte-identical to the
// historical output; only the exact config value 中文 flips the labels.
function zhComments(): boolean {
  return orchLanguage() === "中文";
}

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
    const truncated = zhComments() ? "…(该条发现已截断)" : "…(finding truncated)";
    const body = finding.body.length > MIRROR_FINDING_MAX_CHARS ? `${finding.body.slice(0, MIRROR_FINDING_MAX_CHARS)}${truncated}` : finding.body;
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
  const zh = zhComments();
  const t = (en: string, cn: string): string => (zh ? cn : en);
  switch (result.schema) {
    case "orch.result/reviewer/v1":
      return [
        ...mirrorFindingLines(t("Blocking findings", "阻断性发现"), result.blocking_findings),
        ...mirrorFindingLines(t("Non-blocking findings", "非阻断性发现"), result.non_blocking_findings),
        ...mirrorListLines(t("Suggested tests", "建议测试"), result.suggested_tests),
      ];
    case "orch.result/verifier/v1":
      return [
        ...mirrorListLines(t("Commands", "命令"), result.commands.map(commandLine)),
        ...mirrorListLines(t("Acceptance", "验收"), result.acceptance.map((item) => `${item.id}: ${item.status}${item.evidence ? ` — ${item.evidence}` : ""}`)),
      ];
    case "orch.result/implementer/v1":
      return [
        ...mirrorListLines(t("Tests", "测试"), result.tests.map(commandLine)),
        ...mirrorListLines(t("Acceptance", "验收"), result.acceptance.map((item) => `${item.id}: ${item.status}${item.evidence ? ` — ${item.evidence}` : ""}`)),
        ...mirrorListLines(t("Risks", "风险"), result.risks),
      ];
    case "orch.result/controller/v1":
      return mirrorListLines(t("Actions", "动作"), result.actions);
    case "orch.result/researcher/v1":
      return [
        t("Recommendation:", "建议方案:"),
        "",
        result.recommendation,
        "",
        ...mirrorListLines(t("Alternatives considered", "备选方案"), result.alternatives),
        ...mirrorListLines(t("Sources", "来源"), result.sources),
        ...mirrorListLines(t("Open questions", "未决问题"), result.open_questions),
        ...mirrorListLines(t("Risks", "风险"), result.risks),
      ];
    default:
      return [];
  }
}

function mirrorBody(mr: string, runId: string, result: RoleResult, status: RunStatus | null): string {
  const zh = zhComments();
  const lines = [
    zh ? "### orch 运行结果" : "### orch run result",
    "",
    `- MR/PR: ${mr}`,
    `- ${zh ? "运行" : "Run"}: ${runId}`,
    `- ${zh ? "状态" : "State"}: ${status?.state ?? "unknown"}`,
    `- ${zh ? "结论" : "Verdict"}: ${resultVerdict(result)}`,
    "",
    zh ? "摘要:" : "Summary:",
    "",
    resultSummary(result),
  ];
  const detail = resultDetailLines(result);
  if (detail.length > 0) lines.push("", ...detail);
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (body.length <= MIRROR_BODY_MAX_CHARS) return body;
  const truncated = zh
    ? `…(评论已截断;完整结果请运行 \`orch result --run ${runId}\` 查看)`
    : `…(comment truncated; run \`orch result --run ${runId}\` for the full result)`;
  return `${body.slice(0, MIRROR_BODY_MAX_CHARS)}\n\n${truncated}`;
}

function decisionBody(
  mr: string,
  runId: string,
  decision: DecisionRecord,
  result: RoleResult,
  status: RunStatus | null,
): string {
  const zh = zhComments();
  return [
    zh ? "### orch 决策" : "### orch decision",
    "",
    `- MR/PR: ${mr}`,
    `- ${zh ? "运行" : "Run"}: ${runId}`,
    `- ${zh ? "决策" : "Decision"}: ${decision.verdict}`,
    `- ${zh ? "理由" : "Reason"}: ${decision.reason ?? (zh ? "无" : "none")}`,
    `- ${zh ? "创建时间" : "Created"}: ${decision.ts}`,
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
  if (_role === "researcher" && agent === "pi") {
    throw new CliError("researcher role only supports the claude, codex, and omp agents");
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
  "resume-from",
  "idempotency-key",
  "retry",
  "allow-dirty",
  "timeout-sec",
  "session-mode",
  "session-name",
  "session-id",
  "allow-session-chain",
  "dry-run",
  "json",
] as const;

// --resume-from <run_id>: continue a prior run's provider session with a new
// task. The worker keeps its accumulated context — files read, reasoning,
// provider prompt cache — instead of re-reading the repo from zero. Typical
// use: dispatch the rework run against the implementer run the reviewer's
// blocking findings were about. Agent/role/mr/worktree/model are inherited
// from the prior run unless explicitly overridden (agent is never overridable:
// provider sessions are not portable across providers).
interface ResumeContext {
  run_id: string;
  mr: string;
  role: RunRole;
  agent: AgentName;
  worktree: string;
  session: ProviderSessionConfig;
}

async function resolveResumeFrom(args: ParsedArgs): Promise<ResumeContext> {
  const runId = flagString(args, "resume-from");
  for (const flag of ["session-mode", "session-id", "session-name"] as const) {
    if (args.flags.has(flag)) throw new CliError(`--${flag} conflicts with --resume-from; the session is inherited from the prior run`);
  }
  const probeWorktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(probeWorktree);
  const located = locateRun(repo.repo_key, runId, args.flags.has("mr") ? flagString(args, "mr") : undefined);
  const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
  if (!status) throw new CliError(`status.json not found for run: ${runId}`);
  if (!isTerminal(status.state)) throw new CliError(`run ${runId} is still ${status.state}; only terminal runs can be resumed`);
  if (status.provider_session_mode === "ephemeral") {
    throw new CliError(
      `run ${runId} ran with --session-mode ephemeral, so its provider session was not persisted; create resumable runs with fresh_persistent`,
    );
  }
  // provider_resume_id is backfilled from the native stream at terminal state;
  // an explicitly-resumed run may only carry the id in its session config.
  const resumeId = status.provider_resume_id ?? status.provider_session_id;
  if (!resumeId) throw new CliError(`run ${runId} recorded no provider session id; cannot resume`);
  if (args.flags.has("agent") && flagString(args, "agent") !== status.agent) {
    throw new CliError(
      `--agent ${flagString(args, "agent")} conflicts with --resume-from: run ${runId} ran on ${status.agent} and provider sessions are not portable`,
    );
  }
  if (status.agent === "claude" && !isUuid(resumeId)) {
    throw new CliError(`claude resume requires a UUID session id; run ${runId} recorded: ${resumeId}`);
  }
  const spec = readJsonFile<RunSpec | null>(`${located.run_dir}/spec.json`, null);
  const model = args.flags.has("model") ? flagString(args, "model").trim() : (spec?.model ?? null);
  if (model === "") throw new CliError("--model must not be empty");
  const worktree = args.flags.has("worktree") ? probeWorktree : existsSync(status.worktree) ? status.worktree : probeWorktree;
  return {
    run_id: runId,
    mr: located.mr,
    role: status.role,
    agent: status.agent,
    worktree,
    session: {
      provider_session_name: spec?.provider_session_name ?? null,
      provider_session_id: resumeId,
      provider_session_mode: "resume_exact",
      model,
    },
  };
}

// Session-chain guard. Pinning unrelated tasks onto one provider session
// measured as pure cost on a real thread (7 runs, ~150k-token context on every
// turn): per-turn prefill/attention grows while exploration turns do not
// shrink, and stale task residue steers new work. Session reuse is for
// continuing the SAME task — rework rounds under the same (or suffixed) tag,
// at most three runs per session. Anything else starts fresh and carries prior
// decisions in the task text; --allow-session-chain overrides deliberately.
const SESSION_CHAIN_MAX_RUNS = 3;

function assertSessionChainAllowed(mrDir: string, session: ProviderSessionConfig, tag: string, allow: boolean): void {
  if (allow || session.provider_session_mode !== "resume_exact" || !session.provider_session_id) return;
  const sessionId = session.provider_session_id;
  let entries: string[];
  try {
    entries = readdirSync(`${mrDir}/runs`);
  } catch {
    return; // no runs yet — nothing to chain onto
  }
  const bound: { run_id: string; tag: string }[] = [];
  for (const entry of entries) {
    const spec = readJsonFile<RunSpec | null>(`${mrDir}/runs/${entry}/spec.json`, null);
    if (!spec) continue;
    const status = readJsonFile<RunStatus | null>(`${mrDir}/runs/${entry}/status.json`, null);
    // A run is on this session when it consumed it (spec pinned the id) or
    // created/continued it (terminal backfill recorded the provider id).
    if (spec.provider_session_id === sessionId || status?.provider_resume_id === sessionId) {
      bound.push({ run_id: spec.run_id, tag: spec.tag });
    }
  }
  if (bound.length === 0) return;
  // Same task = same tag family: rework rounds drop their -r<N> suffix first
  // (memory-v1 ≙ memory-v1-r2 ≙ memory-v1-r3), then a prefix relation still
  // counts (taskx vs taskx-fix). Unrelated names never match.
  const family = (t: string) => t.replace(/-r\d+$/, "");
  const sameTask = (a: string, b: string) => {
    const fa = family(a);
    const fb = family(b);
    return fa === fb || fa.startsWith(fb) || fb.startsWith(fa);
  };
  const advice =
    "start a fresh session (the default) and carry prior decisions in the task text, or pass --allow-session-chain to chain deliberately";
  const foreign = bound.find((run) => !sameTask(run.tag, tag));
  if (foreign) {
    throw new CliError(
      `provider session ${sessionId} already belongs to task tag ${JSON.stringify(foreign.tag)} (run ${foreign.run_id}); refusing to reuse it for tag ${JSON.stringify(tag)} — chained sessions pay per-turn prefill on the accumulated context without reducing exploration turns; ${advice}`,
    );
  }
  if (bound.length >= SESSION_CHAIN_MAX_RUNS) {
    throw new CliError(
      `provider session ${sessionId} already hosts ${bound.length} runs (${bound.map((run) => run.run_id).join(", ")}); refusing a chain longer than ${SESSION_CHAIN_MAX_RUNS} — ${advice}`,
    );
  }
}

// Per-role defaults from config.json (defaults.agents); bare string = agent.
function configuredRoleDefaults(role: RunRole): RoleDefaults {
  const raw = readOrchConfig().defaults?.agents?.[role];
  if (!raw) return {};
  return typeof raw === "string" ? { agent: raw } : raw;
}

// Dry-run view of an execution plan: argv + the effective sandbox contract.
// plan.env is deliberately omitted — it is the worker's full environment.
function providerPlanPayload(plan: ProviderExecutionPlan, cwd: string) {
  return {
    argv: plan.argv,
    cwd,
    spawn: false as const,
    sandbox_engine: plan.sandboxEngine,
    sandbox_posture: plan.sandboxPosture,
    sandbox_profile_sha256: plan.profileSha256,
    provider_native_sandbox: plan.providerNativeSandbox,
  };
}

async function createRun(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "run create", RUN_CREATE_FLAGS);
  const resume = args.flags.has("resume-from") ? await resolveResumeFrom(args) : null;
  const role = resume && !args.flags.has("role") ? resume.role : (flagString(args, "role") as RunRole);
  // --agent/--model/--timeout-sec fall back to the per-role defaults in
  // config.json (defaults.agents) when omitted; explicit flags always win and
  // without either source the original "missing --agent" error stands.
  const roleDefaults = configuredRoleDefaults(role);
  const agent = resume
    ? resume.agent
    : args.flags.has("agent") || !roleDefaults.agent
      ? (flagString(args, "agent") as AgentName)
      : roleDefaults.agent;
  const tag = flagString(args, "tag", role);
  const worktree = resume ? resume.worktree : resolve(flagString(args, "worktree", process.cwd()));
  const taskFlag = args.flags.has("task") ? flagString(args, "task") : null;
  const taskPath = taskFlag !== null && taskFlag !== "-" ? resolve(taskFlag) : null;
  const taskText = taskFlag === "-" ? await readStdinText() : taskPath ? readFileSync(taskPath, "utf8") : "";
  if (taskFlag === "-" && !taskText.trim()) throw new CliError("--task - received empty stdin");
  const { mr, source: mrSource } =
    resume && !args.flags.has("mr") ? { mr: resume.mr, source: "resume-from" as const } : await resolveMr(args, taskText, worktree);
  // Reviewer runs finish in minutes in practice (52/67 recorded runs override
  // the old 4h default); keep the long default only for roles that build/test.
  const builtinTimeout = role === "reviewer" ? "3600" : "14400";
  const timeoutSec = Number(flagString(args, "timeout-sec", String(roleDefaults.timeout_sec ?? builtinTimeout)));

  if (!isRunRole(role)) {
    throw new CliError(`unsupported role: ${role} (valid: implementer, reviewer, verifier, controller, researcher)`);
  }
  validateRunAgent(agent, role);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new CliError("--timeout-sec must be positive");
  const providerSession = resume ? resume.session : providerSessionConfig(args, agent, roleDefaults.model ?? null);

  // Resolved exactly once here and threaded through to the spec, key,
  // compatibility check, dry-run, and startRun (F6): a config change between
  // two reads must not split the idempotency key from the recorded spec.
  const { engine: sandboxEngine, writeDirs: sandboxWriteDirs } = requestedSandboxEngine();
  const sandboxIdentity = sandboxRunIdentity(sandboxEngine, sandboxWriteDirs);

  const repo = await getRepoIdentity(worktree);
  const mrDir = mrStateDir(repo.repo_key, mr);
  const taskSha = sha256(taskText);
  // The engine version is part of the default fingerprint so sandboxed and
  // unsandboxed requests can never reuse each other's runs.
  const defaultIdempotencyKey = `mr${mr}:${tag}:${taskSha}:session-${providerSessionFingerprint(providerSession)}${sandboxIdentity.keySuffix}`;
  const idempotencyKey = flagString(args, "idempotency-key", defaultIdempotencyKey);
  const idempotencyPath = `${mrDir}/idempotency.json`;
  const dryRun = flagBool(args, "dry-run");
  if (dryRun) {
    const retry = flagBool(args, "retry");
    const dirty = await gitDirty(worktree);
    const baseSha = await gitHead(worktree);
    const existing = readIdempotency(idempotencyPath)[idempotencyKey];
    const existingSession = existing && !retry ? assertProviderSessionCompatible(existing, providerSession, agent) : null;
    if (existing && !retry) assertSandboxCompatible(existing, sandboxEngine, role);
    const effectiveSession = existingSession ?? providerSession;
    const idempotent = Boolean(existing && !retry);
    // Same guard as the real create; an idempotent hit reuses an existing run
    // and chains nothing new.
    if (!idempotent) assertSessionChainAllowed(mrDir, effectiveSession, tag, flagBool(args, "allow-session-chain"));
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
      ...(orchLanguage() === "中文" ? { language: "中文" as const } : {}),
      ...sandboxIdentity.specField,
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
      // Same plan builder as the real spawn (dryRun only skips host
      // mutations), so a sandbox that would fail — wrong platform, missing
      // provider state, hardlinked worktree — fails the dry-run too.
      provider_plan: idempotent
        ? null
        : providerPlanPayload(
            buildProviderExecutionPlan({
              provider: agent,
              spec: specPreview,
              runDir,
              worktree,
              prompt: buildPrompt(specPreview, agent),
              dryRun: true,
            }),
            worktree,
          ),
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
      if (payload.provider_plan) {
        const plan = payload.provider_plan;
        // The multi-line SBPL profile would drown the text view; stand in its
        // hash (the JSON payload carries the full argv).
        const argv =
          plan.argv[0] === "/usr/bin/sandbox-exec" && plan.argv[1] === "-p"
            ? [plan.argv[0], plan.argv[1], `<sbpl sha256=${plan.sandbox_profile_sha256}>`, ...plan.argv.slice(3)]
            : plan.argv;
        lines.push(`provider: ${argv.join(" ")}`);
        lines.push(`sandbox: ${plan.sandbox_engine}/${plan.sandbox_posture}`);
      }
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
      sandboxEngine,
      sandboxWriteDirs,
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
  // Resolved once by the caller (createRun) and passed in immutable, so the
  // spec startRun writes cannot diverge from the idempotency key createRun
  // built from an earlier config read (F6).
  sandboxEngine: typeof SEATBELT_ENGINE | null;
  sandboxWriteDirs: string[];
}

// Spawns a single supervised run and returns its create payload. Shared by
// `run create` and the fan-out commands (cross-review / fanout / investigate).
async function startRun(input: StartRunInput): Promise<Record<string, unknown>> {
  const { args, mr, role, agent, tag, worktree, taskPath, taskText, taskSha, timeoutSec } = input;
  const { providerSession, repo, mrDir, idempotencyKey, idempotencyPath, sandboxEngine, sandboxWriteDirs } = input;
  const sandboxIdentity = sandboxRunIdentity(sandboxEngine, sandboxWriteDirs);

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
      assertSandboxCompatible(existing, sandboxEngine, role);
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

    assertSessionChainAllowed(mrDir, providerSession, tag, flagBool(args, "allow-session-chain"));

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
      ...(orchLanguage() === "中文" ? { language: "中文" as const } : {}),
      ...sandboxIdentity.specField,
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
      // Watchdog: poll is a bounded one-shot contract (cron/launchd drive it).
      // Anything that still hangs past the socket timeouts (2026-07-11: a
      // half-open IMAP connection held the ingest lock ~20h and stalled the
      // whole mail pipeline) must terminate so the next poll can take over —
      // a dead pid's pidfile lock is reclaimed on the next acquire.
      const watchdog = setTimeout(() => {
        process.stderr.write("mailctl poll watchdog: still running after 15m; exiting so the next scheduled poll can take over\n");
        process.exit(1);
      }, 15 * 60 * 1000);
      watchdog.unref?.();
      const dryRun = flagBool(args, "dry-run");
      const ctx = mailctlContext(context, dryRun ? dryRunMailTransport() : undefined);
      const result = await mailctlPoll(ctx, { reconcile: !dryRun, sync: !dryRun });
      clearTimeout(watchdog);
      if (flagBool(args, "json")) printJson(result);
      else process.stdout.write(pollSummary(result, dryRun));
      return 0;
    }

    if (mode === "sync") {
      assertKnownFlags(args, "mailctl sync", ["mr", "execute", "json"]);
      const result = await mailctlSync(mailctlContext(context), {
        mr: args.flags.has("mr") ? flagString(args, "mr") : undefined,
        execute: flagBool(args, "execute"),
      });
      if (flagBool(args, "json")) printJson({ mailctl: "sync", ...result });
      else {
        const reportKeys = result.mrs.flatMap((mr) => mr.report_keys);
        const roots = result.mrs.filter((mr) => mr.create_root).map((mr) => mr.mr);
        process.stdout.write(
          [
            `mailctl sync${result.dry_run ? " dry-run" : ""}: skipped=${result.skipped}`,
            `would_create_roots: ${roots.join(", ") || "none"}`,
            `report_keys: ${reportKeys.join(", ") || "none"}`,
            `sent: ${result.sent.length}`,
            `pending: ${result.pending.length}`,
          ].join("\n") + "\n",
        );
      }
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

  process.stderr.write("usage: orch mailctl init|poll|watch|status|sync|reply|ack|guidance|attachments|attachment [flags]\n");
  return 2;
}

// cross-review: one diff reviewed in parallel by distinct model families.
// --auto inlines the follow-up ritual: wait for this fan-out's runs to settle,
// record the unambiguous decisions, queue ONE merged mirror comment (dry-run
// preview unless --execute).
async function crossReview(args: ParsedArgs): Promise<number> {
  const auto = flagBool(args, "auto");
  for (const flag of ["execute", "wait-sec"]) {
    if (!auto && args.flags.has(flag)) throw new CliError(`--${flag} requires --auto`);
  }
  const outcome = await mailFanout(args, mailFanoutContext(), {
    command: "cross-review",
    role: "reviewer",
    defaultAgentIds: ["claude-reviewer", "omp-reviewer"],
    extraFlags: ["auto", "execute", "wait-sec"],
  });
  if (!auto || outcome.code !== 0 || outcome.dry_run) {
    printJson(outcome.payload);
    return outcome.code;
  }
  return crossReviewAuto(args, outcome);
}

// fanout: generic — run any result role across --to-agent / auto-invited agents.
async function fanout(args: ParsedArgs): Promise<number> {
  const outcome = await mailFanout(args, mailFanoutContext(), { command: "fanout" });
  printJson(outcome.payload);
  return outcome.code;
}

// investigate: read-only research/analysis, defaults to the gemini + claude
// researchers. Researcher (not reviewer) role: research questions deliver a
// recommendation, not an approve/request_changes verdict.
async function investigate(args: ParsedArgs): Promise<number> {
  const outcome = await mailFanout(args, mailFanoutContext(), {
    command: "investigate",
    role: "researcher",
    defaultAgentIds: ["omp-researcher", "claude-researcher"],
  });
  printJson(outcome.payload);
  return outcome.code;
}

// ---------------------------------------------------------------------------
// orch new: one-sentence task -> researcher drafts a plan -> human confirms in
// the terminal -> the same provider session resumes as a controller and
// dispatches/drives the work. Plan phase is mechanically read-only (researcher
// role); only the confirmed session gets the controller's `Bash(orch *)` reach.

const NEW_FLAGS = ["workspace", "worktree", "mr", "model", "timeout-sec", "yes"] as const;

function newMrSlug(description: string, now = new Date()): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  // Non-ASCII descriptions (e.g. Chinese) slug to nothing; fall back to the date.
  return slug || now.toISOString().slice(0, 10).replaceAll("-", "");
}

function newPlanTask(mr: string, description: string): string {
  return [
    "# orch new — planning phase",
    "",
    "Inspect the actual repository and return a self-contained execution plan; change nothing.",
    `Thread/MR for the eventual runs: ${mr}`,
    "",
    "## Task request",
    description,
    "",
    "## Deliverable (orch.result/researcher/v1)",
    "Put the plan in recommendation using exactly this Markdown grammar:",
    "",
    "## Destination",
    "1-2 lines describing the observable finished state.",
    "",
    "## Out of scope",
    "Explicit exclusions, or `None`.",
    "",
    "## Tasks (now)",
    "### kebab-case-task-name",
    "- Role: implementer|reviewer|verifier",
    "- After: none|earlier-task-name[, earlier-task-name]",
    "- Spec: one self-contained paragraph with prerequisites and constraints",
    "- Acceptance:",
    "  - one observable check",
    "",
    "## Later (not yet specified)",
    "Optional follow-up outside this Destination, or `None`. Anything required",
    "to reach Destination must be a Tasks (now) item, even when it has prerequisites.",
    "",
    "Rules:",
    "- Include at least one task. After may name only earlier tasks; use `none`",
    "  for the initial frontier. Order tasks by execution dependency.",
    "- Keep implementation choices open unless the repo or request makes them constraints.",
    "- implementer Specs verify once, scoped to the touched modules, after all edits;",
    "  put repo-wide or full-module test suites in a separate verifier task",
    "  (After: that implementer), never inside the implementer's loop.",
    "- recommendation is the current source of truth: no historical commentary or superseded choices.",
    "- Each open_questions entry must end with either `— recommended: <safe default>`",
    "  or `— blocking: <why execution cannot safely choose>`. Use blocking only when",
    "  no defensible default exists. Leave open_questions empty when unambiguous.",
    "- Put risks and alternatives in their schema fields, not extra recommendation headings.",
  ].join("\n");
}

function newPlanRevisionTask(answer: string, acceptDefaults = false): string {
  return [
    "# orch new — final plan revision",
    "",
    acceptDefaults ? "The human accepted every recommended default below:" : "Human answer / amendment:",
    "",
    answer,
    "",
    "Return a new self-contained orch.result/researcher/v1 result. Integrate these",
    "choices directly into recommendation, remove superseded choices and historical",
    "commentary, and remove every resolved item from open_questions. Keep the exact",
    "Destination / Out of scope / Tasks (now) / Later (not yet specified) grammar",
    "from the planning request. Do not merely append an answers section.",
  ].join("\n");
}

function newExecTask(mr: string, worktree: string, plan: string): string {
  return [
    "# orch new — execution controller",
    "",
    "You are HEADLESS and NON-INTERACTIVE. Execute `orch ...` commands directly.",
    "You may inspect files but never edit them; dispatch workers for all changes.",
    `Thread/MR: ${mr}`,
    `Worktree: ${worktree}`,
    "",
    "## Final resolved plan (sole execution authority)",
    plan,
    "",
    "## Protocol",
    "- Dispatch only tasks whose `After` dependencies have accepted results. Later",
    "  is explicitly outside this run's Destination: do not dispatch it.",
    "- Author every worker task inline; workers do not share your context:",
    `    orch fanout --thread ${mr} --role <role> --task - <<'EOF' ... EOF`,
    `    orch cross-review --thread ${mr} --task - <<'EOF' ... EOF`,
    `    orch run create --mr ${mr} --role <role> --agent <codex|claude|pi|omp> --tag <name> --task - <<'EOF' ... EOF`,
    "    orch run create --resume-from <run_id> --tag <name> --task - <<'EOF' ... EOF",
    "- Put the complete Spec, constraints, relevant ADR/spec excerpts, and Acceptance",
    "  checks into each worker task. Tag direct/rework runs with the plan task name;",
    "  fanout/cross-review auto-tag their runs.",
    "- Implementer tasks verify once, scoped to the modules they touch; dispatch",
    "  repo-wide or full-module test suites as a verifier run after the implementer",
    "  result is accepted, never inside the implementer's loop.",
    `- Reconcile persisted evidence: orch wait --thread ${mr}; inspect each result;`,
    `  record orch decision accept|rework --mr ${mr} --run <id> --reason '...'.`,
    "- Use semantic judgment for decisions, but stop after 2 reworks for one task.",
    "- Finish only after every dispatched run is terminal and has a decision. Report",
    "  unresolved blockers instead of claiming success. Return only controller result JSON.",
  ].join("\n");
}

// Terminal Q&A input rides node:readline in terminal mode: per-character line
// editing (CJK/emoji deletes stay atomic, width math is east-asian aware —
// verified identical to Node v24), emacs keybindings (C-a/C-e/C-w/C-u, arrows),
// and history across replan rounds. Bun's process.stdin/stderr typings clash
// with node:readline's stream types; the casts are runtime-safe.
function newReadline(): ReadlineInterface {
  return createInterface({ input: process.stdin, output: process.stderr } as unknown as ReadLineOptions);
}

function newAskLine(rl: ReadlineInterface, promptText: string): Promise<string> {
  return new Promise((resolveAnswer) => rl.question(promptText, resolveAnswer));
}

// `e` at the prompt: multi-line answers go through $VISUAL/$EDITOR on a draft
// file seeded with the open questions (git-commit style; `#` lines stripped).
// Returns null when the editor exits non-zero (vim `:cq`) — caller re-prompts.
async function newEditAnswer(mrDir: string, rl: ReadlineInterface, openQuestions: string[]): Promise<string | null> {
  const draftPath = `${mrDir}/tasks/answer-draft.md`;
  writeTextAtomic(
    draftPath,
    [
      "# orch new — 多行回答/修改意见。# 开头的行会被忽略;保存退出即提交;清空(或只留注释)=按当前方案执行;:cq 退出=放弃本次回答。",
      ...openQuestions.map((question, index) => `# Q${index + 1}. ${question.replaceAll("\n", " ")}`),
      "",
    ].join("\n"),
  );
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "vi";
  // Hand the terminal to the editor: drop raw mode while it runs, restore after.
  rl.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const proc = Bun.spawn(["/bin/sh", "-c", `${editor} "$1"`, "orch-new-editor", draftPath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  rl.resume();
  if (code !== 0) {
    process.stderr.write(`[orch new] editor exited ${code}; 本次回答已丢弃\n`);
    return null;
  }
  return readFileSync(draftPath, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

interface NewRunHandle {
  run_id: string;
  status_path: string;
  result_path: string;
}

// Spawn `orch run create ... --json` as a subprocess (same pattern as mail
// claim) so newCommand's own stdout stays reserved for its final JSON payload.
async function newSpawnRunCreate(argv: string[], worktree: string): Promise<NewRunHandle> {
  const proc = Bun.spawn([...orchCommand(), "run", "create", ...argv, "--json"], {
    cwd: worktree,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new CliError(`orch run create failed: ${(stderr.trim() || stdout.trim()).slice(0, 800)}`);
  const payload = JSON.parse(stdout) as { run_id: string; status_path: string; result_path?: string; run_dir?: string };
  return {
    run_id: payload.run_id,
    status_path: payload.status_path,
    result_path: payload.result_path ?? `${payload.run_dir}/result.json`,
  };
}

async function newWaitRun(handle: NewRunHandle, label: string): Promise<RunStatus> {
  let lastState = "";
  for (;;) {
    const status = readJsonFile<RunStatus | null>(handle.status_path, null);
    if (status && status.state !== lastState) {
      lastState = status.state;
      process.stderr.write(`[orch new] ${label} ${handle.run_id}: ${status.state}\n`);
    }
    if (status && isTerminal(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function newReadPlanResult(handle: NewRunHandle, status: RunStatus): ResearcherResult {
  const result = readJsonFile<RoleResult | null>(handle.result_path, null);
  if (status.state !== "done" || !result || result.schema !== "orch.result/researcher/v1" || result.verdict !== "completed") {
    throw new CliError(
      `plan run ${handle.run_id} ended ${status.state}${result ? ` (${resultVerdict(result)})` : ""}; inspect: orch result --mr ${status.mr} --run ${handle.run_id} --worktree ${status.worktree}`,
    );
  }
  const validation = validateNewPlanMarkdown(result.recommendation);
  if (!validation.ok) {
    throw new CliError(
      `plan run ${handle.run_id} returned an invalid orch new plan:\n${validation.errors.map((error) => `- ${error}`).join("\n")}\ninspect: orch result --mr ${status.mr} --run ${handle.run_id} --worktree ${status.worktree}`,
    );
  }
  return result;
}

function newRenderPlan(result: ResearcherResult): void {
  const write = (line: string) => process.stderr.write(`${line}\n`);
  write("");
  write("## Proposed plan");
  write(result.recommendation);
  if (result.open_questions.length > 0) {
    write("");
    write("## Open questions");
    result.open_questions.forEach((question, index) => write(`${index + 1}. ${question}`));
  }
  if (result.risks.length > 0) {
    write("");
    write("## Risks");
    for (const risk of result.risks) write(`- ${risk}`);
  }
  write("");
}

function newRecommendedDefaults(result: ResearcherResult): { text: string; blocking: string[] } {
  const questions = classifyNewOpenQuestions(result.open_questions);
  return {
    text: questions.defaults.map((item, index) => `${index + 1}. ${item.question}\n   Accepted default: ${item.value}`).join("\n"),
    blocking: questions.blocking,
  };
}

function newExecutionRuns(repoKey: string, mr: string, baseline: Set<string>, execRunId: string): NewExecutionRun[] {
  return collectMrRuns(repoKey, mr)
    .filter((run) => !baseline.has(run.run_id) && run.run_id !== execRunId)
    .map((run) => {
      const decision = readJsonFile<DecisionRecord | null>(`${mrStateDir(repoKey, mr)}/runs/${run.run_id}/decision.json`, null);
      return {
        run_id: run.run_id,
        role: run.role,
        state: run.state,
        stale: run.stale,
        verdict: run.verdict,
        decision: decision && decision.run_id === run.run_id && (decision.verdict === "accept" || decision.verdict === "rework" || decision.verdict === "close")
          ? decision.verdict
          : null,
      };
    });
}

async function newCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "new", NEW_FLAGS);
  const description = (args.positionals[1] ?? "").trim();
  if (!description) throw new CliError("usage: orch new '<task description>' [--workspace <id>] [flags]");
  const yes = flagBool(args, "yes");
  if (!process.stdin.isTTY && !yes) {
    throw new CliError("orch new is interactive; pass --yes to accept the recommended plan without confirmation");
  }

  let worktree: string;
  if (args.flags.has("worktree")) {
    worktree = resolve(flagString(args, "worktree"));
  } else if (args.flags.has("workspace")) {
    const id = flagString(args, "workspace");
    const workspace = readOrchConfig().workspaces[id];
    if (!workspace) throw new CliError(`unknown workspace: ${id} (register with: orch workspace add --id ${id} --path <path>)`);
    worktree = workspace.path;
  } else {
    worktree = process.cwd();
  }

  const repo = await getRepoIdentity(worktree);
  let mr: string;
  let mrDir: string;
  if (args.flags.has("mr")) {
    // Explicit --mr keeps its reuse semantics and never gets a guessed ref.
    mr = flagString(args, "mr");
    mrDir = mrStateDir(repo.repo_key, mr);
  } else {
    // Exclusive claim: a suffix collision (concurrent orch new or a
    // historical id) must regenerate, never share the other task's state —
    // an inherited forge_ref would publish comments to the other task's MR.
    ({ mr, mrDir } = claimNewMrDir(repo.repo_key, newMrSlug(description)));
    // Pin the forge ref only for the freshly claimed local id, and only when
    // the description names exactly one same-repo MR/PR URL. Mirrored
    // comments are outward side effects; an ambiguous or cross-repo URL
    // fails closed to the plain slug behavior.
    const forgeRef = mrRefFromText(description, repo.remote_url);
    if (forgeRef) writeForgeRef(mrDir, forgeRef);
  }
  mkdirSync(`${mrDir}/tasks`, { recursive: true });

  // The exec controller dispatches through the mail layer; seed the default
  // roster on first use only (a non-empty roster may carry user customization).
  if (Object.keys(readMailAgentsConfig().agents).length === 0) {
    process.stderr.write("[orch new] no mail agents configured; running `orch mail agent defaults`\n");
    const seeded = Bun.spawn([...orchCommand(), "mail", "agent", "defaults"], { cwd: worktree, stdout: "ignore", stderr: "pipe", env: process.env });
    if ((await seeded.exited) !== 0) throw new CliError(`orch mail agent defaults failed: ${await new Response(seeded.stderr).text()}`);
  }

  const passthrough: string[] = ["--model", args.flags.has("model") ? flagString(args, "model") : "fable"];
  if (args.flags.has("timeout-sec")) passthrough.push("--timeout-sec", flagString(args, "timeout-sec"));

  const planTaskPath = `${mrDir}/tasks/plan.md`;
  writeTextAtomic(planTaskPath, newPlanTask(mr, description));
  process.stderr.write(`[orch new] mr ${mr} · worktree ${worktree}\n`);
  let handle = await newSpawnRunCreate(
    ["--mr", mr, "--role", "researcher", "--agent", "claude", "--tag", "plan", "--worktree", worktree, "--task", planTaskPath, ...passthrough],
    worktree,
  );
  process.stderr.write(`[orch new] watch: orch events tail --run ${handle.run_id} --mr ${mr} --native -f\n`);
  const planRuns: string[] = [handle.run_id];
  let plan = newReadPlanResult(handle, await newWaitRun(handle, "plan"));
  newRenderPlan(plan);

  let revision = 1;
  const revisePlan = async (answer: string, acceptDefaults = false): Promise<void> => {
    revision += 1;
    const revisionPath = `${mrDir}/tasks/plan-round-${revision}.md`;
    writeTextAtomic(revisionPath, newPlanRevisionTask(answer, acceptDefaults));
    handle = await newSpawnRunCreate(
      // First-party deliberate chain: replan rounds continue the plan session
      // by design, past any session-chain depth cap.
      ["--resume-from", handle.run_id, "--tag", `plan-r${revision}`, "--task", revisionPath, "--allow-session-chain"],
      worktree,
    );
    planRuns.push(handle.run_id);
    plan = newReadPlanResult(handle, await newWaitRun(handle, "plan"));
    newRenderPlan(plan);
  };

  if (yes) {
    const defaults = newRecommendedDefaults(plan);
    if (defaults.blocking.length > 0) {
      throw new CliError(`orch new --yes cannot answer blocking plan questions:\n${defaults.blocking.map((question) => `- ${question}`).join("\n")}`);
    }
    if (defaults.text) await revisePlan(defaults.text, true);
    if (plan.open_questions.length > 0) {
      throw new CliError(`final plan still has unresolved questions after applying recommended defaults:\n${plan.open_questions.map((question) => `- ${question}`).join("\n")}`);
    }
  } else {
    const rl = newReadline();
    try {
      for (;;) {
        process.stderr.write("回车=按当前方案执行 · 输入回答/修改意见=再规划一轮 · e=编辑器多行回答 · q=放弃\n");
        const raw = (await newAskLine(rl, "> ")).trim();
        if (raw.toLowerCase() === "q") {
          process.stderr.write(`[orch new] aborted; plan run(s) kept for audit under mr ${mr}\n`);
          printJson({ new: mr, worktree, state: "aborted", plan_runs: planRuns });
          return 1;
        }
        const answer = raw.toLowerCase() === "e" ? await newEditAnswer(mrDir, rl, plan.open_questions) : raw;
        if (answer === null) continue;
        if (answer !== "") {
          await revisePlan(answer);
          continue;
        }
        const defaults = newRecommendedDefaults(plan);
        if (defaults.blocking.length > 0) {
          process.stderr.write(`[orch new] execution blocked; answer or amend these questions:\n${defaults.blocking.map((question) => `  - ${question}`).join("\n")}\n`);
          continue;
        }
        if (defaults.text) {
          await revisePlan(defaults.text, true);
          if (plan.open_questions.length > 0) continue;
        }
        break;
      }
    } finally {
      rl.close();
    }
  }

  const execTaskPath = `${mrDir}/tasks/exec.md`;
  writeTextAtomic(execTaskPath, newExecTask(mr, worktree, plan.recommendation));
  const baselineRuns = new Set(collectMrRuns(repo.repo_key, mr).map((run) => run.run_id));
  const execHandle = await newSpawnRunCreate(
    // First-party deliberate chain: the confirmed plan session resumes as the
    // exec controller by design (different tag, same session).
    ["--resume-from", handle.run_id, "--role", "controller", "--tag", "exec", "--task", execTaskPath, "--allow-session-chain"],
    worktree,
  );
  process.stderr.write(`[orch new] executing; follow along: orch wait --thread ${mr} · orch events tail --mr ${mr} -f --native\n`);
  // When config sandbox is on, the controller runs under Seatbelt and cannot
  // spawn workers itself; it enqueues them to the dispatch queue. This
  // unsandboxed parent drains that queue in-process for the controller's whole
  // lifetime, so dispatched workers are spawned host-side with project-write.
  let controllerDone = false;
  const reconcile = reconcileDispatchWatch(orchCommand(), () => controllerDone);
  const execStatus = await newWaitRun(execHandle, "exec").finally(() => {
    controllerDone = true;
  });
  await reconcile;
  const execResult = readJsonFile<RoleResult | null>(execHandle.result_path, null);
  if (execResult && "summary" in execResult) process.stderr.write(`\n[orch new] controller summary: ${execResult.summary}\n`);
  if (execResult && execResult.schema === "orch.result/controller/v1") {
    for (const action of execResult.actions) process.stderr.write(`  - ${action}\n`);
  }

  const controllerOk =
    execStatus.state === "done" &&
    execResult?.schema === "orch.result/controller/v1" &&
    execResult.verdict === "completed";
  const workers = evaluateNewExecution(controllerOk, newExecutionRuns(repo.repo_key, mr, baselineRuns, execHandle.run_id));
  printJson({
    new: mr,
    worktree,
    state: workers.ok ? "completed" : "needs_attention",
    plan_runs: planRuns,
    exec_run: execHandle.run_id,
    exec_state: execStatus.state,
    exec_verdict: execResult ? resultVerdict(execResult) : null,
    workers: {
      total: workers.total,
      handled: workers.handled,
      failed: workers.failed,
      undecided: workers.undecided,
      closed: workers.closed,
      rework_pending: workers.rework_pending,
    },
    follow_up: [`orch verdict --thread ${mr}`, `orch result --mr ${mr} --run ${execHandle.run_id}`, "orch"],
  });
  return workers.ok ? 0 : 1;
}

function runIdOfClaim(run: unknown): string | null {
  if (run && typeof run === "object" && typeof (run as { run_id?: unknown }).run_id === "string") {
    return (run as { run_id: string }).run_id;
  }
  return null;
}

// A fallback result's synthetic finding is a driver error message, not a
// review; the comment carries the recovered raw review text instead.
function unparsedRunSection(mr: string, runId: string, state: string, raw: string): string {
  const zh = zhComments();
  const truncated = zh
    ? `…(原始评审已截断;其余内容请运行 \`orch result --run ${runId}\` 查看)`
    : `…(raw review truncated; run \`orch result --run ${runId}\` for the rest)`;
  const text = raw.length > MIRROR_BODY_MAX_CHARS ? `${raw.slice(0, MIRROR_BODY_MAX_CHARS)}\n\n${truncated}` : raw;
  return [
    zh ? "### orch 运行结果" : "### orch run result",
    "",
    `- MR/PR: ${mr}`,
    `- ${zh ? "运行" : "Run"}: ${runId}`,
    `- ${zh ? "状态" : "State"}: ${state}`,
    zh ? "- 结论: unparsed(driver schema 回退 — 原始评审见下)" : "- Verdict: unparsed (driver schema fallback — raw review below)",
    "",
    text,
  ].join("\n");
}

// The auto phase acts only on the runs THIS fan-out claimed — never on the
// thread's history — and decides only unambiguous outcomes (planAutoDecision).
// Rework/fallback/failed runs are surfaced with the exact follow-up command
// instead of being auto-driven: no unbounded impl↔review loops.
async function crossReviewAuto(args: ParsedArgs, outcome: MailFanoutOutcome): Promise<number> {
  const execute = flagBool(args, "execute");
  const waitSec = flagNumber(args, "wait-sec") ?? 900;
  if (!Number.isFinite(waitSec) || waitSec <= 0) throw new CliError("--wait-sec must be positive");
  const runIds = new Set(outcome.runs.map((item) => runIdOfClaim(item.run)).filter((id): id is string => id !== null));
  if (runIds.size === 0) {
    printJson({
      ...outcome.payload,
      auto: "skipped",
      reason: `no new runs claimed (thread tasks already acked); follow up with: orch verdict --thread ${outcome.thread} --wait`,
    });
    return 0;
  }
  const mr = outcome.runs[0]!.mr;
  const repoKey = outcome.repo_key;

  const deadline = Date.now() + waitSec * 1000;
  let tracked = collectMrRuns(repoKey, mr).filter((run) => runIds.has(run.run_id));
  while (!(tracked.length === runIds.size && tracked.every((run) => isTerminal(run.state) || run.stale))) {
    if (Date.now() >= deadline) {
      throw new CliError(
        `--auto timed out after ${waitSec}s (${tracked.filter((run) => isTerminal(run.state)).length}/${runIds.size} terminal); runs continue — follow up with: orch verdict --thread ${outcome.thread} --wait`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    tracked = collectMrRuns(repoKey, mr).filter((run) => runIds.has(run.run_id));
  }

  const mrDir = mrStateDir(repoKey, mr);
  ensureStateLayout(mrDir);
  const runsRoot = `${mrDir}/runs`;
  const ts = new Date().toISOString();

  // Pass 1 — read-only: results, decision plans, comment sections. Nothing is
  // written until the merged body has passed the leak guard, mirroring
  // decision()'s ordering: a body that can't be mirrored must never leave
  // decided-but-unmirrored runs behind (recovery would hit EEXIST).
  const zh = zhComments();
  const sections: string[] = [];
  const attention: string[] = [];
  const reportRuns: Array<Record<string, unknown>> = [];
  const plans: Array<{ run_id: string; decision: "accept" | "rework"; reason: string | null; report: Record<string, unknown> }> = [];
  for (const run of tracked) {
    // failed/timeout/stale runs may never have written result.json; surface
    // them instead of crashing — and never decide a run without a result.
    const result = readJsonFile<RoleResult | null>(`${runsRoot}/${run.run_id}/result.json`, null);
    const status = readJsonFile<RunStatus | null>(`${runsRoot}/${run.run_id}/status.json`, null);
    const raw = result ? fallbackRawReview(`${runsRoot}/${run.run_id}`, result) : null;
    const plan =
      result === null
        ? { decision: null, reason: null, attention: `no result.json; inspect: orch events tail --run ${run.run_id} --native` }
        : planAutoDecision(run, raw !== null);
    if (plan.attention) attention.push(`${run.run_id} (${run.agent}): ${plan.attention}`);

    const verdict = result === null ? null : raw !== null ? "unparsed" : run.verdict;
    let section =
      result === null
        ? [
            zh ? "### orch 运行结果" : "### orch run result",
            "",
            `- MR/PR: ${mr}`,
            `- ${zh ? "运行" : "Run"}: ${run.run_id}`,
            `- ${zh ? "状态" : "State"}: ${run.state}`,
            zh ? "- 结论: 无(缺少 result.json)" : "- Verdict: none (no result.json)",
          ].join("\n")
        : raw !== null
          ? unparsedRunSection(mr, run.run_id, run.state, raw)
          : mirrorBody(mr, run.run_id, result, status);
    // Reviewer prose quotes absolute local paths as a matter of course:
    // relativize the known prefixes, and withhold a section that still trips
    // the guard rather than aborting the whole auto phase on honest content.
    section = sanitizeCommentBody(section, outcome.worktree, process.env.HOME);
    const leak = privateLeakAllowed() ? null : findPrivateLeak(section);
    if (leak) {
      // The marker string may only go to stdout (attention), never into the
      // comment body — it would re-trigger the leak guard on the merged body.
      section = withheldSection(mr, run.run_id, run.state, verdict ?? "-");
      attention.push(`${run.run_id} (${run.agent}): comment section withheld (private path ${leak.marker})`);
    }
    sections.push(section);

    const report: Record<string, unknown> = {
      run_id: run.run_id,
      agent: run.agent,
      state: run.state,
      verdict,
      blocking: run.blocking,
      decision: plan.decision,
      attention: plan.attention,
    };
    reportRuns.push(report);
    if (plan.decision) plans.push({ run_id: run.run_id, decision: plan.decision, reason: plan.reason, report });
  }

  const header = [
    zh ? "### orch 交叉评审" : "### orch cross-review",
    "",
    `- MR/PR: ${mr}`,
    `- ${zh ? "线程" : "Thread"}: ${outcome.thread}`,
    `- ${zh ? "运行" : "Runs"}: ${tracked.map((run) => `${run.agent}/${run.run_id}`).join(", ")}`,
  ].join("\n");
  let body = [header, ...sections].join("\n\n---\n\n");
  // Per-section caps don't bound the sum; GitHub rejects comments over 65536.
  if (body.length > MIRROR_BODY_MAX_CHARS) {
    const truncated = zh
      ? "…(评论已截断;完整结果请运行 `orch result --run <run_id>` 查看)"
      : "…(comment truncated; run `orch result --run <run_id>` for the full results)";
    body = `${body.slice(0, MIRROR_BODY_MAX_CHARS)}\n\n${truncated}`;
  }
  assertMirrorBodySafe(body); // before any write: a leaky body aborts cleanly with nothing recorded

  const forge = detectForge(outcome.remote_url);
  const adapter = forge === "none" ? null : createForgeAdapter(forge, execute, outcome.worktree);
  if (forge !== "none" && !adapter) throw new CliError(`unsupported forge: ${forge}`);

  // On --execute, hold the outbox lock across enqueue→post→rename: enqueueing
  // outside the lock lets a concurrent `mirror sync --execute` send the pending
  // file first and this command post the same comment a second time.
  const outboxLock = execute ? await acquirePidfileLockWait(`${mrDir}/locks/outbox.lock`, 10_000) : null;
  let comment: Record<string, unknown>;
  let sendFailed = false;
  let queuedName: string | null = null;
  try {
    const outboxPath = enqueueComment(mrDir, { kind: "comment", mr, body, created_at: ts });
    queuedName = basename(outboxPath);
    for (const plan of plans) {
      try {
        writeJsonExclusive(`${runsRoot}/${plan.run_id}/decision.json`, { verdict: plan.decision, run_id: plan.run_id, reason: plan.reason, ts });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        plan.report.decision = "already-decided";
      }
    }
    comment = { outbox_path: outboxPath, mode: "queued", forge };
    if (adapter) {
      const command = await adapter.postComment(forgeRefFor(mrDir, mr), body);
      const success = command.exit_code === 0;
      let finalPath = outboxPath;
      if (execute && success) {
        finalPath = `${sentOutboxDir(mrDir)}/${basename(outboxPath)}`;
        renameSync(outboxPath, finalPath);
      }
      sendFailed = execute && !success;
      comment = {
        outbox_path: finalPath,
        mode: execute ? (success ? "sent" : "failed") : "dry-run",
        forge,
        command: argvForDisplay(command.argv),
        exit_code: command.exit_code,
      };
      if (command.stderr) process.stderr.write(command.stderr);
    } else {
      comment = { ...comment, note: "no github/gitlab remote; comment stays queued" };
    }
  } finally {
    outboxLock?.release();
  }

  // --auto sends only its own comment; older queued comments stay untouched.
  const otherPending = pendingOutboxFiles(mrDir).filter((file) => file !== queuedName);
  printJson({
    mail: "cross-review",
    auto: true,
    thread: outcome.thread,
    mr,
    fanout: outcome.payload,
    runs: reportRuns,
    comment,
    attention,
    ...(otherPending.length > 0 ? { other_pending_outbox: otherPending.length, other_pending_hint: `orch mirror sync --mr ${mr}` } : {}),
    ...(execute ? {} : { next: `orch mirror sync --mr ${mr} --execute` }),
  });
  return sendFailed ? 1 : 0;
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

async function runCancel(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "run cancel", ["run", "mr", "worktree", "reason", "force"]);
  const runId = flagString(args, "run");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const located = locateRun(repo.repo_key, runId, args.flags.has("mr") ? flagString(args, "mr") : undefined);
  const status = readJsonFile<RunStatus | null>(`${located.run_dir}/status.json`, null);
  if (!status) throw new CliError(`status.json not found for run: ${runId}`);
  if (!nonTerminalStates.has(status.state)) {
    printJson({ canceled: false, run_id: runId, state: status.state, reason: "already terminal" });
    return 0;
  }
  if (status.pgid === null) {
    throw new CliError(
      `run ${runId} has no process group yet (state: ${status.state}); retry once it is running, or: orch run reap --mr ${located.mr}`,
    );
  }
  // The marker lands before the signal so the supervisor's fallback result
  // (and the synced result mail) reports the cancellation, not a bare exit code.
  writeJsonAtomic(`${located.run_dir}/canceled.json`, {
    schema: "orch.run/canceled/v1",
    run_id: runId,
    reason: flagString(args, "reason", "canceled via orch run cancel"),
    ts: new Date().toISOString(),
  });
  // Kill the driver's process group; the live supervisor then drives the run
  // to its normal failed terminal state (fallback result, events, status).
  const signal = flagBool(args, "force") ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-status.pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    printJson({
      canceled: false,
      run_id: runId,
      state: status.state,
      reason: `process group ${status.pgid} is gone; run: orch run reap --mr ${located.mr}`,
    });
    return 1;
  }
  printJson({ canceled: true, run_id: runId, mr: located.mr, signal, pgid: status.pgid });
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

async function searchCommand(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "search", ["json", "worktree", "mr", "run", "thread"]);
  if (args.positionals.length !== 2) throw new CliError("usage: orch search <regex> [--mr <id>] [--run <id>] [--thread <id>] [--worktree <path>] [--json]");
  const pattern = args.positionals[1]!;
  const regex = compileSearchRegex(pattern);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const runFiles = scopedRunLocations(repo.repo_key, args).flatMap(searchFilesForRun);
  const mailFiles = searchFilesForMail(repo.repo_key, args);
  const files = [...runFiles, ...mailFiles];
  const hits = files.flatMap((candidate) => searchCandidate(regex, candidate));

  if (flagBool(args, "json")) {
    printJson({
      schema: "orch.search/v1",
      repo_key: repo.repo_key,
      worktree: repo.repo_root,
      pattern,
      scope: {
        mr: args.flags.has("mr") ? flagString(args, "mr") : null,
        run_id: args.flags.has("run") ? flagString(args, "run") : null,
        thread: args.flags.has("thread") ? flagString(args, "thread") : null,
      },
      searched_files: files.length,
      hits,
    });
  } else {
    process.stdout.write(renderSearchHits(hits));
  }
  return 0;
}

async function usageRun(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "usage run", ["json", "worktree", "mr", "run"]);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const run = runLocation(repo.repo_key, flagString(args, "run"), args.flags.has("mr") ? flagString(args, "mr") : undefined);
  const summary = runUsageSummary(run);
  if (flagBool(args, "json")) {
    printJson({ schema: "orch.usage/run/v1", repo_key: repo.repo_key, ...summary });
  } else {
    process.stdout.write(renderUsageLine(`MR ${summary.mr} run ${summary.run_id}`, summary));
  }
  return 0;
}

async function usageThread(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "usage thread", ["json", "worktree", "thread", "mr"]);
  const thread = threadMr(args);
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const runs = runLocationsForMr(repo.repo_key, thread).map(runUsageSummary);
  const aggregate = aggregateRunUsage(runs);
  if (flagBool(args, "json")) {
    printJson({
      schema: "orch.usage/thread/v1",
      repo_key: repo.repo_key,
      thread,
      ...aggregate,
      runs,
    });
  } else {
    process.stdout.write(renderUsageLine(`thread ${thread}`, aggregate));
    for (const run of runs) process.stdout.write(`  ${renderUsageLine(`run ${run.run_id}`, run)}`);
  }
  return 0;
}

async function usageDaily(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, "usage daily", ["json", "worktree", "days"]);
  const rawDays = flagNumber(args, "days") ?? 7;
  if (!Number.isInteger(rawDays) || rawDays <= 0) throw new CliError("--days must be a positive integer");
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - (rawDays - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const byDate = new Map<string, RunLocation[]>();
  for (const run of runLocationsForRepo(repo.repo_key)) {
    const date = runUsageDate(run);
    if (!date || date < since || date > today) continue;
    byDate.set(date, [...(byDate.get(date) ?? []), run]);
  }
  const buckets = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, locations]) => {
      const runs = locations.map(runUsageSummary);
      return { date, ...aggregateRunUsage(runs), runs };
    });

  if (flagBool(args, "json")) {
    printJson({
      schema: "orch.usage/daily/v1",
      repo_key: repo.repo_key,
      days: rawDays,
      since,
      until: today,
      buckets,
    });
  } else {
    if (buckets.length === 0) {
      process.stdout.write("no runs in selected window\n");
    } else {
      for (const bucket of buckets) process.stdout.write(renderUsageLine(bucket.date, bucket));
    }
  }
  return 0;
}

async function usageCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[1];
  if (subcommand === "run") return usageRun(args);
  if (subcommand === "thread") return usageThread(args);
  if (subcommand === "daily") return usageDaily(args);
  throw new CliError("usage: orch usage run --run <id> | orch usage thread --thread <id> | orch usage daily [--days N]");
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
  const command = await adapter.postComment(forgeRefFor(root, mr), body);

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
    // Payloads queued before forge_ref existed still carry the local thread
    // id; resolve those at send time. A payload already recording a real ref
    // keeps its destination untouched.
    const target = payload.mr === mr ? forgeRefFor(mrDir, payload.mr) : payload.mr;
    const command = await adapter.postComment(target, payload.body);
    const success = command.exit_code === 0;
    printJson({
      mirror: execute ? (success ? "sent" : "failed") : "dry-run",
      forge,
      mr: target,
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

// Unsandboxed host reconciler for the dispatch queue: executes the state
// mutations a sandboxed controller enqueued (run create, decision, mail, …).
// `--watch` is the companion for the mailctl controller (which runs detached);
// orch new drives the same reconcile loop in-process while its controller runs.
async function dispatchCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== "reconcile") {
    process.stderr.write("usage: orch dispatch reconcile [--once|--watch]\n");
    return 2;
  }
  assertKnownFlags(args, "dispatch reconcile", ["once", "watch", "json"]);
  if (flagBool(args, "watch")) {
    process.stderr.write("orch dispatch reconcile --watch: draining sandboxed dispatch requests (Ctrl-C to stop)\n");
    await reconcileDispatchWatch(orchCommand(), () => false);
    return 0;
  }
  const handled = await reconcileDispatchOnce(orchCommand());
  if (flagBool(args, "json")) printJson({ reconciled: handled });
  else process.stdout.write(`dispatch reconcile: handled ${handled} request(s)\n`);
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

  // Host-side dispatch boundary: a state-mutating orch command issued from
  // inside a sandbox (a controller's run/decision/mailctl mutation) can't
  // spawn a working worker or touch run artifacts under the jail. Proxy it to
  // the unsandboxed host reconciler and relay its result. Reads run locally.
  if (insideSandbox() && first !== "dispatch" && shouldProxyToHost(args.positionals)) {
    const forwardArgv = process.argv.slice(2);
    // Only drain stdin when the command actually takes it (a `-` marker, e.g.
    // `--task -` / `--task=-`); reading unconditionally could block a
    // stdin-less command (decision/mail) if the shell left stdin open.
    const stdin = !process.stdin.isTTY && args.flags.get("task") === "-" ? await readStdinText() : "";
    const result = await proxyToHost({ argv: forwardArgv, stdin });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exit_code;
  }
  if (first === "dispatch") return dispatchCommand(args);

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
    if (first === "new") {
      process.stdout.write(newHelp());
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
    if (first === "run" && second === "cancel") {
      process.stdout.write(runCancelHelp());
      return 0;
    }
    if (first === "run") {
      process.stdout.write(runHelp());
      return 0;
    }
    if (first === "search") {
      process.stdout.write(searchHelp());
      return 0;
    }
    if (first === "usage") {
      process.stdout.write(usageHelp());
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
  if (first === "new") return newCommand(args);
  if (first === "run" && second === "create") return createRun(args);
  if (first === "run" && second === "list") return runList(args);
  if (first === "run" && second === "reap") return runReap(args);
  if (first === "run" && second === "cancel") return runCancel(args);
  if (first === "search") return searchCommand(args);
  if (first === "usage") return usageCommand(args);
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
