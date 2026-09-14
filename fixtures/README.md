# Golden fixtures

Data-only contract cases run by `src/golden.test.ts`. Adding a case is adding a
directory; no test code changes. Regenerate expectations after an intentional
behaviour change with `UPDATE_FIXTURES=1 bun test src/golden.test.ts` and review
the resulting diff like code.

## result-extraction/<case>/

What a worker's final text turns into as `result.json` (the driver's
`extractResultFromText`, coercions included).

- `spec.json`: overrides merged over a minimal reviewer spec (`role`, `run_id`,
  `language`, ...).
- `output.txt`: the worker's final text exactly as the provider emitted it.
- `expected.json`: the extracted role result, or `null` when nothing valid was
  found.

## comments/<case>/

What a run result renders to as a PR/MR comment (`mirrorBody`) or a decision
comment (`decisionBody`).

- `case.json`: `{ "mr", "run_id", "language"?: "中文", "decision"?: { "verdict", "reason" } }`.
  With `decision` present the case renders the decision comment.
- `result.json`: the run's `result.json`.
- `expected.md`: the rendered markdown.
