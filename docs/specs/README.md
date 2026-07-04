# Specs

`docs/specs/` stores discussable task or feature specs. Use one spec per task
or feature so workers can reason about a bounded slice of work.

## Rule

Specs are planning documents, not immutable decisions. When a spec is used to
author an `orch --task` file, inline the binding ADR/spec excerpts instead of
linking only to paths, because the task is captured into `spec.json`.

## Format

```md
# Short Title

## Goal

The outcome the task or feature should achieve.

## Constraints

Relevant constraints. Cite ADRs by number, and inline the binding text whenever
this spec is used to author an `orch --task` file.

## Acceptance

Observable conditions that prove the work is complete.

## Test Plan

Commands, checks, or manual verification needed before acceptance.
```

## Cross-Reference Rule

Specs cite ADRs. ADRs never cite specs.
