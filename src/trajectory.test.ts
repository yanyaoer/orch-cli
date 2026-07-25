import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateSessionFile, normalizeSession } from "./trajectory.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-traj-"));
  tempDirs.push(dir);
  return dir;
}

// Fixture lines mirror real session files profiled on 2026-07-25.

const CLAUDE_SESSION = [
  JSON.stringify({ type: "queue-operation", operation: "x", sessionId: "s-1", timestamp: "t0" }),
  JSON.stringify({
    type: "user",
    sessionId: "s-1",
    timestamp: "t1",
    message: { role: "user", content: "Review the diff." },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "t2",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need the file list first." },
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "git diff --stat" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: "t3",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: [{ type: "text", text: "3 files changed" }] }],
    },
  }),
  "not json at all",
  JSON.stringify({ type: "attachment", timestamp: "t4" }),
].join("\n");

test("claude session normalizes into ordered role records", () => {
  const records = normalizeSession("claude", CLAUDE_SESSION);
  expect(records.map((r) => r.role)).toEqual(["meta", "user", "reasoning", "assistant", "tool"]);
  expect(records[0]).toMatchObject({ role: "meta", source: "claude", session_id: "s-1" });
  expect(records[1]).toMatchObject({ role: "user", content: "Review the diff.", timestamp: "t1" });
  expect(records[2]).toMatchObject({ role: "reasoning", content: "Need the file list first." });
  expect(records[3]).toMatchObject({ role: "assistant", content: "Let me look." });
  expect(records[3]!.tool_calls).toEqual([
    { id: "tu-1", name: "Bash", args: JSON.stringify({ command: "git diff --stat" }) },
  ]);
  expect(records[4]).toMatchObject({ role: "tool", tool_call_id: "tu-1", content: "3 files changed" });
});

const CODEX_SESSION = [
  JSON.stringify({ type: "session_meta", timestamp: "t0", payload: { id: "cx-1", cwd: "/tmp/w" } }),
  JSON.stringify({
    type: "response_item",
    timestamp: "t1",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "system noise" }] },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "t1",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug." }] },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "t2",
    payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Reproduce first." }], encrypted_content: "x" },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "t3",
    payload: { type: "custom_tool_call", call_id: "c-1", name: "exec", input: "pwd" },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "t3",
    payload: { type: "custom_tool_call_output", call_id: "c-1", output: "/tmp/w" },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "t4",
    payload: { type: "function_call", call_id: "f-1", name: "shell", arguments: '{"cmd":"ls"}' },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "t4",
    payload: { type: "function_call_output", call_id: "f-1", output: "a.txt" },
  }),
  JSON.stringify({
    type: "response_item",
    timestamp: "t5",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
  }),
  JSON.stringify({ type: "event_msg", timestamp: "t5", payload: { type: "agent_message" } }),
].join("\n");

test("codex rollout normalizes both tool-call flavors and skips developer/event noise", () => {
  const records = normalizeSession("codex", CODEX_SESSION);
  expect(records.map((r) => r.role)).toEqual([
    "meta", "user", "reasoning", "assistant", "tool", "assistant", "tool", "assistant",
  ]);
  expect(records[0]).toMatchObject({ role: "meta", source: "codex", session_id: "cx-1" });
  expect(records[1]).toMatchObject({ role: "user", content: "Fix the bug." });
  expect(records[2]).toMatchObject({ role: "reasoning", content: "Reproduce first." });
  expect(records[3]!.tool_calls).toEqual([{ id: "c-1", name: "exec", args: "pwd" }]);
  expect(records[4]).toMatchObject({ role: "tool", tool_call_id: "c-1", content: "/tmp/w" });
  expect(records[5]!.tool_calls).toEqual([{ id: "f-1", name: "shell", args: '{"cmd":"ls"}' }]);
  expect(records[7]).toMatchObject({ role: "assistant", content: "Done." });
});

test("locateSessionFile finds claude and codex session files, rejects unknown agents", () => {
  const home = tempHome();
  mkdirSync(join(home, ".claude/projects/-tmp-w"), { recursive: true });
  writeFileSync(join(home, ".claude/projects/-tmp-w/abc-123.jsonl"), "{}\n");
  mkdirSync(join(home, ".codex/sessions/2026/07/25"), { recursive: true });
  writeFileSync(join(home, ".codex/sessions/2026/07/25/rollout-2026-07-25T01-02-03-uuid-9.jsonl"), "{}\n");

  expect(locateSessionFile("claude", "abc-123", home)).toEqual({
    source: "claude",
    path: join(home, ".claude/projects/-tmp-w/abc-123.jsonl"),
  });
  expect(locateSessionFile("codex", "uuid-9", home)).toEqual({
    source: "codex",
    path: join(home, ".codex/sessions/2026/07/25/rollout-2026-07-25T01-02-03-uuid-9.jsonl"),
  });
  expect(locateSessionFile("claude", "missing", home)).toBeNull();
  expect(locateSessionFile("pi", "abc-123", home)).toBeNull();
  expect(locateSessionFile("omp", "abc-123", home)).toBeNull();
});
