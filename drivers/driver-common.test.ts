import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProviderArgv, buildWorkerEnv, extractResultFromRunDir, extractResultFromText } from "./driver-common.ts";
import type { RunSpec } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-driver-common-"));
  tempDirs.push(dir);
  return dir;
}

function spec(role: RunSpec["role"], runId: string): RunSpec {
  return {
    version: 1,
    run_id: runId,
    mr: "123",
    role,
    agent: "claude",
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
  };
}

test("buildWorkerEnv preserves normal env and removes recursive tool settings", () => {
  const baseEnv = {
    PATH: "/usr/bin",
    HOME: "/home/orch",
    ANTHROPIC_API_KEY: "keep-auth",
    OPENAI_API_KEY: "keep-openai-auth",
    CODEX_HOME: "/home/orch/.codex",
    ORCH_DRIVER_FAKE_RESULT: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "session",
    CLAUDE_CODE_ENTRYPOINT: "entry",
    CLAUDE_CODE_SSE_PORT: "1234",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "true",
    MCP_CONFIG: "/tmp/mcp.json",
    CODEX_MCP_CONFIG: "/tmp/codex-mcp.json",
    ORCH_MCP_URL: "http://127.0.0.1:9999/mcp",
    EMPTY_VALUE: undefined,
  };
  const env = buildWorkerEnv(baseEnv);

  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/home/orch");
  expect(env.ANTHROPIC_API_KEY).toBe("keep-auth");
  expect(env.OPENAI_API_KEY).toBe("keep-openai-auth");
  expect(env.CODEX_HOME).toBe("/home/orch/.codex");
  expect(env.ORCH_DRIVER_FAKE_RESULT).toBe("1");
  expect(env.CLAUDE_CODE_AUTO_CONNECT_IDE).toBe("false");
  expect(env.CLAUDE_CODE_MCP_ALLOWLIST_ENV).toBe("1");
  expect("CLAUDECODE" in env).toBe(false);
  expect("CLAUDE_CODE_CHILD_SESSION" in env).toBe(false);
  expect("CLAUDE_CODE_SESSION_ID" in env).toBe(false);
  expect("CLAUDE_CODE_ENTRYPOINT" in env).toBe(false);
  expect("CLAUDE_CODE_SSE_PORT" in env).toBe(false);
  expect("MCP_CONFIG" in env).toBe(false);
  expect("CODEX_MCP_CONFIG" in env).toBe(false);
  expect("ORCH_MCP_URL" in env).toBe(false);
  expect("EMPTY_VALUE" in env).toBe(false);
  expect(baseEnv.CLAUDECODE).toBe("1");
  expect(baseEnv.MCP_CONFIG).toBe("/tmp/mcp.json");
  expect(buildWorkerEnv(env)).toEqual(env);
});

test("buildProviderArgv keeps defaults fresh and only resumes exact sessions", () => {
  const base = spec("implementer", "impl-session");

  expect(buildProviderArgv("claude", base, "/run", "/worktree")).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
  ]);
  expect(buildProviderArgv("codex", base, "/run", "/worktree")).toEqual([
    "codex",
    "exec",
    "--json",
    "--cd",
    "/worktree",
    "--output-last-message",
    "/run/last_message.txt",
    "-",
  ]);
  expect(buildProviderArgv("pi", { ...base, provider_session_mode: "ephemeral" }, "/run", "/worktree")).toEqual([
    "pi",
    "-p",
    "--mode",
    "json",
    "--no-session",
  ]);

  expect(
    buildProviderArgv(
      "claude",
      {
        ...base,
        provider_session_name: "mr123-review",
        provider_session_mode: "resume_exact",
        provider_session_id: "123e4567-e89b-12d3-a456-426614174000",
      },
      "/run",
      "/worktree",
    ),
  ).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--name",
    "mr123-review",
    "--resume",
    "123e4567-e89b-12d3-a456-426614174000",
  ]);
  expect(
    buildProviderArgv(
      "codex",
      { ...base, provider_session_mode: "resume_exact", provider_session_id: "thread-123" },
      "/run",
      "/worktree",
    ),
  ).toEqual(["codex", "exec", "resume", "--json", "--output-last-message", "/run/last_message.txt", "thread-123", "-"]);
  expect(
    buildProviderArgv(
      "pi",
      { ...base, provider_session_mode: "resume_exact", provider_session_id: "pi-session" },
      "/run",
      "/worktree",
    ),
  ).toEqual(["pi", "-p", "--mode", "json", "--session-id", "pi-session"]);
});

test("extractResultFromRunDir preserves codex agent_message extraction", () => {
  const runDir = tempDir();
  const result = {
    schema: "orch.result/implementer/v1",
    run_id: "impl-codex",
    verdict: "completed",
    summary: "codex native result",
    base_sha: "base",
    head_sha: "head",
    changed_files: ["src/orch.ts"],
    tests: [],
    acceptance: [],
    risks: [],
    rollback: "revert the codex change",
  };
  writeFileSync(
    join(runDir, "native.jsonl"),
    `${JSON.stringify({ item: { type: "agent_message", text: JSON.stringify(result) } })}\n`,
    "utf8",
  );

  expect(extractResultFromRunDir(runDir, spec("implementer", "impl-codex"))).toEqual(result);
});

test("extractResultFromRunDir reads claude stream-json result and assistant text events", () => {
  const resultRunDir = tempDir();
  const reviewer = {
    schema: "orch.result/reviewer/v1",
    run_id: "review-claude",
    verdict: "approve",
    reviews_run_id: "impl-a",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: ["bun test"],
  };
  const assistantFallback = {
    ...reviewer,
    verdict: "request_changes",
    blocking_findings: [{ id: "assistant-fallback", severity: "blocking", file: "x", body: "wrong candidate" }],
  };
  writeFileSync(
    join(resultRunDir, "native.jsonl"),
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(assistantFallback) }] } }),
      JSON.stringify({ type: "result", result: `native claude output\n${JSON.stringify(reviewer)}` }),
      "",
    ].join("\n"),
    "utf8",
  );
  expect(extractResultFromRunDir(resultRunDir, spec("reviewer", "review-claude"))).toEqual(reviewer);

  const assistantRunDir = tempDir();
  const verifier = {
    schema: "orch.result/verifier/v1",
    run_id: "verify-claude",
    verdict: "pass",
    verifies_run_id: "impl-a",
    commands: [{ cmd: "bun test", exit_code: 0, summary: "passed" }],
    acceptance: [{ id: "native-assistant", status: "pass" }],
  };
  writeFileSync(
    join(assistantRunDir, "native.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Here is the verifier result:" },
          { type: "tool_use", name: "ignored" },
          { type: "text", text: JSON.stringify(verifier) },
        ],
      },
    })}\n`,
    "utf8",
  );
  expect(extractResultFromRunDir(assistantRunDir, spec("verifier", "verify-claude"))).toEqual(verifier);
});

test("extractResultFromRunDir reads pi message_end assistant text events", () => {
  const runDir = tempDir();
  const reviewer = {
    schema: "orch.result/reviewer/v1",
    run_id: "review-pi",
    verdict: "approve",
    reviews_run_id: "impl-a",
    blocking_findings: [],
    non_blocking_findings: [{ id: "pi-note", body: "parsed from pi native output" }],
    suggested_tests: ["bun test"],
  };
  writeFileSync(
    join(runDir, "native.jsonl"),
    [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "ignore this" },
            { type: "text", text: "```json\n" + JSON.stringify(reviewer) + "\n```" },
          ],
        },
      }),
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", text: "valid JSON event, but no text candidate" }],
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  expect(extractResultFromRunDir(runDir, spec("reviewer", "review-pi"))).toEqual(reviewer);
});

test("extractResultFromRunDir accepts codex final text wrapped by schema key", () => {
  const runDir = tempDir();
  const reviewer = {
    schema: "orch.result/reviewer/v1",
    run_id: "review-codex",
    verdict: "approve",
    reviews_run_id: "impl-a",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: ["bun test"],
  };
  writeFileSync(
    join(runDir, "native.jsonl"),
    `${JSON.stringify({ item: { type: "agent_message", text: JSON.stringify({ "orch.result/reviewer/v1": reviewer }) } })}\n`,
    "utf8",
  );

  expect(extractResultFromRunDir(runDir, spec("reviewer", "review-codex"))).toEqual(reviewer);
  expect(extractResultFromText(JSON.stringify({ result: reviewer }), spec("reviewer", "review-codex"))).toEqual(reviewer);
  expect(extractResultFromText(JSON.stringify({ metadata: reviewer }), spec("reviewer", "review-codex"))).toBeNull();
});

test("extractResultFromRunDir accepts claude final text with prose before result JSON", () => {
  const runDir = tempDir();
  const verifier = {
    schema: "orch.result/verifier/v1",
    run_id: "verify-claude-prose",
    verdict: "pass",
    verifies_run_id: "impl-a",
    commands: [{ cmd: "bun test drivers/driver-common.test.ts", exit_code: 0, summary: "passed" }],
    acceptance: [{ id: "result-extraction", status: "pass" }],
  };
  writeFileSync(
    join(runDir, "native.jsonl"),
    `${JSON.stringify({
      type: "result",
      result: `I checked the implementation first {not JSON}.\n${JSON.stringify(verifier)}\nNo further notes.`,
    })}\n`,
    "utf8",
  );

  expect(extractResultFromRunDir(runDir, spec("verifier", "verify-claude-prose"))).toEqual(verifier);
});
