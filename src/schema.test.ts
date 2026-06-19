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

