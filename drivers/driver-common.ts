import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { isResultRole, type AgentName, type RunSpec, type RoleResult } from "../src/types.ts";
import { fallbackResult, resultSchemaName, validateRoleResult } from "../src/schema.ts";
import { writeJsonAtomic } from "../src/json.ts";

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
    `Required schema field: "${schemaName}".`,
    "Do not wrap the JSON in Markdown.",
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
  return env;
}

export function buildProviderArgv(provider: AgentName, spec: RunSpec, runDir: string, worktree: string): string[] {
  if (provider === "claude") {
    const argv = ["claude", "-p", "--verbose", "--output-format", "stream-json", "--input-format", "text"];
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
      return ["codex", "exec", "resume", "--json", "--output-last-message", lastMessagePath, spec.provider_session_id, "-"];
    }
    const argv = ["codex", "exec", "--json", "--cd", worktree, "--output-last-message", lastMessagePath];
    if (spec.provider_session_mode === "ephemeral") argv.push("--ephemeral");
    argv.push("-");
    return argv;
  }

  const argv = ["pi", "-p", "--mode", "json"];
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
  if (validateRoleResult(spec.role, value).ok) return value as RoleResult;

  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isResultRole(spec.role)) return null;

  const obj = value as Record<string, unknown>;
  const schemaName = resultSchemaName(spec.role);
  for (const key of [schemaName, "result"]) {
    const wrapped = obj[key];
    if (validateRoleResult(spec.role, wrapped).ok) return wrapped as RoleResult;
  }
  return null;
}

export function extractResultFromText(text: string, spec: RunSpec): RoleResult | null {
  for (const candidate of parsedJsonCandidates(text)) {
    const result = roleResultFromCandidate(candidate, spec);
    if (result) return result;
  }
  return null;
}

function textFromClaudeAssistantContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

export function extractResultFromRunDir(runDir: string, spec: RunSpec): RoleResult | null {
  const candidates: string[] = [];
  for (const path of [`${runDir}/last_message.txt`, `${runDir}/stdout.log`]) {
    if (existsSync(path)) candidates.push(readFileSync(path, "utf8"));
  }

  const nativePath = `${runDir}/native.jsonl`;
  if (existsSync(nativePath)) {
    const claudeResultCandidates: string[] = [];
    const claudeAssistantCandidates: string[] = [];
    const codexCandidates: string[] = [];
    const piCandidates: string[] = [];
    const rawLineCandidates: string[] = [];
    for (const line of readFileSync(nativePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          type?: unknown;
          result?: unknown;
          message?: { role?: unknown; content?: unknown };
          item?: { type?: string; text?: string };
        };
        if (event.type === "result" && typeof event.result === "string") {
          claudeResultCandidates.push(event.result);
        }
        if (event.type === "assistant") {
          const text = textFromClaudeAssistantContent(event.message?.content);
          if (text) claudeAssistantCandidates.push(text);
        }
        if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
          codexCandidates.push(event.item.text);
        }
        if (
          (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") &&
          event.message?.role === "assistant"
        ) {
          const text = textFromClaudeAssistantContent(event.message.content);
          if (text) piCandidates.push(text);
        }
      } catch {
        rawLineCandidates.push(line);
      }
    }
    candidates.push(
      ...claudeResultCandidates,
      ...claudeAssistantCandidates,
      ...codexCandidates,
      ...piCandidates,
      ...rawLineCandidates,
    );
  }

  for (const candidate of candidates) {
    const result = extractResultFromText(candidate, spec);
    if (result) return result;
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
