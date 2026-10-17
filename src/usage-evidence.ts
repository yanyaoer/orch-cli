import type { RunSpec, RunStatus } from "./types.ts";

export interface NormalizedTokens {
  input_tokens: number; cache_read_input_tokens: number; cache_write_input_tokens: number;
  output_tokens: number; total_tokens: number; non_cache_read_tokens: number;
}
export type UsageEvidence = {
  normalized_tokens: NormalizedTokens | null;
  coverage: { status: "complete" | "partial" | "missing"; reasons: string[]; counted_records: number; basis: string };
  response_observations: { basis: "pi_completed_assistant_messages_only" | "unavailable"; successful_messages: number | null; error_messages: number | null; unknown_messages: number | null; repair_attempts: number };
};
const zero = (): NormalizedTokens => ({ input_tokens: 0, cache_read_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, total_tokens: 0, non_cache_read_tokens: 0 });
function count(n: unknown): n is number { return typeof n === "number" && Number.isSafeInteger(n) && n >= 0; }
export function addNormalized(a: NormalizedTokens, b: NormalizedTokens): NormalizedTokens {
  return Object.fromEntries(Object.keys(a).map(k => [k, a[k as keyof NormalizedTokens] + b[k as keyof NormalizedTokens]])) as unknown as NormalizedTokens;
}
function normalized(u: any, format: "pi" | "claude" | "codex"): NormalizedTokens | null {
  if (!u || typeof u !== "object") return null;
  const base = format === "pi" ? u.input : u.input_tokens;
  const output = format === "pi" ? u.output : u.output_tokens;
  const read = format === "pi" ? u.cacheRead : format === "codex" ? u.cached_input_tokens ?? u.cache_read_input_tokens : u.cache_read_input_tokens;
  const write = format === "pi" ? u.cacheWrite : format === "codex" ? 0 : u.cache_creation_input_tokens;
  // Missing cache counts are unknown, not a demonstrated zero.
  if (![base, output, read, write].every(count)) return null;
  const input = format === "codex" ? base : base + read + write;
  if (read > input) return null;
  const total = input + output;
  if (!Number.isSafeInteger(total) || (format === "pi" && u.totalTokens !== undefined && u.totalTokens !== total)) return null;
  return { input_tokens: input, cache_read_input_tokens: read, cache_write_input_tokens: write,
    output_tokens: output, total_tokens: total, non_cache_read_tokens: total - read };
}

// Reads only numeric provider usage and lifecycle metadata. It never returns
// prompts, assistant content, tool arguments, credentials or SDK price guesses.
export function usageEvidence(native: string | null, spec: Partial<RunSpec> | null, status?: Partial<RunStatus> | null): UsageEvidence {
  const reasons = new Set<string>();
  const attempts: any[][] = [[]];
  for (const line of (native ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { reasons.add("malformed_native_record"); continue; }
    if (e?.type === "orch_result_repair") attempts.push([]);
    else if (e && typeof e === "object") attempts.at(-1)!.push(e);
  }
  let sum = zero(), records = 0;
  let piSeen = false, successMessages = 0, errorMessages = 0, unknownMessages = 0;
  const formats = new Set<string>();
  for (const [index, events] of attempts.entries()) {
    const pi = events.filter(e => e.type === "message_end" && e.message?.role === "assistant");
    // Detect the envelope before looking for usage. A terminal error or a
    // newer missing counter must not disappear behind an earlier valid one.
    const claude = events.filter(e => e.type === "result");
    const codex = events.filter(e => ["thread.started", "turn.started", "turn.completed", "turn.failed"].includes(e.type));
    if ([pi.length, claude.length, codex.length].filter(Boolean).length > 1) reasons.add("mixed_provider_formats");
    if (pi.length) {
      piSeen = true;
      formats.add("pi_message_end");
      const ids = new Set<string>();
      for (const e of pi) {
        const m = e.message;
        const id = typeof m.responseId === "string" ? m.responseId : typeof m.id === "string" ? m.id : null;
        if (id && ids.has(id)) continue;
        if (id) ids.add(id);
        if (["error", "aborted"].includes(m.stopReason)) {
          errorMessages++; reasons.add("provider_error_usage_may_be_incomplete");
        } else if (["stop", "length", "toolUse"].includes(m.stopReason)) successMessages++;
        else unknownMessages++;
        const n = normalized(m.usage, "pi");
        if (n) { sum = addNormalized(sum, n); records++; }
        else reasons.add("pi_message_usage_missing_or_invalid");
      }
      if (!events.some(e => e.type === "agent_end")) reasons.add("pi_terminal_missing");
    } else if (claude.length) {
      formats.add("claude_result_total");
      if (claude.at(-1).is_error === true) reasons.add("provider_error_usage_may_be_incomplete");
      const n = normalized(claude.at(-1).usage, "claude");
      if (n) { sum = addNormalized(sum, n); records++; }
      else reasons.add("claude_terminal_usage_invalid");
    } else if (codex.length) {
      formats.add("codex_session_counter");
      if (events.some(e => e.type === "turn.failed" || e.type === "error")) reasons.add("provider_error_usage_may_be_incomplete");
      // turn.completed is cumulative. Sum only last counter per session,
      // never every turn. Resumed sessions need a host-captured pre-run
      // baseline; absent evidence is deliberately not inferred from siblings.
      const fresh = index > 0 || spec?.provider_session_mode === "fresh_persistent" || spec?.provider_session_mode === "ephemeral";
      if (!fresh) { reasons.add("codex_session_baseline_unknown"); continue; }
      const counters = new Map<string, NormalizedTokens>();
      let session = "unidentified";
      let unfinished = false;
      for (const e of events) {
        if (e.type === "thread.started" && typeof e.thread_id === "string") session = e.thread_id;
        if (e.type === "turn.started") {
          if (unfinished) reasons.add("codex_overlapping_turns");
          unfinished = true;
        }
        if (e.type === "turn.completed" || e.type === "turn.failed") unfinished = false;
        if (e.type !== "turn.completed") continue;
        const n = normalized(e.usage, "codex");
        if (!n) { reasons.add("codex_terminal_usage_invalid"); continue; }
        const prior = counters.get(session);
        if (prior && (n.input_tokens < prior.input_tokens || n.output_tokens < prior.output_tokens || n.cache_read_input_tokens < prior.cache_read_input_tokens)) {
          reasons.add("codex_counter_regressed");
        }
        counters.set(session, n);
      }
      if (unfinished) reasons.add("codex_unfinished_turn");
      if (!counters.size) reasons.add("codex_terminal_usage_missing");
      for (const n of counters.values()) { sum = addNormalized(sum, n); records++; }
    } else reasons.add("attempt_usage_missing");
  }
  if (!status || !["done", "failed"].includes(status.state ?? "")) reasons.add("run_not_terminal_or_interrupted");
  if (formats.size > 1) reasons.add("mixed_provider_formats");
  return { normalized_tokens: records ? sum : null, response_observations: {
    basis: piSeen ? "pi_completed_assistant_messages_only" : "unavailable",
    successful_messages: piSeen ? successMessages : null, error_messages: piSeen ? errorMessages : null,
    unknown_messages: piSeen ? unknownMessages : null, repair_attempts: attempts.length - 1,
  }, coverage: {
    status: records ? reasons.size ? "partial" : "complete" : "missing",
    reasons: [...reasons].sort(), counted_records: records,
    basis: [...formats].sort().join("+") || "none",
  } };
}

export function lifecycleEvidence(text: string | null, spec: Partial<RunSpec> | null) {
  const phases: Array<{ phase: string; at: string; wait_reason: "provider_process" | null }> = [];
  let started: string | null = null, finished: string | null = null;
  const allowed = new Set(["provider_start", "provider_end", "result_validation", "result_repair_start", "result_repair_end", "delivery_complete"]);
  for (const line of (text ?? "").split(/\r?\n/)) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e?.ts !== "string" || !Number.isFinite(Date.parse(e.ts))) continue;
    if (e.type === "starting" && started === null) started = e.ts;
    if (["done", "failed", "timeout", "cancelled", "stale"].includes(e.type)) finished = e.ts;
    if (e.type === "phase" && allowed.has(e.phase)) phases.push({ phase: e.phase, at: e.ts,
      wait_reason: e.wait_reason === "provider_process" ? "provider_process" : null });
  }
  const interval = (a: string | null | undefined, b: string | null) => {
    if (!a || !b || !Number.isFinite(Date.parse(a)) || Date.parse(b) < Date.parse(a)) return null;
    return Date.parse(b) - Date.parse(a);
  };
  return { created_at: spec?.created_at ?? null, started_at: started, finished_at: finished,
    observed_run_ms: interval(started, finished), creation_to_start_ms: interval(spec?.created_at, started), phases,
    queue_wait_ms: null, human_wait_ms: null, model_only_ms: null,
    limitations: ["creation_to_start is not pure queue wait", "provider_process includes model, tool and transport time", "unobserved waits are unknown"] };
}
