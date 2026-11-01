// In-run resume of a claude session that ended on a transient API error
// (2026-11-01: three replays died on 14:10 ECONNRESET and were rerun from zero).
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_RESUME_PROMPT, apiResumeVerdict, buildProviderArgv, buildWorkerEnv, DEFAULT_CLAUDE_MAX_RETRIES, runProviderDriver } from "./driver-common.ts";
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
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-api-resume-"));
  tempDirs.push(dir);
  return dir;
}
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const SID = "0b7c6a52-1d0e-4c55-9b8e-3f6a1c2d4e5f";
function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    version: 1, run_id: "review-1", mr: "1", role: "reviewer", agent: "claude", model: null, tag: "review",
    provider_session_name: null, provider_session_id: null, provider_session_mode: "fresh_persistent",
    idempotency_key: "review-1", repo_key: "local/repo", worktree: "/tmp/repo", task_path: null, task_text: "review it",
    task_sha: "s", base_sha: "base", timeout_sec: 60, created_at: "2026-11-01T00:00:00.000Z", ...overrides,
  } as RunSpec;
}
const valid = JSON.stringify({ schema: "orch.result/reviewer/v1", verdict: "approve", reviews_run_id: "impl-1", blocking_findings: [], non_blocking_findings: [], suggested_tests: [] });
const usage = (n: number) => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const init = { type: "system", subtype: "init", session_id: SID };
const errorResult = (text: string, n = 1) => ({ type: "result", subtype: "success", is_error: true, result: text, session_id: SID, num_turns: 7, total_cost_usd: 0.5, usage: usage(n) });
const okResult = { type: "result", subtype: "success", is_error: false, result: valid, session_id: SID, num_turns: 3, total_cost_usd: 0.2, usage: usage(5) };
const ECONNRESET = "API Error: Connection dropped (ECONNRESET). Check the proxy or network.";

// Fake claude: call N prints calls[N-1] (the last entry repeats), records argv and stdin per call.
async function drive(calls: unknown[][], runSpec = spec()): Promise<{ code: number; runDir: string; argv: string[]; stdin: string[] }> {
  const root = tempDir();
  const runDir = join(root, "run"), binDir = join(root, "bin"), worktree = join(root, "wt");
  for (const dir of [runDir, binDir, worktree]) mkdirSync(dir);
  calls.forEach((lines, i) => writeFileSync(join(root, `call-${i + 1}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
  writeFileSync(join(binDir, "claude"), [
    "#!/bin/sh",
    `n=$(( $(cat ${q(join(root, "count"))} 2>/dev/null || echo 0) + 1 )); echo $n > ${q(join(root, "count"))}`,
    `printf '%s\\n' "$*" > ${q(root)}/argv-$n; cat > ${q(root)}/stdin-$n`,
    `f=${q(root)}/call-$n.jsonl; [ -e "$f" ] || f=${q(root)}/call-${calls.length}.jsonl`,
    `cat "$f"; grep -q 'No conversation found' "$f" && exit 1; exit 0`, "",
  ].join("\n"));
  chmodSync(join(binDir, "claude"), 0o755);
  const specPath = join(runDir, "spec.json");
  writeFileSync(specPath, JSON.stringify({ ...runSpec, worktree }));
  setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
  setEnv("ORCH_API_RESUME_DELAY_SEC", "0");
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

test("apiResumeVerdict: transient API errors resume; limits, auth and other errors do not", () => {
  const seg = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n");
  // Error texts seen in orch runs 2026-10-12..11-01.
  for (const text of [
    "API Error: Connection dropped (ECONNRESET)",
    ECONNRESET,
    "API Error: Request rejected (429) · Too many requests",
    "API Error: Can't reach the API server — check your internet connection",
    'API Error: 524 {"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/"}',
    "API Error: 529 Overloaded",
    "API Error: Request timed out.",
  ]) expect({ text, v: apiResumeVerdict(seg(init, errorResult(text))).resumable }).toEqual({ text, v: true });
  for (const [text, reason] of [
    ["You've hit your weekly limit · resets Nov 4 at 10am (Asia/Singapore)", "not_transient"],
    ["You've reached your Fable limit. Switch to another model, or wait.", "not_transient"],
    ["Not logged in · Please run /login", "not_transient"],
    ["API Error: 400 prompt is too long: 1000512 tokens > 1000000 maximum", "not_transient"],
    ["API Error: 401 authentication_error", "not_transient"],
  ]) expect({ text, r: apiResumeVerdict(seg(init, errorResult(text))).reason }).toEqual({ text, r: reason });
  expect(apiResumeVerdict(seg(init, okResult)).reason).toBe("no_error");
  expect(apiResumeVerdict(seg(init)).reason).toBe("no_result");
  // The last envelope decides: a success after an earlier error is not resumed.
  expect(apiResumeVerdict(seg(init, errorResult(ECONNRESET), okResult)).resumable).toBe(false);
  const lost = apiResumeVerdict(seg({ type: "result", is_error: true, errors: [`No conversation found with session ID: ${SID}`] }));
  expect(lost).toMatchObject({ resumable: false, reason: "session_lost" });
  expect(apiResumeVerdict(seg(init, errorResult(ECONNRESET)))).toMatchObject({ num_turns: 7, cost_usd: 0.5 });
});

test("driver: an ECONNRESET end resumes the same session in the same run and delivers the resumed answer", async () => {
  const { code, runDir, argv, stdin } = await drive([[init, errorResult(ECONNRESET)], [init, okResult]]);
  expect(code).toBe(0);
  expect(argv).toHaveLength(2);
  expect(argv[0]).not.toContain("--resume");
  expect(argv[1]).toContain(`--resume ${SID}`);
  expect(argv[1]).not.toContain("--no-session-persistence");
  expect(stdin[1]).toBe(API_RESUME_PROMPT);
  expect(stdin[0]).toContain("review it");
  expect(resultOf(runDir)).toMatchObject({ verdict: "approve" });
  expect(readFileSync(join(runDir, "exit_code"), "utf8").trim()).toBe("0");
  const resume = events(runDir).filter((e) => e.type === "api_resume");
  expect(resume).toEqual([expect.objectContaining({ attempt: 1, max: 5, session_id: SID, error: ECONNRESET, prev_num_turns: 7, prev_cost_usd: 0.5 })]);
  const native = readFileSync(join(runDir, "native.jsonl"), "utf8");
  expect(native).toContain('"type":"orch_api_resume","attempt":1');
  // usage: both claude processes are counted.
  expect(usageEvidence(native, spec(), { state: "done" } as never).normalized_tokens?.output_tokens).toBe(6);
  expect(usageEvidence(native, spec(), { state: "done" } as never).response_observations.repair_attempts).toBe(0);
});

test("driver: a resume_exact run resumes its own session id", async () => {
  const other = "11111111-2222-4333-8444-555555555555";
  const { argv } = await drive([[{ ...init, session_id: other }, errorResult(ECONNRESET)], [okResult]], spec({ provider_session_mode: "resume_exact", provider_session_id: other }));
  expect(argv[0]).toContain(`--resume ${other}`);
  expect(argv[1]).toContain(`--resume ${other}`);
});

test("driver: resumes stop at ORCH_API_RESUME_MAX and the run fails with the record", async () => {
  setEnv("ORCH_API_RESUME_MAX", "2");
  const { code, runDir, argv } = await drive([[init, errorResult(ECONNRESET)]]);
  expect(argv).toHaveLength(3);
  expect(code).not.toBe(0);
  expect(events(runDir).filter((e) => e.type === "api_resume").map((e) => e.attempt)).toEqual([1, 2]);
  expect(events(runDir).find((e) => e.type === "api_resume_stopped")).toMatchObject({ attempt: 2, reason: "max_attempts" });
  expect(resultOf(runDir).verdict).not.toBe("approve");
});

test("driver: ORCH_API_RESUME_MAX=0 disables the resume", async () => {
  setEnv("ORCH_API_RESUME_MAX", "0");
  const { argv, runDir } = await drive([[init, errorResult(ECONNRESET)], [init, okResult]]);
  expect(argv).toHaveLength(1);
  expect(events(runDir).find((e) => e.type === "api_resume_stopped")).toMatchObject({ reason: "disabled" });
});

test("driver: a usage limit is not resumed (loopx resumes it after the reset)", async () => {
  const { argv, runDir, code } = await drive([[init, errorResult("You've hit your session limit · resets 5pm (Asia/Singapore)")], [init, okResult]]);
  expect(argv).toHaveLength(1);
  expect(code).not.toBe(0);
  expect(events(runDir).some((e) => String(e.type).startsWith("api_resume"))).toBe(false);
});

test("driver: a lost session stops the resume and says so", async () => {
  const { argv, runDir, code } = await drive([[init, errorResult(ECONNRESET)], [{ type: "result", is_error: true, errors: [`No conversation found with session ID: ${SID}`] }]]);
  expect(argv).toHaveLength(2);
  expect(code).not.toBe(0);
  expect(events(runDir).find((e) => e.type === "api_resume_stopped")).toMatchObject({ attempt: 1, reason: "session_lost" });
});

test("driver: an ephemeral run has no session to resume", async () => {
  const { argv } = await drive([[init, errorResult(ECONNRESET)], [init, okResult]], spec({ provider_session_mode: "ephemeral" }));
  expect(argv).toHaveLength(1);
  expect(argv[0]).toContain("--no-session-persistence");
});

test("nativeResult: the segment after an orch_api_resume marker decides the outcome", () => {
  const text = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n");
  expect(nativeResult(text(init, errorResult(ECONNRESET), { type: "orch_api_resume", attempt: 1 }, init, okResult))).toMatchObject({ failed: false, text: valid });
  expect(nativeResult(text(init, errorResult(ECONNRESET), { type: "orch_api_resume", attempt: 1 }, init, errorResult(ECONNRESET))).failed).toBe(true);
  // a resumed segment killed before any result is not a success
  expect(nativeResult(text(init, errorResult(ECONNRESET), { type: "orch_api_resume", attempt: 1 }, init)).text).toBeNull();
});

test("session persistence: only ephemeral runs pass --no-session-persistence; claude workers get CLAUDE_CODE_MAX_RETRIES", () => {
  for (const role of ["implementer", "reviewer", "verifier", "researcher"] as const) {
    for (const mode of ["fresh_persistent", "resume_exact"] as const) {
      const argv = buildProviderArgv("claude", spec({ role, provider_session_mode: mode, provider_session_id: mode === "resume_exact" ? SID : null }), "/tmp/run", "/tmp/wt");
      expect({ role, mode, flag: argv.includes("--no-session-persistence") }).toEqual({ role, mode, flag: false });
    }
  }
  expect(buildProviderArgv("claude", spec({ provider_session_mode: "ephemeral" }), "/tmp/run", "/tmp/wt")).toContain("--no-session-persistence");
  expect(buildWorkerEnv({ PATH: "/bin" }).CLAUDE_CODE_MAX_RETRIES).toBe(String(DEFAULT_CLAUDE_MAX_RETRIES));
  expect(buildWorkerEnv({ PATH: "/bin", CLAUDE_CODE_MAX_RETRIES: "4" }).CLAUDE_CODE_MAX_RETRIES).toBe("4");
});
