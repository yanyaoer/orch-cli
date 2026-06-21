# orch-cli

Daemonless multi-agent orchestration for coding work.

`orch` runs headless coding agents as supervised local jobs, keeps the state outside any one chat session, and lets a controller decide from normalized artifacts instead of provider-native text streams. It is built for workflows where one agent implements, another reviews, a verifier runs checks, and the final decision can be mirrored back to a GitHub PR or GitLab MR.

中文：`orch` 是一个无常驻 daemon 的多 Agent 编排 CLI。它把 Codex/Claude 这类 headless worker 进程化运行，把状态落到本地目录，并用统一的 `result.json` 给主控或人类做裁决。

Project page: `docs/index.html` is ready for GitHub Pages and includes a bilingual animated overview.

## Current Scope

This repository is the v2 MVP described in [docs/orch-mvp-spec.md](docs/orch-mvp-spec.md).

Shipped today:

- `orch run create` starts one supervised headless worker run.
- `orch run list`, `orch status`, `orch events tail`, and `orch result` read local run state.
- `orch decision` records `accept` or `rework` locally and queues a mirror comment.
- `orch mirror` and `orch mirror sync` dry-run by default, then use `gh` or `glab` only with `--execute`.
- Drivers exist for `codex`, `claude`, and `pi`.
- `orch chatgpt-bridge` deploys a Cloudflare Worker (no tunnel) and connects ChatGPT (Developer Mode, e.g. `gpt-5.5-pro`) to a read-only view of the worktree.
- Role result schemas exist for `implementer`, `reviewer`, and `verifier`.

Not shipped yet:

- No long-running daemon.
- No queue service or multi-machine state database.
- No interactive attach/debug shell command in the current CLI.
- No `agy` driver in the current implementation.
- [docs/multi-agent.md](docs/multi-agent.md) is historical context for the older tmux/MR-centered design, not the current quickstart path.

## Install

Prerequisites:

- Bun
- Git
- `codex`, `claude`, and/or `pi` authenticated locally if you want real worker runs
- Optional: `gh` for GitHub mirroring or `glab` for GitLab mirroring
- Optional: `wrangler` and a Cloudflare account for `orch chatgpt-bridge`

Development setup:

```sh
$ bun install
$ bun test
$ bun run build
$ orch --help
```

Run directly from source:

```sh
$ orch --help
```

Build a single local binary:

```sh
$ bun run build
$ cp ./dist/orch ~/.local/bin/orch
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

Create a worker task:

```md
Role: reviewer
Worktree: /path/to/repo
Goal: Review the implementation and report blocking issues.
Acceptance: Return orch.result/reviewer/v1 JSON with concrete findings.
```

Start a run:

```sh
$ orch run create \
  --mr 123 \
  --role reviewer \
  --agent codex \
  --tag review-a \
  --worktree . \
  --task task.md \
  --timeout-sec 3600
```

Observe it:

```sh
$ orch run list --mr 123 --worktree .
$ orch status --mr 123 --json --worktree .
$ orch events tail --mr 123 --run review-a-20260619T120000-abc123 -n 20
$ orch result --mr 123 --run review-a-20260619T120000-abc123
```

Record a controller decision:

```sh
$ orch decision accept \
  --mr 123 \
  --run review-a-20260619T120000-abc123 \
  --reason "reviewed"
```

Preview or send mirror comments:

```sh
$ orch mirror sync --mr 123
$ orch mirror sync --mr 123 --execute
```

Mirror commands are dry-run by default. Without `--execute`, `orch` prints the planned `gh` or `glab` argv and does not touch the network.

## How It Works

`orch` is a stateless reconciler. Every command reads local state, performs one action, and exits.

```text
controller / human
  -> orch CLI
  -> per-run supervisor
  -> codex, claude, or pi headless driver
  -> local run directory
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

## Safety Model

`orch` is deliberately file-first and conservative:

- Idempotency: the default key is `mr<id>:<tag>:<task_sha>`, so repeated `run create` calls reuse an existing run unless `--retry` is passed.
- Worktree locking: write roles take a worktree lock. Reviewer and verifier roles inspect artifacts and do not take the write lock.
- Native stream isolation: provider output is stored in `native.jsonl`; controllers should read normalized `events.jsonl`, `status.json`, and `result.json`.
- Schema gate: the supervisor validates `result.json` before marking a run `done`.
- Local-first mirroring: PR/MR comments go to `outbox/pending/` first. Network sends are opt-in with `--execute`.

## Result Contract

Every successful worker must finish with a valid `result.json`.

Implemented schemas:

- `orch.result/implementer/v1`: `verdict`, `summary`, `base_sha`, `head_sha`, `changed_files`, `tests`, `acceptance`, `risks`, `rollback`
- `orch.result/reviewer/v1`: `verdict`, `reviews_run_id`, `blocking_findings`, `non_blocking_findings`, `suggested_tests`
- `orch.result/verifier/v1`: `verdict`, `verifies_run_id`, `commands`, `acceptance`

The driver prompt asks the provider to return exactly one JSON object. The driver then extracts that object, writes `result.json`, and the supervisor validates it.

## Commands

```text
orch run create    Start one headless worker run for an MR task
orch run list      List local runs for an MR
orch events tail   Print a run's local events.jsonl
orch result        Print a run's local result.json
orch status        Read local run status for an MR
orch decision      Record accept/rework and queue a PR/MR mirror comment
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
$ bun run build
$ cp ./dist/orch ~/.local/bin/orch
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

- richer stale/timeout policy and retry ergonomics
- better provider resume support
- `attach` as log tailing and `debug shell` as human takeover helpers
- more provider drivers once the driver contract is stable
- daemon or queue service only when unattended multi-machine orchestration becomes real
