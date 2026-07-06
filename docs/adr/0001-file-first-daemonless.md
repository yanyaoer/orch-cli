# 0001 File-First Daemonless State

Status: Accepted

## Context

orch's value proposition is that a human or an agent can inspect every piece of
run state with ordinary shell commands — `cat`, `find`, `tail`, `git diff` — with
no daemon running and no framework to learn. Every architectural proposal that
introduces a canonical event ledger, a projection layer, a workflow database, or
a background process trades that inspectability for machinery: understanding the
system starts to require replaying reducers or reading framework code instead of
reading files. That trade raises audit cost and breaks the daemonless model,
which is the pressure this ADR resolves once instead of per-review.

## Decision

Files own the truth, artifacts own the evidence, locks and idempotency own
mutual exclusion, the CLI owns progress, transports only carry necessary facts
outward.

Concretely:

- Canonical state remains ordinary cat-readable local files under `XDG_STATE`:
  `spec.json`, `status.json`, `result.json`, `decision.json`, outbox files, and
  `artifacts/`. Each file is the authoritative record of the fact it names.
- `events.jsonl` and `mail-events.jsonl` are append-only diagnostics and
  transport traces. They are never the sole source of truth: no reader may need
  to replay them to reconstruct canonical state.
- Rejected until a real failing use case pays rent:
  - a global event ledger or event envelope,
  - projection-only canonical state (state derived solely by replaying events),
  - a workflow database or workflow-id layer,
  - a routing policy DSL,
  - a principal/keyring layer,
  - a lease/fencing protocol,
  - any daemon (`orchd`) oriented domain split.

Note: the agent-registry field `max_concurrency` was removed rather than
enforced — nothing in claim or run behavior ever honored it, and a config field
that looks load-bearing but is not is worse than none. Reintroduce it only when
a real concurrent-claim failure exists.

## Consequences

- Enables: full audit of any run with shell built-ins; state survives and stays
  legible without any process running; workers and controllers stay simple
  because they read and write plain files.
- Forbids: designs where canonical state is only reachable through replay,
  a query layer, or a daemon; re-litigating the rejected list above without a
  concrete failing use case as evidence.
- Makes more expensive: features that genuinely need cross-run coordination or
  global ordering — they must either fit the file-first model (locks,
  idempotent writes) or bring the failing use case that supersedes this ADR.
