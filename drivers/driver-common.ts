import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { isResultRole, type AgentName, type RunSpec, type RoleResult } from "../src/types.ts";
import { fallbackResult, resultSchemaName, validateRoleResult } from "../src/schema.ts";
import { writeJsonAtomic } from "../src/json.ts";
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
  const schemaName =
    spec.role === "reviewer"
      ? "orch.result/reviewer/v1"
      : spec.role === "verifier"
        ? "orch.result/verifier/v1"
        : "orch.result/implementer/v1";
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
    "Do not wrap the JSON in Markdown. Do not create or edit result files in the worktree; return the JSON as your final answer only.",
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
  // $SHELL breaks providers whose shell tool follows it (agy does; claude
  // pins zsh, codex rejects fish, pi pins /bin/bash).
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

export const AGY_MODEL = "Gemini 3.1 Pro (High)";

// agy has no stdin/file prompt channel; the prompt must ride in argv, which is
// visible in `ps` and bounded by ARG_MAX (~1MB on macOS). Fail early with a
// clear message instead of an opaque E2BIG from spawn.
export const AGY_MAX_PROMPT_BYTES = 512 * 1024;

// Worktree permission posture matched to the role's constraint. `reviewer` is the
// pure read-only analysis role, so its provider is launched without write access.
// Write roles (implementer/...) and `verifier` (which must run tests/commands)
// keep each provider's default write-capable posture.
export function isReadOnlyRole(role: RunSpec["role"]): boolean {
  return role === "reviewer";
}

// claude model tier by role: reviewer escalates to opus (deep critique, paired
// with agy as a distinct model family in cross-review); implementer/verifier
// stay on the claude CLI's default model (sonnet) and only dial --effort.
const CLAUDE_ROLE_MODEL: Partial<Record<RunSpec["role"], string>> = {
  reviewer: "opus",
};

// claude reasoning effort by role: reviewer needs the deepest pass, verifier is
// mechanical (tests/acceptance checks) so it stays cheap, implementer sits in
// between and can be bumped manually per-task via provider_session_name/task text.
const CLAUDE_ROLE_EFFORT: Partial<Record<RunSpec["role"], string>> = {
  implementer: "medium",
  verifier: "low",
  reviewer: "high",
};

export function buildProviderArgv(
  provider: AgentName,
  spec: RunSpec,
  runDir: string,
  worktree: string,
  prompt = "",
): string[] {
  const readOnly = isReadOnlyRole(spec.role);

  if (provider === "agy") {
    // agy = gemini-3.1-pro, reviewer-only. Second line of defense behind orch's
    // validateRunAgent: never launch agy with write access, whatever the caller says.
    if (!readOnly) {
      throw new Error(`agy is reviewer-only; refusing to launch with write access for role ${spec.role}`);
    }
    if (Buffer.byteLength(prompt, "utf8") > AGY_MAX_PROMPT_BYTES) {
      throw new Error(
        `agy prompt exceeds ${AGY_MAX_PROMPT_BYTES} bytes; agy passes the prompt via argv (ps-visible, ARG_MAX-bound) — trim the task or use another reviewer`,
      );
    }
    // --sandbox keeps it read-only (no worktree edits); the prompt rides in argv
    // (print mode ignores stdin).
    const argv = ["agy", "--print=" + prompt, "--model", spec.model ?? AGY_MODEL, "--sandbox"];
    if (spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
      argv.push("--conversation", spec.provider_session_id);
    }
    return argv;
  }

  if (provider === "claude") {
    const argv = ["claude", "-p", "--verbose", "--output-format", "stream-json", "--input-format", "text"];
    const model = spec.model ?? CLAUDE_ROLE_MODEL[spec.role];
    if (model) argv.push("--model", model);
    const effort = CLAUDE_ROLE_EFFORT[spec.role];
    if (effort) argv.push("--effort", effort);
    if (readOnly) argv.push("--permission-mode", "plan");
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
    if (spec.provider_session_mode === "resume_exact" && spec.provider_session_id) {
      const resume = ["codex", "exec", "resume", "--json", "--output-last-message", lastMessagePath];
      if (spec.model) resume.push("--model", spec.model);
      if (readOnly) resume.push("--sandbox", "read-only");
      resume.push(spec.provider_session_id, "-");
      return resume;
    }
    const argv = ["codex", "exec", "--json", "--cd", worktree, "--output-last-message", lastMessagePath];
    if (spec.model) argv.push("--model", spec.model);
    if (readOnly) argv.push("--sandbox", "read-only");
    if (spec.provider_session_mode === "ephemeral") argv.push("--ephemeral");
    argv.push("-");
    return argv;
  }

  const argv = ["pi"];
  if (spec.model) argv.push("--model", spec.model);
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

function roleResultFromCandidate(value: unknown, spec: RunSpec): RoleResult | null {
  const normalized = normalizedRoleResult(value, spec);
  if (normalized) return normalized;

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isResultRole(spec.role)) return null;

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

function coerceStringArray(obj: Record<string, unknown>, field: string): void {
  if (Array.isArray(obj[field])) obj[field] = (obj[field] as unknown[]).map(coercedString);
}

function coerceFindings(obj: Record<string, unknown>, field: string, blocking: boolean): void {
  if (!Array.isArray(obj[field])) return;
  obj[field] = (obj[field] as unknown[]).map((item, index) => {
    const finding: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item) ? { ...(item as Record<string, unknown>) } : { body: String(item) };
    if (typeof finding.body !== "string" || !finding.body.trim()) {
      const body = [finding.description, finding.message, finding.detail, finding.text].find(
        (v) => typeof v === "string" && v.trim(),
      );
      if (body) finding.body = body;
    }
    if (blocking) {
      if (typeof finding.id !== "string" || !finding.id.trim()) finding.id = `finding-${index + 1}`;
      if (typeof finding.severity !== "string" || !finding.severity.trim()) finding.severity = "unspecified";
      if (typeof finding.file !== "string" || !finding.file.trim()) finding.file = "unspecified";
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

function coerceRoleResult(role: RunSpec["role"], obj: Record<string, unknown>): void {
  if (typeof obj.verdict === "string") {
    const verdict = obj.verdict.trim().toLowerCase();
    obj.verdict = VERDICT_SYNONYMS[verdict] ?? verdict;
  }
  if (role === "reviewer") {
    coerceFindings(obj, "blocking_findings", true);
    coerceFindings(obj, "non_blocking_findings", false);
    coerceStringArray(obj, "suggested_tests");
    if (typeof obj.reviews_run_id !== "string") obj.reviews_run_id = obj.reviews_run_id == null ? "" : String(obj.reviews_run_id);
  } else if (role === "implementer") {
    coerceStringArray(obj, "changed_files");
    coerceStringArray(obj, "risks");
  } else if (role === "verifier") {
    if (typeof obj.verifies_run_id !== "string") obj.verifies_run_id = obj.verifies_run_id == null ? "" : String(obj.verifies_run_id);
  }
}

function normalizedRoleResult(value: unknown, spec: RunSpec): RoleResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isResultRole(spec.role)) return null;

  const schemaName = resultSchemaName(spec.role);
  const obj = { ...(value as Record<string, unknown>) };
  // Candidates only come from this run's own stream, so the spec is the
  // authority on run_id — models frequently invent one, which used to reject
  // the entire result.
  obj.run_id = spec.run_id;
  if (validateRoleResult(spec.role, obj).ok) return obj as unknown as RoleResult;
  if (obj.schema === undefined) obj.schema = schemaName;
  coerceRoleResult(spec.role, obj);

  return validateRoleResult(spec.role, obj).ok ? (obj as unknown as RoleResult) : null;
}

export function extractResultFromText(text: string, spec: RunSpec): RoleResult | null {
  for (const candidate of parsedJsonCandidates(text)) {
    const result = roleResultFromCandidate(candidate, spec);
    if (result) return result;
  }
  return null;
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
    // agy plain text and stream noise, tried after every structured candidate.
    candidates.push(
      ...candidateTexts(events, "final", "claude"),
      ...candidateTexts(events, "assistant", "claude"),
      ...candidateTexts(events, "assistant", "codex"),
      ...candidateTexts(events, "assistant", "pi"),
      ...candidateTexts(events, "raw", "unknown"),
      // Plain-text providers (agy) emit a multi-line response; the JSON object
      // may span lines, so try the whole stream as one candidate too.
      nativeText,
    );
  }

  return candidates;
}

export function extractResultFromRunDir(runDir: string, spec: RunSpec): RoleResult | null {
  for (const candidate of collectResultCandidates(runDir)) {
    const result = extractResultFromText(candidate, spec);
    if (result) return result;
  }
  return null;
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

export async function maybeWriteFakeResult(runDir: string, spec: RunSpec, provider: string): Promise<boolean> {
  if (process.env.ORCH_DRIVER_FAKE_RESULT !== "1") return false;
  const sleepMs = Number(process.env.ORCH_DRIVER_FAKE_SLEEP_MS ?? "0");
  if (Number.isFinite(sleepMs) && sleepMs > 0) await sleep(sleepMs);
  writeFileSync(
    `${runDir}/native.jsonl`,
    `${JSON.stringify({ type: "fake", provider, run_id: spec.run_id, ts: new Date().toISOString() })}\n`,
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
      : spec.role === "verifier"
        ? {
            schema: "orch.result/verifier/v1",
            run_id: spec.run_id,
            verdict: "pass",
            verifies_run_id: spec.run_id,
            commands: [],
            acceptance: [],
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
  const proc = Bun.spawn(buildProviderArgv(provider, spec, args.runDir, args.worktree, prompt), {
    cwd: args.worktree,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: buildWorkerEnv(),
  });
  // agy reads the prompt from argv (print mode); everyone else gets it on stdin.
  if (provider !== "agy") proc.stdin.write(prompt);
  proc.stdin.end();

  await pipeToFile(proc.stdout, `${args.runDir}/native.jsonl`);
  const code = await proc.exited;
  writeExitCode(args.runDir, code);

  const extracted = extractResultFromRunDir(args.runDir, spec);
  if (extracted) {
    writeResult(args.runDir, spec, extracted);
    return code;
  }

  // Preserve the worker's real answer even when it doesn't fit the schema —
  // in practice most runs produce a usable review that must stay reachable.
  const raw = rawResultText(args.runDir);
  if (raw) writeFileSync(`${args.runDir}/result.raw.md`, raw, "utf8");

  // A provider that exits 0 with no output at all did no work (broken auth,
  // silent CLI failure); report that as a failed run, not a quiet `done`.
  const silent = code === 0 && !raw;
  const summary = silent
    ? `${provider} exited 0 but produced no output; check the provider CLI auth/session (run \`${provider}\` interactively once)`
    : code === 0
      ? `${provider} did not return a valid orch result JSON; raw output saved to result.raw.md. Excerpt: ${raw!.slice(0, 400)}`
      : `${provider} exited ${code}${raw ? "; raw output saved to result.raw.md" : ""}`;
  writeResult(args.runDir, spec, synthesizeResult(spec, summary));
  return silent ? 1 : code;
}
