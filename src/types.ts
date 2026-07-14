// Every run role has a result schema. Rework/debug follow-ups are implementer
// runs (dispatch with --resume-from and a tag), not separate roles.
export type RunRole = "implementer" | "reviewer" | "verifier" | "controller" | "researcher";

export type AgentName = "codex" | "claude" | "pi" | "omp";

export type ProviderSessionMode = "ephemeral" | "fresh_persistent" | "resume_exact";

// OS sandbox policy version (docs/sandbox-design.md). A semantic change to
// the policy must ship as a new engine value (seatbelt-v2, …); the same value
// must never silently widen.
export type SandboxEngine = "none" | "seatbelt-v1";

// Worktree write posture, derived from the immutable role: implementer and
// verifier write the project; reviewer/researcher/controller do not.
export type SandboxPosture = "read-only" | "project-write";

export type RunState =
  | "created"
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled"
  | "stale";

export type ResultVerdict =
  | "completed"
  | "failed"
  | "approve"
  | "request_changes"
  | "pass"
  | "fail";

export interface RunSpec {
  version: 1;
  run_id: string;
  mr: string;
  role: RunRole;
  agent: AgentName;
  model: string | null;
  tag: string;
  provider_session_name: string | null;
  provider_session_id: string | null;
  provider_session_mode: ProviderSessionMode;
  idempotency_key: string;
  repo_key: string;
  worktree: string;
  task_path: string | null;
  task_text: string;
  task_sha: string;
  base_sha: string;
  timeout_sec: number;
  created_at: string;
  // Snapshot of config.json `language` at spec creation, present only when it
  // was 中文: the driver must not depend on live global config, and the spec
  // stays auditable. Absent (legacy specs, english config) means english.
  language?: "中文";
  // Snapshot of config.json `sandbox` at spec creation, present only when the
  // run was created with the OS sandbox on: the driver must wrap the provider
  // in this exact policy version or fail closed. Absent means no orch OS
  // sandbox. Posture is derived from the immutable role, never stored, so the
  // two can't contradict. Mirrors `language` snapshotting.
  sandbox_engine?: "seatbelt-v1";
}

export interface RunStatus {
  run_id: string;
  mr: string;
  role: RunRole;
  agent: AgentName;
  tag: string;
  provider_session_name: string | null;
  provider_session_id: string | null;
  provider_session_mode: ProviderSessionMode;
  state: RunState;
  pid: number | null;
  pgid: number | null;
  started_at: string | null;
  updated_at: string;
  exit_code: number | null;
  timeout_sec: number;
  last_event_seq: number;
  native_event_count: number;
  provider_resume_id: string | null;
  worktree: string;
  base_sha: string;
  head_sha: string | null;
  // Effective sandbox contract for audit: engine/posture snapshot from the
  // spec at create; profile hash and native-sandbox flag flow in from the
  // driver's recorded execution plan (sandbox.json) once the driver runs.
  sandbox_engine?: SandboxEngine;
  sandbox_posture?: SandboxPosture;
  sandbox_profile_sha256?: string | null;
  provider_native_sandbox?: boolean;
}

export interface ResultCoercion {
  field: string;
  from: string;
  to: string;
  reason: string;
}

export interface OrchEvent {
  type: "created" | "starting" | "running" | "heartbeat" | "done" | "failed" | "timeout" | "stale" | "result_coercion";
  seq: number;
  ts: string;
  message?: string;
  coercions?: ResultCoercion[];
}

export interface CommandResult {
  cmd: string;
  exit_code: number;
  summary: string;
}

export interface AcceptanceResult {
  id: string;
  status: string;
  evidence?: string;
}

export interface ImplementerResult {
  schema: "orch.result/implementer/v1";
  run_id: string;
  verdict: "completed" | "failed";
  summary: string;
  base_sha: string;
  head_sha: string;
  changed_files: string[];
  tests: CommandResult[];
  acceptance: AcceptanceResult[];
  risks: string[];
  rollback: string;
}

export interface ReviewerResult {
  schema: "orch.result/reviewer/v1";
  run_id: string;
  verdict: "approve" | "request_changes";
  reviews_run_id: string;
  blocking_findings: Array<{ id: string; severity: string; file: string; body: string }>;
  non_blocking_findings: Array<{ id: string; severity?: string; file?: string; body: string }>;
  suggested_tests: string[];
}

export interface VerifierResult {
  schema: "orch.result/verifier/v1";
  run_id: string;
  verdict: "pass" | "fail";
  verifies_run_id: string;
  commands: CommandResult[];
  acceptance: AcceptanceResult[];
}

export interface ControllerResult {
  schema: "orch.result/controller/v1";
  run_id: string;
  verdict: "completed" | "failed";
  summary: string;
  actions: string[];
}

// Researcher/architect: read-only deep research and solution design (web
// research allowed); delivers a recommendation, never code.
export interface ResearcherResult {
  schema: "orch.result/researcher/v1";
  run_id: string;
  verdict: "completed" | "failed";
  summary: string;
  recommendation: string;
  alternatives: string[];
  sources: string[];
  open_questions: string[];
  risks: string[];
}

export type RoleResult = ImplementerResult | ReviewerResult | VerifierResult | ControllerResult | ResearcherResult;

// Roles that write the worktree, and so must take the worktree lock and have
// their uncommitted diff collected as evidence. This is exactly the set with
// `project-write` sandbox posture: verifier runs real build/test commands that
// create artifacts in the worktree, so it must serialize against implementers
// on the same worktree, not race them lock-free. Kept in sync with
// sandboxPosture by a test (src/schema.test.ts).
export const writeRoles = new Set<RunRole>(["implementer", "verifier"]);

// Runtime validator for role strings arriving from CLI flags, mail events, or
// legacy spec.json files (which may carry retired roles such as debugger).
export function isRunRole(value: string): value is RunRole {
  return value === "implementer" || value === "reviewer" || value === "verifier" || value === "controller" || value === "researcher";
}
