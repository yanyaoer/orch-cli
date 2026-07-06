# orch — daemonless multi-agent orchestrator (CLI)

Dispatches headless AI workers (codex / claude / pi / omp) against a git worktree,
supervises them, and records auditable per-run state under `XDG_STATE`. No daemon.
Repo: `github.com/yanyaoer/orch-cli`.

Full usage lives in the CLI itself: `orch --help`, `orch <cmd> --help`,
`orch help <task-spec|result|events|concepts|forge>`.

Install: `curl -fsSL https://raw.githubusercontent.com/yanyaoer/orch-cli/main/install.sh | sh`
(latest release binary → `~/.local/bin`); upgrade with `orch update` (`--check` to compare only).

## When to use what
- **Not sure what needs attention? Run bare `orch`** → the overview: active runs +
  every pending action (undecided runs, stale runs, pending outbox) as runnable
  command lines; add `--json` when a controller consumes it, `--all` for every
  repo. It is a notification center, not a debt ledger: items idle beyond
  `--attention-days` (default 14, 0 disables) age out, and mrs whose name is a
  local branch already merged into HEAD auto-archive. Clear backlog in one go
  with `orch decision sweep --execute` (accept/rework/close per the overview's
  rubric, no mirror comments); `orch decision close` acks a single run quietly.
  Controller loop for fan-out threads: `orch wait --thread <id>` blocks
  until the next run needs attention (decision = ack; returns `settled` when
  done); `orch verdict --thread <id> --wait` waits for the whole thread and
  suggests accept / rework / inspect.
- **Run a headless worker** to implement / review / verify a task → `orch run create`
  (driver = codex|claude|pi|omp, role = implementer|reviewer|verifier). Read the result
  with `orch status` / `orch result`; record `orch decision` and `orch mirror` it to
  the PR/MR comment.
- **omp = oh-my-pi, model-aware with quota fallback** → defaults to
  `google-antigravity/gemini-3.1-pro` and falls back to
  `zenmux/anthropic/claude-fable-5`, then `openai-codex/gpt-5.5` when the active
  model's quota/rate limit is exhausted (omp-native `retry.fallbackChains` via a
  per-run config overlay). An explicit `--model <ref>` becomes the primary; the
  rest of the chain stays as fallbacks. Runs ephemeral (one-shot) by default.
- **Permissions match the role** → the `reviewer` role launches every provider
  read-only (claude plan mode / codex `--sandbox read-only` / pi and omp
  read-only tools). `verifier` and write roles keep write-capable access (verifier
  must run tests; write roles edit the worktree).
- **claude model/effort match the role** → `reviewer` escalates the claude driver
  to `--model opus --effort high` (deep critique, a stronger second opinion
  alongside omp's Gemini 3.1 Pro in `cross-review`); `implementer` stays on the
  CLI's default model (sonnet) at `--effort medium`; `verifier` stays on sonnet at
  `--effort low` (mechanical test/acceptance checks, cheapest tier). An explicit
  `orch run create --model <ref>` is recorded in `spec.json` and overrides the
  provider model for model-aware drivers such as pi, omp, codex, and claude.
- **Fan one task across agents (mail-native)** → `orch cross-review`
  (claude+omp review one diff), `orch fanout --role <r>` (generic, any result
  role), `orch investigate` (read-only research, defaults to omp+claude). These
  route through the mail layer: pass `--thread <id>` (it supplies the mr + the
  workspace worktree — **no `--mr` needed**), `--task <file>`, and optionally
  `--to-agent <mail-agent-id>` (repeatable) to override the default roster. Each
  publishes one task per agent then claims+runs it; re-running a thread skips
  acked tasks. Needs `orch mail agent defaults` once. `--dry-run` shows the
  resolved agents without publishing. Follow with `orch status` / `orch result`.
- **Drive orch by email** → `orch mailctl` (init/poll/watch/status/reply/ack/guidance):
  an allowlisted, authenticated sender emails a task; `poll` ingests it (IMAP) and
  auto-spawns a claude **controller** run that fans work out and replies in-thread
  (SMTP). The controller itself only has `Bash(orch *)` + read-only tools — it
  orchestrates via the same orch commands, never edits code. Setup + auth/security
  detail live in the README; run `orch mailctl --help`.
- **Watch what a worker is doing** → `orch events tail --run <id> --native`:
  renders the provider-native stream (`native.jsonl`) as normalized progress
  events (`session` / `assistant` / `tool_use` / `tool_result` / `usage` /
  `final` / `raw`), provider-independent — no per-provider parsing. Add `-f`
  to stream live until the run ends (auto-exits on terminal/stale); `-f`
  without `--run` multiplexes every active run in the repo (and runs created
  while following) with tail-style `==> mr/run <==` headers until Ctrl-C.
  Lifecycle authority stays with plain `orch events tail` (events.jsonl) +
  `orch status`.
- **Let ChatGPT read this repo live** (a *tool-capable* model, gpt-5.5 non-Pro) →
  `orch chatgpt-bridge`: deploys a Cloudflare Worker MCP bridge (no tunnel) so
  ChatGPT Developer Mode can read the worktree. ⚠️ ChatGPT **Pro / heavy-reasoning
  modes don't mount MCP connector tools** — pick a non-Pro model, or use handoff-pro.
- **Hand a strong but tool-less model a full snapshot** (e.g. gpt-5.5-pro Pro mode) →
  `orch handoff-pro`: packs the repo (tree, diff, key files) into one markdown blob
  to paste in; it returns a plan you execute via `orch run create`.

## Division of labor
Strong model plans (via handoff-pro); tool-capable workers (codex / pi / gpt-5.5)
execute; omp (gemini-3.1-pro with quota fallback to claude-fable-5, then gpt-5.5)
covers review / research; orch orchestrates and keeps all run state auditable
under XDG_STATE.
