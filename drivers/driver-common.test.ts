import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrompt,
  buildProviderArgv,
  buildWorkerEnv,
  CLAUDE_CONTROLLER_ALLOWED_TOOLS,
  CLAUDE_RESEARCHER_ALLOWED_TOOLS,
  CODEX_RESEARCHER_MODEL,
  extractResultFromRunDir,
  extractResultFromText,
  ompFallbackConfigYaml,
  ompModelChain,
  OMP_MODEL_CHAIN,
  rawResultText,
  runProviderDriver,
} from "./driver-common.ts";
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
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeFakeCodex(binDir: string, output: unknown): void {
  const path = join(binDir, "codex");
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' ${shellQuote(JSON.stringify(output))}\n`, "utf8");
  chmodSync(path, 0o755);
}

async function runFakeCodexResult(output: unknown): Promise<{ runDir: string; exitCode: number }> {
  const root = tempDir();
  const runDir = join(root, "run");
  const binDir = join(root, "bin");
  const worktree = join(root, "worktree");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFakeCodex(binDir, output);

  const runSpec = spec("reviewer", "review-coercion-event");
  const specPath = join(runDir, "spec.json");
  writeFileSync(specPath, `${JSON.stringify(runSpec, null, 2)}\n`, "utf8");

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  try {
    const exitCode = await runProviderDriver("codex", ["--spec", specPath, "--run-dir", runDir, "--worktree", worktree]);
    return { runDir, exitCode };
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

function readRunEvents(runDir: string): Array<{ type?: unknown; coercions?: Array<{ field?: unknown; from?: unknown; to?: unknown }> }> {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

test("buildWorkerEnv replaces a fish SHELL with bash and keeps POSIX shells", () => {
  expect(buildWorkerEnv({ PATH: "/usr/bin", SHELL: "/opt/homebrew/bin/fish" }).SHELL).toBe("/bin/bash");
  expect(buildWorkerEnv({ PATH: "/usr/bin", SHELL: "/bin/zsh" }).SHELL).toBe("/bin/zsh");
  expect(buildWorkerEnv({ PATH: "/usr/bin" }).SHELL).toBeUndefined();
});

test("buildWorkerEnv strips node_modules/.bin entries from PATH", () => {
  const env = buildWorkerEnv({
    PATH: "/Users/u/node_modules/.bin:/Users/u/repo/node_modules/.bin:/usr/local/bin:/usr/bin",
  });
  expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
});

test("buildPrompt names schema property and forbids worktree result files", () => {
  const prompt = buildPrompt(spec("reviewer", "review-prompt"), "pi");
  expect(prompt).toContain('"schema": "orch.result/reviewer/v1"');
  expect(prompt).toContain("Do not create or edit result files in the worktree");
  expect(prompt).not.toContain("Required schema field");

  const controllerPrompt = buildPrompt(spec("controller", "control-prompt"), "claude");
  expect(controllerPrompt).toContain('"schema": "orch.result/controller/v1"');
});

test("buildPrompt demands a role-appropriate verdict from every role", () => {
  // Verdict is the only success/failure signal and can never be coerced
  // (completed and failed share identical content fields), so the prompt
  // contract is the layer that must demand it.
  const verdictLine: Record<string, string> = {
    implementer: '"completed" | "failed"',
    reviewer: '"approve" | "request_changes"',
    controller: '"completed" | "failed"',
    researcher: '"completed" | "failed"',
    verifier: '"pass" | "fail"',
  };
  for (const [role, verdicts] of Object.entries(verdictLine)) {
    const prompt = buildPrompt(spec(role as RunSpec["role"], `verdict-${role}`), "claude");
    expect(prompt).toContain(`It must also include "verdict", exactly one of: ${verdicts}.`);
    expect(prompt).toContain('Never omit "verdict".');
  }
  // Roles with a failure verdict get the honesty clause; reviewer's two
  // verdicts are both valid review outcomes, so it must not.
  expect(buildPrompt(spec("researcher", "verdict-honesty"), "claude")).toContain('Use "failed" when the task could not genuinely be completed');
  expect(buildPrompt(spec("verifier", "verdict-honesty-v"), "claude")).toContain('Use "fail" when the task could not genuinely be completed');
  expect(buildPrompt(spec("reviewer", "verdict-honesty-r"), "claude")).not.toContain("could not genuinely be completed");
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
    "--effort",
    "medium",
    "--permission-mode",
    "bypassPermissions",
  ]);
  expect(buildProviderArgv("codex", base, "/run", "/worktree")).toEqual([
    "codex",
    "exec",
    "--json",
    "--cd",
    "/worktree",
    "--output-last-message",
    "/run/last_message.txt",
    "--sandbox",
    "workspace-write",
    "-",
  ]);
  expect(buildProviderArgv("pi", { ...base, provider_session_mode: "ephemeral" }, "/run", "/worktree")).toEqual([
    "pi",
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking",
    "xhigh",
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
    "--effort",
    "medium",
    "--permission-mode",
    "bypassPermissions",
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
  ).toEqual(["codex", "exec", "--sandbox", "workspace-write", "resume", "--json", "--output-last-message", "/run/last_message.txt", "thread-123", "-"]);
  expect(
    buildProviderArgv(
      "pi",
      { ...base, provider_session_mode: "resume_exact", provider_session_id: "pi-session" },
      "/run",
      "/worktree",
    ),
  ).toEqual(["pi", "--model", "openai-codex/gpt-5.6-sol", "--thinking", "xhigh", "-p", "--mode", "json", "--session-id", "pi-session"]);
});

test("buildProviderArgv passes explicit model overrides to supporting providers", () => {
  const base = spec("reviewer", "model-override");
  const model = "zenmux-anthropic/anthropic/claude-fable-5";

  expect(buildProviderArgv("pi", { ...base, model, provider_session_mode: "ephemeral" }, "/run", "/worktree")).toEqual([
    "pi",
    "--model",
    model,
    "--thinking",
    "xhigh",
    "-p",
    "--mode",
    "json",
    "--tools",
    "read,grep,find,ls",
    "--no-session",
  ]);

  expect(buildProviderArgv("claude", { ...base, model }, "/run", "/worktree")).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--model",
    model,
    "--effort",
    "high",
    "--permission-mode",
    "plan",
  ]);

  expect(buildProviderArgv("codex", { ...base, model }, "/run", "/worktree")).toEqual([
    "codex",
    "exec",
    "--json",
    "--cd",
    "/worktree",
    "--output-last-message",
    "/run/last_message.txt",
    "--model",
    model,
    "--sandbox",
    "read-only",
    "-",
  ]);

  expect(
    buildProviderArgv(
      "codex",
      { ...base, model, provider_session_mode: "resume_exact", provider_session_id: "thread-123" },
      "/run",
      "/worktree",
    ),
  ).toEqual([
    "codex",
    "exec",
    "--sandbox",
    "read-only",
    "resume",
    "--json",
    "--output-last-message",
    "/run/last_message.txt",
    "--model",
    model,
    "thread-123",
    "-",
  ]);
});

test("buildProviderArgv runs omp with the default model chain and @file prompt", () => {
  const base = spec("reviewer", "omp-review");

  expect(buildProviderArgv("omp", { ...base, provider_session_mode: "ephemeral" }, "/run", "/worktree", "do review")).toEqual([
    "omp",
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking=xhigh",
    "--config",
    "/run/omp-fallback.yml",
    "-p",
    "--mode",
    "json",
    "--tools",
    "read,grep,find,ls",
    "--no-session",
    "@/run/prompt.md",
  ]);

  expect(
    buildProviderArgv(
      "omp",
      { ...base, provider_session_mode: "resume_exact", provider_session_id: "sess-123" },
      "/run",
      "/worktree",
      "do review",
    ),
  ).toEqual([
    "omp",
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking=xhigh",
    "--config",
    "/run/omp-fallback.yml",
    "-p",
    "--mode",
    "json",
    "--tools",
    "read,grep,find,ls",
    "--resume",
    "sess-123",
    "@/run/prompt.md",
  ]);

  // omp is not reviewer-only: write roles launch without the read-only tool set.
  expect(
    buildProviderArgv("omp", { ...spec("implementer", "omp-impl"), provider_session_mode: "ephemeral" }, "/run", "/worktree", "build"),
  ).toEqual([
    "omp",
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking=xhigh",
    "--config",
    "/run/omp-fallback.yml",
    "-p",
    "--mode",
    "json",
    "--no-session",
    "@/run/prompt.md",
  ]);
});

test("ompModelChain puts the requested model first and keeps the rest as quota fallbacks", () => {
  expect(ompModelChain(null)).toEqual({
    primary: "openai-codex/gpt-5.6-sol",
    fallbacks: ["zenmux/anthropic/claude-fable-5", "google-antigravity/gemini-3.1-pro"],
  });
  expect(ompModelChain("zenmux/anthropic/claude-fable-5")).toEqual({
    primary: "zenmux/anthropic/claude-fable-5",
    fallbacks: ["openai-codex/gpt-5.6-sol", "google-antigravity/gemini-3.1-pro"],
  });
  // A model outside the chain keeps the full chain as fallbacks.
  expect(ompModelChain("openai/gpt-5.5-pro")).toEqual({
    primary: "openai/gpt-5.5-pro",
    fallbacks: [...OMP_MODEL_CHAIN],
  });
});

test("ompFallbackConfigYaml renders omp's native retry.fallbackChains overlay", () => {
  expect(ompFallbackConfigYaml(["zenmux/anthropic/claude-fable-5", "openai-codex/gpt-5.6"])).toBe(
    ["retry:", "  fallbackChains:", "    default:", "      - zenmux/anthropic/claude-fable-5", "      - openai-codex/gpt-5.6", ""].join(
      "\n",
    ),
  );
});

test("buildProviderArgv matches read-only posture to the reviewer role per provider", () => {
  const base = spec("reviewer", "review-posture");

  // claude reviewer runs in plan mode (read-only, no edits), escalated to opus/high effort.
  expect(buildProviderArgv("claude", base, "/run", "/worktree")).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--model",
    "opus",
    "--effort",
    "high",
    "--permission-mode",
    "plan",
  ]);

  // codex reviewer runs with the read-only sandbox.
  expect(buildProviderArgv("codex", base, "/run", "/worktree")).toEqual([
    "codex",
    "exec",
    "--json",
    "--cd",
    "/worktree",
    "--output-last-message",
    "/run/last_message.txt",
    "--sandbox",
    "read-only",
    "-",
  ]);

  // pi reviewer is restricted to read-only tools.
  expect(buildProviderArgv("pi", { ...base, provider_session_mode: "ephemeral" }, "/run", "/worktree")).toEqual([
    "pi",
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking",
    "xhigh",
    "-p",
    "--mode",
    "json",
    "--tools",
    "read,grep,find,ls",
    "--no-session",
  ]);
});

test("buildProviderArgv gives researcher a read-only web-research posture on claude and codex", () => {
  const base = spec("researcher", "research-posture");

  // claude researcher runs fable at xhigh effort; web tools ride an explicit
  // whitelist under dontAsk (plan mode would deny them headless), no Edit/Write.
  expect(buildProviderArgv("claude", base, "/run", "/worktree")).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--model",
    "fable",
    "--effort",
    "xhigh",
    "--allowedTools",
    CLAUDE_RESEARCHER_ALLOWED_TOOLS,
    "--permission-mode",
    "dontAsk",
  ]);

  // codex researcher defaults to gpt-5.6-sol at xhigh reasoning with native
  // web search enabled, inside the read-only sandbox.
  expect(buildProviderArgv("codex", base, "/run", "/worktree")).toEqual([
    "codex",
    "exec",
    "--json",
    "--cd",
    "/worktree",
    "--output-last-message",
    "/run/last_message.txt",
    "--model",
    CODEX_RESEARCHER_MODEL,
    "-c",
    "model_reasoning_effort=xhigh",
    "-c",
    "tools.web_search=true",
    "--sandbox",
    "read-only",
    "-",
  ]);

  // an explicit model override wins over the researcher default.
  const overridden = buildProviderArgv("codex", { ...base, model: "gpt-6" }, "/run", "/worktree");
  expect(overridden).toContain("gpt-6");
  expect(overridden).not.toContain(CODEX_RESEARCHER_MODEL);

  // resume keeps the researcher flags.
  expect(
    buildProviderArgv(
      "codex",
      { ...base, provider_session_mode: "resume_exact", provider_session_id: "sess-1" },
      "/run",
      "/worktree",
    ),
  ).toEqual([
    "codex",
    "exec",
    "--sandbox",
    "read-only",
    "resume",
    "--json",
    "--output-last-message",
    "/run/last_message.txt",
    "--model",
    CODEX_RESEARCHER_MODEL,
    "-c",
    "model_reasoning_effort=xhigh",
    "-c",
    "tools.web_search=true",
    "sess-1",
    "-",
  ]);

  // omp researcher rides the normal gemini chain with read-only tools (no web).
  expect(buildProviderArgv("omp", { ...base, provider_session_mode: "ephemeral" }, "/run", "/worktree")).toEqual([
    "omp",
    "--model",
    "openai-codex/gpt-5.6-sol",
    "--thinking=xhigh",
    "--config",
    "/run/omp-fallback.yml",
    "-p",
    "--mode",
    "json",
    "--tools",
    "read,grep,find,ls",
    "--no-session",
    "@/run/prompt.md",
  ]);

  expect(() => buildProviderArgv("pi", base, "/run", "/worktree")).toThrow(
    "researcher role only supports claude, codex, and omp providers",
  );
});

test("extractResultFromText coerces researcher alias fields and missing arrays", () => {
  const runSpec = spec("researcher", "research-coerce");
  const result = extractResultFromText(
    JSON.stringify({
      schema: "orch.result/researcher/v1",
      run_id: "invented",
      verdict: "complete",
      summary: "compared approaches",
      proposal: "adopt approach B",
      sources: ["https://example.com/doc"],
    }),
    runSpec,
  );
  expect(result).toMatchObject({
    schema: "orch.result/researcher/v1",
    run_id: "research-coerce",
    verdict: "completed",
    recommendation: "adopt approach B",
    sources: ["https://example.com/doc"],
    alternatives: [],
    open_questions: [],
    risks: [],
  });
});

test("extractResultFromText fails closed on any missing or blank researcher verdict", () => {
  // Completed and failed require identical content fields, so a missing
  // verdict is genuinely ambiguous: coercing it to completed would let failed
  // research dispatch write-role workers (orch new gates on completed). The
  // result must be rejected, whatever the missing-value spelling.
  const researcherBody = {
    schema: "orch.result/researcher/v1",
    summary: "cross-review MR 4245",
    recommendation: "## Destination\nreview lands as one merged comment",
    risks: ["reviewers may repeat settled findings"],
    alternatives: [],
    open_questions: [],
  };
  for (const verdict of [undefined, null, "", "   "]) {
    const body = verdict === undefined ? researcherBody : { ...researcherBody, verdict };
    // Prose preamble reproduces the real plan-run failure shape.
    const text = `调研完成，以下为计划 JSON。\n\n${JSON.stringify(body)}`;
    expect(extractResultFromText(text, spec("researcher", "research-no-verdict"))).toBeNull();
  }

  // An explicit verdict extracts through the same prose preamble — failed is
  // preserved, never rewritten to completed.
  for (const verdict of ["completed", "failed"]) {
    const text = `调研完成，以下为计划 JSON。\n\n${JSON.stringify({ ...researcherBody, verdict })}`;
    expect(extractResultFromText(text, spec("researcher", `research-${verdict}`))).toMatchObject({
      schema: "orch.result/researcher/v1",
      run_id: `research-${verdict}`,
      verdict,
      recommendation: researcherBody.recommendation,
      sources: [],
    });
  }
});

test("buildProviderArgv picks claude model/effort by role", () => {
  const argv = (role: RunSpec["role"], runId: string) =>
    buildProviderArgv("claude", spec(role, runId), "/run", "/worktree");

  // reviewer escalates to opus at high effort (paired with omp's gemini as a distinct model family).
  expect(argv("reviewer", "role-reviewer")).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--model",
    "opus",
    "--effort",
    "high",
    "--permission-mode",
    "plan",
  ]);

  // implementer stays on the CLI default model (sonnet), medium effort.
  expect(argv("implementer", "role-implementer")).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--effort",
    "medium",
    "--permission-mode",
    "bypassPermissions",
  ]);

  // verifier stays on the CLI default model (sonnet), low effort (mechanical checks).
  expect(argv("verifier", "role-verifier")).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--effort",
    "low",
    "--permission-mode",
    "bypassPermissions",
  ]);

  expect(argv("controller", "role-controller")).toEqual([
    "claude",
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--effort",
    "medium",
    "--allowedTools",
    CLAUDE_CONTROLLER_ALLOWED_TOOLS,
    "--permission-mode",
    "dontAsk",
  ]);
  expect(CLAUDE_CONTROLLER_ALLOWED_TOOLS).toContain("Bash(orch *)");
  expect(CLAUDE_CONTROLLER_ALLOWED_TOOLS).toContain("Read");
  expect(CLAUDE_CONTROLLER_ALLOWED_TOOLS).not.toMatch(/\b(?:Edit|Write|MultiEdit)\b/);
  expect(() => buildProviderArgv("codex", spec("controller", "role-controller-codex"), "/run", "/worktree")).toThrow(
    "controller role only supports claude provider",
  );
});

test("extractResultFromText coerces benign schema deviations instead of discarding", () => {
  const reviewSpec = spec("reviewer", "review-coerce");
  const deviant = JSON.stringify({
    schema: "orch.result/reviewer/v1",
    run_id: "model-invented-id",
    verdict: "Approved",
    reviews_run_id: 42,
    blocking_findings: ["plain string finding"],
    non_blocking_findings: [{ id: "nb-1", severity: "low", file: "a.ts", description: "body under wrong key" }],
    suggested_tests: [{ id: "st-1", body: "object instead of string" }, "already a string"],
  });
  const result = extractResultFromText(deviant, reviewSpec);
  expect(result).not.toBeNull();
  expect(result).toMatchObject({ run_id: "review-coerce", verdict: "approve", reviews_run_id: "42" });
  const reviewer = result as import("../src/types.ts").ReviewerResult;
  expect(reviewer.blocking_findings[0]).toMatchObject({
    body: "plain string finding",
    id: "finding-1",
    severity: "unspecified",
    file: "unspecified",
  });
  expect(reviewer.non_blocking_findings[0]?.body).toBe("body under wrong key");
  expect(reviewer.suggested_tests).toEqual(["st-1: object instead of string", "already a string"]);

  const controlSpec = spec("controller", "control-coerce");
  const controller = extractResultFromText(
    JSON.stringify({
      schema: "orch.result/controller/v1",
      run_id: "model-invented-id",
      verdict: "Complete",
      summary: "coordinated one batch",
      actions: [{ id: "ack", summary: "acked inbound message" }, "queued worker"],
    }),
    controlSpec,
  );
  expect(controller).toMatchObject({
    schema: "orch.result/controller/v1",
    run_id: "control-coerce",
    verdict: "completed",
    summary: "coordinated one batch",
    actions: ["ack: acked inbound message", "queued worker"],
  });
});

test("runProviderDriver records result_coercion events for verdict synonym coercions", async () => {
  const { runDir, exitCode } = await runFakeCodexResult({
    schema: "orch.result/reviewer/v1",
    run_id: "model-invented-id",
    verdict: "approved",
    reviews_run_id: "impl-a",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: [],
  });

  expect(exitCode).toBe(0);
  const events = readRunEvents(runDir);
  const coercionEvent = events.find((event) => event.type === "result_coercion");
  expect(coercionEvent?.coercions?.some((coercion) => coercion.field === "verdict" && coercion.from === "approved" && coercion.to === "approve")).toBe(
    true,
  );
});

test("runProviderDriver does not record result_coercion events for conforming results", async () => {
  const { runDir, exitCode } = await runFakeCodexResult({
    schema: "orch.result/reviewer/v1",
    run_id: "review-coercion-event",
    verdict: "approve",
    reviews_run_id: "impl-a",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: [],
  });

  expect(exitCode).toBe(0);
  expect(readRunEvents(runDir).some((event) => event.type === "result_coercion")).toBe(false);
});

test("rawResultText returns the final-message candidate and null when empty", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "native.jsonl"),
    `${JSON.stringify({ type: "result", result: "final prose answer without JSON" })}\n`,
    "utf8",
  );
  expect(rawResultText(dir)).toBe("final prose answer without JSON");

  const empty = tempDir();
  writeFileSync(join(empty, "native.jsonl"), "", "utf8");
  expect(rawResultText(empty)).toBeNull();
});

test("extractResultFromText coerces a flattened findings list and omitted empty arrays", () => {
  // Observed live from omp/gemini: one `findings` list instead of the two
  // schema arrays, and empty arrays plus reviews_run_id omitted entirely.
  const text = JSON.stringify({
    schema: "orch.result/reviewer/v1",
    verdict: "approve",
    findings: [],
  });
  expect(extractResultFromText(text, spec("reviewer", "flat-approve"))).toEqual({
    schema: "orch.result/reviewer/v1",
    run_id: "flat-approve",
    verdict: "approve",
    reviews_run_id: "",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: [],
  });

  const withFinding = JSON.stringify({
    schema: "orch.result/reviewer/v1",
    verdict: "request_changes",
    findings: [{ body: "off-by-one in pager" }],
  });
  expect(extractResultFromText(withFinding, spec("reviewer", "flat-findings"))).toMatchObject({
    verdict: "request_changes",
    // Flattened findings surface as blocking so nothing is dropped.
    blocking_findings: [{ body: "off-by-one in pager", id: "finding-1", severity: "unspecified", file: "unspecified" }],
    non_blocking_findings: [],
  });

  // An approving reviewer's flattened findings are non-blocking nits: routing
  // them to blocking would flip the downstream suggestion to rework.
  const approvedNits = JSON.stringify({
    schema: "orch.result/reviewer/v1",
    verdict: "approve",
    findings: [{ body: "naming nit in pager" }],
  });
  expect(extractResultFromText(approvedNits, spec("reviewer", "flat-nits"))).toMatchObject({
    verdict: "approve",
    blocking_findings: [],
    non_blocking_findings: [{ body: "naming nit in pager" }],
  });
});

test("extractResultFromRunDir parses multi-line plain-text JSON", () => {
  const runDir = tempDir();
  const result = {
    schema: "orch.result/reviewer/v1",
    run_id: "plain-review",
    verdict: "approve",
    reviews_run_id: "plain-review",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: [],
  };
  // A plain-text provider may print pretty-printed JSON spanning multiple
  // lines (no native event wrapper); the whole stream is tried as one candidate.
  writeFileSync(join(runDir, "native.jsonl"), `Here is the review:\n${JSON.stringify(result, null, 2)}\n`);

  expect(extractResultFromRunDir(runDir, spec("reviewer", "plain-review"))).toEqual(result);
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

// Locks the candidate precedence of the normalizer-backed extraction: the
// claude final message beats assistant/codex decoys, and raw candidates from
// non-object JSON lines are tried but never accepted as results.
test("extractResultFromRunDir prefers the claude final message in a mixed native stream", () => {
  const runDir = tempDir();
  const winner = {
    schema: "orch.result/reviewer/v1",
    run_id: "review-mixed",
    verdict: "approve",
    reviews_run_id: "impl-a",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: [],
  };
  const decoy = { ...winner, verdict: "request_changes" };
  writeFileSync(
    join(runDir, "native.jsonl"),
    [
      "[1, 2, 3]",
      "plain text noise, not JSON",
      JSON.stringify({ type: "reasoning_delta", delta: "stream noise" }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(decoy) }] },
      }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(decoy) } }),
      JSON.stringify({ type: "result", result: JSON.stringify(winner) }),
      "",
    ].join("\n"),
    "utf8",
  );

  expect(extractResultFromRunDir(runDir, spec("reviewer", "review-mixed"))).toEqual(winner);
});

test("extractResultFromRunDir reads pi agent_end messages", () => {
  const runDir = tempDir();
  const reviewer = {
    schema: "orch.result/reviewer/v1",
    run_id: "review-pi-agent-end",
    verdict: "approve",
    reviews_run_id: "impl-a",
    blocking_findings: [],
    non_blocking_findings: [{ body: "parsed from pi agent_end messages" }],
    suggested_tests: ["bun test"],
  };
  writeFileSync(
    join(runDir, "native.jsonl"),
    `${JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "ignored" }] },
        { role: "assistant", content: [{ type: "text", text: JSON.stringify(reviewer) }] },
      ],
    })}\n`,
    "utf8",
  );

  expect(extractResultFromRunDir(runDir, spec("reviewer", "review-pi-agent-end"))).toEqual(reviewer);
});

test("extractResultFromRunDir accepts schema-key and partial reviewer wrappers", () => {
  const runDir = tempDir();
  const reviewer = {
    verdict: "approve",
    blocking_findings: [],
    non_blocking_findings: [],
    suggested_tests: ["bun test"],
  };
  const expected = {
    schema: "orch.result/reviewer/v1",
    run_id: "review-codex",
    reviews_run_id: "",
    ...reviewer,
  };
  writeFileSync(
    join(runDir, "native.jsonl"),
    `${JSON.stringify({ item: { type: "agent_message", text: JSON.stringify({ "orch.result/reviewer/v1": reviewer }) } })}\n`,
    "utf8",
  );

  expect(extractResultFromRunDir(runDir, spec("reviewer", "review-codex"))).toEqual(expected);
  const worktree = tempDir();
  writeFileSync(join(worktree, "reviewer-result.json"), JSON.stringify({ "orch.result/reviewer/v1": reviewer }), "utf8");
  expect(extractResultFromRunDir(tempDir(), { ...spec("reviewer", "review-codex"), worktree })).toBeNull();
  expect(extractResultFromText(JSON.stringify({ result: reviewer }), spec("reviewer", "review-codex"))).toEqual(expected);
  expect(extractResultFromText(JSON.stringify({ schema: "orch.result/reviewer/v1", run_id: "review-codex", ...reviewer }), spec("reviewer", "review-codex"))).toEqual(expected);
  expect(extractResultFromText(JSON.stringify({ metadata: reviewer }), spec("reviewer", "review-codex"))).toBeNull();
  // A model-invented run_id no longer rejects the result: candidates only come
  // from this run's own stream, so the spec's run_id is authoritative.
  expect(
    extractResultFromText(JSON.stringify({ schema: "orch.result/reviewer/v1", run_id: "old-run", ...reviewer }), spec("reviewer", "review-codex")),
  ).toEqual(expected);
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

test("extractResultFromText accepts a fenced gemini-style result with finding/scenario prose", () => {
  // Observed live from omp/gemini: the whole result inside a ```json fence,
  // findings carrying finding (title) + scenario (detail) instead of body.
  const raw = [
    "```json",
    JSON.stringify(
      {
        schema: "orch.result/reviewer/v1",
        verdict: "request_changes",
        blocking_findings: [
          { severity: "critical", file: "src/x.ts:1", finding: "Broken cooldown", scenario: "When X flaps, Y alerts forever." },
        ],
        non_blocking_findings: [{ severity: "low", file: "src/y.ts:2", finding: "Doc gap", scenario: "Z is undocumented." }],
        suggested_tests: [],
        reviews_run_id: "review-fenced",
      },
      null,
      2,
    ),
    "```",
    "",
  ].join("\n");

  const result = extractResultFromText(raw, spec("reviewer", "review-fenced"));
  expect(result).toMatchObject({
    verdict: "request_changes",
    blocking_findings: [
      { id: "finding-1", severity: "critical", file: "src/x.ts:1", body: "Broken cooldown\n\nWhen X flaps, Y alerts forever." },
    ],
    non_blocking_findings: [{ body: "Doc gap\n\nZ is undocumented." }],
  });
});
