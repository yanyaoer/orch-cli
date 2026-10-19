# 0002 Per-account slots and pauses

Status: Proposed

## Context

orch runs inherit CLAUDE_CONFIG_DIR / CODEX_HOME from the environment and never record it. On 2026-10-19 this produced
four real failures: (1) a gateway concurrency 429 was read as quota exhaustion and all dispatch paused for 60 minutes, twice;
(2) `run create --resume-from` passed orch's checks but claude could not find the session because the config dir had
changed between runs, and no run record could say which account it used; (3) ~/.claude was out of quota until 2026-10-21
while ~/.claude-work had quota, and nothing in orch could route work to it; (4) 522/524 gateway errors ended runs as plain
`failed`, indistinguishable from quota. The external scheduler (loopx) compensated by scraping transcripts, keeping a
global quota file, and counting slots in two places (orch runs vs `claude --bg` sessions). ADR-0001 removed
`max_concurrency` because nothing honored it; these cases are the concurrent-claim failures it asked for.

## Decision

- `config.json.accounts[]` declares provider accounts: id, provider (claude|codex), the env that selects the config dir,
  `max_concurrent`, optional model whitelist. Every run snapshots its account into spec.json and status.json.
- Slots are N exclusive owner-record locks under `$XDG_STATE_HOME/orch/accounts/<id>/slot-<k>.lock` (the existing
  `src/locks.ts` mechanism); a full account is exit 75, same as a held worktree lock. External holders publish the same
  record via `orch account acquire/release` (pid-bound, or ttl-bound as fallback).
- Provider limits are classified from structured provider output only into quota | concurrency | server and written to
  status.limit. Only `quota` writes `accounts/<id>/pause.json` (expires by itself); concurrency/server never pause an account.
- `--resume-from` inherits and enforces the original account. The sandbox grants the account's own dir instead of ~/.claude
  (seatbelt-v2). Trajectory lookup uses the account dir.
- Selection without --account: a non-paused account with a free slot for the provider, honoring `defaults.pairing`
  (verifier/reviewer from a different model family than the MR's implementer).
- No daemon, no queue, no new run state. Canonical state remains cat-readable files.

## Consequences

- Enables: several accounts consuming quota in parallel; auditable account per run; one slot ledger shared with
  non-orch sessions; loopx deletes pick-agent.py, transcript scraping and its global quota file.
- Forbids: inheriting the provider config dir silently once accounts are configured; classifying limits from model prose.
- Makes more expensive: adding a provider means adding its config-dir env var and a limit parser with real-run fixtures;
  changing the sandbox grant bumps the engine version.
