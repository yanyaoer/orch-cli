import { normalizeNativeLine, textFromAssistantContent } from "./native-events.ts";
import { stripNulls } from "./schema.ts";

// Result delivery has stricter semantics than progress display: a malformed
// final answer must never expose an earlier, schema-shaped answer as final.
//
// `earlier` is the one narrow exception's input: the answers of Claude's
// earlier terminal envelopes in the same attempt, oldest first, present only
// when the stream also ends on a successful envelope. A Claude session that
// already delivered its result can be woken again (its own reminder, a
// background task's notification) and then end on a prose turn; the caller
// decides whether that final turn is a result attempt at all
// (effectiveFinalAnswer in drivers/driver-common.ts).
export function nativeResult(text: string): {
  text: string | null; structured: boolean; failed: boolean; repair: boolean; earlier: string[];
} {
  let answer: string | null = null;
  let structured = false;
  let failed = false;
  let repair = false;
  let attemptLines: string[] = [];
  let envelopes: string[] = [];
  let endsOnEnvelope = false;
  for (const line of text.split(/\r?\n/)) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { attemptLines.push(line); continue; }
    if (obj?.type === "orch_result_repair") {
      answer = null; structured = false; failed = false; repair = true; attemptLines = [];
      envelopes = []; endsOnEnvelope = false;
      continue;
    }
    attemptLines.push(line);
    if (!obj || typeof obj !== "object") continue;
    if ((obj.type === "message_start" && obj.message?.role === "assistant") ||
        (["item.started", "item.updated"].includes(obj.type) && obj.item?.type === "agent_message")) {
      structured = true; answer = null; endsOnEnvelope = false;
      continue;
    }
    const piMessage = (obj.type === "message_end" || obj.type === "turn_end") && obj.message?.role === "assistant";
    const piEnd = obj.type === "agent_end" && Array.isArray(obj.messages);
    if (piMessage || piEnd) {
      structured = true; endsOnEnvelope = false;
      const messages = piMessage ? [obj.message] : obj.messages.filter((m: any) => m?.role === "assistant");
      if (piEnd && messages.length === 0) answer = null;
      for (const message of messages) {
        if (typeof message.stopReason === "string") failed = ["error", "aborted"].includes(message.stopReason);
        const value = textFromAssistantContent(message.content);
        // A repeated turn_end carries the same completed message. If its
        // content differs or is empty, never assume an older answer survives.
        answer = value;
      }
      continue;
    }
    if (obj.type === "turn.completed" || (obj.type === "result" && obj.is_error === false)) failed = false;
    if (obj.type === "turn.failed" || obj.type === "error" ||
        (obj.type === "result" && (obj.is_error === true || String(obj.subtype ?? "").startsWith("error")))) {
      structured = true; failed = true;
    }
    if (obj.type === "result") {
      // Claude's terminal envelope supersedes every earlier assistant even
      // when its result is missing, empty or malformed.
      structured = true;
      // Under --json-schema the validated object rides structured_output; it
      // wins over the prose result. null (schema retries exhausted) falls back
      // to the text path and its repair round.
      const native = obj.structured_output;
      answer = native && typeof native === "object" && !Array.isArray(native)
        ? JSON.stringify(stripNulls(native))
        : typeof obj.result === "string" ? obj.result.trim() || null : null;
      endsOnEnvelope = !failed && answer !== null;
      if (endsOnEnvelope) envelopes.push(answer!);
      continue;
    }
    for (const event of normalizeNativeLine(line)) {
      if (event.kind !== "raw") structured = true;
      if (event.kind === "final" || event.kind === "assistant") {
        structured = true;
        if (event.text !== undefined) { answer = event.text; endsOnEnvelope = false; }
      }
    }
  }
  const earlier = endsOnEnvelope && !failed ? envelopes.slice(0, -1) : [];
  return { text: structured ? answer : attemptLines.join("\n").trim() || null, structured, failed, repair, earlier };
}
