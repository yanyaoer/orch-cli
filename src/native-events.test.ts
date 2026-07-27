import { expect, test } from "bun:test";
import { createNativeNormalizer, normalizeNativeLine, normalizeNativeText, providerResumeIdFromNativeText } from "./native-events.ts";

function jsonl(lines: unknown[]): string {
  return lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";
}

test("normalizes a claude stream-json run", () => {
  const events = normalizeNativeText(
    jsonl([
      { type: "system", subtype: "init", session_id: "sess-1", model: "sonnet" },
      {
        type: "assistant",
        session_id: "sess-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking the diff" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } },
          ],
        },
      },
      {
        type: "user",
        session_id: "sess-1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "clean" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: '{"schema":"orch.result/reviewer/v1"}',
        usage: { input_tokens: 10, output_tokens: 5, service_tier: "standard" },
      },
    ]),
  );

  expect(events).toEqual([
    { kind: "session", format: "claude", session_id: "sess-1" },
    { kind: "assistant", format: "claude", text: "checking the diff" },
    { kind: "tool_use", format: "claude", tool: "Bash", text: '{"command":"git status"}' },
    { kind: "tool_result", format: "claude", text: "clean" },
    { kind: "final", format: "claude", text: '{"schema":"orch.result/reviewer/v1"}' },
    { kind: "usage", format: "claude", usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
});

test("normalizes a codex exec --json run", () => {
  const events = normalizeNativeText(
    jsonl([
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.started", item: { type: "command_execution", command: "bun test" } },
      { type: "item.completed", item: { type: "command_execution", command: "bun test", exit_code: 0 } },
      { type: "item.completed", item: { type: "agent_message", text: "all checks pass" } },
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
    ]),
  );

  expect(events).toEqual([
    { kind: "session", format: "codex", session_id: "th-1" },
    { kind: "tool_use", format: "codex", tool: "command_execution", text: "bun test" },
    { kind: "tool_result", format: "codex", tool: "command_execution", text: "bun test (exit 0)" },
    { kind: "assistant", format: "codex", text: "all checks pass" },
    { kind: "usage", format: "codex", usage: { input_tokens: 100, output_tokens: 20 } },
  ]);
});

test("normalizes a pi --mode json run", () => {
  const events = normalizeNativeText(
    jsonl([
      { type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } },
      { type: "tool_execution_end", toolName: "read" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "pi answer" }] } },
      { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "pi final" }] }] },
    ]),
  );

  expect(events).toEqual([
    { kind: "tool_use", format: "pi", tool: "read", text: '{"path":"a.ts"}' },
    { kind: "tool_result", format: "pi", tool: "read", text: undefined },
    { kind: "assistant", format: "pi", text: "pi answer" },
    { kind: "assistant", format: "pi", text: "pi final" },
  ]);
});

test("unparseable lines become raw events; unrecognized JSON is dropped", () => {
  expect(normalizeNativeLine("Here is the review:")).toEqual([{ kind: "raw", format: "unknown", text: "Here is the review:" }]);
  expect(normalizeNativeLine('{"type":"reasoning_delta","delta":"..."}')).toEqual([]);
  expect(normalizeNativeLine('["not","an","event"]')).toEqual([{ kind: "raw", format: "unknown", text: '["not","an","event"]' }]);
  expect(normalizeNativeLine("   ")).toEqual([]);
});

test("session events dedupe per id and keep first-key precedence", () => {
  const events = normalizeNativeText(
    jsonl([
      { type: "system", session_id: "sess-1" },
      { type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [] } },
      { conversation_id: "conv-2" },
    ]),
  );
  expect(events).toEqual([
    { kind: "session", format: "claude", session_id: "sess-1" },
    { kind: "session", format: "unknown", session_id: "conv-2" },
  ]);

  expect(providerResumeIdFromNativeText(jsonl([{ provider_resume_id: "r-1", thread_id: "th-9" }]))).toBe("r-1");
  expect(providerResumeIdFromNativeText("plain text only\n")).toBeNull();
});

test("resume id: first line wins across lines, key order wins within a line", () => {
  expect(providerResumeIdFromNativeText(jsonl([{ conversation_id: "c1" }, { session_id: "s2" }]))).toBe("c1");
  expect(providerResumeIdFromNativeText(jsonl([{ thread_id: "t1", session_id: "s1" }]))).toBe("s1");
});

test("pi/omp session announcement yields session event and resume id", () => {
  const line = { type: "session", version: 3, id: "019f5a38-5df8-7000-a014-053e5ae73d56", timestamp: "2026-07-13T06:44:31.352Z", cwd: "/tmp/wt" };
  expect(normalizeNativeLine(JSON.stringify(line))).toEqual([
    { kind: "session", format: "pi", session_id: "019f5a38-5df8-7000-a014-053e5ae73d56" },
  ]);
  expect(providerResumeIdFromNativeText(jsonl([line]))).toBe("019f5a38-5df8-7000-a014-053e5ae73d56");

  // Bare `id` on any other event type stays stream noise, and explicit
  // session keys keep precedence over it on the same line.
  expect(normalizeNativeLine(JSON.stringify({ type: "message_start", id: "msg-1" }))).toEqual([]);
  expect(providerResumeIdFromNativeText(jsonl([{ type: "session", id: "i-1", session_id: "s-1" }]))).toBe("s-1");
});

test("long tool detail is compacted and truncated", () => {
  const long = "x".repeat(500);
  const [toolUse] = normalizeNativeLine(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { content: long } }] },
    }),
  );
  expect(toolUse!.kind).toBe("tool_use");
  expect(toolUse!.text!.length).toBeLessThanOrEqual(201);
  expect(toolUse!.text!.endsWith("…")).toBe(true);
});

test("createNativeNormalizer dedups sessions across incremental calls", () => {
  const normalize = createNativeNormalizer();
  const first = normalize(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1", model: "sonnet" }));
  expect(first).toEqual([{ kind: "session", format: "claude", session_id: "sess-1" }]);

  const repeat = normalize(
    JSON.stringify({
      type: "assistant",
      session_id: "sess-1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    }),
  );
  expect(repeat).toEqual([{ kind: "assistant", format: "claude", text: "hi" }]);
});
