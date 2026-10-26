// Claude implementer results that orch rejected although the work was done
// (orch run ledger 2026-10-23..26: 42 of 45 failed claude implementer runs).
// Streams and answers below are shaped after those runs, names generalized.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downgradeBasis,
  effectiveFinalAnswer,
  extractResultFromRunDir,
  rawResultText,
  repairHints,
  repairPreservesVerdict,
  resultValidationErrors,
  runProviderDriver,
} from "./driver-common.ts";
import { pairingCmd, validateRoleResult } from "../src/schema.ts";
import type { RoleResult, RunSpec } from "../src/types.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-claude-recovery-"));
  tempDirs.push(dir);
  return dir;
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const RUN_ID = "impl-142-s6-r2-20261023T103106-09ddb8";
function spec(role: RunSpec["role"] = "implementer"): RunSpec {
  return {
    version: 1, run_id: RUN_ID, mr: "278", role, agent: "claude", model: null, tag: "impl",
    provider_session_name: null, provider_session_id: null, provider_session_mode: "fresh_persistent",
    idempotency_key: RUN_ID, repo_key: "local/repo", worktree: "/tmp/repo", task_path: null, task_text: "t",
    task_sha: "s", base_sha: "base", timeout_sec: 60, created_at: "2026-10-23T10:31:06.000Z",
  };
}

type Test = { cmd: string; exit_code: number | null; status: string; phase: string; summary: string };
const t = (cmd: string, exit_code: number | null, status: string, phase: string, summary = "s"): Test => ({ cmd, exit_code, status, phase, summary });
function implementer(tests: Test[], verdict = "completed"): Record<string, unknown> {
  return {
    schema: "orch.result/implementer/v1", run_id: RUN_ID, verdict, summary: "done", base_sha: "base", head_sha: "base",
    changed_files: ["src/a.mjs"], tests, acceptance: [{ id: "I1", status: "met", evidence: "unit" }], risks: [], rollback: "git checkout base -- src/a.mjs",
  };
}
const errorsOf = (result: Record<string, unknown>) => validateRoleResult("implementer", result).errors;

// --- 1. red check pairing ------------------------------------------------

test("pairingCmd drops only text a shell would not run", () => {
  expect(pairingCmd("  node --test a.test.mjs (module from 439227a3)  ")).toBe("node --test a.test.mjs");
  expect(pairingCmd("node a.cjs  # R1: stream URL set back to '/api/events'")).toBe("node a.cjs");
  expect(pairingCmd("go test ./x (scratch copy) (run 2)")).toBe("go test ./x");
  expect(pairingCmd("node --test x.mjs (runContext:()=>ctx, no root carrier)")).toBe("node --test x.mjs");
  // Shell syntax stays: subshells, substitutions, arrays, quoted '#'/'(', words joined with '#'.
  expect(pairingCmd("make lint && (cd web && npm test)")).toBe("make lint && (cd web && npm test)");
  expect(pairingCmd("run $(git rev-parse HEAD)")).toBe("run $(git rev-parse HEAD)");
  expect(pairingCmd("make test; (cd web && npm test)")).toBe("make test; (cd web && npm test)");
  expect(pairingCmd("! (grep -q x f)")).toBe("! (grep -q x f)");
  expect(pairingCmd("grep -E 'a # (b)' f")).toBe("grep -E 'a # (b)' f");
  expect(pairingCmd("echo a#b")).toBe("echo a#b");
  expect(pairingCmd("find . \\( -name x \\)")).toBe("find . \\( -name x \\)");
  expect(pairingCmd("f ()")).toBe("f ()");
});

test("A1: a red check whose cmd carries a note pairs with the same command after the change", () => {
  for (const before of [
    "node --test sandbox/test/model-request-safety.test.mjs (module from 439227a3)",
    "node --test sandbox/test/model-request-safety.test.mjs  # red: module from 439227a3",
    " node --test sandbox/test/model-request-safety.test.mjs ",
    "red check — guard removed; node --test sandbox/test/model-request-safety.test.mjs",
    "python3 local-evidence/red.py r3-I1 && node --test sandbox/test/model-request-safety.test.mjs",
  ]) {
    const result = implementer([t(before, 1, "failed", "before_change"), t("node --test sandbox/test/model-request-safety.test.mjs", 0, "passed", "after_change")]);
    expect({ before, errors: errorsOf(result) }).toEqual({ before, errors: [] });
  }
});

test("A1: pairing stays strict — a different command, a failed after run, or only a before run never pairs", () => {
  const red = (cmd: string) => t(cmd, 1, "failed", "before_change");
  for (const tests of [
    [red("red: node --test a.test.mjs"), t("node --test a.test.mjs", 0, "passed", "after_change")],
    [red("node --test a.test.mjs b.test.mjs (old)"), t("node --test a.test.mjs", 0, "passed", "after_change")],
    [red("node --test a.test.mjs (old)"), t("make smoke", 0, "passed", "after_change")],
    [red("node --test a.test.mjs (old)"), t("node --test a.test.mjs", 1, "failed", "after_change")],
    [red("node --test a.test.mjs (old)"), red("node --test a.test.mjs")],
    [red("node --test  a.test.mjs"), t("node --test a.test.mjs", 0, "passed", "after_change")],
    [red("node --test a.test.mjs; make smoke"), t("make  smoke", 0, "passed", "after_change")],
    [red("make lint && (cd web && npm test)"), t("make lint &&", 0, "passed", "after_change")],
  ]) {
    expect(errorsOf(implementer(tests)).some((error) => error.startsWith("verdict completed contradicts tests[0]"))).toBe(true);
  }
  // A failed after-change check is still a contradiction whatever its cmd says.
  const relabeled = implementer([t("bun test (after the change)", 1, "failed", "after_change"), t("bun test", 0, "passed", "after_change")]);
  expect(errorsOf(relabeled)).toContain("verdict completed contradicts tests[0] (failed: bun test (after the change))");
});

// --- 2. repair hints -------------------------------------------------------

test("repair hints state the pairing rule and list the passing cmds instead of pushing the verdict", () => {
  const previous = JSON.stringify(implementer([
    t("red R1: guard removed; go test -run 'TestMaintenance' ./cmd/gw", 1, "failed", "before_change"),
    t("make smoke", 0, "passed", "after_change"),
    t("node x.cjs", 1, "passed", "after_change", "break check failed as expected"),
    t("full suite", 0, "skipped", "after_change"),
    t("bun test", 1, "failed", "after_change"),
  ]));
  const errors = resultValidationErrorsOf(previous);
  expect(errors).toEqual([
    "tests[2] is passed but exit_code 1 != expected_exit_code 0",
    "tests[3] is skipped, so exit_code must be null (a check that did not run has no exit code)",
    "verdict completed contradicts tests[0] (failed: red R1: guard removed; go test -run 'TestMaintenance' ./cmd/gw)",
    "verdict completed contradicts tests[4] (failed: bun test)",
  ]);
  const hints = repairHints(errors, previous, spec());
  const text = hints.join("\n");
  expect(text).toContain("character for character after dropping surrounding whitespace, a trailing shell comment");
  expect(text).toContain('tests[0] is a before_change red check with no passing after_change entry of the same cmd. Passing after_change cmds in the previous answer: "make smoke".');
  expect(text).toContain("A red check that failed before the change is not a failed required check.");
  expect(text).toContain('an implementer test is "passed" only with exit_code 0');
  expect(text).toContain('report it as a negative check: cmd "! <cmd>", exit_code 0, status "passed"');
  expect(text).toContain('A "skipped" check did not run and has "exit_code": null.');
  expect(text).toContain('tests[4] failed and is not phase "before_change".');
  // Each rule is stated once.
  expect(new Set(hints).size).toBe(hints.length);
  expect(repairHints(["verdict pass contradicts commands[0] (failed: x)"], "{}", spec("verifier"))).toEqual([]);
  expect(repairHints(["commands[0] is passed but exit_code 2 != expected_exit_code 0"], "{}", spec("verifier"))[0]).toContain('set "expected_exit_code": 2');
});

function resultValidationErrorsOf(previous: string): string[] {
  const dir = tempDir();
  writeFileSync(join(dir, "last_message.txt"), previous);
  return resultValidationErrors(dir, spec());
}

// --- 3. a prose turn after the delivered result ----------------------------

const init = (session: string) => ({ type: "system", subtype: "init", session_id: session });
const structuredCall = (value: unknown) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "StructuredOutput", input: value }] } });
const say = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const envelope = (structured: unknown, result: string) => ({ type: "result", subtype: "success", is_error: false, num_turns: 3, result, structured_output: structured });
const WAKEUP_PROSE = "Nothing left to do for this round. Both runs finished before this wakeup and passed on the final tree; the final result was already delivered.";
const writeStream = (dir: string, lines: unknown[]) => writeFileSync(join(dir, "native.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
const valid = implementer([t("bun test (base)", 1, "failed", "before_change"), t("bun test", 0, "passed", "after_change")]);

test("A2: a prose wake-up turn after the delivered result keeps the delivered result", () => {
  const dir = tempDir();
  writeStream(dir, [
    init("s1"), say("Working."), structuredCall(valid), envelope(valid, JSON.stringify(valid)),
    init("s1"), say(WAKEUP_PROSE), envelope(null, WAKEUP_PROSE),
  ]);
  expect(extractResultFromRunDir(dir, spec())).toEqual(valid as unknown as RoleResult);
  expect(effectiveFinalAnswer(dir, spec())).toEqual({ text: JSON.stringify(valid), source: "earlier_turn", finalTurn: WAKEUP_PROSE });
  // Without a role to judge "is this a result attempt" nothing is replaced.
  expect(rawResultText(dir)).toBe(WAKEUP_PROSE);
  // The latest earlier result wins over older ones.
  const older = { ...valid, summary: "older" };
  writeStream(dir, [envelope(older, ""), envelope(valid, ""), say(WAKEUP_PROSE), envelope(null, WAKEUP_PROSE)]);
  expect((extractResultFromRunDir(dir, spec()) as { summary: string }).summary).toBe("done");
});

test("A2: the fallback never replaces a final result attempt or crosses a failure, repair marker or non-envelope", () => {
  const cases: Array<[string, unknown[]]> = [
    ["final malformed JSON", [envelope(valid, ""), envelope(null, '{"verdict":"completed","summary":')]],
    ["final prose quoting a verdict key", [envelope(valid, ""), envelope(null, 'I changed "verdict" to failed after the suite broke.')]],
    ["final failed result", [envelope(valid, ""), envelope(null, JSON.stringify({ ...valid, verdict: "failed", tests: [t("bun test", 1, "failed", "after_change")] }))]],
    ["final invalid result", [envelope(valid, ""), envelope(null, JSON.stringify({ ...valid, tests: [t("bun test", 1, "failed", "after_change")] }))]],
    ["final empty envelope", [envelope(valid, ""), envelope(null, "")]],
    ["final error envelope", [envelope(valid, ""), { type: "result", subtype: "error_during_execution", is_error: true, result: WAKEUP_PROSE }]],
    ["stream ends mid-turn", [envelope(valid, ""), say(WAKEUP_PROSE)]],
    ["result only in an assistant message", [say(JSON.stringify(valid)), envelope(null, WAKEUP_PROSE)]],
    ["result before a repair marker", [envelope(valid, ""), { type: "orch_result_repair", attempt: 1 }, envelope(null, WAKEUP_PROSE)]],
  ];
  for (const [name, lines] of cases) {
    const dir = tempDir();
    writeStream(dir, lines);
    const answer = effectiveFinalAnswer(dir, spec());
    expect({ name, source: answer?.source ?? null }).toEqual({ name, source: answer ? "final" : null });
    if (name !== "final failed result") expect({ name, result: extractResultFromRunDir(dir, spec()) }).toEqual({ name, result: null });
  }
});

test("A2: an invalid delivered result followed by prose is what the repair round sees, so its verdict is kept", () => {
  const dir = tempDir();
  const unpaired = implementer([t("red R1: guard removed; bun test --grep guard", 1, "failed", "before_change"), t("bun test", 0, "passed", "after_change")]);
  writeStream(dir, [envelope(unpaired, ""), say(WAKEUP_PROSE), envelope(null, WAKEUP_PROSE)]);
  const previous = rawResultText(dir, spec())!;
  expect(JSON.parse(previous).verdict).toBe("completed");
  expect(resultValidationErrors(dir, spec())).toEqual(["verdict completed contradicts tests[0] (failed: red R1: guard removed; bun test --grep guard)"]);
  const repaired = implementer([t("red R1: guard removed; bun test", 1, "failed", "before_change"), t("bun test", 0, "passed", "after_change")]);
  expect(repairPreservesVerdict(previous, repaired as unknown as RoleResult, spec())).toBe(true);
  // Before: the prose final carried no verdict, so only "failed" could pass.
  expect(repairPreservesVerdict(WAKEUP_PROSE, repaired as unknown as RoleResult, spec())).toBe(false);
});

// --- end to end through the driver, with a fake claude --------------------

async function runFakeClaude(first: unknown[], repair: unknown[] | null): Promise<{ runDir: string; code: number; prompts: () => string }> {
  const root = tempDir();
  const runDir = join(root, "run"), binDir = join(root, "bin"), worktree = join(root, "worktree");
  for (const dir of [runDir, binDir, worktree]) mkdirSync(dir);
  const marker = join(root, "first-done");
  const lines = (stream: unknown[]) => stream.map((line) => `printf '%s\\n' ${shellQuote(JSON.stringify(line))}`).join("\n");
  writeFileSync(join(binDir, "claude"), [
    "#!/bin/sh", `cat >> ${shellQuote(join(root, "prompts.txt"))}`,
    `if [ -e ${shellQuote(marker)} ]; then`, lines(repair ?? []), "exit 0", "fi",
    `: > ${shellQuote(marker)}`, lines(first), "exit 0", "",
  ].join("\n"));
  chmodSync(join(binDir, "claude"), 0o755);
  const specPath = join(runDir, "spec.json");
  writeFileSync(specPath, JSON.stringify({ ...spec(), worktree }));
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  try {
    const code = await runProviderDriver("claude", ["--spec", specPath, "--run-dir", runDir, "--worktree", worktree]);
    return { runDir, code, prompts: () => readFileSync(join(root, "prompts.txt"), "utf8") };
  } finally {
    process.env.PATH = previousPath;
  }
}
const events = (runDir: string) => readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const resultOf = (runDir: string) => JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));

test("driver: A2 run delivers the earlier result, records the passed-over turn, and notes it in risks", async () => {
  const { runDir, code } = await runFakeClaude([init("s1"), structuredCall(valid), envelope(valid, ""), init("s1"), say(WAKEUP_PROSE), envelope(null, WAKEUP_PROSE)], null);
  expect(code).toBe(0);
  const result = resultOf(runDir);
  expect(result.verdict).toBe("completed");
  expect(result.risks).toEqual([`orch: the session ended on a prose turn without a result; the result is the one it delivered in an earlier turn. Final turn: ${WAKEUP_PROSE.slice(0, 117)}...`]);
  expect(events(runDir).find((event) => event.type === "result_source")).toMatchObject({ source: "earlier_turn" });
  expect(events(runDir).some((event) => event.type === "result_repair")).toBe(false);
});

test("driver: A1 answer with annotated red check cmds validates without a repair round", async () => {
  const annotated = implementer([t("node --test x.test.mjs (module from 439227a3)", 1, "failed", "before_change"), t("node --test x.test.mjs", 0, "passed", "after_change")]);
  const { runDir, code } = await runFakeClaude([init("s1"), envelope(annotated, "")], null);
  expect(code).toBe(0);
  expect(resultOf(runDir).verdict).toBe("completed");
  expect(events(runDir).some((event) => event.type === "result_repair")).toBe(false);
});

test("driver: a repair that turns completed into failed over unpaired red checks only is flagged", async () => {
  const unpaired = implementer([t("red R1: guard removed; go test -run TestGuard ./x", 1, "failed", "before_change"), t("make smoke", 0, "passed", "after_change")]);
  const downgraded = { ...unpaired, verdict: "failed" };
  const { runDir, code, prompts } = await runFakeClaude([envelope(unpaired, "")], [envelope(downgraded, "")]);
  expect(code).toBe(0);
  const result = resultOf(runDir);
  expect(result.verdict).toBe("failed");
  expect(result.risks.at(-1)).toContain("orch: the result repair round changed the verdict from completed to failed although the original answer's only failed checks were before_change red checks");
  const repair = events(runDir).find((event) => event.type === "result_repair");
  expect(repair.verdict_downgraded).toEqual({ from: "completed", to: "failed", basis: "red_checks_only" });
  expect(prompts()).toContain('Rules behind these errors:\n- A failed "before_change" red check counts only when');
});

test("downgradeBasis: a real failed check, unmet acceptance or ambiguous exit is evidence", () => {
  const red = t("red: x", 1, "failed", "before_change");
  expect(downgradeBasis(JSON.stringify(implementer([red, t("make smoke", 0, "passed", "after_change")])), spec())).toBe("red_checks_only");
  expect(downgradeBasis(JSON.stringify(implementer([red, t("bun test", 1, "failed", "after_change")])), spec())).toBe("evidence");
  expect(downgradeBasis(JSON.stringify(implementer([red, t("bun test", 1, "passed", "after_change")])), spec())).toBe("evidence");
  expect(downgradeBasis(JSON.stringify({ ...implementer([red]), acceptance: [{ id: "A", status: "unmet" }] }), spec())).toBe("evidence");
  expect(downgradeBasis("no json here", spec())).toBe("evidence");
});
