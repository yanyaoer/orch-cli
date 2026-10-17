import { expect, test } from "bun:test";
import { lifecycleEvidence, usageEvidence } from "./usage-evidence.ts";
const stream = (...e: unknown[]) => e.map(x => JSON.stringify(x)).join("\n");
const done = { state: "done" as const };
const fresh = { provider_session_mode: "fresh_persistent" as const };
const counter = (input: number, cached: number, output: number) => ({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } });

test("Codex cumulative counters count only final per session and include fresh repair", () => {
  const e = usageEvidence(stream({ type: "thread.started", thread_id: "one" }, counter(100, 80, 20), counter(200, 160, 40),
    { type: "orch_result_repair" }, { type: "thread.started", thread_id: "two" }, counter(10, 5, 2)), fresh, done);
  expect(e.coverage.status).toBe("complete");
  expect(e.normalized_tokens).toEqual({ input_tokens: 210, cache_read_input_tokens: 165, cache_write_input_tokens: 0, output_tokens: 42, total_tokens: 252, non_cache_read_tokens: 87 });
});
test("resume baseline and missing old metadata remain unknown, never zero or session total", () => {
  for (const s of [null, { provider_session_mode: "resume_exact" as const }]) {
    const e = usageEvidence(stream(counter(200, 160, 40)), s, done);
    expect(e.normalized_tokens).toBeNull();
    expect(e.coverage.reasons).toContain("codex_session_baseline_unknown");
  }
});
test("Pi nested message usage counted once, duplicate turn/agent snapshots ignored", () => {
  const message = { role: "assistant", responseId: "r1", content: [{ type: "text", text: "SECRET" }], usage: {
    input: 10, cacheRead: 100, cacheWrite: 3, output: 7, totalTokens: 120, cost: { total: 0 },
  } };
  const e = usageEvidence(stream({ type: "message_end", message }, { type: "message_end", message },
    { type: "turn_end", message }, { type: "agent_end", messages: [message] }), fresh, done);
  expect(e.coverage.status).toBe("complete");
  expect(e.coverage.counted_records).toBe(1);
  expect(e.normalized_tokens?.total_tokens).toBe(120);
  expect(JSON.stringify(e)).not.toContain("SECRET");
});
test("Claude terminal includes cache input, does not sum assistant usage again", () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 };
  const e = usageEvidence(stream({ type: "assistant", message: { usage } }, { type: "result", usage }), fresh, done);
  expect(e.normalized_tokens?.input_tokens).toBe(130);
  expect(e.normalized_tokens?.total_tokens).toBe(135);
});
test("invalid, missing or interrupted data is not complete coverage", () => {
  const valid = { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 } } };
  const e = usageEvidence(stream(valid, { ...valid, message: { role: "assistant" } }, { type: "agent_end" }), fresh, done);
  expect(e.coverage.status).toBe("partial");
  expect(usageEvidence(stream(counter(2, 10, 3)), fresh, done).normalized_tokens).toBeNull();
  expect(usageEvidence(stream(counter(20, 10, 3)), fresh, { state: "running" }).coverage.status).toBe("partial");
});
test("lifecycle exposes only observed safe phases and keeps unobserved waits unknown", () => {
  const e = lifecycleEvidence(stream({ type: "starting", ts: "2026-01-01T00:00:01Z" },
    { type: "phase", phase: "provider_start", ts: "2026-01-01T00:00:02Z", wait_reason: "provider_process", prompt: "SECRET" },
    { type: "phase", phase: "SECRET", ts: "2026-01-01T00:00:03Z" },
    { type: "done", ts: "2026-01-01T00:00:05Z" }), { created_at: "2026-01-01T00:00:00Z" });
  expect(e.observed_run_ms).toBe(4000);
  expect(e.creation_to_start_ms).toBe(1000);
  expect(e.queue_wait_ms).toBeNull();
  expect(e.phases).toHaveLength(1);
  expect(JSON.stringify(e)).not.toContain("SECRET");
});

test("zero-usage error messages are not complete successful response evidence", () => {
  const e = usageEvidence(stream({ type: "message_end", message: { role: "assistant", stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }, { type: "agent_end" }), fresh, done);
  expect(e.coverage.status).toBe("partial");
  expect(e.coverage.reasons).toContain("provider_error_usage_may_be_incomplete");
  expect(e.response_observations).toMatchObject({ successful_messages: 0, error_messages: 1 });
});

test("latest Claude terminal without usage cannot hide behind an earlier total", () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 5 };
  const e = usageEvidence(stream({ type: "result", usage }, { type: "result", is_error: true, subtype: "error_during_execution" }), fresh, { state: "failed" });
  expect(e.coverage.status).toBe("missing");
  expect(e.coverage.reasons).toContain("claude_terminal_usage_invalid");
  expect(e.coverage.reasons).toContain("provider_error_usage_may_be_incomplete");
});
test("mixed provider envelopes are detected even if one lacks usage", () => {
  const e = usageEvidence(stream({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }, { type: "agent_end" }, { type: "result", is_error: true }), fresh, done);
  expect(e.coverage.status).toBe("partial");
  expect(e.coverage.reasons).toContain("mixed_provider_formats");
});
test("unfinished Codex turns and truncated records make observed counters partial", () => {
  const prefix = stream({ type: "thread.started", thread_id: "one" }, { type: "turn.started" }, counter(100, 80, 5));
  const open = usageEvidence(prefix + '\n' + stream({ type: "turn.started" }), fresh, { state: "failed" });
  expect(open.coverage.status).toBe("partial");
  expect(open.coverage.reasons).toContain("codex_unfinished_turn");
  expect(open.normalized_tokens?.total_tokens).toBe(105);
  const truncated = usageEvidence(prefix + '\n{"type":"turn.completed","usage":', fresh, done);
  expect(truncated.coverage.status).toBe("partial");
  expect(truncated.coverage.reasons).toContain("malformed_native_record");
});

test("conflicting duplicate Pi messages retain error and invalid evidence without double counting", () => {
  const first = { role: "assistant", responseId: "same", stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } };
  for (const tail of [
    { ...first, stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { ...first, stopReason: "aborted" },
    { ...first, usage: {} },
    { ...first, usage: { ...first.usage, output: 3 } },
  ]) {
    const e = usageEvidence(stream({ type: "message_end", message: first }, { type: "message_end", message: tail },
      { type: "message_end", message: tail }, { type: "agent_end" }), fresh, done);
    expect(e.coverage.status).toBe("partial");
    expect(e.coverage.reasons).toContain("pi_duplicate_message_conflict");
    expect(e.coverage.counted_records).toBe(1);
    expect(e.normalized_tokens?.total_tokens).toBe(12);
    expect(e.response_observations.successful_messages).toBe(0);
    expect(e.response_observations.error_messages).toBe(["error", "aborted"].includes(tail.stopReason) ? 1 : 0);
  }
});
