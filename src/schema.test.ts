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
      commands: [],
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
