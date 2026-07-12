import { describe, expect, test } from "bun:test";
import { classifyNewOpenQuestions, evaluateNewExecution, validateNewPlanMarkdown } from "./new-flow.ts";

const validPlan = `## Destination
Ship a safe parser.

## Out of scope
- UI changes

## Tasks (now)
### implement-parser
- Role: implementer
- After: none
- Spec: Implement the parser without changing the public API.
- Acceptance:
  - parser tests pass
  - malformed input is rejected

### review-parser
- Role: reviewer
- After: implement-parser
- Spec: Review the implementation after implement-parser completes.
- Acceptance:
  - no blocking findings remain

## Later (not yet specified)
None.
`;

describe("validateNewPlanMarkdown", () => {
  test("accepts the exact plan grammar", () => {
    const result = validateNewPlanMarkdown(validPlan);
    expect(result).toEqual({
      ok: true,
      errors: [],
      tasks: [
        {
          id: "implement-parser",
          role: "implementer",
          depends_on: [],
          spec: "Implement the parser without changing the public API.",
          acceptance: ["parser tests pass", "malformed input is rejected"],
        },
        {
          id: "review-parser",
          role: "reviewer",
          depends_on: ["implement-parser"],
          spec: "Review the implementation after implement-parser completes.",
          acceptance: ["no blocking findings remain"],
        },
      ],
    });
  });

  test.each([
    ["leading commentary", `Here is the plan.\n${validPlan}`],
    ["code fence", `\`\`\`md\n${validPlan}\`\`\``],
    ["missing heading", validPlan.replace("## Destination\nShip a safe parser.\n\n", "")],
    ["duplicate heading", validPlan.replace("## Out of scope", "## Destination\nAgain.\n\n## Out of scope")],
    ["reordered headings", validPlan.replace("## Destination", "## TEMP").replace("## Out of scope", "## Destination").replace("## TEMP", "## Out of scope")],
    ["empty tasks", validPlan.replace(/### implement-parser[\s\S]*?(?=## Later)/, "")],
    ["bad task name", validPlan.replace("### implement-parser", "### Implement Parser")],
    ["duplicate task name", validPlan.replace("### review-parser", "### implement-parser")],
    ["bad role", validPlan.replace("- Role: implementer", "- Role: researcher")],
    ["missing dependency", validPlan.replace("- After: none\n", "")],
    ["future dependency", validPlan.replace("- After: none", "- After: review-parser")],
    ["missing spec", validPlan.replace("- Spec: Implement the parser without changing the public API.", "- Spec:")],
    ["missing acceptance", validPlan.replace("- Acceptance:\n  - parser tests pass\n  - malformed input is rejected", "")],
    ["empty later", validPlan.replace("## Later (not yet specified)\nNone.", "## Later (not yet specified)")],
  ])("rejects %s", (_name, markdown) => {
    expect(validateNewPlanMarkdown(markdown).ok).toBe(false);
  });
});

test("classifyNewOpenQuestions separates recommended defaults from blockers", () => {
  expect(
    classifyNewOpenQuestions([
      "Use SQLite? — recommended: yes",
      "Which production account? — blocking: no safe default",
      "Malformed legacy question",
    ]),
  ).toEqual({
    defaults: [{ question: "Use SQLite? — recommended: yes", value: "yes" }],
    blocking: ["Which production account? — blocking: no safe default", "Malformed legacy question"],
  });
});

test("evaluateNewExecution requires real, terminal, decided workers", () => {
  const accepted = {
    run_id: "impl-a",
    role: "implementer",
    state: "done" as const,
    stale: false,
    verdict: "completed",
    decision: "accept" as const,
  };
  expect(evaluateNewExecution(true, [accepted]).ok).toBe(true);
  expect(evaluateNewExecution(true, []).ok).toBe(false);
  expect(evaluateNewExecution(true, [{ ...accepted, state: "failed" }])).toMatchObject({ ok: false, failed: ["impl-a"] });
  expect(evaluateNewExecution(true, [{ ...accepted, decision: null }])).toMatchObject({ ok: false, undecided: ["impl-a"] });
  expect(evaluateNewExecution(true, [{ ...accepted, decision: "close" }])).toMatchObject({ ok: false, closed: ["impl-a"] });
  expect(evaluateNewExecution(true, [{ ...accepted, verdict: "failed" }])).toMatchObject({ ok: false, failed: ["impl-a"] });
  expect(evaluateNewExecution(false, [accepted])).toMatchObject({ ok: false, total: 1 });
  expect(evaluateNewExecution(true, [{ ...accepted, decision: "rework" }])).toMatchObject({ ok: false, rework_pending: ["impl-a"] });
  expect(
    evaluateNewExecution(true, [
      { ...accepted, run_id: "review-a", role: "reviewer", verdict: "request_changes", decision: "rework" },
      { ...accepted, run_id: "review-a-r2", role: "reviewer", verdict: "approve" },
    ]).ok,
  ).toBe(true);
});
