# orch gui

Minimal AppKit front-end for the orch CLI (SwiftPM, no Xcode project).

```sh
cd gui && swift run
```

- Sidebar: tasks (MR threads) for the selected workspace via `orch status --json`,
  expandable to per-agent runs with state; refreshes every 5s. Double-click a run
  to print its `orch result` in the log.
- Main pane: pick a workspace (`orch workspace list`), type a task, press Enter →
  `orch new '<query>' --workspace <id> --yes`. Plan/controller progress and the
  multiplexed worker stream (`orch events tail -f --native`) render above the input.
- `orch new` runs with `--yes` because the terminal confirm step has no GUI; tasks
  with blocking questions fail fast — answer them via the CLI instead.

Requires `orch` on `$PATH` (or `~/.local/bin/orch`).
