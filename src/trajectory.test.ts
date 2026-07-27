import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKeyFromRemote } from "./paths.ts";
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
    type: "assistant",
    timestamp: "t0",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "redacted" }] },
  }),
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

test("claude handles string tool results, structured result blocks, and string assistant content", () => {
  const session = [
    JSON.stringify({
      type: "user",
      sessionId: "s-2",
      timestamp: "t1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-s", content: "plain string result" }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "t2",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-ref", content: [{ type: "tool_reference", tool_name: "ExitPlanMode" }] }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "t3",
      message: { role: "assistant", content: "string assistant reply" },
    }),
  ].join("\n");
  const records = normalizeSession("claude", session);
  expect(records[1]).toMatchObject({ role: "tool", tool_call_id: "tu-s", content: "plain string result" });
  // Structured blocks without text serialize instead of vanishing into "".
  expect(records[2]!.content).toContain("tool_reference");
  expect(records[2]!.content).toContain("ExitPlanMode");
  expect(records[3]).toMatchObject({ role: "assistant", content: "string assistant reply" });
});

test("codex tool outputs as text-block arrays normalize to joined text", () => {
  const session = [
    JSON.stringify({ type: "session_meta", timestamp: "t0", payload: { id: "cx-2" } }),
    JSON.stringify({
      type: "response_item",
      timestamp: "t1",
      payload: { type: "custom_tool_call", call_id: "c-9", name: "exec", input: "pwd" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "t1",
      payload: { type: "custom_tool_call_output", call_id: "c-9", output: [{ type: "input_text", text: "/tmp/w" }] },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "t2",
      payload: { type: "function_call_output", call_id: "f-9", output: [{ type: "input_text", text: "line1" }, { type: "input_text", text: "line2" }] },
    }),
  ].join("\n");
  const records = normalizeSession("codex", session);
  expect(records[2]).toMatchObject({ role: "tool", tool_call_id: "c-9", content: "/tmp/w" });
  expect(records[3]).toMatchObject({ role: "tool", tool_call_id: "f-9", content: "line1\nline2" });
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

// ---------------------------------------------------------------------------
// Process-level command tests

async function runOrch(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runCmd(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${args.join(" ")} failed`);
}

test(
  "trajectory CLI: run export + archive, thread skip visibility, all-skipped failure, selector conflicts",
  async () => {
    const root = tempHome();
    const home = join(root, "home");
    const stateHome = join(root, "state");
    const worktree = join(root, "wt");
    mkdirSync(worktree, { recursive: true });
    const remote = "git@github.com:example/traj.git";
    await runCmd(["git", "init"], worktree);
    await runCmd(["git", "remote", "add", "origin", remote], worktree);
    await runCmd(
      ["git", "-c", "user.email=orch@example.com", "-c", "user.name=orch", "commit", "--allow-empty", "-m", "init"],
      worktree,
    );

    const repoKey = repoKeyFromRemote(remote, worktree);
    const sessionId = "sess-abc";
    const claudeRunDir = join(stateHome, "orch", repoKey, "mrs/t1/runs/run-claude");
    mkdirSync(claudeRunDir, { recursive: true });
    writeFileSync(
      join(claudeRunDir, "status.json"),
      JSON.stringify({ run_id: "run-claude", mr: "t1", role: "reviewer", agent: "claude", state: "done", provider_resume_id: sessionId }),
    );
    const ompRunDir = join(stateHome, "orch", repoKey, "mrs/t1/runs/run-omp");
    mkdirSync(ompRunDir, { recursive: true });
    writeFileSync(
      join(ompRunDir, "status.json"),
      JSON.stringify({ run_id: "run-omp", mr: "t1", role: "reviewer", agent: "omp", state: "done" }),
    );
    const onlyOmpDir = join(stateHome, "orch", repoKey, "mrs/t2/runs/run-omp2");
    mkdirSync(onlyOmpDir, { recursive: true });
    writeFileSync(
      join(onlyOmpDir, "status.json"),
      JSON.stringify({ run_id: "run-omp2", mr: "t2", role: "reviewer", agent: "omp", state: "done" }),
    );
    mkdirSync(join(home, ".claude/projects/-wt"), { recursive: true });
    writeFileSync(join(home, ".claude/projects/-wt", `${sessionId}.jsonl`), CLAUDE_SESSION + "\n");

    const env = { HOME: home, XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: join(root, "config") };
    const base = ["trajectory", "--worktree", worktree];

    const run = await runOrch([...base, "--run", "run-claude", "--mr", "t1", "--jsonl"], env);
    expect(run.exitCode).toBe(0);
    const records = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as { role: string });
    expect(records.map((r) => r.role)).toEqual(["meta", "user", "reasoning", "assistant", "tool"]);

    const archived = await runOrch([...base, "--run", "run-claude", "--mr", "t1", "--jsonl", "--archive"], env);
    expect(archived.exitCode).toBe(0);
    expect(readFileSync(join(claudeRunDir, "trajectory.jsonl"), "utf8").trim()).toBe(archived.stdout.trim());

    // Mixed thread: claude exports, the omp skip must be visible on stderr.
    const thread = await runOrch([...base, "--thread", "t1", "--jsonl"], env);
    expect(thread.exitCode).toBe(0);
    expect(thread.stdout.trim().split("\n")).toHaveLength(5);
    expect(thread.stderr).toContain("skip run-omp");
    expect(thread.stderr).toContain("session adapter");

    // Nothing exportable is a failure, not an empty success.
    const empty = await runOrch([...base, "--thread", "t2", "--jsonl"], env);
    expect(empty.exitCode).not.toBe(0);
    expect(empty.stderr).toContain("no exportable session");

    const conflict = await runOrch([...base, "--run", "run-claude", "--thread", "t1"], env);
    expect(conflict.exitCode).not.toBe(0);
    expect(conflict.stderr).toContain("conflicts");

    const mrInThread = await runOrch([...base, "--thread", "t1", "--mr", "t1"], env);
    expect(mrInThread.exitCode).not.toBe(0);
  },
  60000,
);
