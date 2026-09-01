import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./cli.ts";
import { buildReworkAppendix } from "./mail-cli.ts";

const REPO_KEY = "github.com/x/y-abc123";
const previousStateHome = process.env.XDG_STATE_HOME;
let stateHome: string;

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), "orch-rework-"));
  process.env.XDG_STATE_HOME = stateHome;
});

afterEach(() => {
  rmSync(stateHome, { recursive: true, force: true });
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
});

interface FixtureRun {
  agent: string;
  round: string;
  state?: string;
  base_sha?: string;
  verdict?: string;
  blocking?: Array<Record<string, unknown>>;
  non_blocking?: unknown[];
  decision?: string;
}

function writeRun(mr: string, run: FixtureRun): string {
  const runId = `mail-reviewer-${run.agent}-${run.round}-${run.round.slice(-6)}${run.agent.length}`;
  const runDir = join(stateHome, "orch", REPO_KEY, "mrs", mr, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "status.json"),
    JSON.stringify({
      run_id: runId,
      role: "reviewer",
      agent: run.agent,
      state: run.state ?? "done",
      started_at: `${run.round.slice(0, 4)}-01-01T00:00:00.000Z`,
      updated_at: `${run.round.slice(0, 4)}-01-01T00:10:00.000Z`,
      base_sha: run.base_sha ?? "a".repeat(40),
      mr,
    }),
    "utf8",
  );
  if (run.verdict) {
    writeFileSync(
      join(runDir, "result.json"),
      JSON.stringify({
        schema: "orch.result/reviewer/v1",
        verdict: run.verdict,
        blocking_findings: run.blocking ?? [],
        non_blocking_findings: run.non_blocking ?? [],
      }),
      "utf8",
    );
  }
  if (run.decision) {
    // Matches recordDecision's on-disk shape: the controller's call is `verdict`.
    writeFileSync(
      join(runDir, "decision.json"),
      JSON.stringify({ verdict: run.decision, run_id: runId, reason: "test", ts: new Date().toISOString() }),
      "utf8",
    );
  }
  return runId;
}

test("rework appendix summarizes prior rounds, scopes the diff, and truncates findings", () => {
  const longBody = `The claim.  ${"x".repeat(400)}`;
  writeRun("16", {
    agent: "claude",
    round: "20260831T110000",
    base_sha: "b".repeat(40),
    verdict: "request_changes",
    blocking: [{ id: "B1", severity: "high", file: "src/worktree.ts", body: longBody }],
    non_blocking: [{ id: "N1" }, { id: "N2" }],
    decision: "rework",
  });
  writeRun("16", { agent: "omp", round: "20260831T110000", state: "timeout", base_sha: "b".repeat(40), decision: "close" });

  const appendix = buildReworkAppendix(REPO_KEY, "16", "c".repeat(40));
  expect(appendix).toContain("This is round 2.");
  expect(appendix).toContain(`REVIEW SCOPE — review ONLY: git diff ${"b".repeat(40)}...${"c".repeat(40)}`);
  expect(appendix).toContain("### Round 1");
  expect(appendix).toContain("verdict=request_changes, decision=rework");
  expect(appendix).toContain("state=timeout, verdict=-, decision=close");
  expect(appendix).toContain("[blocking | high | B1 | src/worktree.ts]");
  expect(appendix).toContain("non-blocking: 2 recorded finding(s)");
  // Long bodies are clipped, not embedded whole.
  expect(appendix).not.toContain("x".repeat(300));
  expect(appendix).toContain("...");
  expect(appendix).not.toContain("WARNING:");
});

test("rework appendix notes an unchanged head and warns from round 4 on", () => {
  const head = "d".repeat(40);
  for (const round of ["20260831T100000", "20260831T110000", "20260831T120000"]) {
    writeRun("17", { agent: "claude", round, base_sha: head, verdict: "request_changes", decision: "rework" });
  }
  const appendix = buildReworkAppendix(REPO_KEY, "17", head);
  expect(appendix).toContain("This is round 4.");
  expect(appendix).toContain("WARNING: 3 prior rounds");
  expect(appendix).toContain(`HEAD equals the last reviewed commit (${head})`);
  expect(appendix).toContain("### Round 3");
});

test("rework without settled reviewer runs fails loudly", () => {
  expect(() => buildReworkAppendix(REPO_KEY, "18", "e".repeat(40))).toThrow(CliError);
  expect(() => buildReworkAppendix(REPO_KEY, "18", "e".repeat(40))).toThrow("no settled reviewer runs");
  // A still-running round does not count as settled.
  writeRun("18", { agent: "claude", round: "20260831T130000", state: "running" });
  expect(() => buildReworkAppendix(REPO_KEY, "18", "e".repeat(40))).toThrow("no settled reviewer runs");
});
