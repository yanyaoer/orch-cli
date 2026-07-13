# orch-cli

Daemonless multi-agent orchestration for coding work.

`orch` runs headless coding agents as supervised local jobs, keeps the state outside any one chat session, and lets a controller decide from normalized artifacts instead of provider-native text streams. It is built for workflows where one agent implements, another reviews, a verifier runs checks, and the final decision can be mirrored back to a GitHub PR or GitLab MR.

中文：`orch` 是一个无常驻 daemon 的多 Agent 编排 CLI。它把 Codex/Claude 这类 headless worker 进程化运行，把状态落到本地目录，并用统一的 `result.json` 给主控或人类做裁决。

Project page: `docs/index.html` is ready for GitHub Pages and includes a bilingual animated overview.

Latest release: `v0.0.8` ([CHANGELOG.md](CHANGELOG.md)).

## Current Scope

This repository is the v2 MVP described in [docs/orch-mvp-spec.md](docs/orch-mvp-spec.md).

## Workspace Decisions and Specs

Durable architecture decisions live in [docs/adr/](docs/adr/README.md); task and feature specs live in [docs/specs/](docs/specs/README.md). When those constraints shape an `orch --task` file, inline the binding excerpts so the run remains replayable from `spec.json`.

Shipped on `main` (v0.0.8, see [CHANGELOG.md](CHANGELOG.md)):

- `orch run create` starts one supervised headless worker run. `--mr` is optional: it resolves from an `MR: <id-or-url>` line in the task's leading header block, a merge-request/pull URL in the task text, or the current branch name (`mr_source` reports which).
- Bare `orch` prints the overview: active runs plus every pending action (undecided terminal runs, stale runs, pending outbox) expressed as a runnable orch command line — the same contract humans copy and agents execute from `--json`. `--all` scans every repo under the state root. The overview is a notification center, not a debt ledger: items idle beyond `--attention-days` (default 14, `0` disables) age out, and mrs matching a local branch already merged into HEAD are archived wholesale. `orch decision close` acks a run without queueing a comment; `orch decision sweep --execute` batch-acks the whole backlog by the overview's own rubric.
- `orch verdict --thread <id>` aggregates a fan-out thread's verdicts into one suggestion (accept / rework / inspect / pending / reap); `--wait` blocks until the thread settles. `orch wait --thread <id>` is the wait-any primitive: it blocks until the next run needs attention, and a recorded decision acts as the ack so handled runs are never returned again.
- `orch run list`, `orch status`, `orch events tail`, and `orch result` read local run state; omitting `--mr` aggregates across all MRs in the repo. `orch result --wait` blocks until the run reaches a terminal state; reviewer results render findings, verifier results render commands and acceptance.
- `orch events tail --native` renders the provider-native stream (`native.jsonl`) as normalized progress events — `session`, `assistant`, `tool_use`, `tool_result`, `usage`, `final`, `raw` — so a controller can see what a worker is doing without parsing per-provider formats. The same normalizer (`src/native-events.ts`) backs result extraction and resume-id detection. `-f/--follow` streams appended lines live: with `--run` it exits once the run is terminal (or stale) and drained; without `--run` it multiplexes every active run in the repo (`--all`: every repo) with tail-style `==> mr/run <==` headers, picks up runs created while following, and announces its scope on stderr up front.
- `orch search` regex-scans the current repo's local run files (`result.json`, `events.jsonl`, `native.jsonl`, `artifacts/*.{txt,log,patch}`) plus mail `mail-events.jsonl` diagnostics; `orch usage run|thread|daily` aggregates token maps from normalized native usage events and reports missing token data as `has_token_data=false`.
- Non-terminal runs whose supervisor pid is gone show as `stale?`; `orch run reap` persists them as `stale`. A provider that exits 0 without any output fails its run instead of quietly reporting done. `orch run cancel --run <id> [--reason <text>]` stops a running worker mid-flight: it signals the driver's process group and the live supervisor finalizes the run with a `canceled: <reason>` result.
- `orch decision` records `accept` or `rework` locally and queues a mirror comment.
- `orch mail` provides the local message bus: signed mail events, Maildir delivery, router dispatch, atomic task claim, and result-driven review/verify follow-ups.
- `orch cross-review`, `orch fanout`, and `orch investigate` fan one task across several agents in a single command. They route through the mail layer, so a `--thread <id>` supplies the mr and workspace context (no `--mr` needed).
- The `researcher` role (architect / deep research) is read-only and web-research capable: it delivers a plan, not code, and takes no worktree lock. claude runs `fable` at `xhigh` effort under a `dontAsk` whitelist (`jina`/`tvly` CLIs + WebSearch/WebFetch + read-only repo tools, no Edit/Write); codex defaults to `gpt-5.6-sol` at `xhigh` reasoning with native `web_search` inside the read-only sandbox; omp rides its gemini quota-fallback chain read-only (repo-internal research, no web); pi is not supported.
- `orch new '<task description>'` — one-sentence task intake: a read-only Fable/xhigh researcher drafts a mechanically validated Destination / Out of scope / Tasks / Later plan. Enter or `--yes` resolves safe recommended defaults into one self-contained final plan; questions without a safe default block execution. The same Fable session resumes at controller/medium effort to dispatch workers, while final success is derived from persisted worker status/result/decision files rather than the controller's claim alone.
- `--task -` on `orch run create` and the fanout commands reads the task text from stdin.
- The `challenger`, `rework`, and `debugger` roles are removed: `implementer` is the only write role; rework/debug follow-ups are implementer runs dispatched via `--resume-from`.
- `orch mailctl` drives orch by real email over IMAP/SMTP: an allowlisted, authenticated sender emails a task, `orch mailctl poll` ingests it, auto-spawns a claude **controller** run that decomposes/dispatches the work and replies progress in the same thread. Daemonless (`poll` is the cron/launchd contract; `watch` is a foreground IMAP-IDLE convenience), zero npm deps, any IMAP/SMTP provider (Gmail via app password). Inbound email is treated as an authentication boundary (allowlist + trusted-authserv-id Authentication-Results, fail-closed; text/plain-only task body). The controller result schema is `orch.result/controller/v1`.
- `orch mirror` and `orch mirror sync` dry-run by default, then use `gh` or `glab` only with `--execute`.
- Drivers exist for `codex`, `claude`, `pi`, and `omp`.
- Permissions match the role: the read-only `reviewer` role launches each provider without write access (claude plan mode, codex `--sandbox read-only`, pi and omp read-only tools). `verifier` and write roles keep write-capable access.
- claude model/effort match the role too: `reviewer` runs `--model opus --effort high`; `implementer` stays on the default model at `--effort medium`; `verifier` stays on the default model at `--effort low`.
- `orch run create --model <ref>` records a provider model override in `spec.json` and passes it through to model-aware drivers such as pi, omp, codex, and claude.
- Recommended default profile (`~/.config/orch/config.json`): set `defaults.agents.implementer` to `pi`, so `orch run create --role implementer` works without `--agent` and the mail roster auto-invites `pi-implementer`. In a same-model harness pilot (SWE-bench Verified subset, gpt-5.6-sol frozen across codex/omp/pi), resolve rates were indistinguishable while pi used ~45% of omp's and ~56% of codex's cache-read traffic — the cheapest implementer at equal quality:

```json
{
  "version": 1,
  "workspaces": {},
  "defaults": {
    "agents": {
      "implementer": "pi",
      "reviewer": "claude",
      "verifier": "pi",
      "controller": "claude",
      "researcher": "codex"
    }
  }
}
```

Each role value is either a bare agent name or an object carrying default args, e.g. `{"agent": "omp", "model": "openai-codex/gpt-5.6", "timeout_sec": 1800}` — explicit `orch run create` flags always win. Leave `model` unset unless you mean to override the driver's role tier (a configured model becomes `spec.model`, which for claude also replaces the reviewer/researcher model escalation).

An optional top-level `"language": "中文"` switches everything orch publishes to the MR/PR (mirror/decision/cross-review comments and worker result prose) to Chinese; code, commands, paths, and identifiers stay as-is. Missing or any other value (including `"english"`) keeps the current English output.

- `omp` (oh-my-pi) defaults to `openai-codex/gpt-5.6-sol` at `--thinking=xhigh` and falls back to `zenmux/anthropic/claude-fable-5`, then `google-antigravity/gemini-3.1-pro` when the active model's quota/rate limit is exhausted; an explicit `--model <ref>` becomes the primary and the rest of the chain stays as fallbacks.
- `orch chatgpt-bridge` deploys a Cloudflare Worker (no tunnel) and connects ChatGPT (Developer Mode, e.g. `gpt-5.5-pro`) to a read-only view of the worktree.
- Role result schemas exist for `implementer`, `reviewer`, `verifier`, `researcher` (read-only plan-not-code research, `orch.result/researcher/v1`), and `controller` (the `orch mailctl` mail controller; claude-only, orchestrate-not-edit).
- Provider session/model controls are explicit: defaults avoid latest-session resume, exact resume requires `--session-mode resume_exact --session-id <id>`, `--model <ref>` selects a provider model when supported, and idempotency keys include session/model settings.

Not shipped yet:

- No long-running daemon.
- No multi-machine state database; the shipped bus is local mail/Maildir state.
- No interactive attach/debug shell command in the current CLI.
- [docs/multi-agent.md](docs/multi-agent.md) is historical context for the older tmux/MR-centered design, not the current quickstart path.

## Install

One line (downloads the latest release binary for your platform into `~/.local/bin`):

```sh
$ curl -fsSL https://raw.githubusercontent.com/yanyaoer/orch-cli/main/install.sh | sh
```

Override the target with `ORCH_INSTALL_DIR=/somewhere` or pin a tag with `ORCH_VERSION=v0.0.8`. Upgrade later with:

```sh
$ orch update          # self-replace with the latest release (--check to only compare)
```

Prerequisites:

- Bun and Git for source builds (the release binary needs neither)
- `codex`, `claude`, `pi`, and/or `omp` authenticated locally if you want real worker runs
- Optional: `gh` for GitHub mirroring or `glab` for GitLab mirroring
- Optional: `wrangler` and a Cloudflare account for `orch chatgpt-bridge`

Development setup:

```sh
$ bun install
$ bun test
$ bun run build
$ bun run orch --help
```

Run directly from source:

```sh
$ bun run orch --help
```

Build a single local binary:

```sh
$ bun run install:local
$ orch --help
```

`dist/` is intentionally ignored by Git. Treat the compiled binary as a local or release artifact.

Release binaries are published from GitHub Actions when a `v*` tag is pushed; `install.sh` and `orch update` consume them. Manual download:

```sh
$ curl -L https://github.com/yanyaoer/orch-cli/releases/latest/download/orch-darwin-arm64 -o ~/.local/bin/orch
$ chmod +x ~/.local/bin/orch
$ orch --help
```

Other assets use the same naming pattern, for example `orch-linux-x64` and `orch-linux-arm64`.

Sandboxed runners:

`orch` writes to `${XDG_STATE_HOME:-$HOME/.local/state}/orch` by default. In restricted agent sandboxes, that directory may not be writable unless it is explicitly granted by the runner. Use a writable state home when needed:

```sh
$ XDG_STATE_HOME=/tmp/orch-state orch run create --mr demo --role reviewer --agent codex --tag review-a --worktree . --task task.md
```

This is a sandbox policy issue, not a binary install issue. The installed `~/.local/bin/orch` works normally in your shell; inside a restricted sandbox it still follows the sandbox's writable roots.

## Quickstart

Create a worker task (the optional `MR:` header pins the state namespace; a merge-request/pull URL in the text works too):

```md
Role: reviewer
MR: https://gitlab.example.com/group/repo/-/merge_requests/123
Goal: Review the implementation and report blocking issues.
Acceptance: Return orch.result/reviewer/v1 JSON with concrete findings.
```

Start a run — `--mr` resolves from the task header, a forge URL in the task text, or the current branch:

```sh
$ orch run create --role reviewer --agent codex --worktree . --task task.md
```

Block until it finishes and read the findings:

```sh
$ orch result --run review-a-20260619T120000-abc123 --wait
```

Preview a pi run with a non-default registered model:

```sh
$ orch run create --mr demo --role reviewer --agent pi --tag pi-fable \
  --worktree . --task task.md \
  --model zenmux-anthropic/anthropic/claude-fable-5 \
  --dry-run
```

Observe it (omit `--mr` to aggregate every MR in the repo; dead-pid runs show as `stale?`):

```sh
$ orch run list --worktree .
$ orch status --json --worktree .
$ orch events tail --run review-a-20260619T120000-abc123 -n 20
$ orch events tail --run review-a-20260619T120000-abc123 --native -n 20
                           # provider progress: session/assistant/tool_use/tool_result/usage/final/raw
$ orch events tail --run review-a-20260619T120000-abc123 --native -f
                           # follow live; exits once the run is terminal (or stale) and drained
$ orch events tail -f --all --native
                           # no --run: multiplex every active run (tail-style ==> mr/run <== headers),
                           # pick up runs created while following, until Ctrl-C; --all spans every repo
$ orch run reap            # persist stale for runs whose supervisor died
```

Record a controller decision (the run id locates its MR):

```sh
$ orch decision accept \
  --run review-a-20260619T120000-abc123 \
  --reason "reviewed"
```

Preview or send mirror comments:

```sh
$ orch mirror sync --mr 123
$ orch mirror sync --mr 123 --execute
```

Mirror commands are dry-run by default. Without `--execute`, `orch` prints the planned `gh` or `glab` argv and does not touch the network.

## Mail Bus Dispatch

`orch mail` is the local message bus for multi-agent dispatch. It writes signed `orch.mail/event/v1` messages as `.eml` files, imports verified events into `mail-events.jsonl`, and keeps a Maildir view for NeoMutt or other mail tools.

```sh
$ orch mail agent defaults
$ orch workspace add --id orch-cli --path .
$ orch mail submit --thread th_123 --mr 123 --workspace orch-cli --task task.md
$ RAW=$(orch mail deliver-local --thread th_123 | bun -e 'const p=JSON.parse(await Bun.stdin.text()); console.log(p.delivered[0]?.to ?? "")')
$ orch mail import --thread th_123 --file "$RAW"
$ orch mail route --thread th_123
$ orch mail claim --thread th_123 --agent codex-implementer
```

Routing is result-driven:

1. `submit` queues a router task for `orch-router@local.orch`.
2. `route` turns the imported router task into one implementer task, usually `codex-implementer`.
3. `claim` atomically leases the task and starts `orch run create`.
4. `reply result` publishes the implementer's `result.json` as `result.submitted`.
5. A later `route` fans that result out to reviewer and verifier agents, so Claude/Pi review actual Codex output instead of racing on the original prompt.

The `MaildirBus` adapter in `src/bus.ts` is intentionally small: `publish*`, `import*`, `listEvents`, `claimTasks`, `ackTask`, and `nackTask`. Claims are stored under `mail/threads/<thread>/claims/` with a lease record, then acknowledged into the legacy `mail-claimed.json` projection after `orch run create` succeeds.

## Fan-out Dispatch

`cross-review`, `fanout`, and `investigate` are one-shot wrappers over the mail bus. Each resolves one `task.requested` per target agent into a thread, reusing an existing task with the same thread/role/agent/task hash when present, then claims only those resolved task events. Because they go through mail, the `--thread <id>` supplies the mr (defaults to the thread id) and the workspace worktree — there is no `--mr` flag.

```sh
$ orch mail agent defaults                       # once: register the default agents
$ orch cross-review --thread review-123 --task review.md
$ orch fanout --thread verify-123 --role verifier --to-agent pi-verifier --task verify.md
$ orch investigate --thread research-1 --task question.md
$ orch status --mr review-123                     # follow the runs (mr == thread)
```

- `cross-review`: reviewer role; default agents `claude-reviewer` (opus, high effort) + `omp-reviewer` (distinct model families).
- `fanout`: any result role via `--role`; default agents are the auto-invited agents for that role.
- `investigate`: researcher role for read-only research; default agents `omp-researcher` + `claude-researcher`.
- `--to-agent <mail-agent-id>` (repeatable) overrides the default roster; `--dry-run` prints the resolved agents without publishing; `--model <ref>` forwards a provider model override to every spawned run.
- Re-running the same thread with the same task is idempotent: already-acked assignments are reused and not run again; nacked or expired assignments can be claimed without publishing duplicates.
- `cross-review --auto` inlines the follow-up ritual: it waits for this fan-out's runs to settle (`--wait-sec`, default 900), records the unambiguous decisions (approve + 0 blocking → accept, real blocking findings → rework), and queues ONE merged comment covering every run instead of one per run. The comment stays a dry-run preview in the outbox until you pass `--execute` (same A5 posture as `orch mirror sync`). Runs whose result can't be trusted are surfaced with the exact follow-up command, never auto-decided: driver schema fallbacks get their raw review text recovered from `result.raw.md` into the comment body (the synthetic `orch-driver-result` placeholder is never mirrored), and failed/timeout/stale runs are listed under `attention`. Rework dispatch stays a human/controller call — `--auto` does not loop implementers.

```sh
$ orch cross-review --thread 3823 --task review.md --auto            # preview: decisions recorded, comment queued
$ orch cross-review --thread 3823 --task review.md --auto --execute  # same, and the merged comment is posted
```

## Mail Controller (`orch mailctl`)

`orch mailctl` drives orch by real email. An allowlisted, authenticated sender emails a task; `orch mailctl poll` ingests it over a zero-dependency IMAP client, publishes a router task, and — with no controller already running for the thread — auto-spawns a headless claude **controller** run. The controller decomposes the work, dispatches implementer/reviewer runs with `orch fanout`/`cross-review`, records `orch decision`s, and replies progress over SMTP in the same email thread. Works with any IMAP/SMTP provider (Gmail via an app password).

```sh
$ orch mailctl init --user you@example.com \
    --imap-host imap.gmail.com --smtp-host smtp.gmail.com --smtp-mode implicit \
    --allow boss@example.com --workspace my-repo \
    --password-cmd '["security","find-generic-password","-w","-s","orch-mail"]' \
    --trusted-authserv-id mx.google.com
$ orch mailctl poll --json      # main contract: one bounded ingest + reconcile cycle (cron/launchd)
$ orch mailctl watch            # foreground convenience: IMAP IDLE + periodic reconcile
$ orch mailctl status           # cursor, active threads, controller generations, outbound queue, recent rejections
$ orch mailctl reply   --thread em-<id> --report-key <k> --body "…"   # (used by the controller)
$ orch mailctl ack     --thread em-<id> --attention <id>              # (used by the controller)
$ orch mailctl guidance --thread em-<id>                             # unacked instructions for the controller
$ orch mailctl attachments --thread em-<id>                          # quarantined attachments for a thread
$ orch mailctl attachment show --id att-<id>                         # print a safe text attachment (log/patch/md/json/csv)
$ orch mailctl attachment promote --id att-<id> [--dest <dir>]       # copy a stored payload out of quarantine
```

Notifications default to `{"enabled": false, "max_per_hour": 30}`; set `"to": "owner@example.com"` if needed.
`orch mailctl sync [--mr <id>] [--json]` previews MR progress email; `--execute` requires notifications enabled, while `poll` and `watch` sync automatically.
Each MR gets one subject root with dispatched/result/decision replies, with idempotency and backoff across retries. Policy checks are isolated per report: path-shaped private markers are redacted and revalidated, while genuinely unsafe bodies are fingerprint-quarantined once without blocking safe sibling updates.
Delivery is **at-least-once**: outbox markers dedupe re-sends, but a crash in the window between SMTP acceptance and the sent-marker write can deliver the same progress email twice (stable Message-IDs let mail clients collapse the duplicate). Changing or removing `notify.to` also invalidates queued progress mail — stale retries are marked superseded and re-queued for the current recipient on the next sync, and the new recipient receives the thread's anchoring root once before further updates.
Note: the first sync after enabling notifications backfills every existing MR under the repo (rate-limited by `max_per_hour`), so a repo with history produces a burst of catch-up mail. Set `"since": "<ISO-8601>"` in `notify` to cut the backfill: runs created before that timestamp are never projected.
Body paths may use `$ORCH_STATE`, `$WORKSPACE`, or `~`; the `secretPatterns` leak guard always runs, and `max_per_hour` limits delivery.

**Daemonless, precisely.** `poll` is the primary contract — a bounded one-shot ingest + reconcile you drive from `cron` or `launchd`, exactly the stateless-reconciler model, with no orch-owned background service. `watch` is a **foreground** convenience: it is honestly a long-running process (an IMAP-IDLE loop), but it is *not a daemon* — it never forks or detaches, owns no global scheduler, holds no persistent model session, and does one bounded reconcile per wake before returning to IDLE (`Ctrl-C` exits). So the "daemonless" claim means *no background service / no `orchd`*, not "no long-running process ever". **For unattended operation, drive `poll` from cron/launchd — do not keep `watch` alive under a restart supervisor.**

**Scheduling `poll`.** Without a scheduler, mail sits unread on the IMAP server until the next manual `poll`. On macOS, a per-user LaunchAgent runs `poll` every 5 minutes (missed intervals coalesce into one run after wake; the unquoted heredoc expands `$HOME` at write time — launchd does not expand variables). launchd jobs get a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `EnvironmentVariables` must include the directories of every helper your config shells out to — notably `password_cmd` tools like `pass` (which itself needs Homebrew's `gpg`); without it every poll fails with `Executable not found in $PATH`:

```sh
$ cat > ~/Library/LaunchAgents/com.orch.mailctl-poll.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.orch.mailctl-poll</string>
  <key>ProgramArguments</key><array>
    <string>$HOME/.local/bin/orch</string>
    <string>mailctl</string><string>poll</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>/tmp/orch-mailctl-poll.log</string>
  <key>StandardErrorPath</key><string>/tmp/orch-mailctl-poll.log</string>
</dict></plist>
EOF
$ launchctl load ~/Library/LaunchAgents/com.orch.mailctl-poll.plist
```

On Linux, the cron equivalent is `*/5 * * * * "$HOME"/.local/bin/orch mailctl poll`. Overlapping cycles are safe either way — a `poll` that finds `ingest.lock` held skips quietly. Check `orch mailctl status` for `last_poll_at` and `consecutive_failures` to confirm the schedule is alive.

State lives under `${XDG_STATE_HOME:-$HOME/.local/state}/orch/mail-control/` (a single `ingest.lock`, exactly-once `messages/<sha>` markers, per-thread mappings, outbound queue) plus per-thread controller runs under the usual run tree with mr `mailctl-em-<id>`.

Inbound email is treated as an **authentication boundary**:

- `From` must be on the `allowed_senders` allowlist (weak by itself), and must not be the account itself.
- By default (`require_auth_results`) the message must carry an `Authentication-Results` header from the configured `trusted_authserv_id` with dkim/dmarc `pass` and domain alignment — evaluated on the single top-most trusted instance only, fail-closed. A forged lower A-R can't override it. An optional `subject_token` adds a second factor.
- Task text comes only from a real `text/plain` part; **HTML-only mail is refused** (`rejected_html`) so HTML/CSS hidden text can never become task instructions. Quoted/forwarded tails and attachments are stripped from task text.
- Attachments on accepted mail are **quarantined**, not lost: payloads land under `mail-control/attachments/quarantine/<att-id>/` (never the worktree, never the prompt). The controller sees only a summary line per attachment; it reads safe text types (`txt/log/md/patch/diff/json/csv`) via `orch mailctl attachment show`, and anything else stays sealed unless a human (or the controller, explicitly) runs `attachment promote`.
- Rejections leave a `rejected_*` marker (never silent); `messages/<sha>` markers make ingestion exactly-once across crashes. `orch mailctl status` counts the last 7 days of `rejected_*` markers by reason, and the `orch` overview flags rejects that fire after the sender allowlist passes (auth/token/html_only/parse_error) — the "owner locked out by a missing subject token" case is visible without reading `audit.jsonl`.
- The controller runs with `Bash(orch *)` + read-only tools (no Edit/Write): it **orchestrates, it does not edit code** — code changes are dispatched to write-role workers holding the worktree lock.
- Outbound replies run a mail-specific leak scan (local paths / secret shapes / size cap) and `ORCH_MIRROR_ALLOW_PRIVATE` does not open the mail channel.

## How It Works

`orch` is a stateless reconciler. Every command reads local state, performs one action, and exits.

```text
controller / human
  -> orch mail submit / sendmail
  -> MaildirBus signed event log
  -> orch mail route / claim
  -> per-run supervisor
  -> codex, claude, pi, or omp headless driver
  -> result.submitted mail
  -> reviewer / verifier follow-up tasks
  -> optional PR/MR mirror through outbox
```

The local state directory is:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mrs/<mr>/runs/<run_id>/
```

Important run files:

- `spec.json`: immutable run input snapshot
- `spec.sha256`: hash of the stored spec bytes
- `status.json`: run lifecycle, pid/pgid, timestamps, exit code, resume id, git shas
- `events.jsonl`: normalized orch events such as `created`, `running`, `heartbeat`, `done`, `failed`, `timeout`
- `native.jsonl`: provider-native stream, not treated as orch events; `orch events tail --native` renders it as normalized progress events
- `stdout.log` and `stderr.log`: process output
- `result.json`: role-specific result used for decisions
- `artifacts/`: optional worker artifacts

Outbox comments are stored under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mrs/<mr>/outbox/{pending,sent}/
```

Mail bus state is stored under:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mail/threads/<thread>/
```

Important mail files:

- `outbox/pending/*.eml`: signed events queued for local delivery.
- `maildir/{new,cur,tmp}`: Maildir view for NeoMutt.
- `inbox/events/mail-events.jsonl`: verified append-only event projection.
- `claims/*.claim.json`: atomic task leases and ack/nack records.

## Safety Model

`orch` is deliberately file-first and conservative:

- Idempotency: the default key includes `mr`, `tag`, `task_sha`, and provider session/model settings, so repeated equivalent `run create` calls reuse an existing run unless `--retry` is passed.
- Worktree locking: write roles take a worktree lock. Reviewer and verifier roles inspect artifacts and do not take the write lock.
- Native stream isolation: provider output is stored in `native.jsonl`; controllers should read normalized `events.jsonl`, `status.json`, and `result.json`. For progress observability, `orch events tail --native` gives a read-side normalized view of the native stream without promoting it to run-state authority.
- Provider sessions: default runs do not resume the latest provider session. Claude/Codex start fresh headless sessions, Pi stays ephemeral; exact resume requires explicit `--session-mode resume_exact --session-id <id>`.
- Resume a prior run: `orch run create --resume-from <run_id> --task rework.md` continues that run's provider session with a new task — the worker keeps its accumulated context (files read, reasoning, provider prompt cache) instead of re-reading the repo from zero. Agent, role, mr, worktree, and model are inherited unless overridden; `--agent` and the `--session-*` flags conflict with it (sessions are not portable across providers). The session id is taken from the prior run's `status.json` (`provider_resume_id`, backfilled from the native stream at terminal state); ephemeral runs are refused since their sessions were never persisted. Typical use: dispatch the rework run against the implementer run the reviewer's blocking findings were about.
- Schema gate: the supervisor validates `result.json` before marking a run `done`.
- Local-first mirroring: PR/MR comments go to `outbox/pending/` first. Network sends are opt-in with `--execute`, and concurrent executes are serialized per MR outbox.
- Atomic decisions: `decision.json` is created with `O_EXCL`, so concurrent controllers racing on the same run get one winner and one clear `already decided` error — the `orch wait` → decision loop stays safe with multiple controllers.
- Mail bus claims: `claimTasks` creates a per-event lease with atomic `O_EXCL`; `ackTask` is written only after `orch run create` succeeds, and `nackTask` records failed starts for retry.
- Result-driven review: reviewer and verifier mail tasks are routed from `result.submitted` implementer events, not from the original router task.
- Honest terminal states: a provider that exits 0 with no output fails its run, and `orch run reap` persists `stale` for runs whose supervisor died.
- Worker env hardening: spawned workers drop recursive tool/MCP variables, strip `node_modules/.bin` PATH entries (stale provider CLIs cannot shadow the real ones), and replace a fish `SHELL` with bash.

## Result Contract

Every successful worker must finish with a valid `result.json`.

Implemented schemas:

- `orch.result/implementer/v1`: `verdict`, `summary`, `base_sha`, `head_sha`, `changed_files`, `tests`, `acceptance`, `risks`, `rollback`
- `orch.result/reviewer/v1`: `verdict`, `reviews_run_id`, `blocking_findings`, `non_blocking_findings`, `suggested_tests`
- `orch.result/verifier/v1`: `verdict`, `verifies_run_id`, `commands`, `acceptance`
- `orch.result/researcher/v1`: `verdict` (completed|failed), `summary`, `recommendation`, `alternatives[]`, `sources[]`, `open_questions[]`, `risks[]`
- `orch.result/controller/v1`: `verdict`, `summary`, `actions` (the `orch mailctl` controller; claude-only, not in `writeRoles`, launched with a `Bash(orch *)` + read-only allowed-tools whitelist)

The driver prompt asks the provider to return exactly one JSON object. The driver then extracts that object (coercing benign schema deviations such as verdict synonyms and object-vs-string array items), writes `result.json`, and the supervisor validates it. When extraction fails, the worker's raw final message is preserved as `result.raw.md` in the run dir and excerpted in the fallback summary; a provider that exits 0 with no output at all fails the run.

## Commands

```text
orch               Overview: active runs + pending actions as runnable commands
orch new           One-sentence task: plan -> confirm in terminal -> controller executes
orch verdict       Aggregate one thread's verdicts and suggest a decision (--wait)
orch wait          Block until the next run in a thread needs attention (wait-any)
orch run create    Start one headless worker run for an MR task
orch run list      List local runs for an MR (dead-pid runs show as stale?)
orch run cancel    Stop a running worker (supervisor finalizes it as failed)
orch run reap      Persist stale for non-terminal runs whose supervisor died
orch search        Regex-search run files and mail event diagnostics
orch usage         Summarize token usage by run, thread, or day
orch cross-review  Review one diff in parallel with several agents (via mail thread)
orch fanout        Run one task across several agents, any result role (via mail thread)
orch investigate   Read-only research via the researcher role; default agents omp-researcher + claude-researcher (via mail thread)
orch events tail   Print a run's local events.jsonl (--native: normalized provider progress;
                   -f: follow live, without --run multiplexing every active run, --all every repo)
orch result        Print a run's local result.json
orch status        Read local run status for an MR
orch decision      Record accept/rework and queue a PR/MR mirror comment
orch mail          Local signed-mail bus: submit, route, claim, reply, import
orch mailctl       Email-driven orchestration over IMAP/SMTP (init/poll/watch/status/reply/ack/guidance)
orch workspace     Register local workspaces for mail routing
orch mirror        Mirror one local run result summary to a PR/MR comment
orch mirror sync   Send queued outbox comments to a PR/MR
orch chatgpt-bridge  Deploy + connect the read-only ChatGPT bridge (Cloudflare Worker)
orch handoff-pro   Hand off full repo context to a tool-less model (e.g. gpt-5.5-pro)
```

Use command help as the source of truth:

```sh
$ orch <command> --help
$ orch help task-spec
$ orch help result
$ orch help events
$ orch help concepts
$ orch help forge
```

## Development

```sh
$ bun test
$ bun run install:local
$ orch --help
```

Useful smoke test without spending provider tokens:

```sh
$ env ORCH_DRIVER_FAKE_RESULT=1 XDG_STATE_HOME=/tmp/orch-demo-state orch run create \
  --mr demo \
  --role reviewer \
  --agent codex \
  --tag fake-review \
  --worktree . \
  --task task.md
```

Then inspect:

```sh
$ XDG_STATE_HOME=/tmp/orch-demo-state orch run list --mr demo
$ XDG_STATE_HOME=/tmp/orch-demo-state orch status --mr demo --json
```

## Roadmap

The current MVP intentionally avoids a daemon. Natural next steps are:

- `orch doctor`: preflight checks for provider binaries, versions, flags, and roster consistency
- policy-driven reconcile: auto-execute low-risk suggested actions (`--apply` behind an explicit policy file)
- reviewer runs against an immutable artifact (temporary worktree at `base_sha`) instead of the live worktree
- better provider resume support; `attach` as log tailing and `debug shell` as human takeover helpers
- daemon or queue service only when unattended multi-machine orchestration becomes real
