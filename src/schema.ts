import type {
  ControllerResult,
  ImplementerResult,
  ResearcherResult,
  RoleResult,
  RunRole,
  ReviewerResult,
  VerifierResult,
} from "./types.ts";
import { isRunRole } from "./types.ts";

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

const COMMAND_STATUSES = new Set(["passed", "failed", "skipped"]);

// What a reported check actually amounted to. Legacy entries without status
// derive it from exit_code vs expected_exit_code (default 0), so a negative
// test that is supposed to exit non-zero can still pass.
export function commandOutcome(item: { exit_code?: unknown; status?: unknown; expected_exit_code?: unknown }): "passed" | "failed" | "skipped" {
  if (item.status === "passed" || item.status === "failed" || item.status === "skipped") return item.status;
  const expected = typeof item.expected_exit_code === "number" ? item.expected_exit_code : 0;
  return item.exit_code === expected ? "passed" : "failed";
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
    if (!nonEmptyString(item.summary)) errors.push(`${field}[${index}].summary is required`);
    if (item.status !== undefined && !COMMAND_STATUSES.has(item.status as string)) {
      errors.push(`${field}[${index}].status must be passed|failed|skipped`);
    }
    if (item.optional !== undefined && typeof item.optional !== "boolean") errors.push(`${field}[${index}].optional must be a boolean`);
    if (item.expected_exit_code !== undefined && !Number.isInteger(item.expected_exit_code)) {
      errors.push(`${field}[${index}].expected_exit_code must be an integer`);
    }
    if (item.status === "skipped") {
      // A check that never ran cannot encode success (exit_code 0).
      if (item.exit_code !== null && item.exit_code !== undefined) {
        errors.push(`${field}[${index}] is skipped, so exit_code must be null (a check that did not run has no exit code)`);
      }
      return;
    }
    if (typeof item.exit_code !== "number") {
      errors.push(`${field}[${index}].exit_code must be a number`);
      return;
    }
    const expected = typeof item.expected_exit_code === "number" ? item.expected_exit_code : 0;
    if (item.status === "passed" && item.exit_code !== expected) {
      errors.push(`${field}[${index}] is passed but exit_code ${item.exit_code} != expected_exit_code ${expected}`);
    }
  });
}

// Acceptance status vocabulary: met|unmet|skipped, plus the synonyms live
// results already use. null = unrecognized.
export function acceptanceOutcome(status: unknown): "met" | "unmet" | "skipped" | null {
  const value = typeof status === "string" ? status.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (["met", "pass", "passed", "ok", "done", "satisfied", "confirmed", "verified", "yes", "true"].includes(value)) return "met";
  if (["unmet", "not_met", "fail", "failed", "blocked", "partial", "refuted", "missing", "no", "false"].includes(value)) return "unmet";
  if (["skipped", "skip", "not_run", "n/a", "na", "deferred"].includes(value)) return "skipped";
  return null;
}

// A success verdict must agree with its own evidence: no failed check, no
// unmet or unrecognized acceptance item. This is semantic consistency of the
// JSON only — orch does not re-run the commands; the raw logs and the
// controller's own verification remain the proof that they ran.
// A verifier pass is a claim that verification happened, which an all-skipped
// result cannot make: at least one check must have run and passed, and a
// skipped command or acceptance item is allowed only when explicitly marked
// optional. (An implementer's completed may skip checks it leaves to the
// controller/verifier — that is a different claim.)
function validateVerifierPass(obj: Record<string, unknown>, errors: string[]): void {
  const commands = Array.isArray(obj.commands) ? (obj.commands as unknown[]) : [];
  if (!commands.some((item) => record(item) && commandOutcome(item) === "passed")) {
    errors.push("verdict pass requires at least one command that actually ran and passed");
  }
  commands.forEach((item, index) => {
    if (record(item) && commandOutcome(item) === "skipped" && item.optional !== true) {
      errors.push(`verdict pass cannot skip required commands[${index}] (${String(item.cmd)}); mark it optional or run it`);
    }
  });
  const acceptance = Array.isArray(obj.acceptance) ? (obj.acceptance as unknown[]) : [];
  acceptance.forEach((item, index) => {
    if (record(item) && acceptanceOutcome(item.status) === "skipped" && item.optional !== true) {
      errors.push(`verdict pass cannot skip required acceptance[${index}] (${String(item.id)}); mark it optional or verify it`);
    }
  });
}

function validateSuccessConsistency(obj: Record<string, unknown>, verdict: string, commandField: string, errors: string[]): void {
  const commands = obj[commandField];
  if (Array.isArray(commands)) {
    commands.forEach((item: unknown, index) => {
      if (record(item) && commandOutcome(item) === "failed") {
        errors.push(`verdict ${verdict} contradicts ${commandField}[${index}] (failed: ${String(item.cmd)})`);
      }
    });
  }
  if (Array.isArray(obj.acceptance)) {
    obj.acceptance.forEach((item, index) => {
      if (!record(item)) return;
      const outcome = acceptanceOutcome(item.status);
      if (outcome === null) errors.push(`acceptance[${index}].status must be met|unmet|skipped under verdict ${verdict}`);
      else if (outcome === "unmet") errors.push(`verdict ${verdict} contradicts acceptance[${index}] (${String(item.id)} unmet)`);
    });
  }
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
    if (item.optional !== undefined && typeof item.optional !== "boolean") errors.push(`${field}[${index}].optional must be a boolean`);
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

export function resultSchemaName(role: RunRole): RoleResult["schema"] {
  if (role === "implementer") return "orch.result/implementer/v1";
  if (role === "reviewer") return "orch.result/reviewer/v1";
  if (role === "controller") return "orch.result/controller/v1";
  if (role === "researcher") return "orch.result/researcher/v1";
  return "orch.result/verifier/v1";
}

// Verdict is the only field that distinguishes success from failure for most
// roles (completed and failed require identical content fields), so it can
// never be inferred or defaulted — it must be demanded from the model
// (buildPrompt) and validated here.
export const ROLE_VERDICTS: Record<RunRole, readonly [string, string]> = {
  implementer: ["completed", "failed"],
  reviewer: ["approve", "request_changes"],
  controller: ["completed", "failed"],
  researcher: ["completed", "failed"],
  verifier: ["pass", "fail"],
};

// Required scalar fields per role, shared by validateRoleResult and
// buildPrompt: models cannot guess the field list from the schema name alone
// (live runs dropped verdict, then summary), so the prompt must spell it out
// from the same source the validator enforces. Arrays and the *_run_id
// strings self-heal in coerceRoleResult and are deliberately not listed.
export const ROLE_REQUIRED_FIELDS: Record<RunRole, readonly string[]> = {
  implementer: ["verdict", "summary", "base_sha", "head_sha", "rollback"],
  reviewer: ["verdict"],
  controller: ["verdict", "summary"],
  researcher: ["verdict", "summary", "recommendation"],
  verifier: ["verdict"],
};

// One example per role, printed verbatim in the worker prompt and in the
// result-repair prompt: models copy a shape far more reliably than they infer
// it from a field list (live runs invented finding keys and object items).
export const ROLE_RESULT_EXAMPLE: Record<RunRole, string> = {
  implementer:
    '{"schema":"orch.result/implementer/v1","run_id":"<run_id>","verdict":"completed|failed","summary":"what changed and why","base_sha":"<base sha from the task>","head_sha":"<HEAD after your commits>","changed_files":["path/one.ts"],"tests":[{"cmd":"bun test src/one.test.ts","exit_code":0,"status":"passed","summary":"12 pass"},{"cmd":"bun run build","exit_code":null,"status":"skipped","summary":"not run: why"}],"acceptance":[{"id":"AC1","status":"met|unmet|skipped","evidence":"how you checked"}],"risks":["..."],"rollback":"git revert <head_sha>"}',
  reviewer:
    '{"schema":"orch.result/reviewer/v1","run_id":"<run_id>","verdict":"approve|request_changes","reviews_run_id":"<run id under review; empty string if none>","blocking_findings":[{"id":"F1","severity":"high|medium|low","file":"path/one.ts:42","body":"what breaks, how to reproduce, what to change"}],"non_blocking_findings":[{"body":"..."}],"suggested_tests":["..."]}',
  controller: '{"schema":"orch.result/controller/v1","run_id":"<run_id>","verdict":"completed|failed","summary":"...","actions":["..."]}',
  researcher:
    '{"schema":"orch.result/researcher/v1","run_id":"<run_id>","verdict":"completed|failed","summary":"...","recommendation":"...","alternatives":["..."],"sources":["https://..."],"open_questions":["..."],"risks":["..."]}',
  verifier:
    '{"schema":"orch.result/verifier/v1","run_id":"<run_id>","verdict":"pass|fail","verifies_run_id":"<run id verified>","commands":[{"cmd":"...","exit_code":0,"status":"passed","summary":"..."},{"cmd":"<negative test>","exit_code":2,"expected_exit_code":2,"status":"passed","summary":"rejects bad input as expected"},{"cmd":"<optional check>","exit_code":null,"status":"skipped","optional":true,"summary":"not run: why"}],"acceptance":[{"id":"AC1","status":"met|unmet|skipped","evidence":"..."}]}',
};

export function validateRoleResult(role: RunRole, value: unknown): ValidationResult {
  if (!isRunRole(role)) {
    return { ok: false, errors: [`role ${role} has no result schema`] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["result must be an object"] };
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  if (obj.schema !== resultSchemaName(role)) errors.push(`schema must be ${resultSchemaName(role)}`);
  if (!nonEmptyString(obj.run_id)) errors.push("run_id is required");
  const verdicts = ROLE_VERDICTS[role];
  if (!verdicts.includes(obj.verdict as string)) errors.push(`verdict must be ${verdicts.join("|")}`);

  if (role === "implementer") {
    const missing = requireFields(obj, [...ROLE_REQUIRED_FIELDS.implementer]);
    errors.push(...missing.map((field) => `${field} is required`));
    validateStringArray(obj, "changed_files", errors);
    validateCommands(obj, "tests", errors);
    validateAcceptance(obj, "acceptance", errors, true);
    validateStringArray(obj, "risks", errors);
    if (obj.verdict === "completed") validateSuccessConsistency(obj, "completed", "tests", errors);
  } else if (role === "reviewer") {
    const missing = requireFields(obj, [...ROLE_REQUIRED_FIELDS.reviewer]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (typeof obj.reviews_run_id !== "string") errors.push("reviews_run_id must be a string");
    validateFindings(obj, "blocking_findings", errors, true);
    validateFindings(obj, "non_blocking_findings", errors, false);
    validateStringArray(obj, "suggested_tests", errors);
  } else if (role === "controller") {
    const missing = requireFields(obj, [...ROLE_REQUIRED_FIELDS.controller]);
    errors.push(...missing.map((field) => `${field} is required`));
    validateStringArray(obj, "actions", errors);
  } else if (role === "researcher") {
    const missing = requireFields(obj, [...ROLE_REQUIRED_FIELDS.researcher]);
    errors.push(...missing.map((field) => `${field} is required`));
    validateStringArray(obj, "alternatives", errors);
    validateStringArray(obj, "sources", errors);
    validateStringArray(obj, "open_questions", errors);
    validateStringArray(obj, "risks", errors);
  } else {
    const missing = requireFields(obj, [...ROLE_REQUIRED_FIELDS.verifier]);
    errors.push(...missing.map((field) => `${field} is required`));
    if (typeof obj.verifies_run_id !== "string") errors.push("verifies_run_id must be a string");
    validateCommands(obj, "commands", errors);
    // A verifier's whole deliverable is evidence-backed checks; rejecting the
    // evidence field discarded an otherwise complete live result.
    validateAcceptance(obj, "acceptance", errors, true);
    if (obj.verdict === "pass") {
      validateSuccessConsistency(obj, "pass", "commands", errors);
      validateVerifierPass(obj, errors);
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
