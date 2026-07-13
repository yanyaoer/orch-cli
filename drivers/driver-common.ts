import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { isRunRole, type AgentName, type ResultCoercion, type RunSpec, type RoleResult } from "../src/types.ts";
import { fallbackResult, resultSchemaName, ROLE_REQUIRED_FIELDS, ROLE_VERDICTS, validateRoleResult } from "../src/schema.ts";
import { appendJsonLine, countLines, writeJsonAtomic } from "../src/json.ts";
import { normalizeNativeText, type NativeEvent } from "../src/native-events.ts";

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

export function buildPrompt(spec: RunSpec, provider: string): string {
  const role = isRunRole(spec.role) ? spec.role : "implementer";
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
    "",
    "Execute the task below. Your final answer must be a single JSON object matching this orch schema.",
    `The top-level JSON object must include: "schema": "${schemaName}".`,
    // Models cannot infer the field list from the schema name: live runs
    // dropped verdict, then summary. Spell out every validator-required field.
    `Required top-level fields — omitting any of them fails the run: ${required.map((field) => `"${field}"`).join(", ")}.`,
    `It must also include "verdict", exactly one of: ${verdicts.map((verdict) => `"${verdict}"`).join(" | ")}. Never omit "verdict".` +
      (failure ? ` Use "${failure}" when the task could not genuinely be completed; never claim success for ungrounded or partial work.` : ""),
    "Do not wrap the JSON in Markdown. Do not create or edit result files in the worktree; return the JSON as your final answer only.",
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

export function buildWorkerEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }

  for (const key of recursiveToolEnvKeys) delete env[key];
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
// Primary is gpt-5.6-sol at xhigh thinking; gemini sits at the tail because
// its provider intermittently geo-rejects behind the corporate VPN.
export const OMP_MODEL_CHAIN: readonly string[] = [
  "openai-codex/gpt-5.6-sol",
  "zenmux/anthropic/claude-fable-5",
  "google-antigravity/gemini-3.1-pro",
];

export const OMP_THINKING = "--thinking=xhigh";

// pi default mirrors omp's primary: gpt-5.6-sol at xhigh thinking. pi has no
// quota-fallback chain; an explicit --model overrides the default.
export const PI_DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";

export function ompModelChain(model: string | null | undefined): { primary: string; fallbacks: string[] } {
  const primary = model ?? OMP_MODEL_CHAIN[0]!;
  return { primary, fallbacks: OMP_MODEL_CHAIN.filter((entry) => entry !== primary) };
}

export function ompPromptPath(runDir: string): string {
  return `${runDir}/prompt.md`;
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

// Researcher model per provider: codex pins gpt-5.6-sol and claude pins fable,
// both at xhigh effort; omp rides its default quota-fallback chain
// (gpt-5.6-sol primary at xhigh thinking).
export const CODEX_RESEARCHER_MODEL = "gpt-5.6-sol";

// claude model tier by role: reviewer escalates to opus (deep critique, paired
// with omp's gpt-5.6-sol as a distinct model family in cross-review);
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

export function buildProviderArgv(
  provider: AgentName,
  spec: RunSpec,
  runDir: string,
  worktree: string,
  prompt = "",
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
    if (readOnly) argv.push("--tools", "read,grep,find,ls");
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
    // and test commands wait for interactive approval that never comes. Blast
    // radius note: bypassPermissions disables claude's sandbox entirely, wider
    // than codex write roles (which keep codex's default workspace-write
    // sandbox). Role→read-only mapping is identical; sandbox strength is not.
    else argv.push("--permission-mode", "bypassPermissions");
    if (spec.provider_session_name) argv.push("--name", spec.provider_session_name);
    if (spec.provider_session_mode === "ephemeral") {
      argv.push("--no-session-persistence");
    } else if (spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
      argv.push("--resume", spec.provider_session_id);
    }
    return argv;
  }

  if (provider === "codex") {
    const lastMessagePath = `${runDir}/last_message.txt`;
    // Researcher: pin the strong-reasoning model at xhigh effort and enable
    // codex-native web search — the read-only sandbox blocks network for shell
    // commands, so web research must ride the Responses web_search tool.
    const researcherFlags =
      spec.role === "researcher" ? ["-c", "model_reasoning_effort=xhigh", "-c", "tools.web_search=true"] : [];
    const model = spec.model ?? (spec.role === "researcher" ? CODEX_RESEARCHER_MODEL : null);
    if (spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
      // `codex exec resume` has no --sandbox flag (exit 2 if passed); the
      // sandbox rides the parent `exec` level, accepted before the subcommand.
      const resume = ["codex", "exec"];
      // codex exec DEFAULTS to the read-only sandbox (verified live: writes
      // blocked without an explicit -s); write-capable roles must ask for
      // workspace-write explicitly or implementers cannot edit anything.
      resume.push("--sandbox", readOnly ? "read-only" : "workspace-write");
      resume.push("resume", "--json", "--output-last-message", lastMessagePath);
      if (model) resume.push("--model", model);
      resume.push(...researcherFlags);
      resume.push(spec.provider_session_id, "-");
      return resume;
    }
    const argv = ["codex", "exec", "--json", "--cd", worktree, "--output-last-message", lastMessagePath];
    if (model) argv.push("--model", model);
    argv.push(...researcherFlags);
    // See resume path above: codex exec defaults to read-only.
    argv.push("--sandbox", readOnly ? "read-only" : "workspace-write");
    if (spec.provider_session_mode === "ephemeral") argv.push("--ephemeral");
    argv.push("-");
    return argv;
  }

  const argv = ["pi", "--model", spec.model ?? PI_DEFAULT_MODEL, "--thinking", "xhigh"];
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

function findJsonObjectEnd(text: string, start: number): number | null {
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
  const seen = new Set<string>();
  const pushJson = (json: string): void => {
    const key = json.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const parsed = tryParseJson(key);
    if (parsed !== null) candidates.push(parsed);
  };

  for (const fenced of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (fenced[1]) pushJson(fenced[1]);
  }

  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== "{") continue;
    const end = findJsonObjectEnd(trimmed, start);
    if (end === null) continue;
    pushJson(trimmed.slice(start, end + 1));
  }

  return candidates;
}

function roleResultFromCandidate(value: unknown, spec: RunSpec): ExtractedResult | null {
  const normalized = normalizedRoleResult(value, spec);
  if (normalized) return normalized;

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isRunRole(spec.role)) return null;

  const obj = value as Record<string, unknown>;
  const schemaName = resultSchemaName(spec.role);
  for (const key of [schemaName, "result"]) {
    const wrapped = normalizedRoleResult(obj[key], spec);
    if (wrapped) return wrapped;
  }
  return null;
}

// Providers often deviate from the schema in benign ways (string items where
// objects are expected and vice versa, invented run ids, verdict synonyms).
// Real usage showed ~2/3 of runs losing their result to strict validation, so
// coerce the unambiguous deviations instead of discarding the whole result.
function coercedString(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    const body = [obj.body, obj.description, obj.text, obj.cmd, obj.summary].find(
      (v) => typeof v === "string" && v.trim(),
    ) as string | undefined;
    if (body) return typeof obj.id === "string" && obj.id.trim() ? `${obj.id}: ${body}` : body;
  }
  return JSON.stringify(item);
}

function coerceStringArray(obj: Record<string, unknown>, field: string, coercions: ResultCoercion[]): void {
  if (!Array.isArray(obj[field])) return;
  obj[field] = (obj[field] as unknown[]).map((item, index) => {
    const coerced = coercedString(item);
    if (typeof item !== "string" || item !== coerced) {
      recordCoercion(coercions, `${field}[${index}]`, item, coerced, "string array item");
    }
    return coerced;
  });
}

function coerceFindings(obj: Record<string, unknown>, field: string, blocking: boolean, coercions: ResultCoercion[]): void {
  if (!Array.isArray(obj[field])) return;
  obj[field] = (obj[field] as unknown[]).map((item, index) => {
    const finding: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item) ? { ...(item as Record<string, unknown>) } : { body: String(item) };
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      recordCoercion(coercions, `${field}[${index}]`, item, finding, "finding object");
    }
    if (typeof finding.body !== "string" || !finding.body.trim()) {
      // Models name the prose differently (gemini emits finding+scenario);
      // when a title and a detail field coexist, keep both halves.
      const isProse = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
      const title = [finding.finding, finding.title, finding.summary].find(isProse);
      const detail = [finding.scenario, finding.description, finding.message, finding.detail, finding.text].find(isProse);
      const body = [title, detail].filter(Boolean).join("\n\n");
      if (body) {
        recordCoercion(coercions, `${field}[${index}].body`, finding.body, body, "body alias");
        finding.body = body;
      }
    }
    if (blocking) {
      if (typeof finding.id !== "string" || !finding.id.trim()) {
        const next = `finding-${index + 1}`;
        recordCoercion(coercions, `${field}[${index}].id`, finding.id, next, "required finding field default");
        finding.id = next;
      }
      if (typeof finding.severity !== "string" || !finding.severity.trim()) {
        recordCoercion(coercions, `${field}[${index}].severity`, finding.severity, "unspecified", "required finding field default");
        finding.severity = "unspecified";
      }
      if (typeof finding.file !== "string" || !finding.file.trim()) {
        recordCoercion(coercions, `${field}[${index}].file`, finding.file, "unspecified", "required finding field default");
        finding.file = "unspecified";
      }
    }
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

function coerceRoleResult(role: RunSpec["role"], obj: Record<string, unknown>, coercions: ResultCoercion[]): void {
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
    coerceFindings(obj, "blocking_findings", true, coercions);
    coerceFindings(obj, "non_blocking_findings", false, coercions);
    coerceStringArray(obj, "suggested_tests", coercions);
    if (typeof obj.reviews_run_id !== "string") {
      const next = obj.reviews_run_id == null ? "" : String(obj.reviews_run_id);
      recordCoercion(coercions, "reviews_run_id", obj.reviews_run_id, next, "stringified id");
      obj.reviews_run_id = next;
    }
  } else if (role === "implementer") {
    coerceMissingArrays(obj, ["changed_files", "tests", "acceptance", "risks"], coercions);
    coerceStringArray(obj, "changed_files", coercions);
    coerceStringArray(obj, "risks", coercions);
  } else if (role === "controller") {
    coerceMissingArrays(obj, ["actions"], coercions);
    coerceStringArray(obj, "actions", coercions);
  } else if (role === "researcher") {
    coerceMissingArrays(obj, ["alternatives", "sources", "open_questions", "risks"], coercions);
    for (const field of ["alternatives", "sources", "open_questions", "risks"]) {
      coerceStringArray(obj, field, coercions);
    }
    if (typeof obj.recommendation !== "string" || !obj.recommendation.trim()) {
      // Models name the deliverable differently; the aliases are unambiguous.
      const alias = [obj.proposal, obj.decision, obj.conclusion].find(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
      if (alias) {
        recordCoercion(coercions, "recommendation", obj.recommendation, alias, "recommendation alias");
        obj.recommendation = alias;
      }
    }
    // summary is descriptive, not control flow: when it is missing but the
    // deliverable exists, derive it from the recommendation's first prose line
    // instead of discarding an otherwise valid result (a live plan run omitted
    // summary while including verdict and a full recommendation).
    if ((typeof obj.summary !== "string" || !obj.summary.trim()) && typeof obj.recommendation === "string") {
      // First prose line: headings and fenced code blocks (including their
      // contents) are skipped, list markers are stripped so a bullet-only
      // plan still yields readable content.
      let firstProse: string | undefined;
      // Only the fence kind that opened a block closes it; the other kind is
      // ordinary content inside (and gets skipped with the rest of the block).
      let fence: "```" | "~~~" | null = null;
      for (const raw of obj.recommendation.split("\n")) {
        const line = raw.trim();
        const mark = line.startsWith("```") ? "```" : line.startsWith("~~~") ? "~~~" : null;
        if (mark && fence === null) {
          fence = mark;
          continue;
        }
        if (mark && mark === fence) {
          fence = null;
          continue;
        }
        if (fence !== null || !line || line.startsWith("#")) continue;
        // Both `1.` and `1)` list styles; a line that is only a marker is noise.
        const stripped = line.replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/, "");
        if (stripped) {
          firstProse = stripped;
          break;
        }
      }
      if (firstProse) {
        const derived = firstProse.length > 200 ? `${firstProse.slice(0, 197)}...` : firstProse;
        recordCoercion(coercions, "summary", obj.summary, derived, "summary derived from recommendation");
        obj.summary = derived;
      }
    }
    // Verdict is deliberately never defaulted: completed and failed require
    // identical content fields, so a missing verdict is genuinely ambiguous
    // and coercing it would let failed research dispatch write-role workers
    // (orch new gates on completed). buildPrompt demands the field instead;
    // a result without it fails closed with the raw output preserved.
  } else if (role === "verifier") {
    coerceMissingArrays(obj, ["commands", "acceptance"], coercions);
    if (typeof obj.verifies_run_id !== "string") {
      const next = obj.verifies_run_id == null ? "" : String(obj.verifies_run_id);
      recordCoercion(coercions, "verifies_run_id", obj.verifies_run_id, next, "stringified id");
      obj.verifies_run_id = next;
    }
  }
}

function normalizedRoleResult(value: unknown, spec: RunSpec): ExtractedResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isRunRole(spec.role)) return null;

  const schemaName = resultSchemaName(spec.role);
  const obj = { ...(value as Record<string, unknown>) };
  const coercions: ResultCoercion[] = [];
  // Candidates only come from this run's own stream, so the spec is the
  // authority on run_id — models frequently invent one, which used to reject
  // the entire result.
  if (obj.run_id !== spec.run_id) {
    recordCoercion(coercions, "run_id", obj.run_id, spec.run_id, "spec run_id is authoritative");
    obj.run_id = spec.run_id;
  }
  if (validateRoleResult(spec.role, obj).ok) return { result: obj as unknown as RoleResult, coercions };
  if (obj.schema === undefined) {
    recordCoercion(coercions, "schema", obj.schema, schemaName, "missing schema");
    obj.schema = schemaName;
  }
  coerceRoleResult(spec.role, obj, coercions);

  return validateRoleResult(spec.role, obj).ok ? { result: obj as unknown as RoleResult, coercions } : null;
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

function candidateTexts(events: NativeEvent[], kind: NativeEvent["kind"], format: NativeEvent["format"]): string[] {
  return events.filter((event) => event.kind === kind && event.format === format && typeof event.text === "string").map((event) => event.text!);
}

function collectResultCandidates(runDir: string): string[] {
  const candidates: string[] = [];
  for (const path of [`${runDir}/last_message.txt`, `${runDir}/stdout.log`]) {
    if (existsSync(path)) candidates.push(readFileSync(path, "utf8"));
  }

  const nativePath = `${runDir}/native.jsonl`;
  if (existsSync(nativePath)) {
    const nativeText = readFileSync(nativePath, "utf8");
    const events = normalizeNativeText(nativeText);
    // Final-message-first candidate order per provider format; raw lines are
    // plain text and stream noise, tried after every structured candidate.
    candidates.push(
      ...candidateTexts(events, "final", "claude"),
      ...candidateTexts(events, "assistant", "claude"),
      ...candidateTexts(events, "assistant", "codex"),
      ...candidateTexts(events, "assistant", "pi"),
      ...candidateTexts(events, "raw", "unknown"),
      // A plain-text provider response may be a JSON object spanning multiple
      // lines, so try the whole stream as one candidate too.
      nativeText,
    );
  }

  return candidates;
}

export function extractResultWithCoercionsFromRunDir(runDir: string, spec: RunSpec): ExtractedResult | null {
  for (const candidate of collectResultCandidates(runDir)) {
    const extracted = extractResultWithCoercionsFromText(candidate, spec);
    if (extracted) return extracted;
  }
  return null;
}

export function extractResultFromRunDir(runDir: string, spec: RunSpec): RoleResult | null {
  return extractResultWithCoercionsFromRunDir(runDir, spec)?.result ?? null;
}

export function appendResultCoercionEvent(runDir: string, coercions: ResultCoercion[]): void {
  if (coercions.length === 0) return;
  try {
    const eventsPath = `${runDir}/events.jsonl`;
    appendJsonLine(eventsPath, {
      type: "result_coercion",
      seq: countLines(eventsPath),
      ts: new Date().toISOString(),
      coercions,
    });
  } catch {
    // Coercion visibility is diagnostic only; extraction/result writing must win.
  }
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
            commands: [],
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
            summary: `fake ${provider} completed`,
            base_sha: spec.base_sha,
            head_sha: spec.base_sha,
            changed_files: [],
            tests: [],
            acceptance: [],
            risks: [],
            rollback: "No changes made.",
          },
  );
  writeExitCode(runDir, 0);
  return true;
}

export async function pipeToFile(stream: ReadableStream<Uint8Array> | null, path: string): Promise<void> {
  if (!stream) return;
  const fd = openSync(path, "w");
  try {
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      writeSync(fd, chunk.value);
    }
  } finally {
    closeSync(fd);
  }
}

export async function runProviderDriver(provider: AgentName, argv: string[]): Promise<number> {
  const args = parseDriverArgs(argv);
  const spec = readSpec(args.specPath);
  if (await maybeWriteFakeResult(args.runDir, spec, provider)) return 0;

  const prompt = buildPrompt(spec, provider);
  if (provider === "omp") {
    // omp -p ignores stdin: the prompt rides an @file argument, and the quota
    // fallback chain rides a per-run config overlay (omp retry.fallbackChains).
    writeFileSync(ompPromptPath(args.runDir), prompt, "utf8");
    const { fallbacks } = ompModelChain(spec.model);
    if (fallbacks.length > 0) {
      writeFileSync(ompFallbackConfigPath(args.runDir), ompFallbackConfigYaml(fallbacks), "utf8");
    }
  }
  const proc = Bun.spawn(buildProviderArgv(provider, spec, args.runDir, args.worktree, prompt), {
    cwd: args.worktree,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: buildWorkerEnv(),
  });
  if (provider !== "omp") proc.stdin.write(prompt);
  proc.stdin.end();

  await pipeToFile(proc.stdout, `${args.runDir}/native.jsonl`);
  const code = await proc.exited;
  writeExitCode(args.runDir, code);

  const extracted = extractResultWithCoercionsFromRunDir(args.runDir, spec);
  if (extracted) {
    writeResult(args.runDir, spec, extracted.result);
    appendResultCoercionEvent(args.runDir, extracted.coercions);
    return code;
  }

  // Preserve the worker's real answer even when it doesn't fit the schema —
  // in practice most runs produce a usable review that must stay reachable.
  const raw = rawResultText(args.runDir);
  if (raw) writeFileSync(`${args.runDir}/result.raw.md`, raw, "utf8");

  const summary =
    code === 0 && !raw
      ? `${provider} exited 0 but produced no output; check the provider CLI auth/session (run \`${provider}\` interactively once)`
      : code === 0
        ? `${provider} did not return a valid orch result JSON; raw output saved to result.raw.md. Excerpt: ${raw!.slice(0, 400)}`
        : `${provider} exited ${code}${raw ? "; raw output saved to result.raw.md" : ""}`;
  writeResult(args.runDir, spec, synthesizeResult(spec, summary));
  // No valid result is a failed run whatever the provider exit code claims:
  // exit 0 here would let the supervisor mark a protocol failure `done`, and
  // run-state consumers (overview, wait, retries) would read it as success.
  // The raw answer stays reachable via result.raw.md either way.
  return code || 1;
}
