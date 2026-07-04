# Specs

`docs/specs/` stores discussable task or feature specs. Use one spec per task
or feature so workers can reason about a bounded slice of work.

## Rule

Specs are planning documents, not immutable decisions. When a spec is used to
author an `orch --task` file, inline the binding ADR/spec excerpts instead of
linking only to paths, because the task is captured into `spec.json`.
Specs describe durable behavioral contracts: interfaces, types, acceptance
criteria, and constraints. Do not use file paths or line numbers; precise paths
belong in the dispatch-time `--task` file consumed within minutes.

## Format

```md
# Short Title

## Goal

The outcome the task or feature should achieve.

## Out of Scope

What this spec explicitly will not cover.

## Constraints

Relevant constraints. Cite ADRs by number, and inline the binding text whenever
this spec is used to author an `orch --task` file.

## Acceptance

Observable conditions that prove the work is complete.

## Test Plan

Commands, checks, or manual verification needed before acceptance. Agree the
seams under test before implementation begins; prefer existing seams over new
ones, and fewer seams over more.
```

## Cross-Reference Rule

Specs cite ADRs. ADRs never cite specs.
