### orch run result

- MR/PR: 42
- Run: review-1
- State: unknown
- Verdict: request_changes

Summary:

1 blocking finding(s), 1 non-blocking finding(s).

Blocking findings (1):

**[high | F1 | src/a.ts:12]**
Null dereference when the list is empty.

Repro: call with [].

Non-blocking findings (1):

**[]**
Log line typo.

Suggested tests (1):

- empty list case
