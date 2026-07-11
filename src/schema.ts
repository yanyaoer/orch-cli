import type {
  ControllerResult,
  ImplementerResult,
  ResearcherResult,
  ResultRole,
  RoleResult,
  RunRole,
  ReviewerResult,
  VerifierResult,
} from "./types.ts";
import { isResultRole } from "./types.ts";

// TS validation in this file is the canonical result schema.
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

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireFields(obj: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((field) => {
    const value = obj[field];
    if (typeof value === "string") return value.trim() === "";
    if (Array.isArray(value)) return false;
    return value === undefined || value === null;
  });
}

function validateStringArray(obj: Record<string, unknown>, field: string, errors: string[]): void {
  if (!array(obj[field])) {
    errors.push(`${field} must be an array`);
    return;
  }
  obj[field].forEach((item, index) => {
    if (typeof item !== "string") errors.push(`${field}[${index}] must be a string`);
  });
}

function validateCommands(obj: Record<string, unknown>, field: string, errors: string[]): void {
  if (!array(obj[field])) {
    errors.push(`${field} must be an array`);
    return;
  }
  obj[field].forEach((item, index) => {
    if (!record(item)) {
      errors.push(`${field}[${index}] must be an object`);
      return;
    }
    if (!nonEmptyString(item.cmd)) errors.push(`${field}[${index}].cmd is required`);
    if (typeof item.exit_code !== "number") errors.push(`${field}[${index}].exit_code must be a number`);
    if (!nonEmptyString(item.summary)) errors.push(`${field}[${index}].summary is required`);
  });
}

function validateAcceptance(obj: Record<string, unknown>, field: string, errors: string[], evidenceAllowed: boolean): void {
  if (!array(obj[field])) {
    errors.push(`${field} must be an array`);
    return;
  }
  obj[field].forEach((item, index) => {
    if (!record(item)) {
      errors.push(`${field}[${index}] must be an object`);
      return;
    }
    if (!nonEmptyString(item.id)) errors.push(`${field}[${index}].id is required`);
    if (!nonEmptyString(item.status)) errors.push(`${field}[${index}].status is required`);
    if (!evidenceAllowed && item.evidence !== undefined) errors.push(`${field}[${index}].evidence is not supported`);
    if (item.evidence !== undefined && typeof item.evidence !== "string") errors.push(`${field}[${index}].evidence must be a string`);
  });
}

function validateFindings(obj: Record<string, unknown>, field: string, errors: string[], blocking: boolean): void {
  if (!array(obj[field])) {
    errors.push(`${field} must be an array`);
    return;
  }
  obj[field].forEach((item, index) => {
    if (!record(item)) {
      errors.push(`${field}[${index}] must be an object`);
      return;
    }
    if (!nonEmptyString(item.body)) errors.push(`${field}[${index}].body is required`);
    for (const optional of ["id", "severity", "file"]) {
      if (item[optional] !== undefined && typeof item[optional] !== "string") {
        errors.push(`${field}[${index}].${optional} must be a string`);
      }
    }
    if (blocking) {
      for (const required of ["id", "severity", "file"]) {
        if (!nonEmptyString(item[required])) errors.push(`${field}[${index}].${required} is required`);
      }
    }
  });
}

export function resultSchemaName(role: ResultRole): RoleResult["schema"] {
  if (role === "implementer") return "orch.result/implementer/v1";
  if (role === "reviewer") return "orch.result/reviewer/v1";
  if (role === "controller") return "orch.result/controller/v1";
  if (role === "researcher") return "orch.result/researcher/v1";
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
    validateStringArray(obj, "changed_files", errors);
    validateCommands(obj, "tests", errors);
    validateAcceptance(obj, "acceptance", errors, true);
    validateStringArray(obj, "risks", errors);
  } else if (role === "reviewer") {
    const missing = requireFields(obj, ["verdict"]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (typeof obj.reviews_run_id !== "string") errors.push("reviews_run_id must be a string");
    if (obj.verdict !== "approve" && obj.verdict !== "request_changes") {
      errors.push("verdict must be approve|request_changes");
    }
    validateFindings(obj, "blocking_findings", errors, true);
    validateFindings(obj, "non_blocking_findings", errors, false);
    validateStringArray(obj, "suggested_tests", errors);
  } else if (role === "controller") {
    const missing = requireFields(obj, ["verdict", "summary"]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (obj.verdict !== "completed" && obj.verdict !== "failed") errors.push("verdict must be completed|failed");
    validateStringArray(obj, "actions", errors);
  } else if (role === "researcher") {
    const missing = requireFields(obj, ["verdict", "summary", "recommendation"]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (obj.verdict !== "completed" && obj.verdict !== "failed") errors.push("verdict must be completed|failed");
    validateStringArray(obj, "alternatives", errors);
    validateStringArray(obj, "sources", errors);
    validateStringArray(obj, "open_questions", errors);
    validateStringArray(obj, "risks", errors);
  } else {
    const missing = requireFields(obj, ["verdict"]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (typeof obj.verifies_run_id !== "string") errors.push("verifies_run_id must be a string");
    if (obj.verdict !== "pass" && obj.verdict !== "fail") errors.push("verdict must be pass|fail");
    validateCommands(obj, "commands", errors);
    validateAcceptance(obj, "acceptance", errors, false);
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
  if (args.role === "controller") {
    return {
      schema: "orch.result/controller/v1",
      run_id: args.run_id,
      verdict: "failed",
      summary: args.summary,
      actions: [],
    } satisfies ControllerResult;
  }
  if (args.role === "researcher") {
    return {
      schema: "orch.result/researcher/v1",
      run_id: args.run_id,
      verdict: "failed",
      summary: args.summary,
      recommendation: "No recommendation produced by the driver.",
      alternatives: [],
      sources: [],
      open_questions: [],
      risks: [args.summary],
    } satisfies ResearcherResult;
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
