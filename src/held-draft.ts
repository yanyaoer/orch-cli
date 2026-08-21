import { existsSync, readFileSync, readdirSync } from "node:fs";
import { appendJsonLine, countLines, readJsonFile } from "./json.ts";
import { mailControlStateDir, statePathSegment } from "./paths.ts";
import { sha256 } from "./hash.ts";

// Held Draft protocol (optimistic concurrency for outbound mail): every state
// change on a mail thread appends one line to an append-only event log, and
// the log's line count is the thread version. A reply drafted against
// --base-version N transmits only while the thread is still at N; otherwise
// the draft is parked in outbox-email/held together with the events it
// missed, and the submitter must pick an explicit path: revise the draft,
// release it as-is, or withdraw it.

function sha12(s: string): string {
  return sha256(s).slice(0, 12);
}

export type ThreadEventKind = "inbound" | "reply_sent";

export interface ThreadEvent {
  schema: "orch.mailctl/thread-event/v1";
  kind: ThreadEventKind;
  at: string;
  // inbound: msg_sha of the accepted message; reply_sent: outbound report key.
  ref: string;
  from?: string;
  summary: string;
}

export interface ThreadDeltaEvent extends ThreadEvent {
  version: number;
}

export interface HeldDraftRecord {
  schema: "orch.mailctl/held-draft/v1";
  report_key: string;
  thread: string;
  body: string;
  base_version: number;
  held_at_version: number;
  held_count: number;
  created_at: string;
  updated_at: string;
}

export function threadEventsPath(thread: string): string {
  return `${mailControlStateDir()}/threads/${sha12(thread)}.events.jsonl`;
}

export function threadVersionLockPath(thread: string): string {
  return `${mailControlStateDir()}/locks/thread-version-${sha12(thread)}.lock`;
}

export function outboxEmailHeldDir(): string {
  return `${mailControlStateDir()}/outbox-email/held`;
}

export function reportFileName(reportKey: string): string {
  return `${statePathSegment(reportKey, "report")}-${sha12(reportKey)}.json`;
}

export function heldReplyPath(reportKey: string): string {
  return `${outboxEmailHeldDir()}/${reportFileName(reportKey)}`;
}

export function threadVersion(thread: string): number {
  return countLines(threadEventsPath(thread));
}

// Versions are 1-based line numbers: a corrupt line keeps its slot so later
// events keep stable version numbers.
export function readThreadEvents(thread: string): ThreadDeltaEvent[] {
  let text: string;
  try {
    text = readFileSync(threadEventsPath(thread), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((line, index, all) => line !== "" || index < all.length - 1);
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line) as ThreadEvent;
      if (parsed?.schema === "orch.mailctl/thread-event/v1") return { ...parsed, version: index + 1 };
    } catch {
      // Fall through to the placeholder below.
    }
    return {
      schema: "orch.mailctl/thread-event/v1",
      kind: "inbound",
      at: "",
      ref: "",
      summary: "(unreadable event)",
      version: index + 1,
    } satisfies ThreadDeltaEvent;
  });
}

export function threadDelta(thread: string, since: number): ThreadDeltaEvent[] {
  return readThreadEvents(thread).filter((event) => event.version > since);
}

// Idempotent append: (kind, ref) identifies an event, so replays (marker
// backfill, crash-recovery retry finalize) never double-bump the version.
export function appendThreadEvent(thread: string, event: Omit<ThreadEvent, "schema">): boolean {
  if (readThreadEvents(thread).some((row) => row.kind === event.kind && row.ref === event.ref)) return false;
  appendJsonLine(threadEventsPath(thread), { schema: "orch.mailctl/thread-event/v1", ...event });
  return true;
}

export function readHeldDraft(reportKey: string): HeldDraftRecord | null {
  const record = readJsonFile<HeldDraftRecord | null>(heldReplyPath(reportKey), null);
  return record?.schema === "orch.mailctl/held-draft/v1" ? record : null;
}

export function listHeldDrafts(thread?: string): HeldDraftRecord[] {
  const dir = outboxEmailHeldDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJsonFile<HeldDraftRecord | null>(`${dir}/${name}`, null))
    .filter((record): record is HeldDraftRecord => record?.schema === "orch.mailctl/held-draft/v1")
    .filter((record) => !thread || record.thread === thread);
}
