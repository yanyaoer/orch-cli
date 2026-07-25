import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

// Built-in trajectory normalization: provider session files → role-based
// records, shaped after @letta-ai/trajectory's trajectory-v1 output but
// implemented in-repo with zero dependencies. Sources of truth are the
// provider session stores — orch's native.jsonl is stream output and does not
// contain the full message history (no user records, no per-call pairing).
// Adapters exist for the formats verified against real session files:
// claude (~/.claude/projects/<slug>/<uuid>.jsonl) and codex
// (~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl). pi/omp session
// layouts are unverified; callers get a clear error instead of guesses.

export interface TrajectoryToolCall {
  id: string | null;
  name: string;
  args: string;
}

export interface TrajectoryRecord {
  role: "meta" | "user" | "assistant" | "reasoning" | "tool";
  content: string | null;
  tool_calls?: TrajectoryToolCall[];
  tool_call_id?: string | null;
  timestamp?: string | null;
  source?: string;
  session_id?: string | null;
}

export type TrajectorySource = "claude" | "codex";

export const TRAJECTORY_SOURCES: Record<string, TrajectorySource> = {
  claude: "claude",
  codex: "codex",
};

// ---------------------------------------------------------------------------
// Session file location

export function locateSessionFile(
  agent: string,
  resumeId: string,
  home: string = homedir(),
): { source: TrajectorySource; path: string } | null {
  if (agent === "claude") {
    const projects = `${home}/.claude/projects`;
    let slugs: string[];
    try {
      slugs = readdirSync(projects);
    } catch {
      return null;
    }
    for (const slug of slugs) {
      const path = `${projects}/${slug}/${resumeId}.jsonl`;
      if (existsSync(path)) return { source: "claude", path };
    }
    return null;
  }
  if (agent === "codex") {
    const root = `${home}/.codex/sessions`;
    const suffix = `-${resumeId}.jsonl`;
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }) as string[];
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.endsWith(suffix)) return { source: "codex", path: `${root}/${entry}` };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalization

export function normalizeSession(source: TrajectorySource, text: string): TrajectoryRecord[] {
  return source === "claude" ? normalizeClaude(text) : normalizeCodex(text);
}

function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // one corrupt line must not sink the transcript
    }
  }
  return out;
}

// Claude content blocks: plain string, or [{type:"text"|"thinking"|"tool_use"
// |"tool_result", ...}]. tool_result content is itself a string or an array
// of text blocks.
function claudeBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

function normalizeClaude(text: string): TrajectoryRecord[] {
  const lines = parseLines(text);
  const records: TrajectoryRecord[] = [];
  const sessionId = (lines.find((l) => typeof l.sessionId === "string")?.sessionId as string) ?? null;
  records.push({ role: "meta", content: null, source: "claude", session_id: sessionId });
  for (const line of lines) {
    const timestamp = typeof line.timestamp === "string" ? line.timestamp : null;
    const message = line.message as Record<string, unknown> | undefined;
    if (line.type === "user" && message) {
      const content = message.content;
      if (typeof content === "string") {
        if (content.trim()) records.push({ role: "user", content, timestamp });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b?.type === "tool_result") {
          records.push({
            role: "tool",
            content: claudeBlockText(b.content),
            tool_call_id: typeof b.tool_use_id === "string" ? b.tool_use_id : null,
            timestamp,
          });
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          records.push({ role: "user", content: b.text, timestamp });
        }
      }
      continue;
    }
    if (line.type === "assistant" && message && Array.isArray(message.content)) {
      const texts: string[] = [];
      const calls: TrajectoryToolCall[] = [];
      for (const block of message.content) {
        const b = block as Record<string, unknown>;
        if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
        else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          records.push({ role: "reasoning", content: b.thinking, timestamp });
        } else if (b?.type === "tool_use") {
          calls.push({
            id: typeof b.id === "string" ? b.id : null,
            name: typeof b.name === "string" ? b.name : "tool",
            args: JSON.stringify(b.input ?? {}),
          });
        }
      }
      if (texts.length > 0 || calls.length > 0) {
        records.push({
          role: "assistant",
          content: texts.length > 0 ? texts.join("\n") : null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
          timestamp,
        });
      }
      continue;
    }
    // attachment / last-prompt / queue-operation / summary / system: skipped
  }
  return records;
}

// Codex rollout lines: session_meta, turn_context, event_msg (progress),
// world_state, and response_item whose payload carries the conversation:
// message (user/assistant/developer), reasoning (summary array),
// function_call{arguments}/custom_tool_call{input} and their _output twins.
function codexMessageText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (typeof b?.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

function normalizeCodex(text: string): TrajectoryRecord[] {
  const lines = parseLines(text);
  const records: TrajectoryRecord[] = [];
  const metaLine = lines.find((l) => l.type === "session_meta");
  const metaPayload = metaLine?.payload as Record<string, unknown> | undefined;
  records.push({
    role: "meta",
    content: null,
    source: "codex",
    session_id: typeof metaPayload?.id === "string" ? (metaPayload.id as string) : ((metaPayload?.session_id as string) ?? null),
  });
  for (const line of lines) {
    if (line.type !== "response_item") continue;
    const timestamp = typeof line.timestamp === "string" ? line.timestamp : null;
    const p = line.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    switch (p.type) {
      case "message": {
        const role = p.role;
        if (role !== "user" && role !== "assistant") break; // developer noise
        const content = codexMessageText(p.content);
        if (content.trim()) records.push({ role, content, timestamp });
        break;
      }
      case "reasoning": {
        const content = codexMessageText(p.summary);
        if (content.trim()) records.push({ role: "reasoning", content, timestamp });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const args = p.type === "function_call" ? p.arguments : p.input;
        records.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: typeof p.call_id === "string" ? p.call_id : null,
            name: typeof p.name === "string" ? p.name : "tool",
            args: typeof args === "string" ? args : JSON.stringify(args ?? {}),
          }],
          timestamp,
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const output = p.output;
        records.push({
          role: "tool",
          content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
          tool_call_id: typeof p.call_id === "string" ? p.call_id : null,
          timestamp,
        });
        break;
      }
      default:
        break;
    }
  }
  return records;
}
