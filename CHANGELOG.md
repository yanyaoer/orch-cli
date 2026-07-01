# Changelog

All notable user-facing changes are recorded here.

## [Unreleased]

### Features

- Added the `agy` provider driver (Gemini 3.1 Pro), restricted to the read-only `reviewer` role and launched sandboxed (`--sandbox`); orch rejects it for every other role.
- Matched provider permissions to the role: the `reviewer` role now launches each provider without worktree write access (claude plan mode, codex `--sandbox read-only`, pi read-only tools, agy `--sandbox`). `verifier` and write roles keep write-capable access.
- Added `orch cross-review`, `orch fanout`, and `orch investigate`: one-shot fan-out of a single task across several agents. They route through the mail layer, so a `--thread <id>` supplies the mr and workspace context instead of `--mr`.

## [0.0.3] - 2026-06-25

### Features

- Replaced the orchestration bus with the local mail/Maildir implementation and added a typed bus abstraction for router, claim, ack, and nack flows.
- Added mail agent and workspace CLI surfaces for default agent materialization, agent listing, and workspace inspection.

### Reliability

- Added the local install script so replacing an existing compiled `orch` binary removes the old target before copying the new Mach-O.
- Simplified provider driver launch flow and shared driver command construction across Codex, Claude, and pi.

### Documentation

- Updated README and GitHub Pages quickstart content for the mail bus, local install path, and current CLI commands.

## [0.0.2] - 2026-06-23

### Features

- Added the `pi` provider driver alongside Codex and Claude.
- Added `orch chatgpt-bridge` for deploying a Cloudflare Worker MCP bridge that exposes a read-only worktree view to ChatGPT Developer Mode.
- Added `handoff-pro` support for packaging repository context for tool-less review/planning.

### Safety and Reliability

- Hardened provider session handling: default runs no longer use provider latest-session resume behavior, exact resume requires `--session-mode resume_exact --session-id <id>`, and unsafe session flag combinations are rejected before state is written.
- Added provider-session fingerprints to default idempotency keys so changing session settings creates a distinct run unless an explicit key is supplied.
- Rejected explicit idempotency-key reuse when the existing run's provider session settings differ from the requested settings; `--retry` is required for a new run.
- Sanitized recursive tool/MCP environment variables before supervisor-to-driver and driver-to-provider spawning.
- Added local private-path leak guards before mirroring decision/result payloads to PR/MR comments.
- Improved provider result extraction for valid JSON nested under schema-key wrappers and provider prose around final JSON.

### Documentation

- Updated README, command help, MVP docs, and multi-agent notes for provider session policy, dry-run planning, and release binaries.
- Updated GitHub Pages HTML to reflect Codex, Claude, and pi drivers plus release install guidance.

### Verification

- Added focused tests for provider argv construction, session validation, idempotency reuse, dry-run planning, result extraction, environment isolation, and mirror leak guards.

## [0.0.1] - 2026-06-21

### Bug Fixes

- Documented sandbox state-directory permissions for restricted runners.

## [0.0.0] - 2026-06-21

### Documentation

- Published the initial public README and GitHub Pages site.
