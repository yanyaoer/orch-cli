import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProviderArgv, repairPreservesVerdict, previousVerdictOf } from "../drivers/driver-common.ts";
import { readCodexBaseline } from "./codex-baseline.ts";
import { nativeResult } from "./native-result.ts";
import { roleJsonSchema, stripNulls, validateRoleResult } from "./schema.ts";
import type { RoleResult, RunRole, RunSpec } from "./types.ts";
import { usageEvidence } from "./usage-evidence.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_NATIVE_SCHEMA;
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-result-contract-"));
  tempDirs.push(dir);
  return dir;
}

function spec(role: RunRole, extra: Partial<RunSpec> = {}): RunSpec {
  return {
    version: 1, run_id: `${role}-1`, mr: "1", role, agent: "claude", model: null, tag: role,
    provider_session_name: null, provider_session_id: null, provider_session_mode: "fresh_persistent",
    idempotency_key: "k", repo_key: "local/repo", worktree: "/tmp/repo", task_path: null, task_text: "t",
    task_sha: "s", base_sha: "base", timeout_sec: 60, created_at: "2026-10-20T00:00:00.000Z", ...extra,
  };
}

// Minimal structural check of the subset roleJsonSchema uses.
function fits(schema: any, value: unknown, path = "$"): string[] {
  const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (!types.includes(kind) && !(kind === "integer" && types.includes("number"))) return [`${path}: ${kind} not in ${types.join("|")}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: ${String(value)} not in enum`];
  if (kind === "array") return (value as unknown[]).flatMap((item, i) => fits(schema.items, item, `${path}[${i}]`));
  if (kind === "object") {
    const obj = value as Record<string, unknown>;
    const errors = schema.required.filter((key: string) => !(key in obj)).map((key: string) => `${path}.${key} missing`);
    for (const key of Object.keys(obj)) {
      if (!(key in schema.properties)) errors.push(`${path}.${key} not allowed`);
      else errors.push(...fits(schema.properties[key], obj[key], `${path}.${key}`));
    }
    return errors;
  }
  return [];
}

function walkObjects(schema: any, visit: (node: any) => void): void {
  if (!schema || typeof schema !== "object") return;
  visit(schema);
  for (const value of Object.values(schema)) walkObjects(value, visit);
}

const STRICT_SAMPLES: Record<RunRole, Record<string, unknown>> = {
  implementer: {
    schema: "orch.result/implementer/v1", run_id: "implementer-1", verdict: "completed", summary: "s", base_sha: "a", head_sha: "b",
    changed_files: ["x.ts"], tests: [
      { cmd: "bun test", exit_code: 1, status: "failed", phase: "before_change", summary: "red check", optional: null },
      { cmd: "bun test", exit_code: 0, status: "passed", phase: "after_change", summary: "ok", optional: null },
      { cmd: "make all", exit_code: null, status: "skipped", phase: "after_change", summary: "not run", optional: null },
    ],
    acceptance: [{ id: "AC1", status: "met", evidence: null, optional: null }], risks: [], rollback: "git revert b",
  },
  reviewer: {
    schema: "orch.result/reviewer/v1", run_id: "reviewer-1", verdict: "approve", reviews_run_id: "",
    blocking_findings: [], non_blocking_findings: [{ id: null, severity: null, file: null, body: "nit" }], suggested_tests: [],
  },
  controller: { schema: "orch.result/controller/v1", run_id: "controller-1", verdict: "completed", summary: "s", actions: [] },
  researcher: {
    schema: "orch.result/researcher/v1", run_id: "researcher-1", verdict: "completed", summary: "s", recommendation: "r",
    alternatives: [], sources: [], open_questions: [], risks: [],
  },
  verifier: {
    schema: "orch.result/verifier/v1", run_id: "verifier-1", verdict: "pass", verifies_run_id: "impl-1",
    commands: [{ cmd: "x --bad", exit_code: 2, status: "passed", summary: "rejected", expected_exit_code: 2, optional: null }],
    acceptance: [{ id: "AC1", status: "met", evidence: "seen", optional: null }], non_blocking_findings: null,
  },
};

test("roleJsonSchema is strict-mode shaped and agrees with validateRoleResult", () => {
  for (const role of Object.keys(STRICT_SAMPLES) as RunRole[]) {
    const schema = roleJsonSchema(role);
    walkObjects(schema, (node) => {
      for (const banned of ["oneOf", "allOf", "anyOf", "if", "then"]) expect(node[banned]).toBeUndefined();
      if (node.type === "object") {
        expect(node.additionalProperties).toBe(false);
        expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
      }
    });
    const sample = STRICT_SAMPLES[role];
    expect(fits(schema, sample)).toEqual([]);
    expect(validateRoleResult(role, stripNulls(sample)).errors).toEqual([]);
  }
});

test("stripNulls drops absent-as-null fields but keeps a skipped check's exit_code null", () => {
  expect(stripNulls({ a: null, b: [{ exit_code: null, optional: null, c: 1 }] })).toEqual({ b: [{ exit_code: null, c: 1 }] });
});

test("implementer tests cannot launder a failure through a non-zero expected_exit_code", () => {
  const laundered = { ...STRICT_SAMPLES.implementer, tests: [{ cmd: "bun test", exit_code: 1, expected_exit_code: 1, status: "passed", summary: "1 fail" }] };
  expect(validateRoleResult("implementer", laundered).errors).toContain(
    "tests[0].expected_exit_code must be 0 for implementer tests (write a negative check so success exits 0, e.g. `! cmd`)",
  );
  expect("expected_exit_code" in (roleJsonSchema("implementer") as any).properties.tests.items.properties).toBe(false);
  // Verifier negative checks keep working.
  expect(validateRoleResult("verifier", stripNulls(STRICT_SAMPLES.verifier)).ok).toBe(true);
});

test("a red check fails before the change only when the same cmd passed after it", () => {
  const impl = stripNulls(STRICT_SAMPLES.implementer) as Record<string, unknown>;
  expect(validateRoleResult("implementer", impl).ok).toBe(true);
  const red = { cmd: "bun test", exit_code: 1, status: "failed", phase: "before_change", summary: "red" };
  // Relabeling a real failure as a red check, with no passing run after the change, is still a contradiction.
  expect(validateRoleResult("implementer", { ...impl, tests: [red] }).errors).toContain("verdict completed contradicts tests[0] (failed: bun test)");
  expect(validateRoleResult("implementer", { ...impl, tests: [red, { ...red, phase: "after_change" }] }).ok).toBe(false);
  expect(validateRoleResult("implementer", { ...impl, tests: [{ ...red, phase: "later" }] }).errors).toContain("tests[0].phase must be before_change|after_change");
  expect(validateRoleResult("verifier", { ...(stripNulls(STRICT_SAMPLES.verifier) as object), commands: [{ cmd: "x", exit_code: 0, status: "passed", summary: "s", phase: "after_change" }] }).errors).toContain("commands[0].phase is only for implementer tests");
  // The repair gate agrees: a proven red check does not block keeping "completed".
  expect(repairPreservesVerdict(JSON.stringify(STRICT_SAMPLES.implementer), impl as unknown as RoleResult, spec("implementer"))).toBe(true);
});

test("verifier non_blocking_findings is optional, validated, and never affects the verdict", () => {
  const base = stripNulls(STRICT_SAMPLES.verifier) as Record<string, unknown>;
  expect("non_blocking_findings" in base).toBe(false);
  const nits = { ...base, non_blocking_findings: [{ severity: "nit", file: "a.ts:1", body: "rename" }, { severity: "pre-existing", body: "old bug" }] };
  expect(validateRoleResult("verifier", nits).ok).toBe(true);
  expect(validateRoleResult("verifier", { ...nits, verdict: "fail" }).ok).toBe(true);
  expect(validateRoleResult("verifier", { ...base, non_blocking_findings: [{ severity: "nit" }] }).errors).toContain("non_blocking_findings[0].body is required");
  expect(validateRoleResult("verifier", { ...base, non_blocking_findings: "none" }).errors).toContain("non_blocking_findings must be an array");
  expect(fits(roleJsonSchema("verifier"), { ...STRICT_SAMPLES.verifier, non_blocking_findings: [{ id: null, severity: "nit", file: null, body: "x" }] })).toEqual([]);
  // A repair of a pass that only carries nits is not a contradiction.
  expect(repairPreservesVerdict(JSON.stringify(nits), nits as unknown as RoleResult, spec("verifier"))).toBe(true);
});

test("repair may downgrade to the failure verdict but never upgrade", () => {
  const s = spec("implementer");
  const contradictory = JSON.stringify({ ...STRICT_SAMPLES.implementer, tests: [{ cmd: "bun test", exit_code: 1, status: "failed", summary: "1 fail" }] });
  const failed = { ...(stripNulls(STRICT_SAMPLES.implementer) as object), verdict: "failed", tests: [{ cmd: "bun test", exit_code: 1, status: "failed", summary: "1 fail" }] } as unknown as RoleResult;
  expect(repairPreservesVerdict(contradictory, failed, s)).toBe(true);
  expect(previousVerdictOf(contradictory, s)).toBe("completed");
  const completed = { ...(stripNulls(STRICT_SAMPLES.implementer) as object) } as unknown as RoleResult;
  expect(repairPreservesVerdict(JSON.stringify({ ...STRICT_SAMPLES.implementer, verdict: "failed" }), completed, s)).toBe(false);
  expect(repairPreservesVerdict("I'll start by reading the code", completed, s)).toBe(false);
  for (const [role, failure] of [["verifier", "fail"], ["reviewer", "request_changes"]] as const) {
    const success = JSON.stringify(STRICT_SAMPLES[role]);
    expect(repairPreservesVerdict(success, { ...STRICT_SAMPLES[role], verdict: failure } as unknown as RoleResult, spec(role))).toBe(true);
  }
});

test("claude structured_output wins over prose; null falls back to the text path", () => {
  const structured = { schema: "orch.result/controller/v1", run_id: "c", verdict: "completed", summary: "s", actions: [], extra: null };
  const line = (o: unknown) => JSON.stringify(o);
  expect(nativeResult(line({ type: "result", is_error: false, result: "prose", structured_output: structured })).text).toBe(
    JSON.stringify({ schema: "orch.result/controller/v1", run_id: "c", verdict: "completed", summary: "s", actions: [] }),
  );
  expect(nativeResult(line({ type: "result", is_error: false, result: "prose answer", structured_output: null })).text).toBe("prose answer");
});

test("claude and codex get the native schema on fresh and resumed runs; pi/omp and the opt-out do not", () => {
  const s = spec("verifier");
  const resumed = spec("verifier", { provider_session_mode: "resume_exact", provider_session_id: "thread-1" });
  for (const sp of [s, resumed]) {
    const claude = buildProviderArgv("claude", sp, "/run", "/wt");
    expect(JSON.parse(claude[claude.indexOf("--json-schema") + 1]!)).toEqual(roleJsonSchema("verifier"));
    const codex = buildProviderArgv("codex", sp, "/run", "/wt");
    expect(codex[codex.indexOf("--output-schema") + 1]).toBe("/run/result.schema.json");
  }
  expect(buildProviderArgv("pi", s, "/run", "/wt").some((arg) => arg.includes("schema"))).toBe(false);
  expect(buildProviderArgv("omp", s, "/run", "/wt").some((arg) => arg.includes("schema"))).toBe(false);
  process.env.ORCH_NATIVE_SCHEMA = "0";
  expect(buildProviderArgv("claude", s, "/run", "/wt")).not.toContain("--json-schema");
  expect(buildProviderArgv("codex", resumed, "/run", "/wt")).not.toContain("--output-schema");
});

test("resumed codex usage subtracts the host-captured rollout baseline", () => {
  const home = tempDir();
  const day = join(home, "sessions", "2026", "10", "20");
  mkdirSync(day, { recursive: true });
  const tokenCount = (input: number, cached: number, output: number) =>
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
  writeFileSync(join(day, "rollout-2026-10-20T00-00-00-thread-1.jsonl"), [tokenCount(100, 80, 10), tokenCount(1000, 900, 50), "{torn"].join("\n"));
  const baseline = readCodexBaseline("thread-1", { CODEX_HOME: home });
  expect(baseline).toEqual({ thread_id: "thread-1", input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50, source: "codex_rollout" });
  expect(readCodexBaseline("missing", { CODEX_HOME: home })).toBeNull();

  const native = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1300, cached_input_tokens: 1150, output_tokens: 70 } }),
  ].join("\n");
  const resumed = { provider_session_mode: "resume_exact" as const };
  const e = usageEvidence(native, resumed, { state: "done" }, baseline);
  expect(e.coverage.status).toBe("complete");
  expect(e.normalized_tokens).toEqual({ input_tokens: 300, cache_read_input_tokens: 250, cache_write_input_tokens: 0, output_tokens: 20, total_tokens: 320, non_cache_read_tokens: 70 });
  expect(usageEvidence(native, resumed, { state: "done" }, null).coverage.reasons).toContain("codex_session_baseline_unknown");
  const regressed = usageEvidence(native, resumed, { state: "done" }, { ...baseline!, input_tokens: 5000 });
  expect(regressed.normalized_tokens).toBeNull();
  expect(regressed.coverage.reasons).toContain("codex_counter_regressed");
});

test("printJson delivers large output through a pipe before process.exit", async () => {
  const script = join(tempDir(), "big.ts");
  writeFileSync(script, `import { printJson } from ${JSON.stringify(join(import.meta.dir, "cli.ts"))};\nprintJson({ blob: "x".repeat(600_000) });\nprocess.exit(0);\n`);
  const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(JSON.parse(out).blob.length).toBe(600_000);
});
