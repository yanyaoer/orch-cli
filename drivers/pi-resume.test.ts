// In-run resume of a pi session whose model request failed after pi's own
// retries (2026-11-18 !1105 verifier r3: "Upstream error" 40 min into the
// suites; pi exited 0, orch found no result and the round was rerun from zero).
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_RESUME_PROMPT, piResumeVerdict, runProviderDriver } from "./driver-common.ts";
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

const SID = "01a1ed16-129f-77fb-b156-bc449962cd97";
function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    version: 1, run_id: "verifier-1", mr: "1", role: "verifier", agent: "pi", model: null, tag: "verifier",
    provider_session_name: null, provider_session_id: null, provider_session_mode: "fresh_persistent",
    idempotency_key: "verifier-1", repo_key: "local/repo", worktree: "/tmp/repo", task_path: null, task_text: "verify it",
    task_sha: "s", base_sha: "base", timeout_sec: 60, created_at: "2026-11-18T00:00:00.000Z", ...overrides,
  } as RunSpec;
}
const valid = JSON.stringify({
  schema: "orch.result/verifier/v1", run_id: "verifier-1", verdict: "pass", verifies_run_id: "impl-1",
  commands: [{ cmd: "make smoke", exit_code: 0, status: "passed", summary: "ok" }],
  acceptance: [{ id: "AC1", status: "met", evidence: "smoke" }],
});
const session = { type: "session", version: 3, id: SID, cwd: "/wt" };
const assistant = (extra: Record<string, unknown>, text = "") => ({
  role: "assistant", content: text ? [{ type: "text", text }] : [], api: "openai-responses", provider: "mify-response", model: "m", ...extra,
});
const failedTurn = (errorMessage: string) => [
  session,
  { type: "turn_start" },
  { type: "message_end", message: assistant({ stopReason: "error", errorMessage }) },
  { type: "turn_end", message: assistant({ stopReason: "error", errorMessage }) },
  { type: "agent_end", messages: [assistant({ stopReason: "error", errorMessage })], willRetry: false },
];
const okTurn = [
  session,
  { type: "message_end", message: assistant({ stopReason: "stop" }, valid) },
  { type: "turn_end", message: assistant({ stopReason: "stop" }, valid) },
  { type: "agent_end", messages: [assistant({ stopReason: "stop" }, valid)] },
];

// Fake pi: call N prints calls[N-1] (the last entry repeats) and exits 0 like pi does.
async function drive(calls: unknown[][], runSpec = spec()): Promise<{ code: number; runDir: string; argv: string[]; stdin: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "orch-pi-resume-"));
  tempDirs.push(root);
  const runDir = join(root, "run"), binDir = join(root, "bin"), worktree = join(root, "wt");
  for (const dir of [runDir, binDir, worktree]) mkdirSync(dir);
  calls.forEach((lines, i) => writeFileSync(join(root, `call-${i + 1}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));
  writeFileSync(join(binDir, "pi"), [
    "#!/bin/sh",
    `n=$(( $(cat ${q(join(root, "count"))} 2>/dev/null || echo 0) + 1 )); echo $n > ${q(join(root, "count"))}`,
    `printf '%s\\n' "$*" > ${q(root)}/argv-$n; cat > ${q(root)}/stdin-$n`,
    `f=${q(root)}/call-$n.jsonl; [ -e "$f" ] || f=${q(root)}/call-${calls.length}.jsonl`,
    `cat "$f"; exit 0`, "",
  ].join("\n"));
  chmodSync(join(binDir, "pi"), 0o755);
  const specPath = join(runDir, "spec.json");
  writeFileSync(specPath, JSON.stringify({ ...runSpec, worktree }));
  setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
  setEnv("ORCH_API_RESUME_DELAY_SEC", "0");
  const code = await runProviderDriver("pi", ["--spec", specPath, "--run-dir", runDir, "--worktree", worktree]);
  const count = Number(readFileSync(join(root, "count"), "utf8"));
  const argv: string[] = [], stdin: string[] = [];
  for (let i = 1; i <= count; i++) {
    argv.push(readFileSync(join(root, `argv-${i}`), "utf8").trim());
    stdin.push(readFileSync(join(root, `stdin-${i}`), "utf8"));
  }
  return { code, runDir, argv, stdin };
}
const events = (runDir: string) => readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const resultOf = (runDir: string) => JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
const segment = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n");

test("piResumeVerdict: a transient model error on the last assistant message resumes; auth, quota and context do not", () => {
  for (const error of ["Upstream error", "Request timed out.", "Connection error.", "fetch failed", "429 Too many requests", "503 Service Unavailable", "terminated"]) {
    expect(piResumeVerdict(segment(failedTurn(error)))).toMatchObject({ resumable: true, error, reason: null });
  }
  // Auth/quota/context errors stay failed even when the text also looks transient.
  for (const error of ["401 invalid api key", "403 Forbidden", "403 Forbidden: Upstream error", "insufficient_quota (429)", "context length exceeded", "No models match mimo"]) {
    expect(piResumeVerdict(segment(failedTurn(error)))).toMatchObject({ resumable: false, reason: "not_transient" });
  }
  expect(piResumeVerdict(segment(okTurn))).toMatchObject({ resumable: false, reason: "no_error" });
  expect(piResumeVerdict(segment([session]))).toMatchObject({ resumable: false, reason: "no_result" });
  // An error earlier in the segment does not count once a later turn stopped normally.
  expect(piResumeVerdict(segment([...failedTurn("Upstream error"), ...okTurn]))).toMatchObject({ resumable: false, reason: "no_error" });
});

test("driver: a pi run that ends on Upstream error resumes its session in the same run and delivers the answer", async () => {
  const { code, runDir, argv, stdin } = await drive([failedTurn("Upstream error"), okTurn]);
  expect(code).toBe(0);
  expect(argv).toHaveLength(2);
  expect(argv[0]).not.toContain("--no-session");
  expect(argv[0]).not.toContain("--session-id");
  expect(argv[1]).toContain(`--session-id ${SID}`);
  expect(stdin[0]).toContain("verify it");
  expect(stdin[1]).toBe(API_RESUME_PROMPT);
  expect(resultOf(runDir)).toMatchObject({ verdict: "pass" });
  expect(events(runDir).filter((e) => e.type === "api_resume")).toEqual([
    expect.objectContaining({ attempt: 1, session_id: SID, error: "Upstream error", prev_exit_code: 0 }),
  ]);
  expect(readFileSync(join(runDir, "native.jsonl"), "utf8")).toContain('"type":"orch_api_resume","attempt":1');
});

test("driver: pi resumes stop at ORCH_API_RESUME_MAX", async () => {
  setEnv("ORCH_API_RESUME_MAX", "2");
  const { argv, runDir } = await drive([failedTurn("Upstream error")]);
  expect(argv).toHaveLength(3);
  expect(events(runDir).find((e) => e.type === "api_resume_stopped")).toMatchObject({ attempt: 2, reason: "max_attempts" });
  expect(resultOf(runDir).verdict).not.toBe("pass");
});

test("driver: a non-transient pi error and an ephemeral pi run are not resumed", async () => {
  const auth = await drive([failedTurn("401 invalid api key"), okTurn]);
  expect(auth.argv).toHaveLength(1);
  expect(events(auth.runDir).some((e) => String(e.type).startsWith("api_resume"))).toBe(false);
  const ephemeral = await drive([failedTurn("Upstream error"), okTurn], spec({ provider_session_mode: "ephemeral" }));
  expect(ephemeral.argv).toHaveLength(1);
  expect(ephemeral.argv[0]).toContain("--no-session");
});
