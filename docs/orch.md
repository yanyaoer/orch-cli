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
- **Implement / review / verify / research one task** → `orch run create`
  (agent = codex|claude|pi|omp, role = implementer|reviewer|verifier|researcher).
  Follow with `orch status` / `orch result`; record `orch decision`, then
  `orch mirror` it to the PR/MR. Dispatching a rework? `orch run create
  --resume-from <run_id> --task rework.md` keeps the worker's provider session
  instead of re-reading the repo from zero.
- **Need a plan/architecture decision, not code?** → `--role researcher`:
  read-only, web-research capable, returns a recommendation — or fan it out
  (below) for a second opinion.
- **Fan one task across agents** → `orch cross-review` (claude+omp review one
  diff; `--auto` records the unambiguous decisions and queues ONE merged MR
  comment), `orch investigate` (researcher role, omp+claude),
  `orch fanout --role <r>` (generic).
- **Drive orch by email** → `orch mailctl`: poll ingests an allowlisted,
  authenticated sender's task and spawns a claude controller that fans work out
  and replies in-thread; the controller orchestrates, it never edits code.
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

## Division of labor
Strong model plans (via handoff-pro); tool-capable workers (codex / pi)
execute; omp (gemini-3.1-pro, quota fallback claude-fable-5 → gpt-5.6) covers
review / research; claude escalates by role (reviewer opus/high, researcher
fable/xhigh). orch orchestrates and keeps all run state auditable under XDG_STATE.
