import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendThreadEvent,
  heldReplyPath,
  listHeldDrafts,
  readThreadEvents,
  threadDelta,
  threadEventsPath,
  threadVersion,
} from "./held-draft.ts";
import { writeJsonAtomic } from "./json.ts";

const previousStateHome = process.env.XDG_STATE_HOME;

afterEach(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
});

function setup(): void {
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "orch-held-draft-"));
}

describe("thread version log", () => {
  it("counts appended events as versions and dedupes by (kind, ref)", () => {
    setup();
    expect(threadVersion("em-a")).toBe(0);
    expect(appendThreadEvent("em-a", { kind: "inbound", at: "t1", ref: "m1", from: "a@x", summary: "one" })).toBe(true);
    expect(appendThreadEvent("em-a", { kind: "reply_sent", at: "t2", ref: "reply:1", summary: "two" })).toBe(true);
    expect(appendThreadEvent("em-a", { kind: "inbound", at: "t3", ref: "m1", from: "a@x", summary: "replay" })).toBe(false);
    expect(threadVersion("em-a")).toBe(2);
    expect(threadVersion("em-other")).toBe(0);

    const events = readThreadEvents("em-a");
    expect(events.map((event) => event.version)).toEqual([1, 2]);
    expect(events.map((event) => event.kind)).toEqual(["inbound", "reply_sent"]);
    expect(threadDelta("em-a", 1).map((event) => event.ref)).toEqual(["reply:1"]);
    expect(threadDelta("em-a", 2)).toEqual([]);
  });

  it("keeps version slots stable across corrupt lines", () => {
    setup();
    const path = threadEventsPath("em-b");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ schema: "orch.mailctl/thread-event/v1", kind: "inbound", at: "t1", ref: "m1", summary: "one" }),
        "not json",
        JSON.stringify({ schema: "orch.mailctl/thread-event/v1", kind: "inbound", at: "t3", ref: "m3", summary: "three" }),
        "",
      ].join("\n"),
    );
    const events = readThreadEvents("em-b");
    expect(threadVersion("em-b")).toBe(3);
    expect(events.map((event) => event.version)).toEqual([1, 2, 3]);
    expect(events[1]!.summary).toBe("(unreadable event)");
    expect(threadDelta("em-b", 1).map((event) => event.ref)).toEqual(["", "m3"]);
  });

  it("lists held drafts filtered by thread", () => {
    setup();
    writeJsonAtomic(heldReplyPath("reply:a"), {
      schema: "orch.mailctl/held-draft/v1",
      report_key: "reply:a",
      thread: "em-a",
      body: "a",
      base_version: 1,
      held_at_version: 2,
      held_count: 1,
      created_at: "t",
      updated_at: "t",
    });
    writeJsonAtomic(heldReplyPath("reply:b"), {
      schema: "orch.mailctl/held-draft/v1",
      report_key: "reply:b",
      thread: "em-b",
      body: "b",
      base_version: 0,
      held_at_version: 1,
      held_count: 2,
      created_at: "t",
      updated_at: "t",
    });
    writeJsonAtomic(join(dirname(heldReplyPath("reply:a")), "junk.json"), { schema: "other" });
    expect(listHeldDrafts().map((record) => record.report_key)).toEqual(["reply:a", "reply:b"]);
    expect(listHeldDrafts("em-b").map((record) => record.report_key)).toEqual(["reply:b"]);
  });
});
