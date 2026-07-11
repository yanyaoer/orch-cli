# Changelog

All notable user-facing changes are recorded here.

## [Unreleased]

### Features

- New `researcher` result role (architect / deep research): read-only, web-research capable, delivers a plan instead of code. Claude runs `fable` at `xhigh` effort under a `dontAsk` whitelist (`jina`/`tvly` CLIs + WebSearch/WebFetch + read-only repo tools, no Edit/Write); codex defaults to `gpt-5.6-sol` at `xhigh` reasoning with native web search enabled inside the read-only sandbox (which blocks shell network, so web CLIs ride codex's `web_search` tool instead); omp rides its gemini quota-fallback chain with read-only tools (repo-internal research, no web). pi is not supported; no worktree lock. Result schema `orch.result/researcher/v1`: `verdict`, `summary`, `recommendation`, `alternatives[]`, `sources[]`, `open_questions[]`, `risks[]`. `orch mail agent defaults` now also binds `codex-researcher` + `claude-researcher` (auto-invited) and `omp-researcher` (explicit), so `orch fanout --role researcher` fans one question across both strong-reasoning stacks.
- `orch investigate` now dispatches the `researcher` role (default agents `omp-researcher` + `claude-researcher`): research questions deliver a recommendation instead of being coerced into a reviewer approve/request_changes verdict.

### Changes

- Removed the never-dispatchable `challenger`, `rework`, and `debugger` roles: both the run gate and the mail claim path always rejected them, so they existed only in types, roster bindings, and controller guidance. `implementer` is now the only write role; rework/debug follow-ups are implementer runs dispatched with `--resume-from` and a tag. Run `orch mail agent defaults` to refresh roster bindings.
- omp quota-fallback chain tail bumped from `openai-codex/gpt-5.5` to `openai-codex/gpt-5.6`.

## [0.0.7] - 2026-07-07

### Features

- `orch search <regex>` — regex-scan the current repo's local run files (`result.json`, `events.jsonl`, `native.jsonl`, `artifacts/*.{txt,log,patch}`) plus mail `mail-events.jsonl` diagnostics, with `--json` for machine consumption. Pure file scan, no index: "which run hit this error" stops being a hand-rolled grep over the state tree.
- `orch usage run|thread|daily` — aggregate provider token usage from normalized native usage events per run, per fan-out thread, or per day. Missing token data is reported as `has_token_data=false`, never as zero; models without pricing are listed under `unpriced_models` with `estimated_cost_usd=null`.
- `orch cross-review --auto [--execute] [--wait-sec N]` — inline the review follow-up ritual: wait for this fan-out's runs to settle, record the unambiguous decisions (approve + 0 blocking → accept, real blocking findings → rework), and queue ONE merged mirror comment covering every run. Dry-run preview by default; `--execute` posts it (and only this comment, never the outbox backlog) under the outbox lock. Uncertain results are surfaced, never auto-decided: driver schema fallbacks get their raw review recovered from `result.raw.md` (JSONL event streams are refused as machine logs), failed/timeout/stale runs land in `attention` with the exact follow-up command, and rework dispatch stays a human/controller call. Comment sections are sanitized (worktree prefix relativized, `$HOME` → `~`); a section still carrying a private path marker is withheld with a pointer to `orch result --run` instead of aborting.
- `orch run create --resume-from <run_id>` — continue a prior run's provider session with a new task: the worker keeps its accumulated context (files read, reasoning, provider prompt cache) instead of re-reading the repo from zero. Inherits agent/role/mr/worktree/model from the prior run unless overridden; `--agent` and the `--session-*` flags conflict with it. Only terminal, non-ephemeral runs with a recorded provider session id are resumable. Typical use: dispatch the rework run against the implementer run the reviewer's blocking findings were about.
- Mirror comments now carry the full structured result (blocking/non-blocking findings, suggested tests, commands, acceptance), not just the summary line.

## [0.0.6] - 2026-07-04

### Features

- `orch mailctl` — drive orch by real email over IMAP/SMTP (the mail controller). An allowlisted, authenticated sender emails a task; `orch mailctl poll` (the primary cron/launchd contract) ingests it over a zero-dependency IMAP client, publishes a router task, and auto-spawns a headless claude **controller** run that fans the work out (`orch fanout`/`cross-review`), records `orch decision`s, and replies progress over SMTP in the same email thread. `orch mailctl watch` is a foreground IMAP-IDLE convenience — a long-running process, but not a background daemon. Subcommands: `init` / `poll` / `watch` / `status` / `reply` / `ack` / `guidance`. Works with any IMAP/SMTP provider (Gmail via an app password). Inbound email is treated as an authentication boundary: the `From` allowlist is backed by an `Authentication-Results` header pinned to a trusted authserv-id (dkim/dmarc `pass` + domain alignment, evaluated on the top-most trusted instance only, fail-closed) plus an optional subject token; task text comes only from a real `text/plain` part (HTML-only mail is refused with `rejected_html`, so HTML/CSS hidden text can never become task instructions); ingestion is exactly-once via `messages/<sha>` markers; the controller runs with `Bash(orch *)` + read-only tools (it orchestrates, it does not edit code); outbound replies run a mail-specific leak scan.
- New `controller` result role and `orch.result/controller/v1` schema (`verdict`, `summary`, `actions`) — claude-only, kept out of `writeRoles` (no worktree lock), launched with a `Bash(orch *)` + read-only allowed-tools whitelist so "orchestrate, don't edit" is a mechanism, not a prompt.
- Persistent constraint layer: `docs/adr/` (architecture decisions) and `docs/specs/` (task/feature specs). When those constraints shape an `orch --task` file, the binding excerpts are inlined so the run stays replayable from `spec.json`. Added controller triage discipline and a hardened spec template.

### Fixes

- IMAP and SMTP socket clients now wait for the socket `open` (TLS handshake) before reading the greeting or writing the first command, and the IMAP client consumes the mandatory server greeting up front — fixing a stall / dropped first write against live servers such as Gmail.
- The mail controller task is launched with `--permission-mode dontAsk` and an explicit headless directive so a real controller executes its `orch` commands directly instead of stalling in plan mode.

## [0.0.5] - 2026-07-04

### Features

- One-line install and self-update: `curl -fsSL https://raw.githubusercontent.com/yanyaoer/orch-cli/main/install.sh | sh` downloads the latest release binary for the current platform into `~/.local/bin` (override with `ORCH_INSTALL_DIR` / pin with `ORCH_VERSION`). The new `orch update` queries the latest GitHub release, downloads the matching asset, probes it with `--version`, and atomically replaces the running executable (`--check` only compares versions; source checkouts are told to `git pull && bun run install:local`). `orch --version` prints the CLI version.

- The overview is now a notification center, not a permanent debt ledger: terminal-but-undecided runs, stale runs, and pending outbox comments idle for more than `--attention-days` (default 14, `0` disables) sink into an `aged out` counter instead of NEEDS ACTION, and mrs whose name matches a local branch already merged into HEAD (and not pointing at HEAD) are archived wholesale — still-running workers stay visible. Added `orch decision close` (a pure ack that queues no mirror comment, for runs that are neither accepted nor sent to rework) and `orch decision sweep [--execute]`, which batch-acks every undecided terminal run using the overview's own rubric (good verdict → accept, bad verdict → rework, failed/missing result → close) without queueing mirror comments.

- Replaced the `agy` driver with `omp` (oh-my-pi). `omp` is model-aware and not role-restricted: it defaults to `google-antigravity/gemini-3.1-pro` and automatically falls back to `zenmux/anthropic/claude-fable-5`, then `openai-codex/gpt-5.5` when the active model's quota/rate limit is exhausted (via omp's native `retry.fallbackChains`, configured per run through a `--config` overlay in the run dir). An explicit `--model <ref>` becomes the primary and the remaining chain models stay as fallbacks. The reviewer role runs with read-only tools; the prompt is passed as an `@file` argument (omp print mode ignores stdin). The default mail roster and `cross-review`/`investigate` now use `omp-reviewer` instead of `agy-reviewer` (run `orch mail agent defaults` to upsert).

- Bare `orch` now prints the global overview: active runs plus every pending action (undecided terminal runs, stale runs, pending outbox comments) expressed as a runnable orch command line. Text and `--json` are projections of the same aggregation, so the command a human copies and the argv an agent spawns are identical. `--all` scans every repo under the state root. (`orch --help` still prints the command reference.)
- Added `orch verdict --thread <id> [--wait]`: aggregates a fan-out thread's run verdicts into one suggestion (accept / rework / inspect / pending / reap) with runnable decision commands per undecided run.
- Added `orch wait --thread <id>`: wait-any primitive that blocks until the next run in a thread needs attention, returning one JSON event (`run_terminal` / `stale` / `settled`). A recorded decision acts as the ack, so handled runs are never returned again — a controller loops `orch wait` → handle → `orch wait` until settled.

### Safety and Reliability

- `orch decision` is now an atomic ack: `decision.json` is created with `O_EXCL`, so two controllers racing on the same run get one winner and one clear `already decided` error instead of a silent overwrite plus a second queued mirror comment. This makes the `orch wait` → decision loop safe with multiple controllers.
- Serialized concurrent `orch mirror sync --execute` per MR outbox with a pidfile lock; previously two parallel executes could both send the same pending comment before either renamed it into `sent/`.

## [0.0.4] - 2026-07-03

### Usage-driven interface improvements

- `--mr` is now optional almost everywhere. `run create` resolves it from an `MR: <id-or-url>` line in the task's leading header block, then a GitLab merge-request / GitHub pull URL in the task text, then the current branch name (the source is reported as `mr_source`). `status`, `run list`, and `run reap` aggregate across all MRs in the repo when `--mr` is omitted, and `decision` locates the MR from the run id. `mirror` keeps requiring `--mr` since it posts to a real PR/MR number. Scan paths report the raw recorded mr value, not the sanitized state-directory name. Note: `run reap` (unreleased) reports `reaped`/`still_running` as `{mr, run_id}` rows.

- Result extraction now coerces benign schema deviations (verdict synonyms, object items in string arrays, string items in finding arrays, model-invented run ids) instead of discarding the whole result; replaying 49 real fallback runs recovered 5 outright.
- When extraction still fails, the worker's raw final message is preserved as `result.raw.md` in the run dir and excerpted in the fallback summary, so `orch result` always has readable content (36 of 49 historical fallbacks).
- A provider that exits 0 without producing any output now fails the run with an auth/session hint instead of quietly reporting `done`.
- `orch result` renders reviewer findings and verifier commands/acceptance (previously only implementer results were expanded), and gained `--wait`/`--wait-sec` to block until the run reaches a terminal state.
- `orch status` / `orch run list` flag non-terminal runs whose pid is gone as `stale?` (read-only check); the new `orch run reap --mr <id>` persists them as `stale`.
- Reviewer runs now default to a 3600s timeout (52 of 67 recorded runs overrode the old 4h default); other roles keep 14400s.
- Unknown top-level commands print `unknown command: …` before the help text, and missing-flag errors print clean messages instead of stack traces.
- Fixed a flag-parsing bug where a boolean flag directly before `-n` swallowed it as its value (`orch events tail --native -n 20` previously ignored both flags).

### Safety and Reliability

- Hardened the agy driver as a second line of defense: the driver layer now refuses any non-reviewer role outright (the `--dangerously-skip-permissions` fallback is gone) and rejects prompts over 512KB with a clear error instead of an opaque argv-size failure.
- Serialized fan-out publishing with a per-thread lock so concurrent `cross-review`/`fanout`/`investigate` invocations no longer publish duplicate tasks and duplicate runs.
- Made the MR lock wait briefly on contention instead of failing `run create`, so fan-out claims that start runs on the same MR concurrently succeed.
- Forwarded `--model` from the fan-out commands to each spawned run; previously it was silently ignored on that path.
- `run create` and the fan-out commands now reject unknown flags instead of silently ignoring typos.
- The supervisor now records a failed terminal state when `spec.json` is missing or corrupt instead of leaving the run stuck in `created`.
- Forge detection matches the GitHub host exactly; lookalike hosts such as `github.com.attacker.net` no longer classify as GitHub.
- Invalid outbox payloads are quarantined to `outbox/invalid/` so `mirror sync` can reach all-clear; idempotent hits on failed runs now print a `--retry` hint; quarantined fan-out mail fails loudly; CLI validation errors print clean messages instead of stack traces.

### Features

- Added the `agy` provider driver (Gemini 3.1 Pro), restricted to the read-only `reviewer` role and launched sandboxed (`--sandbox`); orch rejects it for every other role.
- Added `orch run create --model <ref>` to record provider model overrides in `spec.json` and pass them through to model-aware drivers including pi.
- Matched provider permissions to the role: the `reviewer` role now launches each provider without worktree write access (claude plan mode, codex `--sandbox read-only`, pi read-only tools, agy `--sandbox`). `verifier` and write roles keep write-capable access.
- Added `orch cross-review`, `orch fanout`, and `orch investigate`: one-shot fan-out of a single task across several agents. They route through the mail layer, so a `--thread <id>` supplies the mr and workspace context instead of `--mr`.
- Added `orch events tail --native`: renders the provider-native stream (`native.jsonl`) as normalized progress events (`session` / `assistant` / `tool_use` / `tool_result` / `usage` / `final` / `raw`) across claude/codex/pi/agy. The same normalizer (`src/native-events.ts`) now backs result extraction and provider resume-id detection, replacing the previously scattered per-provider parsing.

## [0.0.3] - 2026-06-25

### Features

- Replaced the orchestration bus with the local mail/Maildir implementation and added a typed bus abstraction for router, claim, ack, and nack flows.
- Added mail agent and workspace CLI surfaces for default agent materialization, agent listing, and workspace inspection.

### Reliability

- Added the local install script so replacing an existing compiled `orch` binary removes the old target before copying the new Mach-O.
- Simplified provider driver launch flow and shared driver command construction across Codex, Claude, and pi.

### Documentation

- Updated README and GitHub Pages quickstart content for the mail bus, local install path, and current CLI commands.

## [0.0.2] - 2026-06-23

### Features

- Added the `pi` provider driver alongside Codex and Claude.
- Added `orch chatgpt-bridge` for deploying a Cloudflare Worker MCP bridge that exposes a read-only worktree view to ChatGPT Developer Mode.
- Added `handoff-pro` support for packaging repository context for tool-less review/planning.

### Safety and Reliability

- Hardened provider session handling: default runs no longer use provider latest-session resume behavior, exact resume requires `--session-mode resume_exact --session-id <id>`, and unsafe session flag combinations are rejected before state is written.
- Added provider-session fingerprints to default idempotency keys so changing session settings creates a distinct run unless an explicit key is supplied.
- Rejected explicit idempotency-key reuse when the existing run's provider session settings differ from the requested settings; `--retry` is required for a new run.
- Sanitized recursive tool/MCP environment variables before supervisor-to-driver and driver-to-provider spawning.
- Added local private-path leak guards before mirroring decision/result payloads to PR/MR comments.
- Improved provider result extraction for valid JSON nested under schema-key wrappers and provider prose around final JSON.

### Documentation

- Updated README, command help, MVP docs, and multi-agent notes for provider session policy, dry-run planning, and release binaries.
- Updated GitHub Pages HTML to reflect Codex, Claude, and pi drivers plus release install guidance.

### Verification

- Added focused tests for provider argv construction, session validation, idempotency reuse, dry-run planning, result extraction, environment isolation, and mirror leak guards.

## [0.0.1] - 2026-06-21

### Bug Fixes

- Documented sandbox state-directory permissions for restricted runners.

## [0.0.0] - 2026-06-21

### Documentation

- Published the initial public README and GitHub Pages site.
