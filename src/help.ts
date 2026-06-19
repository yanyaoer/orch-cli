export type HelpTopic = "task-spec" | "result" | "events" | "concepts" | "forge";

export const HELP_TOPICS: HelpTopic[] = ["task-spec", "result", "events", "concepts", "forge"];

function lines(items: string[]): string {
  return `${items.join("\n")}\n`;
}

export function topLevelHelp(): string {
  return lines([
    "orch: daemonless multi-agent orchestrator",
    "",
    "Commands:",
    "  orch run create    Start one headless worker run for an MR task",
    "  orch run list      List local runs for an MR",
    "  orch events tail   Print a run's local events.jsonl",
    "  orch result        Print a run's local result.json",
    "  orch status        Read local run status for an MR",
    "  orch mirror        Mirror a local run result summary to a PR/MR comment",
    "",
    "Quickstart:",
    "  orch run create --mr 123 --role implementer --agent codex --tag impl-a --worktree . --task task.md",
    "  orch run list --mr 123 --worktree .",
    "  orch events tail --run impl-a-20260619T120000Z-abc123 --mr 123 -n 20",
    "  orch result --run impl-a-20260619T120000Z-abc123 --mr 123",
    "  orch status --mr 123 --json",
    "  cat ${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mrs/123/runs/<run_id>/result.json",
    "",
    "Use:",
    "  orch <command> --help",
    "  orch help <topic>",
    "",
    "Topics:",
    "  task-spec | result | events | concepts | forge",
  ]);
}

export function runCreateHelp(): string {
  return lines([
    "orch run create: start a supervised headless worker run",
    "",
    "Usage:",
    "  orch run create --mr <id> --role <role> --agent <agent> --tag <tag> --worktree <path> --task <file> [flags]",
    "",
    "Flags:",
    "  --mr <id>                 MR or task id used under the local state directory (required)",
    "  --role <role>             Result role: implementer, reviewer, or verifier (required)",
    "  --agent <agent>           Headless provider driver: codex or claude (required)",
    "  --tag <tag>               Human-readable run id prefix; defaults to --role",
    "  --worktree <path>         Git worktree where the worker runs; defaults to the current directory",
    "  --task <file>             Task spec file passed to the worker; omitted means an empty task",
    "  --idempotency-key <key>   Reuse an existing run for the same key; defaults to mr<id>:<tag>:<task_sha>",
    "  --retry                   Create a new run even when --idempotency-key already exists",
    "  --timeout-sec <seconds>   Worker timeout; defaults to 14400",
    "  --help                    Show this help",
    "",
    "Example:",
    "  orch run create --mr 123 --role implementer --agent codex --tag impl-a --worktree . --task task.md --timeout-sec 3600",
  ]);
}

export function runListHelp(): string {
  return lines([
    "orch run list: list local runs for an MR",
    "",
    "Usage:",
    "  orch run list --mr <id> [--worktree <path>] [--json]",
    "",
    "Flags:",
    "  --mr <id>             MR or task id whose local runs should be listed (required)",
    "  --worktree <path>     Git worktree used to derive repo_key; defaults to the current directory",
    "  --json                Print a machine-readable array instead of an aligned table",
    "  --help                Show this help",
    "",
    "Output fields:",
    "  run_id, role, agent, tag, state, started_at, exit_code",
    "",
    "Examples:",
    "  orch run list --mr 123 --worktree .",
    "  orch run list --mr 123 --json",
  ]);
}

export function statusHelp(): string {
  return lines([
    "orch status: read local status for all runs in an MR",
    "",
    "Usage:",
    "  orch status --mr <id> [--json] [--worktree <path>]",
    "",
    "Flags:",
    "  --mr <id>             MR or task id whose local runs should be read (required)",
    "  --json                Print machine-readable JSON instead of a tabular summary",
    "  --worktree <path>     Git worktree used to derive repo_key; defaults to the current directory",
    "  --help                Show this help",
    "",
    "Example:",
    "  orch status --mr 123 --json --worktree .",
  ]);
}

export function eventsTailHelp(): string {
  return lines([
    "orch events tail: print a run's local events.jsonl",
    "",
    "Usage:",
    "  orch events tail --run <run_id> [--mr <id>] [--worktree <path>] [-n <lines>]",
    "",
    "Flags:",
    "  --run <run_id>        Local orch run id to read (required)",
    "  --mr <id>             MR or task id containing the run; omitted scans this repo's local MR state",
    "  --worktree <path>     Git worktree used to derive repo_key; defaults to the current directory",
    "  -n <lines>            Print only the last N lines; omitted prints the whole file",
    "  --help                Show this help",
    "",
    "Examples:",
    "  orch events tail --run impl-a-20260619T120000Z-abc123 --mr 123",
    "  orch events tail --run impl-a-20260619T120000Z-abc123 --worktree . -n 20",
  ]);
}

export function resultCommandHelp(): string {
  return lines([
    "orch result: print a run's local result.json",
    "",
    "Usage:",
    "  orch result --run <run_id> [--mr <id>] [--worktree <path>] [--json]",
    "",
    "Flags:",
    "  --run <run_id>        Local orch run id to read (required)",
    "  --mr <id>             MR or task id containing the run; omitted scans this repo's local MR state",
    "  --worktree <path>     Git worktree used to derive repo_key; defaults to the current directory",
    "  --json                Print result.json exactly as stored",
    "  --help                Show this help",
    "",
    "Human output:",
    "  Prints schema, verdict, and summary. Implementer results also include changed_files and tests.",
    "",
    "Examples:",
    "  orch result --run impl-a-20260619T120000Z-abc123 --mr 123",
    "  orch result --run impl-a-20260619T120000Z-abc123 --worktree . --json",
  ]);
}

export function mirrorHelp(): string {
  return lines([
    "orch mirror: mirror a local run result to a PR/MR",
    "",
    "Usage:",
    "  orch mirror --mr <id> [--run <run_id>] [--worktree <path>] [--execute]",
    "",
    "Flags:",
    "  --mr <id>             Pull request or merge request id to comment on (required)",
    "  --run <run_id>        Local orch run id to mirror; defaults to the newest run for the MR",
    "  --worktree <path>     Git worktree used to derive repo_key and remote; defaults to the current directory",
    "  --execute             Execute the gh/glab command. Omitted means dry-run only",
    "  --help                Show this help",
    "",
    "Examples:",
    "  orch mirror --mr 123 --run impl-a-20260619T120000Z-abc123",
    "  orch mirror --mr 123 --run impl-a-20260619T120000Z-abc123 --execute",
    "  orch mirror --mr 123 --worktree /path/to/repo",
  ]);
}

export function topicHelp(topic: HelpTopic): string {
  switch (topic) {
    case "task-spec":
      return lines([
        "orch help task-spec",
        "",
        "--task points to the instruction file for one worker run. The file is captured into the run spec so the worker can be replayed and audited without reading external docs.",
        "",
        "A useful task file includes:",
        "  - Goal: the concrete change, review, or verification to perform",
        "  - Role: implementer writes code, reviewer audits an existing run, verifier executes checks",
        "  - Agent: codex or claude, the headless provider driver that will execute the task",
        "  - Worktree: the absolute or relative repository checkout where commands should run",
        "  - Acceptance: explicit checks the worker must claim or prove",
        "",
        "Worker contract:",
        "  - The worker must finish by producing result.json in the run directory.",
        "  - result.json must use the schema for its role: orch.result/implementer/v1, reviewer/v1, or verifier/v1.",
        "  - The supervisor validates required fields before marking the run done.",
        "",
        "Example task.md:",
        "  Role: implementer",
        "  Worktree: /path/to/repo",
        "  Goal: add progressive help to the orch CLI.",
        "  Acceptance: build succeeds, tests pass, help topics print useful command guidance.",
      ]);
    case "result":
      return lines([
        "orch help result",
        "",
        "Every run ends with result.json. The schema field identifies the role-specific shape.",
        "",
        "implementer: orch.result/implementer/v1",
        "  Key fields: verdict, summary, base_sha, head_sha, changed_files[], tests[], acceptance[], risks[], rollback",
        "  tests[] items include cmd, exit_code, summary",
        "  acceptance[] items include id, status, evidence",
        "",
        "reviewer: orch.result/reviewer/v1",
        "  Key fields: verdict, reviews_run_id, blocking_findings[], non_blocking_findings[], suggested_tests[]",
        "  verdict is approve or request_changes",
        "  blocking findings include id, severity, file, body",
        "",
        "verifier: orch.result/verifier/v1",
        "  Key fields: verdict, verifies_run_id, commands[], acceptance[]",
        "  verdict is pass or fail",
        "  commands[] items include cmd, exit_code, summary",
        "",
        "Main controllers should read result.json for decisions; provider-native output is retained separately for debugging.",
      ]);
    case "events":
      return lines([
        "orch help events",
        "",
        "Orch events are the normalized local event stream for a run. They live at:",
        "  ${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mrs/<mr>/runs/<run_id>/events.jsonl",
        "",
        "Each line is one JSON object with type, seq, and ts. MVP event types are created, starting, running, heartbeat, done, failed, and timeout.",
        "",
        "Provider-native JSON or text is stored separately in native.jsonl, stdout.log, and stderr.log. Do not treat provider-native records as orch events.",
        "",
        "MR-facing progress messages may use an orch-evt prefix as a mirror, but the local events.jsonl file is the source a controller should poll.",
      ]);
    case "concepts":
      return lines([
        "orch help concepts",
        "",
        "Role permissions:",
        "  implementer, challenger, rework, and debugger are write roles and take a worktree lock.",
        "  reviewer and verifier inspect immutable artifacts and do not take the worktree write lock.",
        "",
        "Run state machine:",
        "  created -> starting -> running -> done",
        "  exceptional terminal states: failed, timeout, cancelled, stale",
        "",
        "State directory layout:",
        "  ${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mrs/<mr>/runs/<run_id>/",
        "  Shorthand: ${XDG_STATE_HOME:-~/.local/state}/orch/<repo_key>/mrs/<mr>/runs/<run_id>/",
        "  Important files: spec.yml, spec.sha256, status.json, events.jsonl, native.jsonl, stdout.log, stderr.log, result.json, artifacts/",
        "",
        "Idempotency and locks:",
        "  A1: repeating run create with the same idempotency key returns the existing run instead of dispatching another worker.",
        "  A2: only one write-role run may hold a given worktree lock at a time.",
        "  The default idempotency key is mr<id>:<tag>:<task_sha>; override it with --idempotency-key and force a new attempt with --retry.",
        "",
        "Forge adapter:",
        "  orch can derive GitHub or GitLab from the repository remote and mirror local result summaries with gh or glab.",
      ]);
    case "forge":
      return lines([
        "orch help forge",
        "",
        "The forge adapter chooses the PR/MR CLI from the current repository remote:",
        "  github.com remotes use gh and GitHub pull requests.",
        "  gitlab.com and self-hosted non-GitHub git hosts use glab and GitLab merge requests.",
        "  missing, local, or unparsable remotes are forge=none and mirror is skipped.",
        "",
        "Safety:",
        "  orch mirror is dry-run by default. It prints the gh/glab argv that would be executed and does not touch the network.",
        "  Pass --execute to run the planned forge command for real.",
        "",
        "Examples:",
        "  orch mirror --mr 123 --run impl-a-20260619T120000Z-abc123",
        "  orch mirror --mr 123 --run impl-a-20260619T120000Z-abc123 --execute",
      ]);
  }
}

export function unknownTopicHelp(topic: string): string {
  return lines([
    `unknown help topic: ${topic}`,
    "",
    "Available topics:",
    `  ${HELP_TOPICS.join(" | ")}`,
    "",
    "Use:",
    "  orch help <topic>",
  ]);
}

export function runHelp(): string {
  return lines([
    "orch run commands:",
    "  orch run create    Start one headless worker run for an MR task",
    "  orch run list      List local runs for an MR",
    "",
    "Use:",
    "  orch run create --help",
    "  orch run list --help",
  ]);
}
