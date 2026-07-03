# orch-cli

Daemonless multi-agent orchestration for coding work.

`orch` runs headless coding agents as supervised local jobs, keeps the state outside any one chat session, and lets a controller decide from normalized artifacts instead of provider-native text streams. It is built for workflows where one agent implements, another reviews, a verifier runs checks, and the final decision can be mirrored back to a GitHub PR or GitLab MR.

中文：`orch` 是一个无常驻 daemon 的多 Agent 编排 CLI。它把 Codex/Claude 这类 headless worker 进程化运行，把状态落到本地目录，并用统一的 `result.json` 给主控或人类做裁决。

Project page: `docs/index.html` is ready for GitHub Pages and includes a bilingual animated overview.

Latest release: `v0.0.3` ([CHANGELOG.md](CHANGELOG.md)).

## Current Scope

This repository is the v2 MVP described in [docs/orch-mvp-spec.md](docs/orch-mvp-spec.md).

Shipped on `main` (v0.0.3 plus unreleased changes, see [CHANGELOG.md](CHANGELOG.md)):

- `orch run create` starts one supervised headless worker run. `--mr` is optional: it resolves from an `MR: <id-or-url>` line in the task's leading header block, a merge-request/pull URL in the task text, or the current branch name (`mr_source` reports which).
- `orch run list`, `orch status`, `orch events tail`, and `orch result` read local run state; omitting `--mr` aggregates across all MRs in the repo. `orch result --wait` blocks until the run reaches a terminal state; reviewer results render findings, verifier results render commands and acceptance.
- Non-terminal runs whose supervisor pid is gone show as `stale?`; `orch run reap` persists them as `stale`. A provider that exits 0 without any output fails its run instead of quietly reporting done.
- `orch decision` records `accept` or `rework` locally and queues a mirror comment.
- `orch mail` provides the local message bus: signed mail events, Maildir delivery, router dispatch, atomic task claim, and result-driven review/verify follow-ups.
- `orch cross-review`, `orch fanout`, and `orch investigate` fan one task across several agents in a single command. They route through the mail layer, so a `--thread <id>` supplies the mr and workspace context (no `--mr` needed).
- `orch mirror` and `orch mirror sync` dry-run by default, then use `gh` or `glab` only with `--execute`.
- Drivers exist for `codex`, `claude`, `pi`, and `agy`.
- Permissions match the role: the read-only `reviewer` role launches each provider without write access (claude plan mode, codex `--sandbox read-only`, pi read-only tools, agy `--sandbox`). `verifier` and write roles keep write-capable access.
- claude model/effort match the role too: `reviewer` runs `--model opus --effort high`; `implementer` stays on the default model at `--effort medium`; `verifier` stays on the default model at `--effort low`.
- `orch run create --model <ref>` records a provider model override in `spec.json` and passes it through to model-aware drivers such as pi, codex, and claude.
- `agy` (Gemini 3.1 Pro) is restricted to the `reviewer` role and runs sandboxed read-only; orch rejects it for any other role.
- `orch chatgpt-bridge` deploys a Cloudflare Worker (no tunnel) and connects ChatGPT (Developer Mode, e.g. `gpt-5.5-pro`) to a read-only view of the worktree.
- Role result schemas exist for `implementer`, `reviewer`, and `verifier`.
- Provider session/model controls are explicit: defaults avoid latest-session resume, exact resume requires `--session-mode resume_exact --session-id <id>`, `--model <ref>` selects a provider model when supported, and idempotency keys include session/model settings.

Not shipped yet:

- No long-running daemon.
- No multi-machine state database; the shipped bus is local mail/Maildir state.
- No interactive attach/debug shell command in the current CLI.
- [docs/multi-agent.md](docs/multi-agent.md) is historical context for the older tmux/MR-centered design, not the current quickstart path.

## Install

Prerequisites:

- Bun
- Git
- `codex`, `claude`, `pi`, and/or `agy` authenticated locally if you want real worker runs
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

Release binaries are published from GitHub Actions when a `v*` tag is pushed:

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

- `cross-review`: reviewer role; default agents `claude-reviewer` (opus, high effort) + `agy-reviewer` (distinct model families).
- `fanout`: any result role via `--role`; default agents are the auto-invited agents for that role.
- `investigate`: reviewer role for read-only research; default agents `agy-reviewer` + `claude-reviewer`.
- `--to-agent <mail-agent-id>` (repeatable) overrides the default roster; `--dry-run` prints the resolved agents without publishing; `--model <ref>` forwards a provider model override to every spawned run.
- Re-running the same thread with the same task is idempotent: already-acked assignments are reused and not run again; nacked or expired assignments can be claimed without publishing duplicates.

## How It Works

`orch` is a stateless reconciler. Every command reads local state, performs one action, and exits.

```text
controller / human
  -> orch mail submit / sendmail
  -> MaildirBus signed event log
  -> orch mail route / claim
  -> per-run supervisor
  -> codex, claude, pi, or agy headless driver
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
- `native.jsonl`: provider-native stream, kept for debugging but not treated as orch events
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
- Native stream isolation: provider output is stored in `native.jsonl`; controllers should read normalized `events.jsonl`, `status.json`, and `result.json`.
- Provider sessions: default runs do not resume the latest provider session. Claude/Codex start fresh headless sessions, Pi stays ephemeral; exact resume requires explicit `--session-mode resume_exact --session-id <id>`.
- Schema gate: the supervisor validates `result.json` before marking a run `done`.
- Local-first mirroring: PR/MR comments go to `outbox/pending/` first. Network sends are opt-in with `--execute`.
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

The driver prompt asks the provider to return exactly one JSON object. The driver then extracts that object (coercing benign schema deviations such as verdict synonyms and object-vs-string array items), writes `result.json`, and the supervisor validates it. When extraction fails, the worker's raw final message is preserved as `result.raw.md` in the run dir and excerpted in the fallback summary; a provider that exits 0 with no output at all fails the run.

## Commands

```text
orch run create    Start one headless worker run for an MR task
orch run list      List local runs for an MR (dead-pid runs show as stale?)
orch run reap      Persist stale for non-terminal runs whose supervisor died
orch cross-review  Review one diff in parallel with several agents (via mail thread)
orch fanout        Run one task across several agents, any result role (via mail thread)
orch investigate   Read-only research/analysis, defaults to gemini-3.1-pro (via mail thread)
orch events tail   Print a run's local events.jsonl
orch result        Print a run's local result.json
orch status        Read local run status for an MR
orch decision      Record accept/rework and queue a PR/MR mirror comment
orch mail          Local signed-mail bus: submit, route, claim, reply, import
orch workspace     Register local workspaces for mail routing
orch mirror        Mirror one local run result summary to a PR/MR comment
orch mirror sync   Send queued outbox comments to a PR/MR
orch chatgpt-bridge  Deploy + connect the read-only ChatGPT bridge (Cloudflare Worker)
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
- `orch verdict`: aggregate cross-review verdicts per thread for one-glance decisions
- reviewer runs against an immutable artifact (temporary worktree at `base_sha`) instead of the live worktree
- better provider resume support; `attach` as log tailing and `debug shell` as human takeover helpers
- daemon or queue service only when unattended multi-machine orchestration becomes real
