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
  // Snapshot of config.json `sandbox_write_dirs` at spec creation: extra
  // user-declared write subpaths for this run. The driver re-vets each entry
  // fail-closed before granting; orch's own config dir and state root are
  // never grantable.
  sandbox_write_dirs?: string[];
  // Worktree snapshot orch itself captured at create (never model-reported):
  // the HEAD + content this run was dispatched against. Absent on legacy specs.
  snapshot?: VcsSnapshot;
  // Full commit id pinned with `run create --head`; the supervisor refuses to
  // start a reviewer/verifier whose checkout is no longer at it.
  pinned_head?: string;
  // Earlier runs of the same role in this MR that this run replaces
  // (--supersedes, --resume-from, --retry). Aggregation drops a superseded
  // run's evidence once this run is done.
  supersedes?: string[];
}

// Host-captured worktree identity. content_sha equals head when the checkout
// is clean; otherwise it hashes the uncommitted diff plus untracked files.
export interface VcsSnapshot {
  vcs: "git" | "jj";
  head: string;
  dirty: boolean;
  content_sha: string;
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
  // Provider (driver) process; its process group is what cancel/timeout kill.
  pid: number | null;
  pgid: number | null;
  // The supervisor process that owns the run until it writes the terminal
  // state. Liveness is judged on this, not on pid: the provider legitimately
  // exits before the supervisor finishes collecting evidence and the result.
  // Absent on runs created by older versions (pid is used instead).
  supervisor_pid?: number | null;
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
  // Snapshots the supervisor captured after taking the worktree lock and after
  // the worker exited. A reviewer/verifier result is evidence only for this
  // snapshot, and only when both exist, match, and snapshot_error is unset.
  start_snapshot?: VcsSnapshot | null;
  end_snapshot?: VcsSnapshot | null;
  snapshot_error?: string | null;
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

export type CommandStatus = "passed" | "failed" | "skipped";

export interface CommandResult {
  cmd: string;
  // null only for status "skipped": a check that never ran has no exit code.
  exit_code: number | null;
  summary: string;
  // Absent on legacy results: derived from exit_code vs expected_exit_code.
  status?: CommandStatus;
  // Negative tests: the exit code that counts as passing (default 0).
  expected_exit_code?: number;
  // Marks a check the verdict does not depend on; only optional checks may be
  // skipped under a verifier pass.
  optional?: boolean;
}

export interface AcceptanceResult {
  id: string;
  status: string;
  evidence?: string;
  // See CommandResult.optional.
  optional?: boolean;
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

// Read-only roles that take the worktree lock in shared mode: many reviewers
// may read one checkout together, but never while a writer holds it.
// controller/researcher take no lock — a long-lived controller must not block
// the writers it dispatches onto its own checkout.
export const sharedLockRoles = new Set<RunRole>(["reviewer"]);

// Roles whose good verdict is evidence about a specific candidate snapshot:
// their approval/pass counts only when bound to the current candidate.
export const evidenceRoles = new Set<RunRole>(["reviewer", "verifier"]);

// Runtime validator for role strings arriving from CLI flags, mail events, or
// legacy spec.json files (which may carry retired roles such as debugger).
export function isRunRole(value: string): value is RunRole {
  return value === "implementer" || value === "reviewer" || value === "verifier" || value === "controller" || value === "researcher";
}
