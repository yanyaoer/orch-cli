import type {
  ImplementerResult,
  ResultRole,
  RoleResult,
  RunRole,
  ReviewerResult,
  VerifierResult,
} from "./types.ts";
import { isResultRole } from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function array(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function requireFields(obj: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => {
    const value = obj[field];
    if (typeof value === "string") return value.trim() === "";
    if (Array.isArray(value)) return false;
    return value === undefined || value === null;
  });
}

export function resultSchemaName(role: ResultRole): RoleResult["schema"] {
  if (role === "implementer") return "orch.result/implementer/v1";
  if (role === "reviewer") return "orch.result/reviewer/v1";
  return "orch.result/verifier/v1";
}

export function validateRoleResult(role: RunRole, value: unknown): ValidationResult {
  if (!isResultRole(role)) {
    return { ok: false, errors: [`role ${role} has no MVP result schema`] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["result must be an object"] };
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  if (obj.schema !== resultSchemaName(role)) errors.push(`schema must be ${resultSchemaName(role)}`);
  if (!nonEmptyString(obj.run_id)) errors.push("run_id is required");

  if (role === "implementer") {
    const missing = requireFields(obj, ["verdict", "summary", "base_sha", "head_sha", "rollback"]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (obj.verdict !== "completed" && obj.verdict !== "failed") errors.push("verdict must be completed|failed");
    for (const field of ["changed_files", "tests", "acceptance", "risks"]) {
      if (!array(obj[field])) errors.push(`${field} must be an array`);
    }
  } else if (role === "reviewer") {
    const missing = requireFields(obj, ["verdict", "reviews_run_id"]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (obj.verdict !== "approve" && obj.verdict !== "request_changes") {
      errors.push("verdict must be approve|request_changes");
    }
    for (const field of ["blocking_findings", "non_blocking_findings", "suggested_tests"]) {
      if (!array(obj[field])) errors.push(`${field} must be an array`);
    }
  } else {
    const missing = requireFields(obj, ["verdict", "verifies_run_id"]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (obj.verdict !== "pass" && obj.verdict !== "fail") errors.push("verdict must be pass|fail");
    for (const field of ["commands", "acceptance"]) {
      if (!array(obj[field])) errors.push(`${field} must be an array`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function fallbackResult(args: {
  role: RunRole;
  run_id: string;
  base_sha: string;
  head_sha: string;
  summary: string;
}): RoleResult {
  if (args.role === "reviewer") {
    return {
      schema: "orch.result/reviewer/v1",
      run_id: args.run_id,
      verdict: "request_changes",
      reviews_run_id: "",
      blocking_findings: [
        { id: "orch-driver-result", severity: "blocking", file: "native.jsonl", body: args.summary },
      ],
      non_blocking_findings: [],
      suggested_tests: [],
    } satisfies ReviewerResult;
  }
  if (args.role === "verifier") {
    return {
      schema: "orch.result/verifier/v1",
      run_id: args.run_id,
      verdict: "fail",
      verifies_run_id: "",
      commands: [],
      acceptance: [],
    } satisfies VerifierResult;
  }
  return {
    schema: "orch.result/implementer/v1",
    run_id: args.run_id,
    verdict: "failed",
    summary: args.summary,
    base_sha: args.base_sha,
    head_sha: args.head_sha,
    changed_files: [],
    tests: [],
    acceptance: [],
    risks: [args.summary],
    rollback: "No changes were accepted by orch.",
  } satisfies ImplementerResult;
}

