import { expect, test } from "bun:test";
import { fallbackResult, validateRoleResult } from "./schema.ts";
import { writeRoles, type RunRole } from "./types.ts";
import { sandboxPosture } from "../drivers/sandbox.ts";

test("reviewer, verifier, controller, and researcher fallback results pass their role validators", () => {
  const reviewer = fallbackResult({
    role: "reviewer",
    run_id: "review-a",
    base_sha: "base",
    head_sha: "head",
    summary: "missing provider result",
  });
  const verifier = fallbackResult({
    role: "verifier",
    run_id: "verify-a",
    base_sha: "base",
    head_sha: "head",
    summary: "missing provider result",
  });
  const controller = fallbackResult({
    role: "controller",
    run_id: "control-a",
    base_sha: "base",
    head_sha: "head",
    summary: "missing provider result",
  });
  const researcher = fallbackResult({
    role: "researcher",
    run_id: "research-a",
    base_sha: "base",
    head_sha: "head",
    summary: "missing provider result",
  });

  expect(validateRoleResult("reviewer", reviewer)).toEqual({ ok: true, errors: [] });
  expect(validateRoleResult("verifier", verifier)).toEqual({ ok: true, errors: [] });
  expect(validateRoleResult("controller", controller)).toEqual({ ok: true, errors: [] });
  expect(validateRoleResult("researcher", researcher)).toEqual({ ok: true, errors: [] });
});

test("result validators reject malformed collection items", () => {
  expect(
    validateRoleResult("reviewer", {
      schema: "orch.result/reviewer/v1",
      run_id: "review-a",
      verdict: "approve",
      reviews_run_id: "impl-a",
      blocking_findings: [{}],
      non_blocking_findings: [{}],
      suggested_tests: [123],
    }).ok,
  ).toBe(false);

  expect(
    validateRoleResult("implementer", {
      schema: "orch.result/implementer/v1",
      run_id: "impl-a",
      verdict: "completed",
      summary: "done",
      base_sha: "base",
      head_sha: "head",
      changed_files: [123],
      tests: [{}],
      acceptance: [{}],
      risks: [false],
      rollback: "revert",
    }).ok,
  ).toBe(false);

  expect(
    validateRoleResult("verifier", {
      schema: "orch.result/verifier/v1",
      run_id: "verify-a",
      verdict: "pass",
      verifies_run_id: "impl-a",
      commands: [{}],
      acceptance: [{}],
    }).ok,
  ).toBe(false);

  // A verifier's deliverable is evidence-backed checks: acceptance items may
  // carry evidence (a live codex verifier lost a complete result to this).
  expect(
    validateRoleResult("verifier", {
      schema: "orch.result/verifier/v1",
      run_id: "verify-evidence",
      verdict: "pass",
      verifies_run_id: "impl-a",
      commands: [{ cmd: "rg -n scheme McpServerKey.kt", exit_code: 0, summary: "digest ignores scheme" }],
      acceptance: [{ id: "f1", status: "CONFIRMED", evidence: "McpServerKey.kt:16-22 摘要忽略 scheme/端口" }],
    }),
  ).toEqual({ ok: true, errors: [] });

  expect(
    validateRoleResult("controller", {
      schema: "orch.result/controller/v1",
      run_id: "control-a",
      verdict: "completed",
      summary: "done",
      actions: [123],
    }).ok,
  ).toBe(false);

  expect(
    validateRoleResult("researcher", {
      schema: "orch.result/researcher/v1",
      run_id: "research-a",
      verdict: "completed",
      summary: "done",
      recommendation: "",
      alternatives: [123],
      sources: [],
      open_questions: [],
      risks: [],
    }).ok,
  ).toBe(false);
});

test("researcher result requires a recommendation and completed|failed verdict", () => {
  const valid = {
    schema: "orch.result/researcher/v1",
    run_id: "research-a",
    verdict: "completed",
    summary: "compared three approaches",
    recommendation: "adopt approach B",
    alternatives: ["approach A: slower", "approach C: more code"],
    sources: ["https://example.com/doc"],
    open_questions: [],
    risks: ["migration cost"],
  };
  expect(validateRoleResult("researcher", valid)).toEqual({ ok: true, errors: [] });
  expect(validateRoleResult("researcher", { ...valid, recommendation: "" }).ok).toBe(false);
  expect(validateRoleResult("researcher", { ...valid, verdict: "approve" }).ok).toBe(false);
});

test("controller and researcher are not write roles", () => {
  expect(writeRoles.has("controller")).toBe(false);
  expect(writeRoles.has("researcher")).toBe(false);
});

// F4: worktree lock + diff evidence must cover exactly the project-write roles.
// verifier writes the worktree (build/test artifacts, and claude Edit/Write),
// so it must be a write role — otherwise it races implementers on the same
// worktree lock-free and its diff is never collected.
test("writeRoles matches the project-write sandbox posture exactly", () => {
  const roles: RunRole[] = ["implementer", "reviewer", "verifier", "controller", "researcher"];
  for (const role of roles) {
    expect(writeRoles.has(role)).toBe(sandboxPosture(role) === "project-write");
  }
  expect(writeRoles.has("verifier")).toBe(true);
});

function verifier(overrides: Record<string, unknown>) {
  return {
    schema: "orch.result/verifier/v1",
    run_id: "verify-1",
    verdict: "pass",
    verifies_run_id: "impl-1",
    commands: [{ cmd: "bun test src/a.test.ts", exit_code: 0, summary: "3 pass" }],
    acceptance: [{ id: "AC1", status: "met" }],
    ...overrides,
  };
}

test("verifier pass must agree with its own checks (v0.0.13 accepted pass + exit 1 + unmet)", () => {
  expect(validateRoleResult("verifier", verifier({})).ok).toBe(true);
  const contradictory = validateRoleResult(
    "verifier",
    verifier({ commands: [{ cmd: "bun test", exit_code: 1, summary: "1 fail" }], acceptance: [{ id: "AC1", status: "unmet" }] }),
  );
  expect(contradictory.ok).toBe(false);
  expect(contradictory.errors).toEqual([
    "verdict pass contradicts commands[0] (failed: bun test)",
    "verdict pass contradicts acceptance[0] (AC1 unmet)",
    "verdict pass requires at least one command that actually ran and passed",
  ]);
  // The same evidence under fail is consistent.
  expect(validateRoleResult("verifier", verifier({ verdict: "fail", commands: [{ cmd: "bun test", exit_code: 1, summary: "1 fail" }], acceptance: [{ id: "AC1", status: "unmet" }] })).ok).toBe(true);
  // An explicit failed status fails a pass even with exit 0 (e.g. output assertion).
  expect(validateRoleResult("verifier", verifier({ commands: [{ cmd: "x", exit_code: 0, status: "failed", summary: "wrong output" }] })).ok).toBe(false);
  // Unrecognized acceptance status cannot ride on a pass.
  expect(validateRoleResult("verifier", verifier({ acceptance: [{ id: "AC1", status: "probably" }] })).errors).toEqual([
    "acceptance[0].status must be met|unmet|skipped under verdict pass",
  ]);
});

test("expected non-zero exits express negative tests; skipped checks cannot encode success", () => {
  const negative = { cmd: "orch run create --bogus", exit_code: 2, expected_exit_code: 2, status: "passed", summary: "rejected as expected" };
  expect(validateRoleResult("verifier", verifier({ commands: [negative] })).ok).toBe(true);
  // Legacy entry without status: derived from exit_code vs expected_exit_code.
  expect(validateRoleResult("verifier", verifier({ commands: [{ ...negative, status: undefined }] })).ok).toBe(true);
  // Claiming passed when the exit differs from the expectation is rejected...
  expect(validateRoleResult("verifier", verifier({ commands: [{ ...negative, exit_code: 0 }] })).errors).toEqual([
    "commands[0] is passed but exit_code 0 != expected_exit_code 2",
  ]);
  expect(validateRoleResult("verifier", verifier({ commands: [{ ...negative, expected_exit_code: 1.5 }] })).errors).toContain(
    "commands[0].expected_exit_code must be an integer",
  );
  // ...and a check that never ran is skipped with exit_code null, never 0.
  const skipped = { cmd: "bun run build", exit_code: null, status: "skipped", summary: "not run: no toolchain" };
  expect(validateRoleResult("verifier", verifier({ commands: [verifier({}).commands[0], { ...skipped, optional: true }] })).ok).toBe(true);
  expect(validateRoleResult("verifier", verifier({ commands: [{ ...skipped, exit_code: 0 }] })).errors).toContain(
    "commands[0] is skipped, so exit_code must be null (a check that did not run has no exit code)",
  );
  expect(validateRoleResult("verifier", verifier({ commands: [{ ...skipped, status: "maybe" }] })).errors).toContain(
    "commands[0].status must be passed|failed|skipped",
  );
  // A non-skipped command still needs a numeric exit code.
  expect(validateRoleResult("verifier", verifier({ commands: [{ cmd: "x", exit_code: null, status: "passed", summary: "s" }] })).ok).toBe(false);
});

test("implementer completed cannot carry failed tests or unmet acceptance", () => {
  const base = {
    schema: "orch.result/implementer/v1",
    run_id: "impl-1",
    verdict: "completed",
    summary: "done",
    base_sha: "a",
    head_sha: "a",
    changed_files: [],
    tests: [{ cmd: "bun test src/a.test.ts", exit_code: 0, status: "passed", summary: "ok" }],
    acceptance: [{ id: "AC1", status: "met" }],
    risks: [],
    rollback: "git revert",
  };
  expect(validateRoleResult("implementer", base).ok).toBe(true);
  expect(validateRoleResult("implementer", { ...base, tests: [{ cmd: "bun test", exit_code: 1, summary: "1 fail" }] }).ok).toBe(false);
  expect(validateRoleResult("implementer", { ...base, acceptance: [{ id: "AC1", status: "unmet" }] }).ok).toBe(false);
  expect(validateRoleResult("implementer", { ...base, verdict: "failed", acceptance: [{ id: "AC1", status: "unmet" }] }).ok).toBe(true);
});

test("verifier pass needs a check that actually ran; required checks and acceptance cannot be skipped", () => {
  const skipped = { cmd: "bun test", exit_code: null, status: "skipped", summary: "not run" };
  // F3 counterexample: everything skipped yet verdict pass.
  const allSkipped = validateRoleResult("verifier", verifier({ commands: [skipped], acceptance: [{ id: "AC1", status: "skipped" }] }));
  expect(allSkipped.errors).toEqual([
    "verdict pass requires at least one command that actually ran and passed",
    "verdict pass cannot skip required commands[0] (bun test); mark it optional or run it",
    "verdict pass cannot skip required acceptance[0] (AC1); mark it optional or verify it",
  ]);
  expect(validateRoleResult("verifier", verifier({ commands: [] })).errors).toEqual(["verdict pass requires at least one command that actually ran and passed"]);
  // Optional items may be skipped once a real check passed; a negative test counts as that check.
  const negative = { cmd: "orch x --bogus", exit_code: 2, expected_exit_code: 2, status: "passed", summary: "rejected" };
  expect(
    validateRoleResult("verifier", verifier({ commands: [negative, { ...skipped, optional: true }], acceptance: [{ id: "AC1", status: "met" }, { id: "AC2", status: "skipped", optional: true }] })).ok,
  ).toBe(true);
  expect(validateRoleResult("verifier", verifier({ acceptance: [{ id: "AC1", status: "met", optional: "yes" }] })).errors).toContain("acceptance[0].optional must be a boolean");
  // The same all-skipped evidence is a valid fail, and an implementer may
  // finish its edits leaving checks to the controller.
  expect(validateRoleResult("verifier", verifier({ verdict: "fail", commands: [skipped], acceptance: [{ id: "AC1", status: "skipped" }] })).ok).toBe(true);
  expect(
    validateRoleResult("implementer", {
      schema: "orch.result/implementer/v1", run_id: "i", verdict: "completed", summary: "s", base_sha: "a", head_sha: "a", changed_files: [],
      tests: [skipped], acceptance: [{ id: "AC1", status: "skipped" }], risks: [], rollback: "r",
    }).ok,
  ).toBe(true);
});
