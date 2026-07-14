# seatbelt-v1 review fixes — 2026-07-14

Baseline reviewed: `cdf499f`. Six findings (three P1, three P2). All fixed with
minimal-repro tests that fail on the old code, then verified with real macOS
Seatbelt processes (no argv-only mocks) and real providers. Evidence:
`docs/reviews/real-smoke-evidence.txt` (four-provider fresh/resume + real-LLM
controller dispatch) and `docs/reviews/compiled-e2e.txt` (compiled-binary E2E).

## What changed

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | P1 | `$TMPDIR` could add any dir (`~/Documents`, other repos, `/opt/...`) to the write allow-set | `acceptableHostTmpDir` accepts only the real Darwin per-user temp (`/private/var/folders/<h>/<h>/T[/…]`) owned by the current uid; everything else is rejected before it can be granted. `drivers/sandbox.ts` |
| 2 | P1 | provider/controller state realpath'd straight into a `(subpath …)` allow, so `~/.pi -> $HOME` or `XDG_STATE_HOME -> /` granted a home/root-wide write | every canonical state subpath must pass `narrowWritableDirReason` (rejects `/`, HOME, ancestors of HOME/worktree, shared roots, non-dirs, non-owned); root-level state files must canonicalize to a direct child of HOME. Fail-closed in `buildProviderExecutionPlan`. |
| 3 | P1 | a sandboxed controller could not dispatch a working worker (worker inherits the controller's read-only Seatbelt; macOS can't nest `sandbox_apply`) | host-side dispatch queue (`src/dispatch.ts`): state-mutating `orch` commands issued in-sandbox are proxied to an unsandboxed reconciler whose workers apply fresh sandboxes. `orch new` runs it in-process; `orch mailctl poll` drains per tick; `orch dispatch reconcile --watch` is the standalone companion. |
| 4 | P2 | verifier is `project-write` but was not in `writeRoles`, so it took no worktree lock and collected no diff evidence | `writeRoles = {implementer, verifier}`, kept equal to the `project-write` posture set by a test; verifier now serializes on the worktree lock and its diff is collected. |
| 5 | P2 | controller got the whole orch state root → could overwrite any run's `spec/status/result/sandbox.json` | controller's only writable orch path is the narrow `dispatch/` outbox; formal artifacts are outside it. Resolved together with #3. |
| 6 | P2 | sandbox config read twice (`createRun` for the key, `startRun` for the spec) → TOCTOU key/spec split | engine resolved once in `createRun` and threaded immutable through `StartRunInput`; key suffix and spec field both come from one `sandboxRunIdentity(engine)` seam. |

## Tests added (fail on `cdf499f`, pass now)

- `drivers/sandbox.test.ts`: `acceptableHostTmpDir` rejects the three attack
  paths; `narrowWritableDirReason` / `rootLevelStateFileReason` gates;
  `sandboxRunIdentity` seam.
- `drivers/driver-common.test.ts`: plan fails closed when provider state
  symlinks to HOME; controller profile grants only `…/orch/dispatch`, not the
  state root.
- `src/schema.test.ts`: `writeRoles` == project-write posture (verifier in).
- `src/supervisor.test.ts`: verifier collects evidence; verifier fails closed
  (exit 75) when another project-write run holds the worktree lock.
- `src/dispatch.test.ts`: proxy⇄reconcile round-trip; marker stripped host-side.
- `src/sandbox-flow.test.ts`: real jail — sandboxed dispatch → host reconciler →
  worker with project-write (inside ok, outside denied); controller jail —
  dispatch dir writable, run artifacts denied.

## Verification

- `bun test`: 365 pass / 0 fail (real Seatbelt jail cases run, not skipped).
- `bun run build`; `git diff --check` clean; no new `tsc` errors vs baseline.
- Source-mode E2E in `bun test`; compiled-binary E2E in `compiled-e2e.txt`.
- Four providers fresh under the jail (inside write ok, out-of-jail write
  denied, `engine=seatbelt-v1`); codex + claude resume verified; pi/omp resume
  works via explicit `--session-id` (the auto `provider_resume_id` backfill gap
  is pre-existing and unrelated to the sandbox).
- Real-LLM claude controller dispatched a `pi` implementer: worker ran host-side
  with `posture=project-write`, wrote inside, out-of-jail write denied.

## Adversarial review (attempts to break the boundary)

- `$TMPDIR` set to `~/Documents` / another repo / `/opt/company/config` → all
  rejected by the Darwin-per-user-temp regex (tested).
- `~/.pi -> $HOME`, `~/.pi -> /`, provider-state ancestor of the worktree,
  non-owned dir, `~/.claude.json -> /etc/hosts` → all fail closed (tested).
- Controller writing a run's `spec.json` under the state root → denied by the
  real jail; writing the dispatch outbox → allowed (tested).
- Nested dispatch (a controller child that would re-enter the sandbox) → the
  proxy runs it host-side with the marker stripped, so it never re-proxies and
  never nests `sandbox_apply` (tested).
- Concurrent implementer + verifier on one worktree → the second fails closed on
  the worktree lock instead of racing (tested).

## Residual limitations (unchanged threat model)

- Not a hostile-code boundary: host reads and network egress stay open.
- The hardlink preflight has a scan→spawn race (accepted for the personal
  anti-mistake model; documented in the design).
- `pi`/`omp` do not backfill `provider_resume_id` from their native stream, so
  `--resume-from` needs an explicit `--session-id`. Pre-existing, orthogonal to
  the sandbox.
- Low-latency mailctl dispatch wants `orch dispatch reconcile --watch` running
  alongside the poll cron; a bare cron drains one batch per tick.
