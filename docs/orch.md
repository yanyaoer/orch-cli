# orch — daemonless multi-agent orchestrator (CLI)

Dispatches headless AI workers (codex / claude / pi / agy) against a git worktree,
supervises them, and records auditable per-run state under `XDG_STATE`. No daemon.
Repo: `github.com/yanyaoer/orch-cli`.

Full usage lives in the CLI itself: `orch --help`, `orch <cmd> --help`,
`orch help <task-spec|result|events|concepts|forge>`.

## When to use what
- **Run a headless worker** to implement / review / verify a task → `orch run create`
  (driver = codex|claude|pi|agy, role = implementer|reviewer|verifier). Read the result
  with `orch status` / `orch result`; record `orch decision` and `orch mirror` it to
  the PR/MR comment.
- **agy = gemini-3.1-pro, `reviewer` role only** → review, research, read-only
  analysis. orch rejects agy for every other role; it runs sandboxed (`--sandbox`),
  ephemeral (one-shot), and defaults to Gemini 3.1 Pro.
- **Permissions match the role** → the `reviewer` role launches every provider
  read-only (claude plan mode / codex `--sandbox read-only` / pi read-only tools /
  agy `--sandbox`). `verifier` and write roles keep write-capable access (verifier
  must run tests; write roles edit the worktree).
- **claude model/effort match the role** → `reviewer` escalates the claude driver
  to `--model opus --effort high` (deep critique, a stronger second opinion
  alongside agy's Gemini 3.1 Pro in `cross-review`); `implementer` stays on the
  CLI's default model (sonnet) at `--effort medium`; `verifier` stays on sonnet at
  `--effort low` (mechanical test/acceptance checks, cheapest tier). An explicit
  `orch run create --model <ref>` is recorded in `spec.json` and overrides the
  provider model for model-aware drivers such as pi, codex, and claude.
- **Fan one task across agents (mail-native)** → `orch cross-review`
  (claude+agy review one diff), `orch fanout --role <r>` (generic, any result
  role), `orch investigate` (read-only research, defaults to agy+claude). These
  route through the mail layer: pass `--thread <id>` (it supplies the mr + the
  workspace worktree — **no `--mr` needed**), `--task <file>`, and optionally
  `--to-agent <mail-agent-id>` (repeatable) to override the default roster. Each
  publishes one task per agent then claims+runs it; re-running a thread skips
  acked tasks. Needs `orch mail agent defaults` once. `--dry-run` shows the
  resolved agents without publishing. Follow with `orch status` / `orch result`.
- **Watch what a worker is doing** → `orch events tail --run <id> --native`:
  renders the provider-native stream (`native.jsonl`) as normalized progress
  events (`session` / `assistant` / `tool_use` / `tool_result` / `usage` /
  `final` / `raw`), provider-independent — no per-provider parsing. Lifecycle
  authority stays with plain `orch events tail` (events.jsonl) + `orch status`.
- **Let ChatGPT read this repo live** (a *tool-capable* model, gpt-5.5 non-Pro) →
  `orch chatgpt-bridge`: deploys a Cloudflare Worker MCP bridge (no tunnel) so
  ChatGPT Developer Mode can read the worktree. ⚠️ ChatGPT **Pro / heavy-reasoning
  modes don't mount MCP connector tools** — pick a non-Pro model, or use handoff-pro.
- **Hand a strong but tool-less model a full snapshot** (e.g. gpt-5.5-pro Pro mode) →
  `orch handoff-pro`: packs the repo (tree, diff, key files) into one markdown blob
  to paste in; it returns a plan you execute via `orch run create`.

## Division of labor
Strong model plans (via handoff-pro); tool-capable workers (codex / pi / gpt-5.5)
execute; agy (gemini-3.1-pro) does read-only review / research; orch orchestrates
and keeps all run state auditable under XDG_STATE.
