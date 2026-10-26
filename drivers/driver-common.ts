import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { isRunRole, writeRoles, type AgentName, type ResultCoercion, type RunSpec, type RoleResult, type SandboxEngine, type SandboxPosture } from "../src/types.ts";
import { acceptanceOutcome, commandOutcome, fallbackResult, isProvenRedCheck, resultSchemaName, ROLE_REQUIRED_FIELDS, ROLE_RESULT_EXAMPLE, ROLE_VERDICTS, roleJsonSchema, stripNulls, validateRoleResult } from "../src/schema.ts";
import { appendJsonLine, countLines, writeJsonAtomic } from "../src/json.ts";
import { normalizeNativeText } from "../src/native-events.ts";
import { nativeResult } from "../src/native-result.ts";
import { codexBaselinePath, readCodexBaseline } from "../src/codex-baseline.ts";
import { scrubGitLocationEnv } from "../src/git-env.ts";
import { sha256 } from "../src/hash.ts";
import {
  acceptableHostTmpDir,
  canonicalizePath,
  exactStateDirReason,
  findWorktreeHardlinks,
  narrowWritableDirReason,
  providerStateDirReason,
  providerStatePaths,
  rootLevelStateFileReason,
  sandboxPosture,
  scratchEnv,
  SEATBELT_ENGINE,
  seatbeltProfile,
  seatbeltUnsupportedReason,
  workerCacheDir,
} from "./sandbox.ts";

export interface DriverArgs {
  specPath: string;
  runDir: string;
  worktree: string;
}

export function parseDriverArgs(argv: string[]): DriverArgs {
  const get = (name: string): string => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0 || !argv[index + 1]) throw new Error(`missing --${name}`);
    return argv[index + 1]!;
  };
  return {
    specPath: get("spec"),
    runDir: get("run-dir"),
    worktree: get("worktree"),
  };
}

export function readSpec(path: string): RunSpec {
  return JSON.parse(readFileSync(path, "utf8")) as RunSpec;
}

// Per-run evidence dir: the one place inside the run dir a write-role worker
// may write (besides the Seatbelt scratch). Logs, reproduction scripts and
// check output written here outlive the worktree, so the worktree can end
// clean; the supervisor lists it in artifacts/evidence-manifest.json.
// Read-only roles (reviewer, researcher) and the controller get none.
export const ORCH_RUN_EVIDENCE_DIR_ENV = "ORCH_RUN_EVIDENCE_DIR";

export function runEvidenceDir(runDir: string): string {
  return `${runDir}/evidence`;
}

export function roleHasEvidenceDir(role: RunSpec["role"]): boolean {
  return writeRoles.has(role);
}

export function buildPrompt(spec: RunSpec, provider: string, runDir?: string): string {
  const role = isRunRole(spec.role) ? spec.role : "implementer";
  const evidenceDir = runDir && roleHasEvidenceDir(role) ? runEvidenceDir(runDir) : null;
  const schemaName = resultSchemaName(role);
  const verdicts = ROLE_VERDICTS[role];
  const failure = verdicts.find((verdict) => verdict === "failed" || verdict === "fail");
  const required = ROLE_REQUIRED_FIELDS[role];
  return [
    `You are running under orch provider driver: ${provider}.`,
    `Run id: ${spec.run_id}`,
    `Role: ${spec.role}`,
    `Worktree: ${spec.worktree}`,
    `Provider session mode: ${spec.provider_session_mode}`,
    `Provider session name: ${spec.provider_session_name ?? "none"}`,
    ...(evidenceDir
      ? [
          `Evidence dir: ${evidenceDir} (also $${ORCH_RUN_EVIDENCE_DIR_ENV})`,
          "Write every log, reproduction script, red/break check output, mutation diff and fetched test report you want kept into the evidence dir (a subdirectory per check is fine); it outlives the worktree and the controller cites it. Keep fixture repositories and whole-tree copies in $TMPDIR, not there. The worktree must end clean (`git status --porcelain` empty); one-off scratch goes to $TMPDIR.",
        ]
      : []),
    "",
    "Execute the task below. Your final answer must be a single JSON object matching this orch schema.",
    `The top-level JSON object must include: "schema": "${schemaName}".`,
    // Models cannot infer the field list from the schema name: live runs
    // dropped verdict, then summary. Spell out every validator-required field.
    `Required top-level fields — omitting any of them fails the run: ${required.map((field) => `"${field}"`).join(", ")}.`,
    `It must also include "verdict", exactly one of: ${verdicts.map((verdict) => `"${verdict}"`).join(" | ")}. Never omit "verdict".` +
      (failure ? ` Use "${failure}" when the task could not genuinely be completed; never claim success for ungrounded or partial work.` : ""),
    `Shape to copy (array items are objects only where shown; findings carry "body", blocking ones also id/severity/file): ${ROLE_RESULT_EXAMPLE[role]}`,
    "Do not wrap the JSON in Markdown. Do not create or edit result files in the worktree; return the JSON as your final answer only.",
    ...(role === "implementer"
      ? [
          // Repeated full builds inside implement loops dominated real run wall
          // time on large repos — but an unconditional ban left gaps whenever
          // no verifier run followed, so required checks are always allowed.
          "Verification discipline: finish ALL edits first, then run the checks this change needs: targeted tests for the code you changed, plus any broader suite or build the task explicitly requires. Do not loop full builds inside edit cycles. A necessary check you could not run is reported as skipped, never as passed.",
        ]
      : []),
    ...(role === "implementer" || role === "verifier"
      ? [
          `Command evidence: every ${role === "verifier" ? "commands" : "tests"} entry carries "status": "passed" | "failed" | "skipped". A check that did not run is "skipped" with "exit_code": null — never exit_code 0. ${role === "verifier" ? 'For a negative test whose expected outcome is a non-zero exit, set "expected_exit_code" to that code; "passed" then means exit_code equals it. ' : 'Write a negative check so that success exits 0 (e.g. `! cmd`); implementer tests never set a non-zero "expected_exit_code". Every test carries "phase": a red check run on the unfixed tree is "before_change" (its failure is expected evidence, and the same cmd must also appear passing as "after_change"); everything else is "after_change". '}A success verdict must not contain a failed check or an unmet acceptance item (acceptance status: met | unmet | skipped): a required check that failed means the verdict is "${failure ?? "failed"}".${role === "verifier" ? ' A verifier "pass" also needs at least one command that actually ran and passed, and may skip a command or acceptance item only when it is marked "optional": true. Nit and pre-existing observations go to the optional "non_blocking_findings" (severity "nit" | "pre-existing"); they never change the verdict.' : ""} orch checks this JSON for consistency but does not re-run your commands: list only commands you actually ran.`,
        ]
      : []),
    ...(spec.language === "中文"
      ? [
          "结果 JSON 中人类可读的 prose 字段(summary、blocking/non_blocking findings 的 body、suggested_tests、recommendation、risks、acceptance evidence、rollback)必须用中文书写;代码、命令、文件路径、标识符保持原样。",
        ]
      : []),
    "",
    "Task:",
    spec.task_text || "(no task text supplied)",
  ].join("\n");
}

const recursiveToolEnvKeys = [
  // Inherited Claude Code tool subprocess/session markers can make nested drivers
  // attach back to the parent tool/MCP session. Keep auth, model, HOME, and PATH intact.
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  // Common direct MCP config env names used by wrappers and bridges.
  "MCP_CONFIG",
  "MCP_CONFIG_PATH",
  "MCP_SERVER_CONFIG",
  "MCP_SERVER_URL",
  "MCP_SERVERS",
  "MCP_TOOLS",
  "CLAUDE_CODE_MCP_CONFIG",
  "CLAUDE_MCP_CONFIG",
  "CODEX_MCP_CONFIG",
  "OPENAI_MCP_CONFIG",
  // orch bridge/tool endpoint env names must not recursively leak to workers.
  "ORCH_MCP_URL",
  "ORCH_MCP_TOKEN",
  "ORCH_MCP_WS_URL",
  "ORCH_TOOL_SERVER_URL",
] as const;

// Set by the supervisor on the driver it spawns: the driver must read a "go"
// line on stdin (sent once its process group is registered in status and the
// worktree lock) before doing anything. EOF means the supervisor died first.
export const DRIVER_HANDSHAKE_ENV = "ORCH_DRIVER_HANDSHAKE";

export async function awaitSupervisorHandshake(): Promise<boolean> {
  if (process.env[DRIVER_HANDSHAKE_ENV] !== "1") return true;
  delete process.env[DRIVER_HANDSHAKE_ENV];
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return received.split("\n")[0] === "go";
}

export function buildWorkerEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }

  for (const key of recursiveToolEnvKeys) delete env[key];
  delete env[DRIVER_HANDSHAKE_ENV];
  // Workers run in spec.worktree; inherited GIT_DIR & co. would point their
  // git at another checkout than the one snapshotted and locked.
  scrubGitLocationEnv(env);
  // Claude-specific hardening: do not auto-connect nested IDE/tool sessions, and
  // restrict any child-started Claude MCP servers to their own explicit allowlist.
  env.CLAUDE_CODE_AUTO_CONNECT_IDE = "false";
  env.CLAUDE_CODE_MCP_ALLOWLIST_ENV = "1";
  // Workers generate POSIX/bash commands; a fish login shell inherited via
  // $SHELL breaks providers whose shell tooling follows it (codex hooks do;
  // claude pins zsh, codex exec rejects fish, pi/omp pin /bin/bash).
  if (env.SHELL?.endsWith("fish")) env.SHELL = "/bin/bash";
  // bun prepends node_modules/.bin dirs (walking up from cwd, including
  // ~/node_modules/.bin) to spawned PATH; a stale provider CLI there (e.g. an
  // accidental old claude in $HOME) then shadows the real one. Provider
  // binaries must resolve from the real PATH.
  if (env.PATH) {
    env.PATH = env.PATH.split(":").filter((entry) => !entry.endsWith("/node_modules/.bin")).join(":");
  }
  return env;
}

// omp = oh-my-pi, model-aware with a quota fallback chain. The primary model
// rides argv; the rest of the chain rides a per-run --config overlay (merged
// over the base config) as `retry.fallbackChains.default`. omp's retry
// recovery consumes it — `retry.modelFallback` (on by default) permits the
// switch — advancing to the next model when the provider reports
// quota/rate-limit exhaustion.
// Primary is gpt-6-astra at high thinking; gemini is the only fallback and
// sits last because its provider intermittently geo-rejects behind the
// corporate VPN.
export const OMP_MODEL_CHAIN: readonly string[] = [
  "openai-codex/gpt-6-astra",
  "google-antigravity/gemini-3.1-pro",
];

export const OMP_THINKING = "--thinking=high";

// pi default mirrors omp's primary: gpt-6-astra at high thinking. pi has no
// quota-fallback chain; an explicit --model overrides the default.
export const PI_DEFAULT_MODEL = "openai-codex/gpt-6-astra";
export const PI_THINKING = "high";

export function ompModelChain(model: string | null | undefined): { primary: string; fallbacks: string[] } {
  const primary = model ?? OMP_MODEL_CHAIN[0]!;
  // A primary outside the built-in chain names a provider orch knows nothing
  // about: no overlay is written, so omp's own retry.fallbackChains (its
  // config.yml) governs instead of a chain of providers the user may not have.
  if (!OMP_MODEL_CHAIN.includes(primary)) return { primary, fallbacks: [] };
  return { primary, fallbacks: OMP_MODEL_CHAIN.filter((entry) => entry !== primary) };
}

export function ompPromptPath(runDir: string): string {
  return `${runDir}/prompt.md`;
}

// Provider-native structured output (claude --json-schema, codex
// --output-schema) constrains the final answer's shape at the provider; the
// text path + repair round stays the fallback (and the only path for pi/omp).
// ORCH_NATIVE_SCHEMA=0 turns it off. The codex schema file lives in the
// host-owned run dir, which a sandboxed provider can read but not rewrite.
export function nativeSchemaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORCH_NATIVE_SCHEMA !== "0";
}

export function resultSchemaPath(runDir: string): string {
  return `${runDir}/result.schema.json`;
}

export function writeResultSchemaFile(runDir: string, spec: RunSpec): void {
  if (!isRunRole(spec.role)) return;
  writeFileSync(resultSchemaPath(runDir), `${JSON.stringify(roleJsonSchema(spec.role))}\n`, "utf8");
}

export function ompFallbackConfigPath(runDir: string): string {
  return `${runDir}/omp-fallback.yml`;
}

export function ompFallbackConfigYaml(fallbacks: readonly string[]): string {
  return ["retry:", "  fallbackChains:", "    default:", ...fallbacks.map((model) => `      - ${model}`), ""].join("\n");
}

// Worktree permission posture matched to the role's constraint. `reviewer` and
// `researcher` are pure read-only analysis roles, so their providers are
// launched without write access. Write roles (implementer/...) and `verifier`
// (which must run tests/commands) keep each provider's default write-capable posture.
export function isReadOnlyRole(role: RunSpec["role"]): boolean {
  return role === "reviewer" || role === "researcher";
}

export const CLAUDE_CONTROLLER_ALLOWED_TOOLS = "Bash(orch *),Read,Grep,Glob,LS";

// Researcher does web research (jina/tvly CLIs + claude-native web tools) plus
// read-only repo inspection; no Edit/Write and no general Bash, so it can
// deliver plans but never code. dontAsk denies everything off this list headless.
export const CLAUDE_RESEARCHER_ALLOWED_TOOLS = "Bash(jina *),Bash(tvly *),WebSearch,WebFetch,Read,Grep,Glob,LS";

// Write roles (implementer/verifier) run headless: they must auto-run edits and
// test/build commands with no interactive approval. dontAsk auto-runs this
// whitelist and never prompts, while — unlike bypassPermissions — keeping
// claude's own guardrails engaged. Broad on purpose (all core write/exec tools)
// so implementers aren't silently denied; MCP tools stay gated by
// CLAUDE_CODE_MCP_ALLOWLIST_ENV. OS-level write confinement is layered on top
// via config `sandbox` (Seatbelt), not by this list.
export const CLAUDE_WRITE_ALLOWED_TOOLS =
  "Task,Bash,BashOutput,KillShell,Glob,Grep,LS,Read,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,TodoWrite";

// Researcher model per provider: codex pins gpt-6-astra at high reasoning and
// claude pins fable at xhigh effort; omp rides its default quota-fallback
// chain (gpt-6-astra primary at high thinking).
export const CODEX_RESEARCHER_MODEL = "gpt-6-astra";
export const CODEX_RESEARCHER_EFFORT = "high";

// claude model tier by role: reviewer escalates to opus (deep critique, paired
// with omp's gpt-6-astra as a distinct model family in cross-review);
// researcher escalates further to fable (deep research/architecture);
// implementer/verifier stay on the claude CLI's default model (sonnet) and only dial --effort.
const CLAUDE_ROLE_MODEL: Partial<Record<RunSpec["role"], string>> = {
  reviewer: "opus",
  researcher: "fable",
};

// claude reasoning effort by role: researcher and reviewer need the deepest
// passes, verifier is mechanical (tests/acceptance checks) so it stays cheap,
// implementer sits in between and can be bumped manually per-task via
// provider_session_name/task text.
const CLAUDE_ROLE_EFFORT: Partial<Record<RunSpec["role"], string>> = {
  implementer: "medium",
  verifier: "low",
  reviewer: "high",
  researcher: "xhigh",
  controller: "medium",
};

// Non-sandboxed argv (engine "none"). The external-sandbox variant — the only
// one that flips codex/claude native sandboxes off — is deliberately not
// exported: those argv exist solely inside buildProviderExecutionPlan,
// atomically bound to the outer Seatbelt wrapper.
export function buildProviderArgv(
  provider: AgentName,
  spec: RunSpec,
  runDir: string,
  worktree: string,
  prompt = "",
): string[] {
  return providerArgv(provider, spec, runDir, worktree, prompt, false);
}

function providerArgv(
  provider: AgentName,
  spec: RunSpec,
  runDir: string,
  worktree: string,
  prompt: string,
  externalSandbox: boolean,
): string[] {
  const readOnly = isReadOnlyRole(spec.role);

  if (spec.role === "controller" && provider !== "claude") {
    throw new Error("controller role only supports claude provider");
  }
  // pi is excluded: no strong-reasoning model and no web path. omp researcher
  // runs the default chain with read-only tools (repo-internal research, no web).
  if (spec.role === "researcher" && provider === "pi") {
    throw new Error("researcher role only supports claude, codex, and omp providers");
  }

  if (provider === "omp") {
    const { primary, fallbacks } = ompModelChain(spec.model);
    const argv = ["omp", "--model", primary, OMP_THINKING];
    // The quota fallback chain rides a per-run config overlay written by
    // runProviderDriver before spawn (omp native retry.fallbackChains).
    if (fallbacks.length > 0) argv.push("--config", ompFallbackConfigPath(runDir));
    argv.push("-p", "--mode", "json");
    // omp's tool names diverge from pi's: find/ls are not valid (omp 17 exits 2
    // on argv validation, before any event); glob covers file discovery.
    if (readOnly) argv.push("--tools", "read,grep,glob");
    if (spec.provider_session_mode === "ephemeral") {
      argv.push("--no-session");
    } else if (spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
      argv.push("--resume", spec.provider_session_id);
    }
    // omp -p ignores stdin; the prompt rides an @file argument written by
    // runProviderDriver (keeps it out of `ps` and clear of ARG_MAX).
    argv.push(`@${ompPromptPath(runDir)}`);
    return argv;
  }

  if (provider === "claude") {
    const argv = ["claude", "-p", "--verbose", "--output-format", "stream-json", "--input-format", "text"];
    // Under the external Seatbelt, claude's internal OS sandbox must be off:
    // nested sandbox_apply fails (probe: Bash exit 71). Tool permissions
    // (allowedTools / permission-mode below) stay on as the intent layer; the
    // outer Seatbelt owns the filesystem write boundary.
    if (externalSandbox) argv.push("--settings", '{"sandbox":{"enabled":false}}');
    const model = spec.model ?? CLAUDE_ROLE_MODEL[spec.role];
    if (model) argv.push("--model", model);
    const effort = CLAUDE_ROLE_EFFORT[spec.role];
    if (effort) argv.push("--effort", effort);
    // Controller intentionally stays out of reviewer plan mode so dispatched
    // workers hold the worktree lock. Keep this whitelist narrow: no Edit/Write,
    // and Bash stays constrained to `orch *` to prevent controller-side writes.
    if (spec.role === "controller") argv.push("--allowedTools", CLAUDE_CONTROLLER_ALLOWED_TOOLS, "--permission-mode", "dontAsk");
    // Researcher needs web tools, which plan mode would deny headless; it rides
    // its own whitelist under dontAsk instead (read-only repo + web, no writes).
    else if (spec.role === "researcher") argv.push("--allowedTools", CLAUDE_RESEARCHER_ALLOWED_TOOLS, "--permission-mode", "dontAsk");
    else if (readOnly) argv.push("--permission-mode", "plan");
    // Write roles and verifier run headless: without an explicit mode, edits
    // and test commands wait for interactive approval that never comes. dontAsk
    // + a broad write whitelist auto-runs them without prompting while keeping
    // claude's own guardrails on (bypassPermissions would disable claude's
    // sandbox entirely). OS-enforced write confinement is opt-in via config
    // `sandbox`: the outer Seatbelt then jails every provider uniformly.
    else argv.push("--allowedTools", CLAUDE_WRITE_ALLOWED_TOOLS, "--permission-mode", "dontAsk");
    // Required, not hardening: Edit/Write and Bash output redirects (>, >>,
    // tee) are checked against the working directories, so without it a
    // dontAsk worker cannot write its evidence. Re-passed on every resume.
    if (roleHasEvidenceDir(spec.role)) argv.push("--add-dir", runEvidenceDir(runDir));
    if (spec.provider_session_name) argv.push("--name", spec.provider_session_name);
    if (nativeSchemaEnabled() && isRunRole(spec.role)) argv.push("--json-schema", JSON.stringify(roleJsonSchema(spec.role)));
    if (spec.provider_session_mode === "ephemeral") {
      argv.push("--no-session-persistence");
    } else if (spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
      argv.push("--resume", spec.provider_session_id);
    }
    return argv;
  }

  if (provider === "codex") {
    // Under the external Seatbelt the provider must not write formal run
    // artifacts: the last message lands in the provider-writable scratch and
    // the driver reads it back after exit. Unsandboxed runs keep the run dir
    // path so existing behavior is unchanged.
    const lastMessagePath = externalSandbox ? `${runDir}/scratch/last_message.txt` : `${runDir}/last_message.txt`;
    // Under the external Seatbelt, codex runs in its official "isolated by an
    // external sandbox" mode: the bypass flag and the outer wrapper are two
    // halves of one execution plan, never emitted separately.
    const sandboxFlags = externalSandbox
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : // codex exec DEFAULTS to the read-only sandbox (verified live: writes
        // blocked without an explicit -s); write-capable roles must ask for
        // workspace-write explicitly or implementers cannot edit anything.
        ["--sandbox", readOnly ? "read-only" : "workspace-write"];
    // Researcher: pin the strong-reasoning model at high effort and enable
    // codex-native web search — the read-only sandbox blocks network for shell
    // commands, so web research must ride the Responses web_search tool.
    const researcherFlags =
      spec.role === "researcher" ? ["-c", `model_reasoning_effort=${CODEX_RESEARCHER_EFFORT}`, "-c", "tools.web_search=true"] : [];
    const model = spec.model ?? (spec.role === "researcher" ? CODEX_RESEARCHER_MODEL : null);
    // The run's evidence dir is the only writable root added to workspace-write
    // (worktree, $TMPDIR and /tmp are codex defaults); the rest of the run dir
    // stays unwritable. Like --sandbox it rides the parent `exec` level on resume.
    const evidenceFlags = roleHasEvidenceDir(spec.role) ? ["--add-dir", runEvidenceDir(runDir)] : [];
    if (spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
      // `codex exec resume` has no --sandbox flag (exit 2 if passed); the
      // sandbox rides the parent `exec` level, accepted before the subcommand.
      const resume = ["codex", "exec", ...sandboxFlags, ...evidenceFlags];
      resume.push("resume", "--json", "--output-last-message", lastMessagePath);
      if (nativeSchemaEnabled()) resume.push("--output-schema", resultSchemaPath(runDir));
      if (model) resume.push("--model", model);
      resume.push(...researcherFlags);
      resume.push(spec.provider_session_id, "-");
      return resume;
    }
    const argv = ["codex", "exec", "--json", "--cd", worktree, "--output-last-message", lastMessagePath];
    if (nativeSchemaEnabled()) argv.push("--output-schema", resultSchemaPath(runDir));
    if (model) argv.push("--model", model);
    argv.push(...researcherFlags);
    argv.push(...sandboxFlags);
    argv.push(...evidenceFlags);
    if (spec.provider_session_mode === "ephemeral") argv.push("--ephemeral");
    argv.push("-");
    return argv;
  }

  const argv = ["pi", "--model", spec.model ?? PI_DEFAULT_MODEL, "--thinking", PI_THINKING];
  argv.push("-p", "--mode", "json");
  if (readOnly) argv.push("--tools", "read,grep,find,ls");
  if (spec.provider_session_mode === "ephemeral") {
    argv.push("--no-session");
  } else if (spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
    argv.push("--session-id", spec.provider_session_id);
  }
  if (spec.provider_session_name) argv.push("--name", spec.provider_session_name);
  return argv;
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

export interface ExtractedResult {
  result: RoleResult;
  coercions: ResultCoercion[];
}

const COERCION_VALUE_LIMIT = 120;

function compactCoercionValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === undefined) {
    text = "undefined";
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > COERCION_VALUE_LIMIT ? `${compact.slice(0, COERCION_VALUE_LIMIT - 3)}...` : compact;
}

function recordCoercion(coercions: ResultCoercion[], field: string, from: unknown, to: unknown, reason: string): void {
  const compactFrom = compactCoercionValue(from);
  const compactTo = compactCoercionValue(to);
  if (compactFrom === compactTo) return;
  coercions.push({ field, from: compactFrom, to: compactTo, reason });
}

// Balanced-object end for the `{` at `start`. `bracesInStrings` collects the
// positions of every `{` the scan passed inside a string literal: those are
// not object starts, and a scan started from one runs with inverted quote
// state to the end of the text.
function findJsonObjectEnd(text: string, start: number, bracesInStrings: number[]): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      } else if (char === "{") {
        bracesInStrings.push(index);
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return index;
      if (depth < 0) return null;
    }
  }

  return null;
}

function parsedJsonCandidates(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const direct = tryParseJson(trimmed);
  if (direct !== null) return [direct];

  const candidates: unknown[] = [];
  const seen = new Map<string, boolean>();
  const pushJson = (json: string): boolean => {
    const key = json.trim();
    if (!key) return false;
    const known = seen.get(key);
    if (known !== undefined) return known;
    const parsed = tryParseJson(key);
    seen.set(key, parsed !== null);
    if (parsed !== null) candidates.push(parsed);
    return parsed !== null;
  };

  for (const fenced of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (fenced[1]) pushJson(fenced[1]);
  }

  // Native streams are JSONL whose string payloads (tool output: code, JSON,
  // diffs) are full of braces; restarting the scan at each of them cost
  // O(braces × text). A scan whose substring parses as JSON had its string
  // boundaries right, so the braces it passed inside strings are dropped as
  // starts. Nothing else is trusted: a scan that failed or closed on a
  // non-JSON substring may have run with inverted quote state, so prose
  // candidates with unbalanced quotes are read exactly as before.
  const skippedStarts = new Set<number>();
  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== "{" || skippedStarts.has(start)) continue;
    const bracesInStrings: number[] = [];
    const end = findJsonObjectEnd(trimmed, start, bracesInStrings);
    if (end === null || !pushJson(trimmed.slice(start, end + 1))) continue;
    for (const index of bracesInStrings) skippedStarts.add(index);
  }

  return candidates;
}

function roleResultFromCandidate(value: unknown, spec: RunSpec): ExtractedResult | null {
  for (const candidate of unwrappedCandidates(value, spec)) {
    const normalized = normalizedRoleResult(candidate, spec);
    if (normalized) return normalized;
  }
  return null;
}

// Providers often deviate from the schema in benign ways (string items where
// objects are expected and vice versa, invented run ids, verdict synonyms).
// Real usage showed ~2/3 of runs losing their result to strict validation, so
// coerce the unambiguous deviations instead of discarding the whole result.
// A bare string is unambiguously the finding body. Every other deviation —
// title/detail under other keys, a blocking finding without id/severity/file —
// goes back to the model through the repair round instead of being guessed here
// (the old aliases and "unspecified" defaults fabricated content).
function coerceFindings(obj: Record<string, unknown>, field: string, coercions: ResultCoercion[]): void {
  if (!Array.isArray(obj[field])) return;
  obj[field] = (obj[field] as unknown[]).map((item, index) => {
    if (typeof item !== "string") return item;
    const finding = { body: item };
    recordCoercion(coercions, `${field}[${index}]`, item, finding, "finding object");
    return finding;
  });
}

const VERDICT_SYNONYMS: Record<string, string> = {
  approved: "approve",
  changes_requested: "request_changes",
  "request-changes": "request_changes",
  passed: "pass",
  complete: "completed",
};

// Models routinely omit arrays that would be empty; restoring them is unambiguous.
function coerceMissingArrays(obj: Record<string, unknown>, fields: string[], coercions: ResultCoercion[]): void {
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null) {
      recordCoercion(coercions, field, obj[field], [], "missing array default");
      obj[field] = [];
    }
  }
}

// Only deviations with exactly one reading are repaired here (case, known
// synonyms, arrays a model left out, ids it typed as numbers, facts the spec
// owns). Anything that would need a guess is left for validation to reject and
// the repair round to send back to the model.
function coerceRoleResult(role: RunSpec["role"], obj: Record<string, unknown>, coercions: ResultCoercion[], spec: RunSpec): void {
  if (typeof obj.verdict === "string") {
    const original = obj.verdict;
    const verdict = original.trim().toLowerCase();
    const coerced = VERDICT_SYNONYMS[verdict] ?? verdict;
    recordCoercion(coercions, "verdict", original, coerced, VERDICT_SYNONYMS[verdict] ? "known synonym" : "normalized verdict");
    obj.verdict = coerced;
  }
  if (role === "reviewer") {
    // Gemini-family models flatten the two finding arrays into a single
    // `findings` list. An approving reviewer's findings are by definition
    // non-blocking (blocking ones would force request_changes); everything
    // else surfaces as blocking so no finding is dropped.
    if (!Array.isArray(obj.blocking_findings) && Array.isArray(obj.findings)) {
      if (obj.verdict === "approve") {
        obj.non_blocking_findings = Array.isArray(obj.non_blocking_findings)
          ? [...(obj.non_blocking_findings as unknown[]), ...(obj.findings as unknown[])]
          : obj.findings;
        recordCoercion(coercions, "findings", obj.findings, { non_blocking_findings: obj.non_blocking_findings }, "flattened reviewer findings");
      } else {
        obj.blocking_findings = obj.findings;
        recordCoercion(coercions, "findings", obj.findings, { blocking_findings: obj.blocking_findings }, "flattened reviewer findings");
      }
      delete obj.findings;
    }
    coerceMissingArrays(obj, ["blocking_findings", "non_blocking_findings", "suggested_tests"], coercions);
    coerceFindings(obj, "blocking_findings", coercions);
    coerceFindings(obj, "non_blocking_findings", coercions);
    if (typeof obj.reviews_run_id !== "string") {
      const next = obj.reviews_run_id == null ? "" : String(obj.reviews_run_id);
      recordCoercion(coercions, "reviews_run_id", obj.reviews_run_id, next, "stringified id");
      obj.reviews_run_id = next;
    }
  } else if (role === "implementer") {
    coerceMissingArrays(obj, ["changed_files", "tests", "acceptance", "risks"], coercions);
    if (typeof obj.base_sha !== "string" || !obj.base_sha.trim()) {
      recordCoercion(coercions, "base_sha", obj.base_sha, spec.base_sha, "spec base_sha is authoritative");
      obj.base_sha = spec.base_sha;
    }
  } else if (role === "controller") {
    coerceMissingArrays(obj, ["actions"], coercions);
  } else if (role === "researcher") {
    coerceMissingArrays(obj, ["alternatives", "sources", "open_questions", "risks"], coercions);
    // recommendation and summary are the deliverable; a missing or misnamed
    // one is sent back through the repair round rather than derived here.
  } else if (role === "verifier") {
    coerceMissingArrays(obj, ["commands", "acceptance"], coercions);
    if (typeof obj.verifies_run_id !== "string") {
      const next = obj.verifies_run_id == null ? "" : String(obj.verifies_run_id);
      recordCoercion(coercions, "verifies_run_id", obj.verifies_run_id, next, "stringified id");
      obj.verifies_run_id = next;
    }
  }
}

function coerceCandidate(value: unknown, spec: RunSpec): { obj: Record<string, unknown>; coercions: ResultCoercion[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isRunRole(spec.role)) return null;

  const schemaName = resultSchemaName(spec.role);
  // Strict provider schemas (codex --output-schema) encode absent optional
  // fields as null; the validator expects them missing.
  const obj = stripNulls(value) as Record<string, unknown>;
  const coercions: ResultCoercion[] = [];
  // Candidates only come from this run's own stream, so the spec is the
  // authority on run_id — models frequently invent one, which used to reject
  // the entire result.
  if (obj.run_id !== spec.run_id) {
    recordCoercion(coercions, "run_id", obj.run_id, spec.run_id, "spec run_id is authoritative");
    obj.run_id = spec.run_id;
  }
  if (validateRoleResult(spec.role, obj).ok) return { obj, coercions };
  if (obj.schema === undefined) {
    recordCoercion(coercions, "schema", obj.schema, schemaName, "missing schema");
    obj.schema = schemaName;
  }
  coerceRoleResult(spec.role, obj, coercions, spec);
  return { obj, coercions };
}

function normalizedRoleResult(value: unknown, spec: RunSpec): ExtractedResult | null {
  const coerced = coerceCandidate(value, spec);
  if (!coerced) return null;
  return validateRoleResult(spec.role, coerced.obj).ok ? { result: coerced.obj as unknown as RoleResult, coercions: coerced.coercions } : null;
}

// The candidate itself, then the same object wrapped under the schema name or
// `result` (models sometimes envelope the answer).
function unwrappedCandidates(value: unknown, spec: RunSpec): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isRunRole(spec.role)) return [];
  const obj = value as Record<string, unknown>;
  return [value, obj[resultSchemaName(spec.role)], obj.result].filter((v) => v && typeof v === "object" && !Array.isArray(v));
}

export function extractResultWithCoercionsFromText(text: string, spec: RunSpec): ExtractedResult | null {
  for (const candidate of parsedJsonCandidates(text)) {
    const extracted = roleResultFromCandidate(candidate, spec);
    if (extracted) return extracted;
  }
  return null;
}

export function extractResultFromText(text: string, spec: RunSpec): RoleResult | null {
  return extractResultWithCoercionsFromText(text, spec)?.result ?? null;
}

function collectResultCandidates(runDir: string): string[] {
  const nativePath = `${runDir}/native.jsonl`;
  const native = existsSync(nativePath) ? nativeResult(readFileSync(nativePath, "utf8")) : null;
  // Once a structured stream or repair attempt exists it is authoritative.
  // Never search old messages, tool output, or stale last_message files for
  // a valid-looking result if the actual final message is invalid/empty.
  if (native && (native.structured || native.repair)) return native.text === null ? [] : [native.text];
  // scratch/last_message.txt is the sandboxed codex location (provider-writable
  // scratch); last_message.txt is the unsandboxed one.
  for (const path of [`${runDir}/scratch/last_message.txt`, `${runDir}/last_message.txt`, `${runDir}/stdout.log`]) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.trim()) return [text];
    }
  }
  return native?.text ? [native.text] : [];
}

function providerFailed(runDir: string): boolean {
  const path = `${runDir}/native.jsonl`;
  return existsSync(path) && nativeResult(readFileSync(path, "utf8")).failed;
}

export function extractResultWithCoercionsFromRunDir(runDir: string, spec: RunSpec): ExtractedResult | null {
  if (providerFailed(runDir)) return null;
  for (const candidate of collectResultCandidates(runDir)) {
    const extracted = extractResultWithCoercionsFromText(candidate, spec);
    if (extracted) return extracted;
  }
  return null;
}

export function extractResultFromRunDir(runDir: string, spec: RunSpec): RoleResult | null {
  return extractResultWithCoercionsFromRunDir(runDir, spec)?.result ?? null;
}

// Why the run has no valid result yet, as the validator would say it: the
// errors of the first candidate that looks like a result (carries schema or
// verdict), else of the first JSON object at all, else a "no JSON" line. Fed
// back to the model by the repair round.
export function resultValidationErrors(runDir: string, spec: RunSpec): string[] {
  let fallback: string[] | null = null;
  for (const text of collectResultCandidates(runDir)) {
    for (const candidate of parsedJsonCandidates(text)) {
      for (const value of unwrappedCandidates(candidate, spec)) {
        const coerced = coerceCandidate(value, spec);
        if (!coerced) continue;
        const { errors } = validateRoleResult(spec.role, coerced.obj);
        if (errors.length === 0) return [];
        const obj = value as Record<string, unknown>;
        if ("schema" in obj || "verdict" in obj) return errors;
        fallback ??= errors;
      }
    }
  }
  return fallback ?? ["no JSON object was found in the final answer"];
}

export function appendDriverEvent(runDir: string, event: Record<string, unknown>): void {
  try {
    const eventsPath = `${runDir}/events.jsonl`;
    appendJsonLine(eventsPath, { ...event, seq: countLines(eventsPath), ts: new Date().toISOString() });
  } catch {
    // Diagnostic only; extraction/result writing must win.
  }
}

export function appendResultCoercionEvent(runDir: string, coercions: ResultCoercion[]): void {
  if (coercions.length === 0) return;
  appendDriverEvent(runDir, { type: "result_coercion", coercions });
}

const REPAIR_PREVIOUS_MAX_CHARS = 16_000;

function repairTaskText(spec: RunSpec, errors: string[], previous: string): string {
  const role = isRunRole(spec.role) ? spec.role : "implementer";
  const excerpt = previous.length > REPAIR_PREVIOUS_MAX_CHARS ? `${previous.slice(0, REPAIR_PREVIOUS_MAX_CHARS)}\n[truncated]` : previous;
  return [
    "Your previous final answer for this run did not validate as an orch result. Validator errors:",
    ...errors.map((error) => `- ${error}`),
    "",
    "Return the corrected JSON object as your final answer and nothing else. Keep every fact and the verdict from the previous answer. Do not upgrade failures, remove findings, or invent evidence. Do not run tools or edit files.",
    `Exception: if the previous answer claimed success but its own evidence shows a failed required check or an unmet acceptance item, a required check that failed means the verdict is ${JSON.stringify(ROLE_VERDICTS[role][1])}: return that verdict with the facts unchanged.`,
    `Required shape: ${ROLE_RESULT_EXAMPLE[role]}`,
    "",
    "--- previous answer ---",
    excerpt,
  ].join("\n");
}

// One extra provider call that only reformats: the model gets the validator's
// own errors plus its previous answer and returns the corrected JSON. Fresh
// ephemeral session, same sandbox plan; its stream is appended to native.jsonl
// after a marker line so the run stays inspectable. Returns the provider exit
// code, or null when no plan could be built.
async function runResultRepair(input: {
  provider: AgentName;
  spec: RunSpec;
  runDir: string;
  worktree: string;
  errors: string[];
  previous: string;
}): Promise<number | null> {
  const spec: RunSpec = {
    ...input.spec,
    provider_session_mode: "ephemeral",
    provider_session_id: null,
    provider_session_name: null,
    task_text: repairTaskText(input.spec, input.errors, input.previous),
  };
  const prompt = buildPrompt(spec, input.provider);
  if (input.provider === "omp") writeFileSync(ompPromptPath(input.runDir), prompt, "utf8");
  let plan: ProviderExecutionPlan;
  try {
    plan = buildProviderExecutionPlan({ provider: input.provider, spec, runDir: input.runDir, worktree: input.worktree, prompt });
  } catch {
    return null;
  }
  const nativePath = `${input.runDir}/native.jsonl`;
  appendFileSync(nativePath, `${JSON.stringify({ type: "orch_result_repair", attempt: 1, errors: input.errors })}\n`, "utf8");
  appendDriverEvent(input.runDir, { type: "phase", phase: "result_repair_start", wait_reason: "provider_process" });
  const proc = Bun.spawn(plan.argv, { cwd: input.worktree, stdin: "pipe", stdout: "pipe", stderr: "inherit", env: plan.env });
  if (input.provider !== "omp") proc.stdin.write(prompt);
  proc.stdin.end();
  await pipeToFile(proc.stdout, nativePath, "a");
  const code = await proc.exited;
  appendDriverEvent(input.runDir, { type: "phase", phase: "result_repair_end", exit_code: code });
  return code;
}

// Best human-readable stand-in for the worker's final answer, used to preserve
// the raw output when schema extraction fails: candidates are ordered
// final-message-first, so the first non-empty one is the closest thing to the
// provider's answer.
export function rawResultText(runDir: string): string | null {
  for (const candidate of collectResultCandidates(runDir)) {
    if (candidate.trim().length > 0) return candidate;
  }
  return null;
}

// A formatting call is not a second assessment. Only an explicit, parseable
// original verdict can authorize a successful repaired result. Unparseable
// answers stay failed even if the formatting model guesses a success. A move
// to the role's failure verdict is always allowed (never an upgrade): live
// repairs correctly turned "completed + failed test" into "failed", and
// rejecting that discarded the real answer for a synthetic fallback.
export function repairPreservesVerdict(previous: string, result: RoleResult, spec: RunSpec): boolean {
  if (isRunRole(spec.role) && result.verdict === ROLE_VERDICTS[spec.role][1]) return true;
  const verdicts = new Set<string>();
  const success = ["completed", "approve", "pass"].includes(result.verdict);
  for (const candidate of parsedJsonCandidates(previous)) {
    for (const value of unwrappedCandidates(candidate, spec)) {
      const obj = coerceCandidate(value, spec)?.obj;
      if (typeof obj?.verdict === "string" && ROLE_VERDICTS[spec.role].includes(obj.verdict)) verdicts.add(obj.verdict);
      if (success && obj && typeof obj.verdict === "string") {
        if (Array.isArray(obj.blocking_findings) && obj.blocking_findings.length) return false;
        for (const field of ["tests", "commands"]) {
          if (Array.isArray(obj[field]) && obj[field].some((entry: any, _index: number, all: unknown[]) => entry && !isProvenRedCheck(entry, all) && (
            commandOutcome(entry) === "failed" ||
            (typeof entry.exit_code === "number" && entry.exit_code !== (entry.expected_exit_code ?? 0)) ||
            (spec.role === "verifier" && entry.status === "skipped" && entry.optional !== true)
          ))) return false;
        }
        if (Array.isArray(obj.acceptance) && obj.acceptance.some((entry: any) => entry && (
          acceptanceOutcome(entry.status) === "unmet" ||
          acceptanceOutcome(entry.status) === null ||
          (spec.role === "verifier" && acceptanceOutcome(entry.status) === "skipped" && entry.optional !== true)
        ))) return false;
      }
    }
  }
  if (verdicts.size === 1) return verdicts.has(result.verdict);
  return verdicts.size === 0 && ["failed", "fail", "request_changes"].includes(result.verdict);
}

// The verdict the provider's own (invalid) answer claimed, when exactly one
// is parseable; feeds the result_repair event's downgrade note.
export function previousVerdictOf(previous: string, spec: RunSpec): string | null {
  const verdicts = new Set<string>();
  for (const candidate of parsedJsonCandidates(previous)) {
    for (const value of unwrappedCandidates(candidate, spec)) {
      const verdict = (value as Record<string, unknown>).verdict;
      if (typeof verdict === "string" && isRunRole(spec.role) && ROLE_VERDICTS[spec.role].includes(verdict)) verdicts.add(verdict);
    }
  }
  return verdicts.size === 1 ? [...verdicts][0]! : null;
}

export function synthesizeResult(spec: RunSpec, summary: string): RoleResult {
  return fallbackResult({
    role: spec.role,
    run_id: spec.run_id,
    base_sha: spec.base_sha,
    head_sha: spec.base_sha,
    summary,
  });
}

export function writeResult(runDir: string, spec: RunSpec, result: RoleResult): void {
  const validation = validateRoleResult(spec.role, result);
  if (!validation.ok) {
    throw new Error(`invalid driver result: ${validation.errors.join("; ")}`);
  }
  writeJsonAtomic(`${runDir}/result.json`, result);
}

export function writeExitCode(runDir: string, code: number): void {
  writeFileSync(`${runDir}/exit_code`, `${code}\n`, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeResearchValue(spec: RunSpec, field: "RECOMMENDATION" | "OPEN_QUESTIONS"): string | undefined {
  const revision = spec.tag.startsWith("plan-r") ? process.env[`ORCH_DRIVER_FAKE_RESEARCH_REVISION_${field}`] : undefined;
  return revision ?? process.env[`ORCH_DRIVER_FAKE_RESEARCH_${field}`];
}

function fakeResearchQuestions(spec: RunSpec): string[] {
  const raw = fakeResearchValue(spec, "OPEN_QUESTIONS");
  if (!raw) return [];
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("ORCH_DRIVER_FAKE_RESEARCH[_REVISION]_OPEN_QUESTIONS must be a JSON string array");
  }
  return value;
}

// Optional fake implementer edit: writes a real file into the worktree so the
// supervisor's git/jj evidence (git-status.txt) reflects a change, letting
// composition flows (prewalk's handoff gate) exercise their host-side checks.
function fakeImplementerEdit(spec: RunSpec): string[] {
  const rel = process.env.ORCH_DRIVER_FAKE_IMPL_EDIT;
  if (!rel) return [];
  const path = `${spec.worktree}/${rel}`;
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, `fake edit by ${spec.run_id}\n`, "utf8");
  return [rel];
}

const FAKE_RESEARCH_PLAN = [
  "## Destination",
  "Complete one fake worker task.",
  "",
  "## Out of scope",
  "None.",
  "",
  "## Tasks (now)",
  "### fake-task",
  "- Role: implementer",
  "- After: none",
  "- Spec: Execute the fake task without external side effects.",
  "- Acceptance:",
  "  - the fake worker reaches done",
  "",
  "## Later (not yet specified)",
  "None.",
].join("\n");

export async function maybeWriteFakeResult(runDir: string, spec: RunSpec, provider: string): Promise<boolean> {
  if (process.env.ORCH_DRIVER_FAKE_RESULT !== "1") return false;
  // Test seam: a fake write-role run leaves one file in its evidence dir, the
  // way a real worker would, so the supervisor's manifest can be checked.
  const fakeEvidence = process.env.ORCH_DRIVER_FAKE_EVIDENCE;
  if (fakeEvidence && roleHasEvidenceDir(spec.role)) {
    if (!/^[A-Za-z0-9._-]+$/.test(fakeEvidence) || fakeEvidence === "." || fakeEvidence === "..") {
      throw new Error(`ORCH_DRIVER_FAKE_EVIDENCE must be a plain file name: ${JSON.stringify(fakeEvidence)}`);
    }
    mkdirSync(runEvidenceDir(runDir), { recursive: true, mode: 0o700 });
    writeFileSync(`${runEvidenceDir(runDir)}/${fakeEvidence}`, `fake ${provider} evidence for ${spec.run_id}\n`, "utf8");
  }
  const sleepMs = Number(process.env.ORCH_DRIVER_FAKE_SLEEP_MS ?? "0");
  if (Number.isFinite(sleepMs) && sleepMs > 0) await sleep(sleepMs);
  writeFileSync(
    `${runDir}/native.jsonl`,
    // session_id: fixed UUID so fake runs are resumable in tests (claude's
    // resume path requires a UUID; the value itself is never dereferenced).
    `${JSON.stringify({ type: "fake", provider, run_id: spec.run_id, session_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ts: new Date().toISOString() })}\n`,
    "utf8",
  );
  writeResult(
    runDir,
    spec,
    spec.role === "reviewer"
      ? {
          schema: "orch.result/reviewer/v1",
          run_id: spec.run_id,
          verdict: "approve",
          reviews_run_id: spec.run_id,
          blocking_findings: [],
          non_blocking_findings: [],
          suggested_tests: [],
        }
      : spec.role === "controller"
        ? {
            schema: "orch.result/controller/v1",
            run_id: spec.run_id,
            verdict: "completed",
            summary: `fake ${provider} controller completed`,
            actions: [],
          }
      : spec.role === "verifier"
        ? {
            schema: "orch.result/verifier/v1",
            run_id: spec.run_id,
            verdict: "pass",
            verifies_run_id: spec.run_id,
            commands: [{ cmd: `fake ${provider} check`, exit_code: 0, status: "passed", summary: "fake check passed" }],
            acceptance: [],
          }
      : spec.role === "researcher"
        ? {
            schema: "orch.result/researcher/v1",
            run_id: spec.run_id,
            verdict: "completed",
            summary: `fake ${provider} research completed`,
            recommendation: fakeResearchValue(spec, "RECOMMENDATION") ?? FAKE_RESEARCH_PLAN,
            alternatives: [],
            sources: [],
            open_questions: fakeResearchQuestions(spec),
            risks: [],
          }
        : {
            schema: "orch.result/implementer/v1",
            run_id: spec.run_id,
            verdict: "completed",
            summary: process.env.ORCH_DRIVER_FAKE_IMPL_SUMMARY ?? `fake ${provider} completed`,
            base_sha: spec.base_sha,
            head_sha: spec.base_sha,
            changed_files: fakeImplementerEdit(spec),
            tests: [],
            acceptance: [],
            risks: [],
            rollback: "No changes made.",
          },
  );
  writeExitCode(runDir, 0);
  return true;
}

// pi/omp emit one line per streaming delta that re-embeds the accumulated state
// so far: message_update carries the partial message, tool_execution_update the
// tool call's args plus its partial result (a subagent call was seen to emit
// 10k of them, each repeating its full prompt) — O(n²) bytes per message/call
// that no reader consumes (native-events.ts normalizes message_end/turn_end/
// agent_end and tool_execution_start/end only; the end lines carry the complete
// message/result), so those lines never reach disk. Matching is structural like
// the read side: top-level JSONL events serialize their type key first.
const droppedNativeLinePrefixes = ['{"type":"message_update"', '{"type":"tool_execution_update"'].map((prefix) =>
  Buffer.from(prefix),
);

function keepsNativeLine(line: Buffer): boolean {
  return !droppedNativeLinePrefixes.some((prefix) => line.subarray(0, prefix.length).equals(prefix));
}

export async function pipeToFile(stream: ReadableStream<Uint8Array> | null, path: string, mode: "w" | "a" = "w"): Promise<void> {
  if (!stream) return;
  const fd = openSync(path, mode);
  try {
    const reader = stream.getReader();
    let pending = Buffer.alloc(0);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending = pending.length === 0 ? Buffer.from(chunk.value) : Buffer.concat([pending, chunk.value]);
      let start = 0;
      for (let nl = pending.indexOf(0x0a, start); nl !== -1; nl = pending.indexOf(0x0a, start)) {
        const line = pending.subarray(start, nl + 1);
        if (keepsNativeLine(line)) writeSync(fd, line);
        start = nl + 1;
      }
      pending = pending.subarray(start);
    }
    if (pending.length > 0 && keepsNativeLine(pending)) writeSync(fd, pending);
  } finally {
    closeSync(fd);
  }
}

export interface ExecutionContext {
  provider: AgentName;
  spec: RunSpec;
  runDir: string;
  worktree: string;
  prompt?: string;
  // Dry-run previews the exact same plan (same builder, same validations) but
  // must not mutate the host: scratch dirs are not created, and the
  // not-yet-existing run dir canonicalizes via its deepest existing ancestor.
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderExecutionPlan {
  argv: string[]; // final spawnable command, outer wrapper included
  sandboxEngine: SandboxEngine;
  sandboxPosture: SandboxPosture;
  profileSha256: string | null;
  providerNativeSandbox: boolean;
  evidenceDir: string | null; // ${runDir}/evidence for write roles, exported as ORCH_RUN_EVIDENCE_DIR
  env: Record<string, string>;
}

// Marker inherited by every descendant of a sandboxed worker. A sandboxed run
// that dispatches another sandboxed run (controller → `orch run create` →
// worker driver) would nest sandbox_apply, which macOS rejects (probe: exit
// 71); the nested driver sees the marker and fails closed with a specific
// error instead of a bare 71.
export const SEATBELT_ENV_MARKER = "ORCH_SANDBOX_ENGINE";
// Immutable host-owned run context inherited by a sandboxed controller's
// `orch ...` subprocesses. The host reconciler validates these values against
// spec.json/status.json before honoring a queued mutation.
export const ORCH_SANDBOX_RUN_ID_ENV = "ORCH_SANDBOX_RUN_ID";
export const ORCH_SANDBOX_RUN_DIR_ENV = "ORCH_SANDBOX_RUN_DIR";

// The single atomic decision point for how a provider executes: engine and
// posture, provider argv, native-sandbox opt-outs (codex bypass, claude
// settings), env redirections, and the Seatbelt wrapper are produced together,
// so a sandbox-disabling argv can never escape without its outer jail. Drivers
// spawn plan.argv with plan.env, nothing else; dry-run displays the same plan.
export function buildProviderExecutionPlan(ctx: ExecutionContext): ProviderExecutionPlan {
  const { provider, spec, runDir, worktree } = ctx;
  const posture = sandboxPosture(spec.role);
  const env = buildWorkerEnv(ctx.env ?? process.env);
  env[ORCH_SANDBOX_RUN_ID_ENV] = spec.run_id;
  env[ORCH_SANDBOX_RUN_DIR_ENV] = runDir;
  const evidenceDir = roleHasEvidenceDir(spec.role) ? runEvidenceDir(runDir) : null;
  // The plan never touches the host (its fail-closed checks come first): run
  // create makes the dir, and runProviderDriver re-ensures it before spawning.
  if (evidenceDir) env[ORCH_RUN_EVIDENCE_DIR_ENV] = evidenceDir;
  if (spec.sandbox_engine === undefined) {
    return {
      argv: providerArgv(provider, spec, runDir, worktree, ctx.prompt ?? "", false),
      sandboxEngine: "none",
      sandboxPosture: posture,
      profileSha256: null,
      providerNativeSandbox: provider === "codex" || provider === "claude",
      evidenceDir,
      env,
    };
  }
  // A spec from a newer orch may carry an engine this build does not
  // implement; running it unsandboxed would silently drop the boundary.
  if (spec.sandbox_engine !== SEATBELT_ENGINE) {
    throw new Error(`sandbox: spec requests unsupported sandbox_engine ${JSON.stringify(spec.sandbox_engine)} (this build implements ${SEATBELT_ENGINE})`);
  }
  const fail = (stage: string, detail: string): never => {
    throw new Error(`sandbox ${SEATBELT_ENGINE} (provider=${provider} role=${spec.role} stage=${stage}): ${detail}`);
  };

  const unsupported = seatbeltUnsupportedReason(ctx.platform ?? process.platform);
  if (unsupported) fail("platform", unsupported);
  const outerEngine = env[SEATBELT_ENV_MARKER];
  if (outerEngine) {
    fail(
      "nesting",
      `already inside an orch ${outerEngine} sandbox; macOS cannot nest sandbox_apply — dispatch this run from an unsandboxed host process`,
    );
  }
  const home = env.HOME;
  if (!home) fail("paths", "HOME is not set");
  if (!existsSync(worktree)) fail("paths", `worktree does not exist: ${worktree}`);
  const canonicalHome = canonicalizePath(home!);
  const canonicalWorktree = canonicalizePath(worktree);

  // The selected provider reuses the host's real login/session state; a
  // missing state dir means "log in from a normal terminal first", not "open
  // $HOME so the provider can pick a landing spot".
  const state = providerStatePaths(provider, canonicalHome);
  for (const dir of state.dirs) {
    if (!existsSync(dir)) fail("provider-state", `${dir} not found; run \`${provider}\` interactively once to initialize it`);
  }

  // Host-owned, run-scoped scratch: the only provider-writable spot inside the
  // run dir. Formal artifacts (native.jsonl, result.json, …) stay outside it.
  const scratchDir = `${runDir}/scratch`;
  if (!ctx.dryRun) {
    mkdirSync(`${scratchDir}/tmp`, { recursive: true, mode: 0o700 });
    mkdirSync(`${scratchDir}/cache`, { recursive: true, mode: 0o700 });
  }
  const canonicalScratch = canonicalizePath(scratchDir);

  // Persistent worker cache: heavyweight tool state (Gradle home & co.) lives
  // across runs in one host-owned dir instead of cold per-run scratch or
  // ad-hoc /tmp dirs. Same fail-closed narrow-dir gate as every other grant.
  const cacheDir = workerCacheDir(env, home!);
  if (!ctx.dryRun) mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const canonicalCache = canonicalizePath(cacheDir);
  {
    const reason = narrowWritableDirReason(canonicalCache, canonicalHome, canonicalWorktree, ctx.dryRun === true);
    if (reason) fail("cache-target", `worker cache ${canonicalCache} ${reason}; refusing to grant it as a write subpath (set XDG_CACHE_HOME to a plain per-user cache dir)`);
  }

  // Config-declared extra write dirs, snapshotted into the spec at create
  // (the driver never reads live config). Re-vet each entry fail-closed:
  // orch's own config dir and state root are never grantable — a worker could
  // otherwise edit sandbox_write_dirs for future runs or forge run state —
  // and everything else passes the same narrow-dir gate as built-in grants.
  const extraWriteDirs: string[] = [];
  if ((spec.sandbox_write_dirs ?? []).length > 0) {
    const guarded: Array<[string, string]> = [
      [canonicalizePath(env.XDG_CONFIG_HOME ? `${env.XDG_CONFIG_HOME}/orch` : `${home}/.config/orch`), "orch config dir"],
      [canonicalizePath(env.XDG_STATE_HOME ? `${env.XDG_STATE_HOME}/orch` : `${home}/.local/state/orch`), "orch state root"],
    ];
    for (const raw of spec.sandbox_write_dirs!) {
      if (typeof raw !== "string" || !raw.startsWith("/")) {
        fail("config-write-dir", `sandbox_write_dirs entry is not an absolute path: ${JSON.stringify(raw)}`);
      }
      const canonical = canonicalizePath(raw);
      for (const [dir, label] of guarded) {
        if (canonical === dir || canonical.startsWith(`${dir}/`) || dir.startsWith(`${canonical}/`)) {
          fail("config-write-dir", `sandbox_write_dirs entry ${raw} overlaps the ${label} (${dir}); orch's own config/state is never grantable`);
        }
      }
      const reason = narrowWritableDirReason(canonical, canonicalHome, canonicalWorktree, ctx.dryRun === true);
      if (reason) fail("config-write-dir", `sandbox_write_dirs entry ${raw} ${reason}; refusing to grant it as a write subpath`);
      if (!extraWriteDirs.includes(canonical)) extraWriteDirs.push(canonical);
    }
  }

  // A hardlink escape needs a write-allowed path to the shared inode. Only the
  // project-write posture puts worktree paths in the allow set — plus the edge
  // case of a worktree living under the always-writable /private/tmp. Under a
  // read-only worktree every write through a hardlinked path is denied anyway,
  // so pure-analysis roles must not be blocked by build-tool hardlinks (e.g.
  // Gradle hardlinks cxx intermediates to committed jniLibs).
  const worktreeWritable = posture === "project-write"
    || canonicalWorktree === "/private/tmp"
    || canonicalWorktree.startsWith("/private/tmp/");
  if (worktreeWritable) {
    const hardlinks = findWorktreeHardlinks(canonicalWorktree);
    if (hardlinks.length > 0) {
      fail(
        "hardlink-preflight",
        `worktree files share inodes with content that may live outside the sandbox (Seatbelt is path-based and cannot stop writes through them): ${hardlinks.join(", ")} — use a hardlink-free copy of the project or stronger isolation`,
      );
    }
  }

  // Every canonical write subpath derived from provider/controller state must
  // survive the narrow-dir gate: a symlinked `~/.pi -> $HOME` or
  // `XDG_STATE_HOME -> /` would otherwise become a home/root-wide (subpath ...)
  // allow. Fail closed on the first offender instead of widening the boundary.
  const providerStateDirs = state.dirs.map(canonicalizePath);
  for (let index = 0; index < providerStateDirs.length; index += 1) {
    const dir = providerStateDirs[index]!;
    const reason = providerStateDirReason(state.dirs[index]!, dir, canonicalHome, canonicalWorktree);
    if (reason) fail("state-target", `provider state ${dir} ${reason}; refusing to grant it as a write subpath`);
  }
  const providerStateFiles = state.files.map(canonicalizePath);
  for (let index = 0; index < providerStateFiles.length; index += 1) {
    const file = providerStateFiles[index]!;
    const reason = rootLevelStateFileReason(state.files[index]!, file, canonicalHome);
    if (reason) fail("state-target", `provider state file ${file} ${reason}; refusing to grant it as a write literal`);
  }

  // Finding 5: the controller does NOT get the whole orch state root (that
  // would let it overwrite every run's spec/status/result/sandbox.json). Its
  // only writable orch area is dispatch/pending; done/ stays host-owned so the
  // controller cannot forge a result. A host-side reconciler
  // executes the queued state mutations (see src/dispatch.ts). The driver runs
  // unsandboxed, so it creates and canonicalizes the dir here.
  let orchStateDir: string | null = null;
  if (spec.role === "controller") {
    const stateRoot = env.XDG_STATE_HOME ? `${env.XDG_STATE_HOME}/orch` : `${home}/.local/state/orch`;
    const canonicalStateRoot = canonicalizePath(stateRoot);
    const dispatchDir = `${canonicalStateRoot}/dispatch`;
    const controllerPendingDir = `${dispatchDir}/pending/${spec.run_id}`;
    const controllerQueueDirs = [
      controllerPendingDir,
      `${dispatchDir}/claims/${spec.run_id}`,
      `${dispatchDir}/done/${spec.run_id}`,
    ];
    for (const dir of controllerQueueDirs) {
      const reason = exactStateDirReason(dir, canonicalizePath(dir));
      if (reason) fail("state-target", `controller dispatch dir ${dir} ${reason}; refusing to use it as a queue endpoint`);
    }
    if (!ctx.dryRun) {
      for (const dir of controllerQueueDirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const dir of controllerQueueDirs) {
        const reason = exactStateDirReason(dir, canonicalizePath(dir));
        if (reason) fail("state-target", `controller dispatch dir ${dir} ${reason}; refusing to use it as a queue endpoint`);
      }
    }
    orchStateDir = controllerPendingDir;
    const reason = narrowWritableDirReason(orchStateDir, canonicalHome, canonicalWorktree, ctx.dryRun === true);
    if (reason) fail("state-target", `controller dispatch dir ${orchStateDir} ${reason}; refusing to grant it as a write subpath`);
  }

  const hostTmp = env.TMPDIR ? canonicalizePath(env.TMPDIR) : null;
  const profile = seatbeltProfile({
    posture,
    worktree: canonicalWorktree,
    scratchDir: canonicalScratch,
    providerStateDirs,
    providerStateFiles,
    hostTmpDir: hostTmp && acceptableHostTmpDir(hostTmp, canonicalHome, canonicalWorktree) ? hostTmp : null,
    orchStateDir,
    workerCacheDir: canonicalCache,
    extraWriteDirs,
    evidenceDir: evidenceDir ? canonicalizePath(evidenceDir) : null,
  });

  return {
    argv: ["/usr/bin/sandbox-exec", "-p", profile, ...providerArgv(provider, spec, runDir, worktree, ctx.prompt ?? "", true)],
    sandboxEngine: SEATBELT_ENGINE,
    sandboxPosture: posture,
    profileSha256: sha256(profile),
    providerNativeSandbox: false,
    evidenceDir,
    env: {
      ...env,
      ...scratchEnv(canonicalScratch),
      // The env seam to the persistent cache grant above. Gradle cannot write
      // ~/.gradle inside the jail; without a stable home it rebuilds a cold
      // cache per run (or lands in ad-hoc /tmp dirs), dominating wall time.
      ORCH_WORKER_CACHE: canonicalCache,
      GRADLE_USER_HOME: `${canonicalCache}/gradle`,
      // Git metadata is read-only in the jail; without this, `git status`
      // tries to take the optional index lock to refresh stat data and fails.
      GIT_OPTIONAL_LOCKS: "0",
      [SEATBELT_ENV_MARKER]: SEATBELT_ENGINE,
    },
  };
}

export async function runProviderDriver(provider: AgentName, argv: string[]): Promise<number> {
  const args = parseDriverArgs(argv);
  const spec = readSpec(args.specPath);
  if (await maybeWriteFakeResult(args.runDir, spec, provider)) return 0;

  const prompt = buildPrompt(spec, provider, args.runDir);
  if (provider === "codex" && nativeSchemaEnabled()) writeResultSchemaFile(args.runDir, spec);
  if (provider === "codex" && spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
    const baseline = readCodexBaseline(spec.provider_session_id);
    if (baseline) writeFileSync(codexBaselinePath(args.runDir), `${JSON.stringify(baseline)}\n`, "utf8");
  }
  if (provider === "omp") {
    // omp -p ignores stdin: the prompt rides an @file argument, and the quota
    // fallback chain rides a per-run config overlay (omp retry.fallbackChains).
    writeFileSync(ompPromptPath(args.runDir), prompt, "utf8");
    const { fallbacks } = ompModelChain(spec.model);
    if (fallbacks.length > 0) {
      writeFileSync(ompFallbackConfigPath(args.runDir), ompFallbackConfigYaml(fallbacks), "utf8");
    }
  }
  let plan: ProviderExecutionPlan;
  try {
    plan = buildProviderExecutionPlan({ provider, spec, runDir: args.runDir, worktree: args.worktree, prompt });
  } catch (error) {
    // Fail closed: a run whose sandbox cannot be built/applied must never
    // reach the provider. The error names engine/provider/role/stage; writing
    // result + exit_code makes the run terminally failed instead of hung.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    writeExitCode(args.runDir, 1);
    writeResult(args.runDir, spec, synthesizeResult(spec, message));
    return 1;
  }
  if (plan.evidenceDir) mkdirSync(plan.evidenceDir, { recursive: true, mode: 0o700 });
  // Audit record of the plan actually used; the supervisor folds it into
  // status.json (the driver never writes status.json itself).
  writeJsonAtomic(`${args.runDir}/sandbox.json`, {
    sandbox_engine: plan.sandboxEngine,
    sandbox_posture: plan.sandboxPosture,
    sandbox_profile_sha256: plan.profileSha256,
    provider_native_sandbox: plan.providerNativeSandbox,
    evidence_dir: plan.evidenceDir,
  });
  appendDriverEvent(args.runDir, { type: "phase", phase: "provider_start", wait_reason: "provider_process" });
  const proc = Bun.spawn(plan.argv, {
    cwd: args.worktree,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: plan.env,
  });
  if (provider !== "omp") proc.stdin.write(prompt);
  proc.stdin.end();

  await pipeToFile(proc.stdout, `${args.runDir}/native.jsonl`);
  const code = await proc.exited;
  appendDriverEvent(args.runDir, { type: "phase", phase: "provider_end", exit_code: code });
  writeExitCode(args.runDir, code);

  appendDriverEvent(args.runDir, { type: "phase", phase: "result_validation" });
  const original = rawResultText(args.runDir);
  const failed = code !== 0 || providerFailed(args.runDir);
  let extracted = failed ? null : extractResultWithCoercionsFromRunDir(args.runDir, spec);
  // A provider that finished normally but whose answer does not validate gets
  // one repair round (ORCH_RESULT_REPAIR=0 disables it); a crashed or killed
  // provider does not, its raw output is preserved below instead.
  if (!extracted && !failed && process.env.ORCH_RESULT_REPAIR !== "0") {
    const errors = resultValidationErrors(args.runDir, spec);
    const previous = rawResultText(args.runDir);
    if (previous) {
      writeFileSync(`${args.runDir}/result.original.md`, previous, "utf8");
      const repairCode = await runResultRepair({ provider, spec, runDir: args.runDir, worktree: args.worktree, errors, previous });
      const repaired = repairCode === 0 ? extractResultWithCoercionsFromRunDir(args.runDir, spec) : null;
      extracted = repaired && repairPreservesVerdict(previous, repaired.result, spec) ? repaired : null;
      const previousVerdict = previousVerdictOf(previous, spec);
      const downgraded = Boolean(extracted && previousVerdict && previousVerdict !== extracted.result.verdict);
      appendDriverEvent(args.runDir, {
        type: "result_repair",
        attempt: 1,
        errors,
        repair_exit_code: repairCode,
        outcome: extracted ? "valid" : "invalid",
        ...(downgraded ? { verdict_downgraded: { from: previousVerdict, to: extracted!.result.verdict } } : {}),
      });
    }
  }
  if (extracted) {
    writeResult(args.runDir, spec, extracted.result);
    appendResultCoercionEvent(args.runDir, extracted.coercions);
    appendDriverEvent(args.runDir, { type: "phase", phase: "delivery_complete", valid_result: true });
    return code;
  }

  // Preserve the worker's real answer even when it doesn't fit the schema —
  // in practice most runs produce a usable review that must stay reachable.
  const raw = original;
  if (raw) writeFileSync(`${args.runDir}/result.raw.md`, raw, "utf8");

  // Exit 71 under the Seatbelt wrapper is the canonical sandbox_apply failure:
  // the sandbox was not applied and the provider never ran (fail-closed).
  const sandboxApplyHint =
    plan.sandboxEngine !== "none" && code === 71 ? ` (Seatbelt sandbox_apply failed; the provider never started)` : "";
  const summary =
    code === 0 && !raw
      ? `${provider} exited 0 but produced no output; check the provider CLI auth/session (run \`${provider}\` interactively once)`
      : code === 0
        ? `${provider} did not return a valid orch result JSON; raw output saved to result.raw.md. Excerpt: ${raw!.slice(0, 400)}`
        : `${provider} exited ${code}${sandboxApplyHint}${raw ? "; raw output saved to result.raw.md" : ""}`;
  writeResult(args.runDir, spec, synthesizeResult(spec, summary));
  appendDriverEvent(args.runDir, { type: "phase", phase: "delivery_complete", valid_result: false });
  // No valid result is a failed run whatever the provider exit code claims:
  // exit 0 here would let the supervisor mark a protocol failure `done`, and
  // run-state consumers (overview, wait, retries) would read it as success.
  // The raw answer stays reachable via result.raw.md either way.
  writeExitCode(args.runDir, code || 1);
  return code || 1;
}
