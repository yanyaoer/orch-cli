# sandbox dispatch follow-up review — 2026-07-14

Baseline: `ff8dc2e`. Scope: the uncommitted `seatbelt-v1` controller/host dispatch
implementation and provider-state path validation.

## Review sequence

| Round | Claude | OMP | Outcome |
|---|---|---|---|
| Original findings | `mail-reviewer-claude-reviewer-20260714T134018-4c7bc2` | `mail-reviewer-omp-reviewer-20260714T134018-d0236a` | Confirmed four blockers: untrusted raw host dispatch, missing mailctl mutations, provider-state aliases, and lost claimed requests. |
| First fix review | `mail-reviewer-claude-reviewer-20260714T145716-a333b5` | `mail-reviewer-omp-reviewer-20260714T145716-2a2fb5` | Claude approved; OMP found queue endpoint aliases and partially visible request publication. |
| Targeted re-review | `mail-reviewer-claude-reviewer-20260714T153449-37bb1d` | `mail-reviewer-omp-reviewer-20260714T153450-70788f` | Claude's raw review approved but failed the orch result schema and was correctly treated as invalid. OMP found controller dry-run rejecting missing exact slots and the transient two-link publication window. |
| Closure review | `mail-reviewer-claude-reviewer-20260714T154429-6f7f52` | `mail-reviewer-omp-reviewer-20260714T154429-2d7a6f` | Both returned valid `approve` results with no blocking findings. |

## Final boundary

- Host dispatch accepts only a structured operation allow-list. The host binds
  each request to the live controller's host-owned spec/status, canonical
  worktree and thread, then reconstructs argv instead of executing raw input.
- Each controller writes only its exact `dispatch/pending/<run-id>` endpoint.
  `pending`, `claims` and `done` are verified before and after creation; aliases,
  non-directories and non-owned endpoints fail closed. Dry-run permits an exact
  missing endpoint without creating state.
- A request is serialized under an invisible temporary name and atomically
  published with no-overwrite semantics. Reconcile defers while the producer's
  temporary hardlink still exists, then claims and executes once; the
  post-claim hardlink check remains enforced.
- Claimed operations are not blindly replayed after a host interruption.
  Recovery preserves a valid persisted result or emits `outcome_unknown`.
- Provider state stays in its exact HOME slot. Top-level provider-state
  symlinks and Claude root-state symlinks/hardlinks are rejected.

## Verification

- Targeted boundary tests: `77 pass / 0 fail`.
- Full suite: `378 pass / 0 fail`, `2327 expect()` calls, 29 files. This includes
  real macOS Seatbelt processes and the complete sandbox dispatch flow.
- `bun run build`: compiled `dist/orch` successfully.
- Compiled smoke: `orch v0.0.9`; empty `dispatch reconcile` handled 0 requests.
- `git diff --check`: clean.

## Accepted low-severity lifecycle limits

- A hard process termination between atomic link publication and temporary-link
  cleanup can leave a complete `nlink > 1` envelope deferred until broader run
  cleanup. It fails closed and its controller has already died.
- Host-owned `done/<controller-run-id>` results remain until run/MR state cleanup.
  This preserves result authenticity but can accumulate for a long-lived
  controller.

Neither limit expands the write boundary. Cleanup policy is intentionally left
outside `seatbelt-v1` rather than adding recovery machinery to the permission
protocol.
