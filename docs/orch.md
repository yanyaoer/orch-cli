# orch — daemonless multi-agent orchestrator (CLI)

Dispatches headless AI workers (codex / claude / pi / omp) against a git worktree
and records auditable per-run state under `XDG_STATE`. No daemon.
Repo: `github.com/yanyaoer/orch-cli`. Install:
`curl -fsSL https://raw.githubusercontent.com/yanyaoer/orch-cli/main/install.sh | sh`.

This file only routes intent → command. All mechanics — flags, defaults, role
permissions, model/effort tiers, result schemas — live in the CLI:
`orch --help`, `orch <cmd> --help`, `orch help <task-spec|result|events|concepts|forge>`.

## When to use what
- **Not sure what needs attention?** → bare `orch`: the overview prints every
  pending action as a runnable command line. Clear the backlog with
  `orch decision sweep`. Thread loops: `orch wait --thread <id>` blocks until
  the next run needs attention; `orch verdict --thread <id> --wait` suggests a
  whole-thread outcome.
- **Start a brand-new task from one sentence** → `orch new '<description>'
  [--workspace <id>]`: Fable drafts a validated plan, you confirm/amend it, then
  the resumed controller drives workers; persisted worker decisions determine success.
- **Implement / review / verify / research one task** → `orch run create`
  (agent = codex|claude|pi|omp, role = implementer|reviewer|verifier|researcher).
  Follow with `orch status` / `orch result`; record `orch decision`, then
  `orch mirror` it to the PR/MR. Dispatching a rework? `orch run create
  --resume-from <run_id> --task rework.md` keeps the worker's provider session
  instead of re-reading the repo from zero. Wrong direction mid-run?
  `orch run cancel --run <id>` stops it and records a canceled result.
- **Need a plan/architecture decision, not code?** → `--role researcher`:
  read-only, web-research capable, returns a recommendation — or fan it out
  (below) for a second opinion.
- **Fan one task across agents** → `orch cross-review` (claude+omp review one
  diff; `--auto` records the unambiguous decisions and queues ONE merged MR
  comment), `orch investigate` (researcher role, omp+claude),
  `orch fanout --role <r>` (generic).
- **Bounded, testable task on a budget** → `orch prewalk --task <f>
  --executor-model <m>`: a guide model plans a validated TODO and lands the
  first edit, then the cheaper model resumes the SAME provider session to
  finish; the handoff gate is host-verified, an unmet gate keeps the guide
  model. Not for ambiguous or high-risk work — those stay frontier-only.
- **Drive orch by email** → `orch mailctl`: poll ingests an allowlisted,
  authenticated sender's task and spawns a claude controller that fans work out
  and replies in-thread; the controller orchestrates, it never edits code.
  MR progress email is synced by `orch mailctl sync` (or automatically by poll); configure `notify` first.
  Setup + security detail: README.
- **Watch a live worker** → `orch events tail --run <id> --native -f`
  (provider-independent progress stream). Run-state authority stays with
  `orch status` + plain `orch events tail`.
- **Let ChatGPT read this repo live** → `orch chatgpt-bridge` (Cloudflare
  Worker MCP bridge, no tunnel). ⚠️ ChatGPT Pro / heavy-reasoning modes don't
  mount MCP connector tools — pick a non-Pro model, or use handoff-pro.
- **Hand a strong but tool-less model a full snapshot** (e.g. gpt-5.5-pro) →
  `orch handoff-pro` packs the repo into one markdown blob to paste in;
  execute the returned plan via `orch run create`.

## Scratch worktrees (review / verify)
One persistent scratch worktree per repo — never one per MR, never a full
`git clone` under /tmp. First time: `git -C <repo> worktree add --detach
/tmp/<repo>-review`. Each round: `git -C /tmp/<repo>-review checkout --detach
<mr-head> && git clean -fd` (keep ignored build dirs for incremental verify).
Parallel reviewers of the same MR share it read-only. A second concurrent MR
may get one extra worktree, but `git -C <repo> worktree remove --force <path>`
it the moment its round ends — `git worktree list` must stay clean.

## Local VCS: jj first
A worktree with a Jujutsu workspace (`.jj`, colocated included) is driven
through jj: MR inference reads the nearest bookmark, base/dirty/evidence use
the auto-snapshotted working-copy commit (`jj diff --from <base> --git`).
Anything else uses git. Sandboxed workers see `.jj` like `.git` — read-only:
edit files, leave VCS to the host.

## Publication language
Optional `language` in `~/.config/orch/config.json`: `中文` or `english`
(default; any other value falls back to english). Rule: when set to `中文`,
review/wiki/comment content published to GitLab (or GitHub) is written in
Chinese — orch enforces it for mirror/decision/cross-review comments and worker
result prose; agents posting wiki or other content on orch's behalf must follow
the same setting. Code, commands, file paths, and identifiers stay as-is.

## Division of labor
Strong model plans (via handoff-pro); tool-capable workers (codex / pi)
execute; omp (gpt-5.6-sol at xhigh thinking, quota fallback claude-fable-5 →
gemini-3.1-pro) covers review / research; claude escalates by role (reviewer opus/high, researcher
fable/xhigh). orch orchestrates and keeps all run state auditable under XDG_STATE.
