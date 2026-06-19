import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { RunSpec, RoleResult } from "../src/types.ts";
import { fallbackResult, validateRoleResult } from "../src/schema.ts";
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
    "",
    "Execute the task below. Your final answer must be a single JSON object matching this orch schema.",
    `Required schema field: "${schemaName}".`,
    "Do not wrap the JSON in Markdown.",
    "",
    "Task:",
    spec.task_text || "(no task text supplied)",
  ].join("\n");
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with extraction heuristics.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue.
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function extractResultFromText(text: string, spec: RunSpec): RoleResult | null {
  const parsed = tryParseJson(text);
  if (!parsed) return null;
  const validation = validateRoleResult(spec.role, parsed);
  return validation.ok ? (parsed as RoleResult) : null;
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
    const rawLineCandidates: string[] = [];
    for (const line of readFileSync(nativePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          type?: unknown;
          result?: unknown;
          message?: { content?: unknown };
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
      } catch {
        rawLineCandidates.push(line);
      }
    }
    candidates.push(...claudeResultCandidates, ...claudeAssistantCandidates, ...codexCandidates, ...rawLineCandidates);
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
