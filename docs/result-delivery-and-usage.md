# Result delivery and usage evidence

The final completed assistant response is authoritative. Structured native
streams do not fall back to earlier messages, tool output or stale last-message
files when the last answer is malformed. Pi `agent_end` snapshots use the last
assistant message; a failed/aborted response or nonzero process exit prevents
successful delivery. A repair marker begins a new attempt, even if it emits no
answer.

One narrow exception: a Claude session that already delivered its result can be
woken again (its own reminder, a background task notification) and end on a
prose turn. When that final turn is a successful terminal envelope and is not a
result attempt at all (no role-shaped JSON, no `"verdict"` key, no
`orch.result/` schema anywhere in it), the latest earlier terminal envelope of
the same attempt that is a result attempt stands in for it. Earlier assistant
messages, tool output and anything before a repair marker are still never used;
a malformed or failed final answer is never replaced. The run records a
`result_source` event with the passed-over turn, and implementer/researcher
results get an `orch:` line in `risks`.

One formatting repair remains available. Its prompt receives the actual final
answer (or the earlier-turn answer above), the validator's errors, and the rule
behind each error (red check pairing, status vs `exit_code`, skipped checks), and
`result.original.md` preserves that answer before repair. A repair
must exit successfully, pass the schema, and preserve an explicit original
verdict. Unparseable originals cannot authorize successful repaired verdicts.
Failed evidence cannot be removed to obtain success. Required skipped checks
block a verifier pass; implementers may preserve checks left to a verifier.
A repair that moves the verdict to the failure side is accepted and flagged:
`verdict_downgraded.basis` is `evidence` when the original answer had a failed
after-change check, a passed check with a non-zero exit, or an unmet acceptance
item, and `red_checks_only` when its only failed checks were unpaired red checks
(the downgrade came from the format); implementer/researcher results get an
`orch:` line in `risks` either way. Rejected repairs leave the original in `result.raw.md`. This is a conservative
gate, not proof of every factual statement; independent review and host evidence
are still required. Run `done` describes process completion, not acceptance of
the business verdict.

`orch usage ... --json` retains the v1 legacy fields for compatibility and adds:

- `normalized_tokens`: input includes cache read/write, output excludes no
  reasoning subset, total is input + output, non-cache-read is total - cache
  read. None of these fields represents unique content or invoice cost.
- `coverage`: `complete`, `partial` or `missing`, with machine-readable reasons,
  counted-record count and provider basis. Partial values describe only observed
  records. Missing fields are not inferred as zero.
- `response_observations`: Pi completed assistant messages classified by explicit
  stop reason into successful, error/aborted and unknown, plus repair attempt
  count. These are not HTTP request/attempt counts. Other providers' response
  counts remain null. Error usage is marked partial even when it reports zero.
- `lifecycle`: safe phase timestamps and observed run duration. Creation-to-start
  time is not pure queue wait. Provider duration includes model, tools and
  transport. Queue, human and model-only waits remain null when not observed.

Pi counts `message_end.message.usage`, deduplicating explicit response/message
IDs and ignoring repeated turn/end snapshots. Claude uses the final terminal
result total per attempt, not assistant totals as well. Conflicting Pi records
with the same ID make coverage partial and the response error or unknown;
their tokens are never counted twice. Codex uses the last
cumulative counter per session, plus separately marked fresh repair attempts.
Resumed/legacy Codex runs without an evidenced pre-run baseline remain excluded
from complete totals. This version deliberately does not inspect arbitrary
provider home/session files or guess baselines from sibling runs.

Thread/daily normalized totals include only complete runs and list exclusions.
Legacy `usage` remains a raw, provider-dependent event sum; it may duplicate
cumulative counters and should not be used for cross-provider cost comparisons.
`estimated_cost_usd` remains null. Numeric metrics contain no prompts, tool
arguments, assistant text or credentials.

New driver phases are `provider_start`, `provider_end`, `result_validation`,
`result_repair_start`, `result_repair_end` and `delivery_complete`.
`wait_reason=provider_process` is an observed category, not an LLM-time estimate.
These additions do not change scheduling, concurrency, models or acceptance.

Validation uses synthetic streams and fake executables; no model call is needed:

```sh
bun test drivers/driver-common.test.ts src/usage-evidence.test.ts src/search-usage.test.ts
```
