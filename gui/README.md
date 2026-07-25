# orch gui

Minimal AppKit front-end for the orch CLI (SwiftPM, no Xcode project).

```sh
cd gui && swift run
```

- Sidebar reads the orch state tree directly
  (`${XDG_STATE_HOME:-~/.local/state}/orch/<repo_key>/mrs/<mr>/runs/<run_id>/`):
  every repo shows up (not just the selected workspace), records survive
  deleted worktrees, and one malformed status.json skips a single row instead
  of blanking the tree. Hierarchy repo → task (MR) → per-agent runs with state
  dot, relative time, and decision mark (✓ accept / ↻ rework / ✕ close);
  rescans every 5s with an mtime cache. Double-click a run to pretty-print its
  `result.json` straight from the state dir.
- History messages for a terminal run are the provider's OWN session file
  (located via the run's `provider_resume_id`: `~/.claude/projects/…` /
  `~/.codex/sessions/…`) normalized into role-based records — user /
  assistant / reasoning / tool call / tool result — by
  [@letta-ai/trajectory](https://github.com/letta-ai/trajectory) (bun runs the
  fork's TypeScript source directly; set `ORCH_TRAJECTORY_DIR`, default
  `~/Projects/fork/trajectory`). orch's `native.jsonl` is stream output the
  trajectory adapters cannot parse (verified), so it remains the path for
  active runs, pi/omp, and any normalize failure. Scroll-up paging works over
  the in-memory records; clicking a line shows the full record JSON in a HUD.
  The view auto-returns to the all-repo multiplexer (`events tail -f --all
  --native`) when the selection clears. A "取消 Run" button cancels the
  selected active run via `orch run cancel`.
- Main pane: pick a workspace (`orch workspace list`) — it scopes only
  `orch new` — type a task, press Enter →
  `orch new '<query>' --workspace <id> --yes`. Plan/controller progress renders
  above the input; the always-on global stream picks up new runs as the
  controller dispatches them.
- `orch new` runs with `--yes` because the terminal confirm step has no GUI; tasks
  with blocking questions fail fast — answer them via the CLI instead.

Requires `orch` on `$PATH` (or `~/.local/bin/orch`).
