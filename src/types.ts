export type RunRole =
  | "implementer"
  | "reviewer"
  | "verifier"
  | "controller"
  | "researcher"
  | "challenger"
  | "rework"
  | "debugger";

export type ResultRole = "implementer" | "reviewer" | "verifier" | "controller" | "researcher";

export type AgentName = "codex" | "claude" | "pi" | "omp";

export type ProviderSessionMode = "ephemeral" | "fresh_persistent" | "resume_exact";

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
  acceptance: Array<{ id: string; status: string }>;
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

export const writeRoles = new Set<RunRole>([
  "implementer",
  "challenger",
  "rework",
  "debugger",
]);

export function isResultRole(role: RunRole): role is ResultRole {
  return role === "implementer" || role === "reviewer" || role === "verifier" || role === "controller" || role === "researcher";
}
