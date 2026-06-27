import { expect, test } from "bun:test";
import { fallbackResult, validateRoleResult } from "./schema.ts";

test("reviewer and verifier fallback results pass their role validators", () => {
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

  expect(validateRoleResult("reviewer", reviewer)).toEqual({ ok: true, errors: [] });
  expect(validateRoleResult("verifier", verifier)).toEqual({ ok: true, errors: [] });
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
});
