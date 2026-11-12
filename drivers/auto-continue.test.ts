// In-run continuation of a claude session whose turn ended in text only,
// without a result JSON (2026-10-28..11-12: six such runs, all "still waiting
// for the sub-agent" / "next message writes section 4" reports, ended failed).
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_RESUME_PROMPT, AUTO_CONTINUE_MAX_DEFAULT, autoContinueLimit, autoContinuePrompt, buildPrompt, runProviderDriver } from "./driver-common.ts";
import { nativeResult } from "../src/native-result.ts";
import { usageEvidence } from "../src/usage-evidence.ts";
import type { RunSpec } from "../src/types.ts";

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const SID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    version: 1, run_id: "design-1", mr: "1", role: "researcher", agent: "claude", model: null, tag: "design",
    provider_session_name: null, provider_session_id: null, provider_session_mode: "fresh_persistent",
    idempotency_key: "design-1", repo_key: "local/repo", worktree: "/tmp/repo", task_path: null, task_text: "design it",
    task_sha: "s", base_sha: "base", timeout_sec: 60, created_at: "2026-11-12T00:00:00.000Z", ...overrides,
  } as RunSpec;
}
const research = JSON.stringify({ schema: "orch.result/researcher/v1", run_id: "design-1", verdict: "completed", summary: "s", recommendation: "r" });
const review = JSON.stringify({ schema: "orch.result/reviewer/v1", verdict: "approve", reviews_run_id: "impl-1", blocking_findings: [], non_blocking_findings: [], suggested_tests: [] });
const usage = (n: number) => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const init = { type: "system", subtype: "init", session_id: SID };
const result = (text: string, n = 1) => ({ type: "result", subtype: "success", is_error: false, result: text, session_id: SID, num_turns: 4, total_cost_usd: 0.3, usage: usage(n) });
const REPORT = "The reviewer sub-agent is still running. I'll wait for its notification before delivering.";
const ECONNRESET = "API Error: Connection dropped (ECONNRESET). Check the proxy or network.";

// Fake claude: call N prints calls[N-1] (the last entry repeats), records argv and stdin per call.
async function drive(calls: unknown[][], runSpec = spec(), autoContinueMax?: string): Promise<{ code: number; runDir: string; argv: string[]; stdin: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "orch-auto-continue-"));
  tempDirs.push(root);
  const runDir = join(root, "run"), binDir = join(root, "bin"), worktree = join(root, "wt");
  for (const dir of [runDir, binDir, worktree]) mkdirSync(dir);
  calls.forEach((lines, i) => writeFileSync(join(root, `call-${i + 1}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
  writeFileSync(join(binDir, "claude"), [
    "#!/bin/sh",
    `n=$(( $(cat ${q(join(root, "count"))} 2>/dev/null || echo 0) + 1 )); echo $n > ${q(join(root, "count"))}`,
    `printf '%s\\n' "$*" > ${q(root)}/argv-$n; cat > ${q(root)}/stdin-$n`,
    `f=${q(root)}/call-$n.jsonl; [ -e "$f" ] || f=${q(root)}/call-${calls.length}.jsonl`,
    `cat "$f"; exit 0`, "",
  ].join("\n"));
  chmodSync(join(binDir, "claude"), 0o755);
  const specPath = join(runDir, "spec.json");
  writeFileSync(specPath, JSON.stringify({ ...runSpec, worktree }));
  setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
  setEnv("ORCH_API_RESUME_DELAY_SEC", "0");
  setEnv("ORCH_AUTO_CONTINUE_MAX", autoContinueMax);
  setEnv("ORCH_RESULT_REPAIR", undefined);
  const code = await runProviderDriver("claude", ["--spec", specPath, "--run-dir", runDir, "--worktree", worktree]);
  const count = Number(readFileSync(join(root, "count"), "utf8"));
  const argv = [], stdin = [];
  for (let i = 1; i <= count; i++) {
    argv.push(readFileSync(join(root, `argv-${i}`), "utf8").trim());
    stdin.push(readFileSync(join(root, `stdin-${i}`), "utf8"));
  }
  return { code, runDir, argv, stdin };
}
const events = (runDir: string) => readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const resultOf = (runDir: string) => JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));

test("a turn that ends in prose is continued in the same session and its result delivered", async () => {
  const { code, runDir, argv, stdin } = await drive([[init, result(REPORT)], [init, result(research, 5)]]);
  expect(code).toBe(0);
  expect(argv).toHaveLength(2);
  // Same plan, only the session is resumed: the cached prefix (system prompt, tools, model, effort) is unchanged.
  expect(argv[1]).toBe(`${argv[0]} --resume ${SID}`);
  expect(stdin[0]).toContain("design it");
  expect(stdin[1]).toBe(autoContinuePrompt(spec()));
  expect(resultOf(runDir)).toMatchObject({ verdict: "completed", recommendation: "r" });
  const ev = events(runDir);
  expect(ev.filter((e) => e.type === "auto_continue")).toEqual([
    expect.objectContaining({ attempt: 1, max: AUTO_CONTINUE_MAX_DEFAULT, session_id: SID, missing: "result_json", final_turn_excerpt: REPORT }),
  ]);
  expect(ev.find((e) => e.type === "auto_continue_stopped")).toMatchObject({ attempt: 1, reason: "result_delivered" });
  expect(ev.some((e) => e.type === "result_repair")).toBe(false);
  const native = readFileSync(join(runDir, "native.jsonl"), "utf8");
  expect(native).toContain('"type":"orch_auto_continue","attempt":1');
  // usage: both claude processes are counted.
  expect(usageEvidence(native, spec(), { state: "done" } as never).normalized_tokens?.output_tokens).toBe(6);
});

test("continuations stop at the default limit of 2, then the repair round runs as before", async () => {
  const { code, runDir, argv } = await drive([[init, result(REPORT)]]);
  // first turn + 2 continuations + 1 ephemeral repair round
  expect(argv).toHaveLength(4);
  expect(argv[1]).toContain(`--resume ${SID}`);
  expect(argv[2]).toContain(`--resume ${SID}`);
  expect(argv[3]).toContain("--no-session-persistence");
  expect(code).not.toBe(0);
  const ev = events(runDir);
  expect(ev.filter((e) => e.type === "auto_continue").map((e) => e.attempt)).toEqual([1, 2]);
  expect(ev.find((e) => e.type === "auto_continue_stopped")).toMatchObject({ attempt: 2, reason: "max_attempts" });
  expect(ev.find((e) => e.type === "result_repair")).toMatchObject({ outcome: "invalid" });
});

test("ORCH_AUTO_CONTINUE_MAX sets the limit; 0 disables", async () => {
  setEnv("ORCH_AUTO_CONTINUE_MAX", "0");
  expect(autoContinueLimit("claude", spec())).toBe(0);
  setEnv("ORCH_AUTO_CONTINUE_MAX", "3");
  expect(autoContinueLimit("claude", spec())).toBe(3);
  setEnv("ORCH_AUTO_CONTINUE_MAX", "x");
  expect(autoContinueLimit("claude", spec())).toBe(AUTO_CONTINUE_MAX_DEFAULT);
});

test("ORCH_AUTO_CONTINUE_MAX=0: no continuation, the repair round handles the prose answer", async () => {
  const { argv, runDir } = await drive([[init, result(REPORT)], [init, result(research)]], spec(), "0");
  expect(argv).toHaveLength(2);
  expect(argv[1]).toContain("--no-session-persistence");
  expect(events(runDir).find((e) => e.type === "auto_continue_stopped")).toMatchObject({ attempt: 0, reason: "disabled" });
  expect(events(runDir).some((e) => e.type === "auto_continue")).toBe(false);
});

test("a malformed result attempt is not continued: the repair round fixes its shape", async () => {
  const malformed = JSON.stringify({ schema: "orch.result/researcher/v1", verdict: "completed", summary: "s" });
  const { argv, runDir } = await drive([[init, result(malformed)], [init, result(research)]]);
  expect(argv).toHaveLength(2);
  expect(argv[1]).toContain("--no-session-persistence");
  expect(events(runDir).some((e) => String(e.type).startsWith("auto_continue"))).toBe(false);
  expect(events(runDir).find((e) => e.type === "result_repair")).toMatchObject({ outcome: "valid" });
});

test("a result in a code fence with text around it is delivered without a continuation", async () => {
  const { argv, runDir } = await drive([[init, result(`Done.\n\n\`\`\`json\n${research}\n\`\`\`\n`)]]);
  expect(argv).toHaveLength(1);
  expect(resultOf(runDir)).toMatchObject({ verdict: "completed" });
  expect(events(runDir).some((e) => String(e.type).startsWith("auto_continue"))).toBe(false);
});

test("implementer and verifier are continued; reviewer, controller and ephemeral runs are not", async () => {
  for (const role of ["implementer", "verifier", "researcher"] as const) expect(autoContinueLimit("claude", spec({ role }))).toBe(AUTO_CONTINUE_MAX_DEFAULT);
  for (const role of ["reviewer", "controller"] as const) expect(autoContinueLimit("claude", spec({ role }))).toBeNull();
  expect(autoContinueLimit("claude", spec({ provider_session_mode: "ephemeral" }))).toBeNull();
  for (const provider of ["codex", "pi", "omp", "agy"] as const) expect(autoContinueLimit(provider, spec())).toBeNull();

  const reviewer = await drive([[init, result(REPORT)], [init, result(review)]], spec({ role: "reviewer", tag: "review" }));
  expect(reviewer.argv).toHaveLength(2);
  expect(reviewer.argv[1]).toContain("--no-session-persistence");
  const ephemeral = await drive([[init, result(REPORT)], [init, result(research)]], spec({ provider_session_mode: "ephemeral" }));
  expect(ephemeral.argv).toHaveLength(2);
  expect(ephemeral.argv[1]).toContain("--no-session-persistence");
});

test("a resume_exact run continues its own session id", async () => {
  const other = "11111111-2222-4333-8444-555555555555";
  const { argv } = await drive([[{ ...init, session_id: other }, result(REPORT)], [result(research)]], spec({ provider_session_mode: "resume_exact", provider_session_id: other }));
  expect(argv).toHaveLength(2);
  expect(argv[1]).toContain(`--resume ${other}`);
});

test("a continuation cut off by a transient API error is resumed, then delivers", async () => {
  const apiError = { type: "result", subtype: "success", is_error: true, result: ECONNRESET, session_id: SID, usage: usage(1) };
  const { code, runDir, stdin } = await drive([[init, result(REPORT)], [init, apiError], [init, result(research)]]);
  expect(code).toBe(0);
  expect(stdin[1]).toBe(autoContinuePrompt(spec()));
  expect(stdin[2]).toBe(API_RESUME_PROMPT);
  expect(resultOf(runDir)).toMatchObject({ verdict: "completed" });
  expect(events(runDir).filter((e) => e.type === "api_resume")).toEqual([expect.objectContaining({ attempt: 1 })]);
});

test("a failed provider is not continued", async () => {
  const { argv } = await drive([[init, { type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: SID }]]);
  expect(argv).toHaveLength(1);
});

test("the continuation message names the schema and the failure verdict, and adds nothing else to the session", () => {
  expect(autoContinuePrompt(spec())).toContain('"schema": "orch.result/researcher/v1"');
  expect(autoContinuePrompt(spec())).toContain('verdict "failed"');
  expect(autoContinuePrompt(spec({ role: "verifier" }))).toContain('"schema": "orch.result/verifier/v1"');
  expect(autoContinuePrompt(spec({ role: "verifier" }))).toContain('verdict "fail"');
});

test("nativeResult: the segment after an orch_auto_continue marker decides the outcome", () => {
  const text = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n");
  expect(nativeResult(text(init, result(REPORT), { type: "orch_auto_continue", attempt: 1 }, init, result(research))).text).toBe(research);
  expect(nativeResult(text(init, result(REPORT), { type: "orch_auto_continue", attempt: 1 }, init)).text).toBeNull();
});

test("researcher prompt asks for writing to a low-context reader; other roles do not get it", () => {
  const researcher = buildPrompt(spec(), "claude");
  expect(researcher).toContain("写给低上下文读者");
  expect(researcher).toContain("结论放最前面");
  expect(researcher).toContain("不用调研中自己起的术语、代号和缩写");
  expect(researcher).toContain("短句和主动语态");
  expect(researcher).toContain("只有真正并列的项");
  for (const role of ["implementer", "verifier", "reviewer", "controller"] as const) {
    expect({ role, has: buildPrompt(spec({ role }), "claude").includes("写给低上下文读者") }).toEqual({ role, has: false });
  }
});
