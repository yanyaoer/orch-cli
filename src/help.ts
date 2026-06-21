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
    "  orch decision      Record accept/rework and queue a PR/MR mirror comment",
    "  orch mirror        Mirror a local run result summary to a PR/MR comment",
    "  orch mirror sync   Send queued outbox comments to a PR/MR",
    "  orch chatgpt-bridge  Deploy + connect the read-only ChatGPT bridge (Cloudflare Worker)",
    "  orch bundle        Export a self-contained context bundle for tool-less models",
    "",
    "Quickstart:",
    "  orch run create --mr 123 --role implementer --agent codex --tag impl-a --worktree . --task task.md",
    "  orch run list --mr 123 --worktree .",
    "  orch events tail --run impl-a-20260619T120000Z-abc123 --mr 123 -n 20",
    "  orch result --run impl-a-20260619T120000Z-abc123 --mr 123",
    "  orch decision accept --mr 123 --run impl-a-20260619T120000Z-abc123 --reason \"reviewed\"",
    "  orch mirror sync --mr 123",
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
    "  --agent <agent>           Headless provider driver: codex, claude, or pi (required)",
    "  --tag <tag>               Human-readable run id prefix; defaults to --role",
    "  --worktree <path>         Git worktree where the worker runs; defaults to the current directory",
    "  --task <file>             Task spec file passed to the worker; omitted means an empty task",
    "  --idempotency-key <key>   Reuse an existing run for the same key; defaults to mr<id>:<tag>:<task_sha>",
    "  --retry                   Create a new run even when --idempotency-key already exists",
    "  --allow-dirty             Acknowledge dirty write-role worktree and suppress the warning",
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

export function decisionHelp(): string {
  return lines([
    "orch decision: record a controller decision for one run",
    "",
    "Usage:",
    "  orch decision accept|rework --mr <id> --run <run_id> [--reason <text>] [--worktree <path>]",
    "",
    "Flags:",
    "  --mr <id>             Pull request or merge request id for the local state directory (required)",
    "  --run <run_id>        Local orch run id being accepted or sent back for rework (required)",
    "  --reason <text>       Optional human decision reason included in decision.json and the queued comment",
    "  --worktree <path>     Git worktree used to derive repo_key; defaults to the current directory",
    "  --help                Show this help",
    "",
    "Behavior:",
    "  Writes runs/<run_id>/decision.json locally.",
    "  Queues a comment payload in outbox/pending/; it does not touch the network.",
    "  Use orch mirror sync to dry-run or send queued outbox comments.",
    "",
    "Examples:",
    "  orch decision accept --mr 123 --run impl-a-20260619T120000Z-abc123 --reason \"reviewed\"",
    "  orch decision rework --mr 123 --run impl-a-20260619T120000Z-abc123",
  ]);
}

export function mirrorHelp(): string {
  return lines([
    "orch mirror: mirror a local run result or sync queued outbox comments to a PR/MR",
    "",
    "Usage:",
    "  orch mirror --mr <id> [--run <run_id>] [--worktree <path>] [--execute]",
    "  orch mirror sync --mr <id> [--worktree <path>] [--execute]",
    "",
    "Flags:",
    "  --mr <id>             Pull request or merge request id to comment on (required)",
    "  --run <run_id>        Local orch run id to mirror; defaults to the newest run for the MR",
    "  --worktree <path>     Git worktree used to derive repo_key and remote; defaults to the current directory",
    "  --execute             Execute the gh/glab command. Omitted means dry-run only",
    "  --help                Show this help",
    "",
    "Modes:",
    "  Without sync, mirrors one local run result directly and preserves the old dry-run output contract.",
    "  With sync, reads outbox/pending/*.json and sends queued comment payloads; successful sends move to outbox/sent/.",
    "",
    "Examples:",
    "  orch mirror --mr 123 --run impl-a-20260619T120000Z-abc123",
    "  orch mirror --mr 123 --run impl-a-20260619T120000Z-abc123 --execute",
    "  orch mirror sync --mr 123",
    "  orch mirror sync --mr 123 --execute",
    "  orch mirror --mr 123 --worktree /path/to/repo",
  ]);
}

export function mirrorSyncHelp(): string {
  return lines([
    "orch mirror sync: send queued outbox comments to a PR/MR",
    "",
    "Usage:",
    "  orch mirror sync --mr <id> [--worktree <path>] [--execute]",
    "",
    "Flags:",
    "  --mr <id>             Pull request or merge request id whose outbox should be synced (required)",
    "  --worktree <path>     Git worktree used to derive repo_key and remote; defaults to the current directory",
    "  --execute             Execute the gh/glab commands. Omitted means dry-run only",
    "  --help                Show this help",
    "",
    "Behavior:",
    "  Dry-run prints each gh/glab argv and does not touch the network.",
    "  --execute sends pending comments one by one.",
    "  Successful sends move from outbox/pending/ to outbox/sent/.",
    "  Failed sends stay in outbox/pending/ and local run or decision state is unchanged.",
    "",
    "Examples:",
    "  orch mirror sync --mr 123",
    "  orch mirror sync --mr 123 --execute",
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
        "  - Agent: codex, claude, or pi, the headless provider driver that will execute the task",
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
        "  Important files: spec.json, spec.sha256, status.json, events.jsonl, native.jsonl, stdout.log, stderr.log, result.json, artifacts/",
        "  MR outbox: ${XDG_STATE_HOME:-~/.local/state}/orch/<repo_key>/mrs/<mr>/outbox/{pending,sent}/",
        "",
        "Outbox:",
        "  Decision and queued mirror payloads are written locally first under outbox/pending/.",
        "  orch mirror sync is dry-run by default; --execute sends via gh/glab and moves successful payloads to outbox/sent/.",
        "  Failed sends remain pending and do not change local run or decision state.",
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
        "  orch mirror and orch mirror sync are dry-run by default. They print the gh/glab argv that would be executed and do not touch the network.",
        "  Pass --execute to run the planned forge command for real.",
        "",
        "Examples:",
        "  orch mirror --mr 123 --run impl-a-20260619T120000Z-abc123",
        "  orch mirror --mr 123 --run impl-a-20260619T120000Z-abc123 --execute",
        "  orch mirror sync --mr 123",
        "  orch mirror sync --mr 123 --execute",
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

export function chatgptBridgeHelp(): string {
  return lines([
    "orch chatgpt-bridge: deploy + connect the read-only ChatGPT bridge in one step",
    "",
    "Usage:",
    "  orch chatgpt-bridge [--worktree <path>] [--redeploy] [--no-connect] [--bridge-dir <path>]",
    "  orch chatgpt-bridge --url <ws(s)://host/ws> --token <T> [--worktree <path>] [--no-connect]",
    "",
    "Managed mode (no --url/--token):",
    "  On first run it deploys the Cloudflare Worker via wrangler, generates a strong",
    "  BRIDGE_TOKEN, derives the MCP/WebSocket URLs, and saves them to the config below.",
    "  Later runs reuse the saved Worker. It then registers the worktree and connects.",
    "  Requires wrangler on PATH and `wrangler login` (Cloudflare auth).",
    "",
    "Direct mode (--url + --token):",
    "  Connects to an already-running Worker (e.g. local `wrangler dev`) without",
    "  deploying or overwriting the saved Worker. Useful for local development.",
    "",
    "Flags:",
    "  --worktree <path>   Worktree the remote may read; defaults to the current directory",
    "  --redeploy          Force a fresh wrangler deploy + new token (managed mode)",
    "  --no-connect        Deploy/register and print the mcp_url, but do not connect",
    "  --bridge-dir <path> Worker source dir; defaults to the chatgpt-bridge dir in the repo",
    "  --url <url>         Direct mode: Worker WebSocket endpoint, e.g. wss://<worker>.workers.dev/ws",
    "  --token <token>     Direct mode: shared secret matching the Worker's BRIDGE_TOKEN",
    "  --help              Show this help",
    "",
    "Config: ${XDG_CONFIG_HOME:-$HOME/.config}/orch/chatgpt-bridge.json (mode 0600; holds token).",
    "Paste the printed mcp_url into ChatGPT → Settings → Apps → Developer mode → Create.",
    "",
    "The agent dials out over WebSocket (no inbound port / tunnel) and serves read-only",
    "tools scoped to the worktree: open_workspace, read, search, show_changes.",
    "",
    "Examples:",
    "  orch chatgpt-bridge --worktree .                 # deploy (first run) + connect",
    "  orch chatgpt-bridge --no-connect                 # deploy + print mcp_url only",
    "  orch chatgpt-bridge --url ws://localhost:8787/ws --token test   # local dev",
  ]);
}

export function bundleHelp(): string {
  return lines([
    "orch bundle: export a self-contained markdown context bundle for tool-less models",
    "",
    "Usage:",
    "  orch bundle [--worktree <path>] [--path <file>]... [--glob <pat>]... [flags]",
    "",
    "Why:",
    "  Some strong models (e.g. ChatGPT Pro / gpt-5.5-pro) reason without MCP tools and",
    "  cannot read your repo. This packs a repo snapshot (tree, status, diff, key files)",
    "  into one markdown file you paste in for review/planning. Execute the plan later",
    "  with `orch run create --agent codex|pi`.",
    "",
    "Flags:",
    "  --worktree <path>        Repo to snapshot; defaults to the current directory",
    "  --path <file>            Include this file (repeatable)",
    "  --glob <pat>             Include files matching this glob (repeatable)",
    "  --title <t>              Bundle title heading",
    "  --out <file>             Output path; defaults to <worktree>/.ai-bridge/pro-context.md",
    "  --copy                   Also copy the markdown to the clipboard (macOS pbcopy)",
    "  --no-diff                Skip the git diff section",
    "  --no-important-files     Do not auto-include important root files (README, package.json, ...)",
    "  --no-changed-files       Do not auto-include git-changed files",
    "  --max-files <n>          Max files embedded (default 24)",
    "  --max-file-bytes <n>     Max bytes per embedded file (default 60000)",
    "  --max-diff-bytes <n>     Max bytes of git diff (default 80000)",
    "  --max-total-bytes <n>    Max total bundle bytes before truncation (default 700000)",
    "  --help                   Show this help",
    "",
    "Safety:",
    "  All paths pass the bridge path guard; .env, private keys, .git, and node_modules",
    "  are always excluded, and obvious inline secrets are redacted.",
    "",
    "Examples:",
    "  orch bundle --worktree .",
    "  orch bundle --path src/orch.ts --glob 'src/**/*.ts' --copy",
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
