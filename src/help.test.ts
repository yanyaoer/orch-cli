import { expect, test } from "bun:test";
import { runCreateHelp, statusHelp, topicHelp, topLevelHelp, unknownTopicHelp } from "./help.ts";

test("top-level help exposes positioning, commands, quickstart, and topics", () => {
  const text = topLevelHelp();

  expect(text).toContain("daemonless multi-agent orchestrator");
  expect(text).toContain("orch run create");
  expect(text).toContain("orch status");
  expect(text).toContain("Quickstart:");
  expect(text).toContain("orch <command> --help");
  expect(text).toContain("task-spec | result | events | concepts");
});

test("command help exposes flags and runnable examples", () => {
  const runCreate = runCreateHelp();
  const status = statusHelp();

  for (const flag of ["--mr", "--role", "--agent", "--tag", "--worktree", "--task", "--idempotency-key", "--retry", "--timeout-sec"]) {
    expect(runCreate).toContain(flag);
  }
  expect(runCreate).toContain("Example:");
  expect(runCreate).toContain("orch run create --mr 123");

  for (const flag of ["--mr", "--json", "--worktree"]) {
    expect(status).toContain(flag);
  }
  expect(status).toContain("orch status --mr 123");
});

test("topic help covers task specs, results, events, and concepts", () => {
  expect(topicHelp("task-spec")).toContain("result.json");
  expect(topicHelp("task-spec")).toContain("Role:");
  expect(topicHelp("task-spec")).toContain("Agent:");
  expect(topicHelp("task-spec")).toContain("Worktree:");

  const result = topicHelp("result");
  expect(result).toContain("orch.result/implementer/v1");
  expect(result).toContain("orch.result/reviewer/v1");
  expect(result).toContain("orch.result/verifier/v1");

  const events = topicHelp("events");
  expect(events).toContain("orch-evt");
  expect(events).toContain("events.jsonl");

  const concepts = topicHelp("concepts");
  expect(concepts).toContain("created -> starting -> running -> done");
  expect(concepts).toContain("${XDG_STATE_HOME:-$HOME/.local/state}/orch/<repo_key>/mrs/<mr>/runs/<run_id>/");
  expect(concepts).toContain("A1:");
  expect(concepts).toContain("A2:");
});

test("unknown topic help is friendly and lists topics", () => {
  const text = unknownTopicHelp("bogus");

  expect(text).toContain("unknown help topic: bogus");
  expect(text).toContain("task-spec | result | events | concepts");
});
