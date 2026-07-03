// Read-side normalizer for provider-native stream output (native.jsonl).
// Each provider CLI emits its own event vocabulary (claude stream-json, codex
// exec --json, pi --mode json, agy plain text); this maps those lines onto a
// small provider-independent progress vocabulary so consumers (events tail,
// result extraction, resume-id detection) share one parser instead of
// re-implementing per-provider knowledge. Orch lifecycle events (events.jsonl)
// stay separate and remain the authority on run state.

export type NativeEventKind = "session" | "assistant" | "tool_use" | "tool_result" | "usage" | "final" | "raw";

// Which provider's native format a line matched. Matching is structural, not
// declared: the same normalizer runs over any native.jsonl without knowing the
// agent, so result extraction keeps working even if spec.json is missing.
export type NativeEventFormat = "claude" | "codex" | "pi" | "unknown";

export interface NativeEvent {
  kind: NativeEventKind;
  format: NativeEventFormat;
  text?: string;
  tool?: string;
  session_id?: string;
  usage?: Record<string, number>;
}

const MAX_DETAIL_CHARS = 200;

function truncated(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > MAX_DETAIL_CHARS ? `${compact.slice(0, MAX_DETAIL_CHARS)}…` : compact;
}

function summarizedInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const compact = typeof text === "string" ? truncated(text) : "";
  return compact.length > 0 ? compact : undefined;
}

export function textFromAssistantContent(content: unknown): string | null {
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

// Key order matters: it mirrors the historical resume-id detection, so the
// first matching key on the first matching line wins across all consumers.
const sessionKeys = ["session_id", "conversation_id", "provider_resume_id", "thread_id"] as const;

const claudeEventTypes = new Set(["system", "assistant", "user", "result"]);

const codexToolItemTypes = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change", "patch_apply"]);

interface NativeLine {
  type?: unknown;
  result?: unknown;
  usage?: unknown;
  message?: { role?: unknown; content?: unknown };
  messages?: unknown;
  item?: { type?: unknown; text?: unknown; command?: unknown; exit_code?: unknown; tool?: unknown; query?: unknown };
  toolName?: unknown;
  tool_name?: unknown;
  name?: unknown;
  args?: unknown;
  input?: unknown;
}

function sessionEvent(event: NativeLine & Record<string, unknown>): NativeEvent | null {
  for (const key of sessionKeys) {
    const value = event[key];
    if (typeof value !== "string" || !value) continue;
    const format: NativeEventFormat =
      typeof event.type === "string" && claudeEventTypes.has(event.type) ? "claude" : key === "thread_id" ? "codex" : "unknown";
    return { kind: "session", format, session_id: value };
  }
  return null;
}

function numericUsage(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage: Record<string, number> = {};
  for (const [key, num] of Object.entries(value as Record<string, unknown>)) {
    if (typeof num === "number" && Number.isFinite(num)) usage[key] = num;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}

function claudeEvents(event: NativeLine): NativeEvent[] {
  const events: NativeEvent[] = [];

  if (event.type === "result" && typeof event.result === "string") {
    events.push({ kind: "final", format: "claude", text: event.result });
  }

  if (event.type === "assistant") {
    const content = event.message?.content;
    const text = textFromAssistantContent(content);
    if (text) events.push({ kind: "assistant", format: "claude", text });
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const toolUse = block as { type?: unknown; name?: unknown; input?: unknown };
        if (toolUse.type === "tool_use" && typeof toolUse.name === "string") {
          events.push({ kind: "tool_use", format: "claude", tool: toolUse.name, text: summarizedInput(toolUse.input) });
        }
      }
    }
  }

  if (event.type === "user" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (!block || typeof block !== "object") continue;
      const toolResult = block as { type?: unknown; content?: unknown };
      if (toolResult.type !== "tool_result") continue;
      const body = typeof toolResult.content === "string" ? toolResult.content : textFromAssistantContent(toolResult.content);
      events.push({ kind: "tool_result", format: "claude", text: body ? truncated(body) : undefined });
    }
  }

  return events;
}

function codexEvents(event: NativeLine): NativeEvent[] {
  const item = event.item;
  if (!item || typeof item !== "object") return [];

  if (item.type === "agent_message" && typeof item.text === "string") {
    return [{ kind: "assistant", format: "codex", text: item.text }];
  }

  if (typeof item.type === "string" && codexToolItemTypes.has(item.type)) {
    const completed = event.type === "item.completed";
    const detail = [item.command, item.query, item.tool].find((v): v is string => typeof v === "string" && v.trim().length > 0);
    const exit = completed && typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";
    const text = detail ? `${truncated(detail)}${exit}` : exit.trim() || undefined;
    return [{ kind: completed ? "tool_result" : "tool_use", format: "codex", tool: item.type, text }];
  }

  return [];
}

function piEvents(event: NativeLine): NativeEvent[] {
  const events: NativeEvent[] = [];

  if ((event.type === "message_end" || event.type === "turn_end") && event.message?.role === "assistant") {
    const text = textFromAssistantContent(event.message.content);
    if (text) events.push({ kind: "assistant", format: "pi", text });
  }

  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    for (const message of event.messages) {
      if (!message || typeof message !== "object") continue;
      const entry = message as { role?: unknown; content?: unknown };
      if (entry.role !== "assistant") continue;
      const text = textFromAssistantContent(entry.content);
      if (text) events.push({ kind: "assistant", format: "pi", text });
    }
  }

  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    const tool = [event.toolName, event.tool_name, event.name].find((v): v is string => typeof v === "string" && v.length > 0);
    events.push({
      kind: event.type === "tool_execution_start" ? "tool_use" : "tool_result",
      format: "pi",
      tool,
      text: summarizedInput(event.args ?? event.input),
    });
  }

  return events;
}

function usageEvent(event: NativeLine): NativeEvent | null {
  const usage = numericUsage(event.usage);
  if (!usage) return null;
  const format: NativeEventFormat =
    event.type === "result"
      ? "claude"
      : event.type === "turn.completed"
        ? "codex"
        : event.type === "turn_end" || event.type === "message_end" || event.type === "agent_end"
          ? "pi"
          : "unknown";
  return { kind: "usage", format, usage };
}

// One native.jsonl line -> zero or more normalized events. Unparseable lines
// surface as kind "raw" (agy plain text and provider stderr noise land here);
// parseable lines that match no known structure are dropped as stream noise.
export function normalizeNativeLine(line: string): NativeEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let event: NativeLine & Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [{ kind: "raw", format: "unknown", text: trimmed }];
    }
    event = parsed as NativeLine & Record<string, unknown>;
  } catch {
    return [{ kind: "raw", format: "unknown", text: trimmed }];
  }

  const events: NativeEvent[] = [];
  const session = sessionEvent(event);
  if (session) events.push(session);
  events.push(...claudeEvents(event), ...codexEvents(event), ...piEvents(event));
  const usage = usageEvent(event);
  if (usage) events.push(usage);
  return events;
}

// Whole-file view with session dedup: providers repeat the session id on every
// line (claude does), which would drown the tail output; the first sighting of
// each id is the only one that carries information.
export function normalizeNativeText(text: string): NativeEvent[] {
  const events: NativeEvent[] = [];
  const seenSessions = new Set<string>();
  for (const line of text.split("\n")) {
    for (const event of normalizeNativeLine(line)) {
      if (event.kind === "session") {
        if (!event.session_id || seenSessions.has(event.session_id)) continue;
        seenSessions.add(event.session_id);
      }
      events.push(event);
    }
  }
  return events;
}

export function providerResumeIdFromNativeText(text: string): string | null {
  return normalizeNativeText(text).find((event) => event.kind === "session")?.session_id ?? null;
}
