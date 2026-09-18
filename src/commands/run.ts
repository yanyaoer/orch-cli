// orch run create|list|reap|cancel: provider session config, resume chains, sandbox compatibility, spawning the detached supervisor.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isRunRole, writeRoles, type AgentName, type ProviderSessionMode, type RunRole, type RunSpec, type RunStatus } from "../types.ts";
import { acquirePidfileLockWait } from "../locks.ts";
import { sha256 } from "../hash.ts";
import { ensureStateLayout, getRepoIdentity, lockPathForWorktree, mrStateDir, type RepoIdentity } from "../paths.ts";
import { appendJsonLine, countLines, jsonBytes, readJsonFile, writeJsonAtomic, writeTextAtomic } from "../json.ts";
import { writeInitialRunFiles } from "../supervisor.ts";
import { vcsDirty, vcsHead } from "../vcs.ts";
import { isTerminal } from "../overview.ts";
import { orchLanguage, readOrchConfig, type RoleDefaults } from "../config.ts";

import { CliError, assertKnownFlags, flagBool, flagString, printJson, readStdinText, type ParsedArgs } from "../cli.ts";
import { buildPrompt, buildProviderExecutionPlan, type ProviderExecutionPlan } from "../../drivers/driver-common.ts";
import { SEATBELT_ENGINE, sandboxPosture, sandboxRunIdentity, seatbeltUnsupportedReason } from "../../drivers/sandbox.ts";
import { archivedIdempotency, formatTable, locateRun, mrIdsForRepo, nonTerminalStates, orchCommand, readIdempotency, resolveMr, runId, runListRows, scanMrRuns, scanRunsRoot, stateDirectoryHint, statusState, type IdempotencyRecord } from "../run-store.ts";

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
  const bound: { run_id: string; tag: string }[] = [];
  for (const { spec, status } of scanRunsRoot(`${mrDir}/runs`, "")) {
    if (!spec) continue;
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

export async function createRun(args: ParsedArgs): Promise<number> {
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
  // Model precedence: --model, then the role default's model — only when the
  // run's agent is that entry's agent, since a model ref is written in one
  // CLI's format and must not follow a --agent override to another CLI — then
  // the per-agent default (defaults.models.<agent>), then the driver's built-in.
  const roleModel = agent === roleDefaults.agent ? roleDefaults.model : undefined;
  const configModel = roleModel ?? readOrchConfig().defaults?.models?.[agent] ?? null;
  const providerSession = resume ? resume.session : providerSessionConfig(args, agent, configModel);

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
    const dirty = await vcsDirty(worktree);
    const baseSha = await vcsHead(worktree);
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

    const dirty = await vcsDirty(worktree);
    if (dirty.length > 0 && writeRoles.has(role) && !flagBool(args, "allow-dirty")) {
      process.stderr.write(
        `warn: worktree has uncommitted changes; write-role run will proceed. Pass --allow-dirty to acknowledge.\n`,
      );
    }
    const baseSha = await vcsHead(worktree);
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

// Persist the read-side stale verdict: non-terminal runs whose pid is dead (or
// that never got a pid and stopped updating an hour ago) are moved to `stale`.
export async function runReap(args: ParsedArgs): Promise<number> {
  const worktree = resolve(flagString(args, "worktree", process.cwd()));
  const repo = await getRepoIdentity(worktree);
  const mrIds = args.flags.has("mr") ? [flagString(args, "mr")] : mrIdsForRepo(repo.repo_key);
  const reaped: Array<{ mr: string; run_id: string }> = [];
  const running: Array<{ mr: string; run_id: string }> = [];
  for (const mr of mrIds) {
    for (const { status, stale, run_dir } of scanMrRuns(repo.repo_key, mr)) {
      if (!status || !nonTerminalStates.has(status.state)) continue;
      const id = run_dir.slice(run_dir.lastIndexOf("/") + 1);
      if (!stale) {
        running.push({ mr: status.mr, run_id: id });
        continue;
      }
      writeJsonAtomic(`${run_dir}/status.json`, { ...status, state: "stale", updated_at: new Date().toISOString() });
      const eventsPath = `${run_dir}/events.jsonl`;
      appendJsonLine(eventsPath, { type: "stale", seq: countLines(eventsPath), ts: new Date().toISOString() });
      reaped.push({ mr: status.mr, run_id: id });
    }
  }
  printJson({ reaped, still_running: running });
  return 0;
}

export async function runCancel(args: ParsedArgs): Promise<number> {
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

export async function runList(args: ParsedArgs): Promise<number> {
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
