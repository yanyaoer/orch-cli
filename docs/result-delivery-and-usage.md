# Result delivery and usage evidence

The final completed assistant response is authoritative. Structured native
streams do not fall back to earlier messages, tool output or stale last-message
files when the last answer is malformed. Pi `agent_end` snapshots use the last
assistant message; a failed/aborted response or nonzero process exit prevents
successful delivery. A repair marker begins a new attempt, even if it emits no
answer.

One formatting repair remains available. Its prompt receives the actual final
answer, and `result.original.md` preserves that answer before repair. A repair
must exit successfully, pass the schema, and preserve an explicit original
verdict. Unparseable originals cannot authorize successful repaired verdicts.
Rejected repairs leave the original in `result.raw.md`. This is a conservative
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
result total per attempt, not assistant totals as well. Codex uses the last
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
