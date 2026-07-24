# orch gui

Minimal AppKit front-end for the orch CLI (SwiftPM, no Xcode project).

```sh
cd gui && swift run
```

- Sidebar: tasks (MR threads) for the selected workspace via `orch status --json`,
  expandable to per-agent runs with state; refreshes every 5s. Double-click a run
  to print its `orch result` in the log.
- Agent management rides orch's normalized native stream (never raw provider
  session files — `native-events.ts` already unifies codex/claude/pi/omp):
  single-click a run to follow that agent's live trajectory
  (`orch events tail --run <id> --native -f`, with 40 lines of replay); the
  stream auto-returns to the workspace-wide multiplexer when the run reaches a
  terminal state or the selection clears. A "取消 Run" button cancels the
  selected active run via `orch run cancel`.
- Main pane: pick a workspace (`orch workspace list`), type a task, press Enter →
  `orch new '<query>' --workspace <id> --yes`. Plan/controller progress renders
  above the input; the always-on global stream picks up new runs as the
  controller dispatches them.
- `orch new` runs with `--yes` because the terminal confirm step has no GUI; tasks
  with blocking questions fail fast — answer them via the CLI instead.

Requires `orch` on `$PATH` (or `~/.local/bin/orch`).
