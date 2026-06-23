# Changelog

All notable user-facing changes are recorded here.

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
