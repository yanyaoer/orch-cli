import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeRunMode,
  claudeTuiArgv,
  configuredClaudeMode,
  flatScreen,
  permissionQuestion,
  PERMISSION_DENIED_MESSAGE,
  runClaudeTui,
  screenState,
  TranscriptTranslator,
  TUI_PROMPT_MAX_BYTES,
} from "./claude-tui.ts";
import { buildProviderArgv, buildProviderExecutionPlan, claudeEntrypoint, runProviderDriver } from "./driver-common.ts";
import { nativeResult } from "../src/native-result.ts";
import { providerResumeIdFromNativeText } from "../src/native-events.ts";
import { usageEvidence } from "../src/usage-evidence.ts";
import type { RunSpec } from "../src/types.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env.ORCH_CLAUDE_MODE = "print";
  delete process.env.ORCH_NATIVE_SCHEMA;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-claude-tui-"));
  tempDirs.push(dir);
  return dir;
}

function spec(role: RunSpec["role"], runId: string, extra: Partial<RunSpec> = {}): RunSpec {
  return {
    version: 1,
    run_id: runId,
    mr: "123",
    role,
    agent: "claude",
    model: null,
    tag: role,
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    idempotency_key: runId,
    repo_key: "local/repo",
    worktree: "/tmp/repo",
    task_path: null,
    task_text: "test task",
    task_sha: "task-sha",
    base_sha: "base",
    timeout_sec: 60,
    created_at: "2026-06-19T12:00:00.000Z",
    ...extra,
  };
}

// --- mode -----------------------------------------------------------------

test("claude mode: tui by default, print from ORCH_CLAUDE_MODE or config, env first", () => {
  expect(configuredClaudeMode({}, undefined)).toEqual({ mode: "tui", source: "default" });
  expect(configuredClaudeMode({}, "print")).toEqual({ mode: "print", source: "config.json claude.mode" });
  expect(configuredClaudeMode({ ORCH_CLAUDE_MODE: "tui" }, "print")).toEqual({ mode: "tui", source: "ORCH_CLAUDE_MODE" });
  expect(configuredClaudeMode({ ORCH_CLAUDE_MODE: "print" }, "tui")).toEqual({ mode: "print", source: "ORCH_CLAUDE_MODE" });
  // An unknown value is not a mode: the next source decides.
  expect(configuredClaudeMode({ ORCH_CLAUDE_MODE: "batch" }, undefined).mode).toBe("tui");
});

test("claude run mode falls back to -p where the interactive mode is not tried", () => {
  const base = { env: {}, configMode: undefined, sandboxed: false, prompt: "hi", platform: "darwin" as const };
  expect(claudeRunMode(base)).toEqual({ mode: "tui", why: null });
  expect(claudeRunMode({ ...base, platform: "linux" }).mode).toBe("tui");
  expect(claudeRunMode({ ...base, env: { ORCH_CLAUDE_MODE: "print" } })).toEqual({ mode: "print", why: "ORCH_CLAUDE_MODE is print" });
  expect(claudeRunMode({ ...base, sandboxed: true }).why).toContain("sandboxed");
  expect(claudeRunMode({ ...base, platform: "win32" }).why).toContain("win32");
  const big = "x".repeat(TUI_PROMPT_MAX_BYTES + 1);
  expect(claudeRunMode({ ...base, prompt: big }).why).toContain(`${TUI_PROMPT_MAX_BYTES + 1} bytes`);
});

test("entrypoint: unset by default, ORCH_CLAUDE_ENTRYPOINT over config", () => {
  expect(claudeEntrypoint({}, undefined)).toBeNull();
  expect(claudeEntrypoint({}, "loopx")).toBe("loopx");
  expect(claudeEntrypoint({ ORCH_CLAUDE_ENTRYPOINT: "cli" }, "loopx")).toBe("cli");
  expect(claudeEntrypoint({ ORCH_CLAUDE_ENTRYPOINT: " " }, "")).toBeNull();
});

test("plan: a claude run is the TUI by default, with the entrypoint only when asked for", () => {
  const base = spec("implementer", "plan-tui");
  const plain = { PATH: "/usr/bin", HOME: "/home/orch", CLAUDE_CODE_ENTRYPOINT: "cli" };
  const tui = buildProviderExecutionPlan({ provider: "claude", spec: base, runDir: "/run", worktree: "/wt", prompt: "do it", env: plain, claudeSessionId: "11111111-1111-4111-8111-111111111111" });
  expect(tui.claude).toEqual({ mode: "tui", why: null, sessionId: "11111111-1111-4111-8111-111111111111", entrypoint: null });
  expect(tui.argv).toEqual(claudeTuiArgv(buildProviderArgv("claude", base, "/run", "/wt"), "11111111-1111-4111-8111-111111111111", "do it"));
  // An inherited entrypoint (the calling Claude Code's) never reaches the worker.
  expect(tui.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();

  const print = buildProviderExecutionPlan({ provider: "claude", spec: base, runDir: "/run", worktree: "/wt", prompt: "do it", env: { ...plain, ORCH_CLAUDE_MODE: "print", ORCH_CLAUDE_ENTRYPOINT: "loopx" } });
  expect(print.claude).toEqual({ mode: "print", why: "ORCH_CLAUDE_MODE is print", sessionId: null, entrypoint: "loopx" });
  expect(print.argv).toEqual(buildProviderArgv("claude", base, "/run", "/wt"));
  expect(print.env.CLAUDE_CODE_ENTRYPOINT).toBe("loopx");

  const forced = buildProviderExecutionPlan({ provider: "claude", spec: base, runDir: "/run", worktree: "/wt", prompt: "do it", env: plain, claudeMode: "print" });
  expect(forced.claude?.mode).toBe("print");
  expect(forced.argv[1]).toBe("-p");

  const codex = buildProviderExecutionPlan({ provider: "codex", spec: { ...base, agent: "codex" }, runDir: "/run", worktree: "/wt", prompt: "x", env: plain });
  expect(codex.claude).toBeUndefined();
});

test("TUI argv: -p-only flags go, a session id comes, the prompt follows --", () => {
  const print = [
    "claude", "-p", "--verbose", "--output-format", "stream-json", "--input-format", "text",
    "--model", "opus", "--allowedTools", "Read,Edit", "--permission-mode", "dontAsk",
    "--add-dir", "/run/evidence", "--json-schema", '{"type":"object"}', "--no-session-persistence",
  ];
  expect(claudeTuiArgv(print, "sid-1", "-starts with a dash")).toEqual([
    "claude", "--model", "opus", "--allowedTools", "Read,Edit", "--permission-mode", "dontAsk",
    "--add-dir", "/run/evidence", "--session-id", "sid-1",
    "--disallowedTools", "AskUserQuestion,ExitPlanMode", "--", "-starts with a dash",
  ]);
  const resumed = claudeTuiArgv(["claude", "-p", "--resume", "sid-0"], "unused", "next");
  expect(resumed).toEqual(["claude", "--resume", "sid-0", "--disallowedTools", "AskUserQuestion,ExitPlanMode", "--", "next"]);
  expect(() => claudeTuiArgv(["codex", "exec"], "s", "p")).toThrow();
});

// --- transcript -> stream-json ---------------------------------------------

const RESULT_TEXT = '{"schema":"orch.review.v1","verdict":"approve"}';

function transcriptRows(prompt = "do the task"): string[] {
  return [
    { type: "custom-title", customTitle: "x" },
    { type: "user", message: { role: "user", content: prompt } },
    { type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>meta</system-reminder>" } },
    { type: "assistant", message: { id: "m1", model: "claude-x", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 } } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] }, toolUseResult: { stdout: "a.txt" } },
    { type: "assistant", isSidechain: true, message: { id: "sub", model: "claude-x", content: [{ type: "text", text: "subagent" }], usage: { input_tokens: 999 } } },
    { type: "assistant", message: { id: "m2", model: "claude-x", role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], usage: { input_tokens: 2, cache_creation_input_tokens: 50, cache_read_input_tokens: 2000, output_tokens: 1 } } },
    { type: "assistant", message: { id: "m2", model: "claude-x", role: "assistant", content: [{ type: "text", text: RESULT_TEXT }], usage: { input_tokens: 2, cache_creation_input_tokens: 50, cache_read_input_tokens: 2000, output_tokens: 40 } } },
    { type: "system", subtype: "turn_duration", durationMs: 1234 },
  ].map((row) => JSON.stringify(row));
}

function translate(rows: string[], since = 0): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  const t = new TranscriptTranslator("sid-9", (line) => out.push(line), "/wt", since);
  for (const row of rows) t.row(row);
  return out;
}

test("transcript rows become claude -p stream-json the result readers accept", () => {
  const lines = translate(transcriptRows());
  expect(lines.map((l) => l.type)).toEqual(["system", "assistant", "user", "assistant", "assistant", "result"]);
  const result = lines.at(-1)!;
  expect(result).toMatchObject({
    type: "result",
    subtype: "success",
    is_error: false,
    result: RESULT_TEXT,
    session_id: "sid-9",
    duration_ms: 1234,
    num_turns: 2,
    // One count per message (its last row), sidechains left out.
    usage: { input_tokens: 12, cache_creation_input_tokens: 150, cache_read_input_tokens: 3000, output_tokens: 45 },
  });
  const native = lines.map((l) => JSON.stringify(l)).join("\n");
  expect(nativeResult(native)).toMatchObject({ text: RESULT_TEXT, structured: true, failed: false });
  expect(providerResumeIdFromNativeText(native)).toBe("sid-9");
  const usage = usageEvidence(native, { agent: "claude" } as Partial<RunSpec>, { state: "done" });
  expect(usage.coverage.status).toBe("complete");
  // usage-evidence counts cache reads/writes inside input_tokens.
  expect(usage.normalized_tokens).toMatchObject({ input_tokens: 3162, cache_read_input_tokens: 3000, cache_write_input_tokens: 150, output_tokens: 45 });
});

test("an API error ends the turn as -p's error envelope; a session that ends mid-turn too", () => {
  const rows = [
    JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
    JSON.stringify({ type: "assistant", isApiErrorMessage: true, apiErrorStatus: 429, message: { id: "e1", model: "<synthetic>", content: [{ type: "text", text: "API Error: rate limited" }] } }),
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 5 }),
  ];
  const lines = translate(rows);
  expect(lines.filter((l) => l.type === "result")).toEqual([
    expect.objectContaining({ subtype: "error_during_execution", is_error: true, result: "API Error: rate limited", api_error_status: 429 }),
  ]);
  expect(nativeResult(lines.map((l) => JSON.stringify(l)).join("\n")).failed).toBe(true);

  const out: Array<Record<string, any>> = [];
  const t = new TranscriptTranslator("s", (line) => out.push(line), "/wt");
  t.row(rows[0]!);
  t.abort("Claude Code exited (1) before the turn ended");
  expect(out.at(-1)).toMatchObject({ type: "result", is_error: true });
});

test("rows before the run (a resumed session's history) and before the first prompt are not told", () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  const history = transcriptRows("old prompt").map((row) => JSON.stringify({ ...JSON.parse(row), timestamp: old }));
  const lines = translate([...history, ...transcriptRows()], Date.now() - 1000);
  expect(lines.filter((l) => l.type === "result")).toHaveLength(1);
  expect(translate([transcriptRows()[3]!])).toEqual([]);
});

test("a second turn (a background task's wake-up) gets its own envelope with the run's usage", () => {
  const wake = [
    JSON.stringify({ type: "user", message: { role: "user", content: "<task-notification>done</task-notification>" } }),
    JSON.stringify({ type: "assistant", message: { id: "m3", model: "claude-x", content: [{ type: "text", text: "noted" }], usage: { input_tokens: 1, output_tokens: 2 } } }),
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 9 }),
  ];
  const results = translate([...transcriptRows(), ...wake]).filter((l) => l.type === "result");
  expect(results.map((r) => r.result)).toEqual([RESULT_TEXT, "noted"]);
  expect(results[1]!.usage.output_tokens).toBe(47);
});

// --- screen ---------------------------------------------------------------

test("screen: the trust question's selection and a sign-in screen are read through escapes", () => {
  const trustNo = "\x1b[2J\x1b[1;1HQuick safety check: Is this a project you trust? \x1b[3;1HYes, I trust this folder?\x1b[5;1H❯ No, exit\x1b[6;1H  Yes, I trust this folder";
  // The real dialog says "trust this folder" in its options too.
  expect(screenState(flatScreen(trustNo))).toBe("trust_no");
  expect(screenState(flatScreen(`${trustNo}\x1b[5;1H  No, exit\x1b[6;1H❯ Yes, I trust this folder`))).toBe("trust_yes");
  expect(screenState(flatScreen("\x1b]0;title\x07Select login method:"))).toBe("sign_in");
  expect(screenState(flatScreen("╭─╮ ❯ \x1b[7m \x1b[0m"))).toBe("other");
});

test("screen: a tool permission question is told from the prompt", () => {
  // As Claude Code 2.1.316 draws it (flattened from a real run).
  const real = "touch created-by-test.txt\x1b[3;1HDo you want to proceed?\x1b[4;1H❯ 1. Yes\x1b[5;1H  2. Yes, and always allow access to /x from this project\x1b[6;1H  4. No\x1b[8;1HEsc to cancel · Tab to amend";
  expect(permissionQuestion(flatScreen(real))).toBe(true);
  expect(permissionQuestion(flatScreen("Do you want to make this edit to a.ts?\n❯ 1. Yes\n  2. No\nEsc to cancel"))).toBe(true);
  expect(permissionQuestion(flatScreen("❯ Do you want to know more? Esc to cancel"))).toBe(false);
  expect(permissionQuestion(flatScreen("╭─╮ ❯ "))).toBe(false);
});

// --- the run, with fake interactive Claude Codes ----------------------------

// A fake interactive claude: needs a terminal, takes --session-id/--resume
// and the prompt after --, writes a transcript under CLAUDE_CONFIG_DIR, then
// waits as the TUI does, until it is ended. FAKE_TUI picks the behavior.
const FAKE_TUI = String.raw`#!/bin/bash
[ -t 0 ] || { echo "fake claude: stdin is not a terminal" >&2; exit 3; }
sid=""; prompt=""; printmode=0
printf '%s\n' "$@" > "$FAKE_ARGV_OUT"
while [ $# -gt 0 ]; do
  case "$1" in
    -p) printmode=1; shift;;
    --session-id|--resume) sid=$2; shift 2;;
    --) prompt=$2; shift 2;;
    *) shift;;
  esac
done
dir="$CLAUDE_CONFIG_DIR/projects/-fake-project"; mkdir -p "$dir"; f="$dir/$sid.jsonl"
row() { printf '%s\n' "$1" >> "$f"; }
json() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
turn() {
  row "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":$(json "$1")}}"
  row "{\"type\":\"assistant\",\"message\":{\"id\":\"m-$2\",\"model\":\"claude-x\",\"content\":[{\"type\":\"text\",\"text\":$(json "$3")}],\"usage\":{\"input_tokens\":1,\"cache_creation_input_tokens\":2,\"cache_read_input_tokens\":30,\"output_tokens\":4}}}"
  row '{"type":"system","subtype":"turn_duration","durationMs":7}'
}
mode=$FAKE_TUI; [ -n "$mode" ] || mode=ok
case "$mode" in
  ok) turn "$prompt" 1 "$FAKE_ANSWER"; sleep 30;;
  trust)
    printf 'Quick safety check: Do you trust this folder?\r\n\xe2\x9d\xaf No, exit\r\n  Yes, I trust this folder\r\n'
    stty raw -echo
    IFS= read -rsn3 key
    [ "$key" = $'\e[B' ] || exit 4
    printf '\e[2A\r  No, exit\r\n\xe2\x9d\xaf Yes, I trust this folder\r\n'
    # bash's read hands Enter back as the empty delimiter
    while IFS= read -rsn1 key; do [ -z "$key" ] || [ "$key" = $'\r' ] && break; done
    turn "$prompt" 1 "$FAKE_ANSWER"; sleep 30;;
  wake) turn "$prompt" 1 "first"; sleep 1; turn "<task-notification>x</task-notification>" 2 "$FAKE_ANSWER"; sleep 30;;
  permission)
    row "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":$(json "$prompt")}}"
    row '{"type":"assistant","message":{"id":"m-1","model":"claude-x","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"touch x"}}],"usage":{"input_tokens":1,"output_tokens":1}}}'
    printf 'Do you want to proceed?\r\n\xe2\x9d\xaf 1. Yes\r\n  2. No\r\nEsc to cancel\r\n'
    stty raw -echo
    IFS= read -rsn1 key
    [ "$key" = $'\e' ] || exit 5
    row '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"interrupted","is_error":true}]}}'
    row '{"type":"system","subtype":"turn_duration","durationMs":3}'
    msg=""; while IFS= read -rsn1 key; do { [ -z "$key" ] || [ "$key" = $'\r' ]; } && break; msg="$msg$key"; done
    case "$msg" in *"nobody can give"*) ;; *) exit 6;; esac
    turn "denied, going on" 2 "$FAKE_ANSWER"; sleep 30;;
  never) sleep 30;;
  quit) exit 0;;
esac
`;

function fakeClaude(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), FAKE_TUI, "utf8");
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

function tuiEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return {
    ...env,
    PATH: `${fakeClaude(root)}:${process.env.PATH ?? ""}`,
    CLAUDE_CONFIG_DIR: join(root, "config"),
    FAKE_ARGV_OUT: join(root, "argv.txt"),
    FAKE_ANSWER: RESULT_TEXT,
    ...extra,
  };
}

async function tui(root: string, extra: Record<string, string>, opts: Partial<Parameters<typeof runClaudeTui>[0]> = {}) {
  const nativePath = join(root, "native.jsonl");
  const sid = "22222222-2222-4222-8222-222222222222";
  const result = await runClaudeTui({
    argv: ["claude", "--session-id", sid, "--", "the prompt"],
    env: tuiEnv(root, extra),
    cwd: root,
    sessionId: sid,
    resumed: false,
    ephemeral: false,
    nativePath,
    nativeMode: "w",
    trustFolder: true,
    readyMs: 5000,
    settleMs: 300,
    pollMs: 20,
    ...opts,
  });
  const native = existsSync(nativePath) ? readFileSync(nativePath, "utf8") : "";
  return { result, native, transcript: join(root, "config", "projects", "-fake-project", `${sid}.jsonl`) };
}

test("TUI run: the prompt is taken in a terminal, the turn is read back, and Claude Code is ended", async () => {
  const root = tempDir();
  const started = Date.now();
  const { result, native } = await tui(root, { FAKE_TUI: "ok" });
  expect(result).toMatchObject({ started: true, code: 0, why: null });
  // Ended once the turn settled, not after the fake's own 30s.
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(nativeResult(native)).toMatchObject({ text: RESULT_TEXT, failed: false });
  expect(readFileSync(join(root, "argv.txt"), "utf8")).toContain("the prompt");
});

test("TUI run: the folder trust question is answered yes once Yes is selected", async () => {
  const root = tempDir();
  const events: Array<Record<string, unknown>> = [];
  const { result, native } = await tui(root, { FAKE_TUI: "trust" }, { onEvent: (e) => events.push(e) });
  expect(result).toMatchObject({ started: true, code: 0 });
  expect(events).toContainEqual({ type: "claude_tui_trust", answered: "yes" });
  expect(nativeResult(native).text).toBe(RESULT_TEXT);
});

test("TUI run: a permission question nobody can answer is denied, and the turn goes on", async () => {
  const root = tempDir();
  const events: Array<Record<string, unknown>> = [];
  process.env.ORCH_CLAUDE_TUI_PERMISSION_WAIT_MS = "300";
  try {
    const { result, native } = await tui(root, { FAKE_TUI: "permission" }, { onEvent: (e) => events.push(e) });
    expect(result).toMatchObject({ started: true, code: 0 });
    expect(events).toContainEqual({ type: "claude_tui_permission", answered: "denied" });
    expect(nativeResult(native)).toMatchObject({ text: RESULT_TEXT, failed: false });
  } finally {
    delete process.env.ORCH_CLAUDE_TUI_PERMISSION_WAIT_MS;
  }
  expect(PERMISSION_DENIED_MESSAGE).toContain("nobody can give");
});

test("TUI run: with trust answering off, the trust question means the run is -p", async () => {
  const root = tempDir();
  const { result, native } = await tui(root, { FAKE_TUI: "trust" }, { trustFolder: false });
  expect(result.started).toBe(false);
  expect(result.why).toContain("trust the folder");
  expect(native).toBe("");
});

test("TUI run: no prompt taken in the ready wait, or an early exit, is not started", async () => {
  const never = await tui(tempDir(), { FAKE_TUI: "never" }, { readyMs: 500 });
  expect(never.result.started).toBe(false);
  expect(never.result.why).toContain("took no prompt in 500ms");
  const quit = await tui(tempDir(), { FAKE_TUI: "quit" });
  expect(quit.result.started).toBe(false);
  expect(quit.result.why).toContain("exited");
});

test("TUI run: a wake-up turn inside the settle wait is followed to its end", async () => {
  const root = tempDir();
  const { result, native } = await tui(root, { FAKE_TUI: "wake" }, { settleMs: 2500 });
  expect(result).toMatchObject({ started: true, code: 0 });
  expect(nativeResult(native)).toMatchObject({ text: RESULT_TEXT, earlier: ["first"] });
});

test("TUI run: an ephemeral run leaves no transcript, as -p's --no-session-persistence", async () => {
  const root = tempDir();
  const { result, transcript } = await tui(root, { FAKE_TUI: "ok" }, { ephemeral: true });
  expect(result.started).toBe(true);
  expect(existsSync(transcript)).toBe(false);
});

// --- the driver -------------------------------------------------------------

async function driver(root: string, extra: Record<string, string>) {
  const runDir = join(root, "run");
  const worktree = join(root, "worktree");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const runSpec = spec("reviewer", "tui-driver");
  writeFileSync(join(runDir, "spec.json"), `${JSON.stringify(runSpec)}\n`, "utf8");
  const env = tuiEnv(root, extra);
  const saved = { ...process.env };
  Object.assign(process.env, env, { ORCH_CLAUDE_MODE: "tui", ORCH_CLAUDE_TUI_SETTLE_MS: "300", ORCH_CLAUDE_TUI_READY_MS: "3000", ORCH_NATIVE_SCHEMA: "0" });
  try {
    const code = await runProviderDriver("claude", ["--spec", join(runDir, "spec.json"), "--run-dir", runDir, "--worktree", worktree]);
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { code, runDir, events };
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const REVIEW = {
  schema: "orch.result/reviewer/v1",
  run_id: "tui-driver",
  verdict: "approve",
  reviews_run_id: "",
  blocking_findings: [],
  non_blocking_findings: [{ body: "looks fine" }],
  suggested_tests: [],
};

test("driver: a claude run goes through the TUI and delivers its result", async () => {
  const root = tempDir();
  const { code, runDir, events } = await driver(root, { FAKE_TUI: "ok", FAKE_ANSWER: JSON.stringify(REVIEW) });
  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"))).toMatchObject({ verdict: "approve", non_blocking_findings: [{ body: "looks fine" }] });
  expect(events.filter((e) => e.type === "claude_mode")).toEqual([expect.objectContaining({ type: "claude_mode", mode: "tui" })]);
  expect(events.some((e) => e.type === "result_repair")).toBe(false);
  const argv = readFileSync(join(root, "argv.txt"), "utf8").split("\n");
  expect(argv).not.toContain("-p");
  expect(argv).toContain("--session-id");
});

test("driver: a TUI that does not start runs the same turn as -p", async () => {
  const root = tempDir();
  // FAKE_TUI=quit exits at once in a terminal; as -p (no terminal) the fake
  // fails its tty check, so a -p stand-in is put first on PATH.
  const bin = join(root, "print-bin");
  mkdirSync(bin, { recursive: true });
  const envelope = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "p-1", result: JSON.stringify(REVIEW), usage: { input_tokens: 1, output_tokens: 1 } });
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/bash\nif [ "$1" = "-p" ]; then cat >/dev/null; printf '%s\\n' '${envelope}'; exit 0; fi\nexec ${join(root, "bin", "claude")} "$@"\n`,
    "utf8",
  );
  chmodSync(join(bin, "claude"), 0o755);
  const { code, runDir, events } = await driver(root, { FAKE_TUI: "quit", PATH: `${bin}:${join(root, "bin")}:${process.env.PATH ?? ""}` });
  expect(code).toBe(0);
  expect(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).verdict).toBe("approve");
  const modes = events.filter((e) => e.type === "claude_mode");
  expect(modes[0]).toMatchObject({ type: "claude_mode", mode: "tui" });
  expect(modes[1]).toMatchObject({ mode: "print", fallback_from: "tui" });
  expect(modes[1].why).toContain("exited");
});
