# Architecture Decision Records

`docs/adr/` stores durable architecture decisions for this workspace.

## Naming

Use numbered files: `NNNN-short-slug.md`.

Example: `0001-worker-task-replay.md`.

## Rule

Accepted ADRs are non-negotiable constraints. A later ADR can supersede an
earlier one, but workers should not re-litigate accepted decisions.

## Format

```md
# NNNN Short Title

Status: Proposed | Accepted | Superseded

## Context

What pressure, constraint, or tradeoff forced the decision.

## Decision

The decision workers must follow.

## Consequences

What this enables, forbids, or makes more expensive.
```

## Cross-Reference Rule

Specs may cite ADRs by number. ADRs never cite specs.
