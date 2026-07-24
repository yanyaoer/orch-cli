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
- Agent management rides orch's normalized native stream (never raw provider
  session files — `native-events.ts` already unifies codex/claude/pi/omp):
  single-click a run to follow that agent's live trajectory
  (`orch events tail --run <id> --native -f`, with 40 lines of replay). Runs
  whose worktree is gone (deleted scratch dirs) replay `native.jsonl` from the
  state dir instead — those are terminal, so the static tail is complete. The
  stream auto-returns to the all-repo multiplexer (`events tail -f --all
  --native`) when the run ends or the selection clears. A "取消 Run" button
  cancels the selected active run via `orch run cancel`.
- Main pane: pick a workspace (`orch workspace list`) — it scopes only
  `orch new` — type a task, press Enter →
  `orch new '<query>' --workspace <id> --yes`. Plan/controller progress renders
  above the input; the always-on global stream picks up new runs as the
  controller dispatches them.
- `orch new` runs with `--yes` because the terminal confirm step has no GUI; tasks
  with blocking questions fail fast — answer them via the CLI instead.

Requires `orch` on `$PATH` (or `~/.local/bin/orch`).
