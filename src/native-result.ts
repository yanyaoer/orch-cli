import { normalizeNativeLine, textFromAssistantContent } from "./native-events.ts";

// Result delivery has stricter semantics than progress display: a malformed
// final answer must never expose an earlier, schema-shaped answer as final.
export function nativeResult(text: string): {
  text: string | null; structured: boolean; failed: boolean; repair: boolean;
} {
  let answer: string | null = null;
  let structured = false;
  let failed = false;
  let repair = false;
  let attemptLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { attemptLines.push(line); continue; }
    if (obj?.type === "orch_result_repair") {
      answer = null; structured = false; failed = false; repair = true; attemptLines = [];
      continue;
    }
    attemptLines.push(line);
    if (!obj || typeof obj !== "object") continue;
    const piMessage = (obj.type === "message_end" || obj.type === "turn_end") && obj.message?.role === "assistant";
    const piEnd = obj.type === "agent_end" && Array.isArray(obj.messages);
    if (piMessage || piEnd) {
      structured = true;
      const messages = piMessage ? [obj.message] : obj.messages.filter((m: any) => m?.role === "assistant");
      for (const message of messages) {
        if (typeof message.stopReason === "string") failed = ["error", "aborted"].includes(message.stopReason);
        const value = textFromAssistantContent(message.content);
        // Empty duplicate turn_end payloads are common. An explicit failed
        // response still blocks extraction even when it has no text.
        if (value !== null) answer = value;
      }
      continue;
    }
    if (obj.type === "turn.completed" || (obj.type === "result" && obj.is_error === false)) failed = false;
    if (obj.type === "turn.failed" || obj.type === "error" ||
        (obj.type === "result" && (obj.is_error === true || String(obj.subtype ?? "").startsWith("error")))) {
      structured = true; failed = true;
    }
    for (const event of normalizeNativeLine(line)) {
      if (event.kind === "final" || event.kind === "assistant") {
        structured = true;
        if (event.text !== undefined) answer = event.text;
      }
    }
  }
  return { text: structured ? answer : attemptLines.join("\n").trim() || null, structured, failed, repair };
}
