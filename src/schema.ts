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
const COMMAND_PHASES = new Set(["before_change", "after_change"]);

// A failed red check (phase before_change) is evidence that the test caught
// the defect, not a failure of the change — but only when the same cmd also
// passed after the change. Without that pairing it stays a contradiction, so
// a real failure cannot be relabeled away.
//
// "Same cmd" is compared on the command a shell would run, after dropping
// only text that cannot change what runs (pairingCmd). Live implementers
// annotated the red run's cmd ("node --test x.mjs (module from 439227a3)",
// "node x.cjs  # R1: stream URL reverted") and 33 of 42 rejected claude
// results failed on that alone. A before cmd may also end in the after cmd
// as its last step ("<mutate>; <cmd>", "<mutate> && <cmd>"): the red run then
// executed exactly the command that later passed. Nothing looser counts — a
// passing check on a different command (a broader suite, "make smoke") proves
// nothing about this one, so it never pairs.
export function isProvenRedCheck(item: Record<string, unknown>, all: readonly unknown[]): boolean {
  if (item.phase !== "before_change" || typeof item.cmd !== "string") return false;
  const before = pairingCmd(item.cmd);
  if (!before) return false;
  return all.some((other) => {
    if (!record(other) || other === item || other.phase === "before_change" || typeof other.cmd !== "string") return false;
    if (commandOutcome(other) !== "passed") return false;
    const after = pairingCmd(other.cmd);
    return Boolean(after) && (before === after || before.endsWith(`; ${after}`) || before.endsWith(` && ${after}`));
  });
}

// Characters after which a "(" is shell syntax (subshell, command
// substitution, array, process substitution, redirection), not a note.
const SHELL_PAREN_LEADS = ["&&", "||", ";", "|", "&", "(", "$", "<", ">", "=", "`", "!"];

// A trailing ` # ...` outside quotes is a shell comment: it never runs.
function stripShellComment(cmd: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < cmd.length; index++) {
    const char = cmd[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "#" && index > 0 && /\s/.test(cmd[index - 1]!)) return cmd.slice(0, index);
  }
  return cmd;
}

// A trailing ` (note)` after a plain word is not valid shell (`word (x)` is a
// syntax error; a subshell needs an operator before it), so it is an
// annotation. Returns the command without it, or null when there is none.
function stripTrailingNote(cmd: string): string | null {
  if (!cmd.endsWith(")")) return null;
  let depth = 0;
  for (let index = cmd.length - 1; index >= 0; index--) {
    const char = cmd[index];
    if (char === ")") depth++;
    else if (char === "(" && --depth === 0) {
      if (index === 0 || !/\s/.test(cmd[index - 1]!)) return null;
      if (!cmd.slice(index + 1, -1).trim()) return null;
      const head = cmd.slice(0, index).trimEnd();
      if (!head || SHELL_PAREN_LEADS.some((lead) => head.endsWith(lead))) return null;
      return head;
    }
  }
  return null;
}

// The cmd as red-check pairing compares it: surrounding whitespace, a trailing
// shell comment and trailing ` (note)` annotations removed. Everything else —
// quoting, inner whitespace, flags, paths — must match character for
// character.
export function pairingCmd(cmd: string): string {
  let text = stripShellComment(cmd).trim();
  for (let note = stripTrailingNote(text); note !== null; note = stripTrailingNote(text)) text = note.trim();
  return text;
}

// What a reported check actually amounted to. Legacy entries without status
// derive it from exit_code vs expected_exit_code (default 0), so a negative
// test that is supposed to exit non-zero can still pass.
export function commandOutcome(item: { exit_code?: unknown; status?: unknown; expected_exit_code?: unknown }): "passed" | "failed" | "skipped" {
  if (item.status === "passed" || item.status === "failed" || item.status === "skipped") return item.status;
  const expected = typeof item.expected_exit_code === "number" ? item.expected_exit_code : 0;
  return item.exit_code === expected ? "passed" : "failed";
}

// negativeChecks: only verifier commands may declare a non-zero expected exit.
// An implementer's tests prove its own change works; a live run reported a
// failing test as exit_code 1 / expected_exit_code 1 / passed to keep
// "completed". A genuine negative check there is written to exit 0 (`! cmd`),
// and a red check is reported as failed with phase "before_change".
function validateCommands(obj: Record<string, unknown>, field: string, errors: string[], negativeChecks = true): void {
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
    if (item.phase !== undefined && (negativeChecks || !COMMAND_PHASES.has(item.phase as string))) {
      errors.push(negativeChecks ? `${field}[${index}].phase is only for implementer tests` : `${field}[${index}].phase must be before_change|after_change`);
    }
    if (item.expected_exit_code !== undefined && !Number.isInteger(item.expected_exit_code)) {
      errors.push(`${field}[${index}].expected_exit_code must be an integer`);
    } else if (!negativeChecks && item.expected_exit_code !== undefined && item.expected_exit_code !== 0) {
      errors.push(`${field}[${index}].expected_exit_code must be 0 for implementer tests (write a negative check so success exits 0, e.g. \`! cmd\`)`);
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
      if (record(item) && commandOutcome(item) === "failed" && !isProvenRedCheck(item, commands)) {
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
    '{"schema":"orch.result/implementer/v1","run_id":"<run_id>","verdict":"completed|failed","summary":"what changed and why","base_sha":"<base sha from the task>","head_sha":"<HEAD after your commits>","changed_files":["path/one.ts"],"tests":[{"cmd":"bun test src/one.test.ts","exit_code":1,"status":"failed","phase":"before_change","summary":"red check: fails on the unfixed tree"},{"cmd":"bun test src/one.test.ts","exit_code":0,"status":"passed","phase":"after_change","summary":"12 pass"},{"cmd":"bun run build","exit_code":null,"status":"skipped","phase":"after_change","summary":"not run: why"}],"acceptance":[{"id":"AC1","status":"met|unmet|skipped","evidence":"how you checked"}],"risks":["..."],"rollback":"git revert <head_sha>"}',
  reviewer:
    '{"schema":"orch.result/reviewer/v1","run_id":"<run_id>","verdict":"approve|request_changes","reviews_run_id":"<run id under review; empty string if none>","blocking_findings":[{"id":"F1","severity":"high|medium|low","file":"path/one.ts:42","body":"what breaks, how to reproduce, what to change"}],"non_blocking_findings":[{"body":"..."}],"suggested_tests":["..."]}',
  controller: '{"schema":"orch.result/controller/v1","run_id":"<run_id>","verdict":"completed|failed","summary":"...","actions":["..."]}',
  researcher:
    '{"schema":"orch.result/researcher/v1","run_id":"<run_id>","verdict":"completed|failed","summary":"...","recommendation":"...","alternatives":["..."],"sources":["https://..."],"open_questions":["..."],"risks":["..."]}',
  verifier:
    '{"schema":"orch.result/verifier/v1","run_id":"<run_id>","verdict":"pass|fail","verifies_run_id":"<run id verified>","commands":[{"cmd":"...","exit_code":0,"status":"passed","summary":"..."},{"cmd":"<negative test>","exit_code":2,"expected_exit_code":2,"status":"passed","summary":"rejects bad input as expected"},{"cmd":"<optional check>","exit_code":null,"status":"skipped","optional":true,"summary":"not run: why"}],"acceptance":[{"id":"AC1","status":"met|unmet|skipped","evidence":"..."}],"non_blocking_findings":[{"severity":"nit|pre-existing","file":"path/one.ts:42","body":"optional; never changes the verdict"}]}',
};

// Provider-native strict JSON Schema per role (claude --json-schema, codex
// --output-schema). Shaped for OpenAI strict mode: every property required,
// additionalProperties false, optional fields nullable, no oneOf/allOf/if.
// It only constrains shape; cross-field rules (success vs failed checks,
// skipped => exit_code null) stay in validateRoleResult, which still runs on
// every result. Nulls are stripped (stripNulls) before validation.
type JsonSchema = Record<string, unknown>;
const S_STRING: JsonSchema = { type: "string" };
const S_STRINGS: JsonSchema = { type: "array", items: S_STRING };
function sNullable(type: string): JsonSchema {
  return { type: [type, "null"] };
}
function sEnum(values: readonly string[]): JsonSchema {
  return { type: "string", enum: [...values] };
}
function sObject(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
function sArray(items: JsonSchema): JsonSchema {
  return { type: "array", items };
}
function sCommand(negativeChecks: boolean): JsonSchema {
  return sObject({
    cmd: S_STRING,
    exit_code: sNullable("integer"),
    status: sEnum(["passed", "failed", "skipped"]),
    summary: S_STRING,
    ...(negativeChecks ? { expected_exit_code: sNullable("integer") } : { phase: sEnum(["before_change", "after_change"]) }),
    optional: sNullable("boolean"),
  });
}
const S_ACCEPTANCE = sObject({ id: S_STRING, status: sEnum(["met", "unmet", "skipped"]), evidence: sNullable("string"), optional: sNullable("boolean") });

const S_NON_BLOCKING_FINDING = sObject({ id: sNullable("string"), severity: sNullable("string"), file: sNullable("string"), body: S_STRING });

export function roleJsonSchema(role: RunRole): JsonSchema {
  const head = { schema: sEnum([resultSchemaName(role)]), run_id: S_STRING, verdict: sEnum(ROLE_VERDICTS[role]) };
  if (role === "implementer") {
    return sObject({ ...head, summary: S_STRING, base_sha: S_STRING, head_sha: S_STRING, changed_files: S_STRINGS, tests: sArray(sCommand(false)), acceptance: sArray(S_ACCEPTANCE), risks: S_STRINGS, rollback: S_STRING });
  }
  if (role === "reviewer") {
    return sObject({
      ...head,
      reviews_run_id: S_STRING,
      blocking_findings: sArray(sObject({ id: S_STRING, severity: S_STRING, file: S_STRING, body: S_STRING })),
      non_blocking_findings: sArray(S_NON_BLOCKING_FINDING),
      suggested_tests: S_STRINGS,
    });
  }
  if (role === "controller") return sObject({ ...head, summary: S_STRING, actions: S_STRINGS });
  if (role === "researcher") {
    return sObject({ ...head, summary: S_STRING, recommendation: S_STRING, alternatives: S_STRINGS, sources: S_STRINGS, open_questions: S_STRINGS, risks: S_STRINGS });
  }
  return sObject({
    ...head,
    verifies_run_id: S_STRING,
    commands: sArray(sCommand(true)),
    acceptance: sArray(S_ACCEPTANCE),
    non_blocking_findings: { type: ["array", "null"], items: S_NON_BLOCKING_FINDING },
  });
}

// Strict schemas encode "absent" as null; the validator and readers expect the
// field to be missing instead. exit_code keeps its null: that is the
// documented encoding of a skipped check.
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!record(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null || key === "exit_code") out[key] = stripNulls(item);
  }
  return out;
}

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
    validateCommands(obj, "tests", errors, false);
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
    // Optional, and deliberately outside the pass/fail consistency checks.
    if (obj.non_blocking_findings !== undefined) validateFindings(obj, "non_blocking_findings", errors, false);
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
