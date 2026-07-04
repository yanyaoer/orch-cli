import { expect, test } from "bun:test";
import {
  decisionHelp,
  eventsTailHelp,
  fanoutHelp,
  mirrorHelp,
  mirrorSyncHelp,
  mailctlHelp,
  resultCommandHelp,
  runCreateHelp,
  runHelp,
  runListHelp,
  statusHelp,
  topicHelp,
  topLevelHelp,
  unknownTopicHelp,
} from "./help.ts";

test("top-level help exposes positioning, commands, quickstart, and topics", () => {
  const text = topLevelHelp();

  expect(text).toContain("daemonless multi-agent orchestrator");
  expect(text).toContain("orch run create");
  expect(text).toContain("orch run list");
  expect(text).toContain("orch cross-review");
  expect(text).toContain("orch fanout");
  expect(text).toContain("orch investigate");
  expect(text).toContain("orch events tail");
  expect(text).toContain("orch result");
  expect(text).toContain("orch status");
  expect(text).toContain("orch decision");
  expect(text).toContain("orch mirror");
  expect(text).toContain("orch mirror sync");
  expect(text).toContain("orch mailctl");
  expect(text).toContain("Quickstart:");
  expect(text).toContain("orch <command> --help");
  expect(text).toContain("task-spec | result | events | concepts | forge");
});

test("fanout help covers the three commands, agent flag, and examples", () => {
  const text = fanoutHelp();
  for (const command of ["cross-review", "fanout", "investigate"]) expect(text).toContain(command);
  expect(text).toContain("--thread");
  expect(text).toContain("--to-agent");
  expect(text).toContain("--role");
  expect(text).toContain("--dry-run");
  expect(text).toContain("orch cross-review --thread review-123");
  expect(text).toContain("orch fanout --thread verify-123 --role verifier");
  expect(text).toContain("orch investigate --thread research-1");
});

test("command help exposes flags and runnable examples", () => {
  const runCreate = runCreateHelp();
  const status = statusHelp();

  for (const flag of [
    "--mr",
    "--role",
    "--agent",
    "--tag",
    "--model",
    "--worktree",
    "--task",
    "--idempotency-key",
    "--retry",
    "--allow-dirty",
    "--timeout-sec",
    "--session-mode",
    "--session-name",
    "--session-id",
    "--dry-run",
    "--json",
  ]) {
    expect(runCreate).toContain(flag);
  }
  expect(runCreate).toContain("Example:");
  expect(runCreate).toContain("controller");
  expect(runCreate).toContain("Claude-only");
  expect(runCreate).toContain("allowed-tool whitelist");
  expect(runCreate).toContain("orch run create --mr 123");

  const runList = runListHelp();
  for (const flag of ["--mr", "--worktree", "--json"]) {
    expect(runList).toContain(flag);
  }
  expect(runList).toContain("run_id, mr, role, agent, tag, state, started_at, exit_code");
  expect(runList).toContain("orch run list --mr 123");

  const run = runHelp();
  expect(run).toContain("orch run create");
  expect(run).toContain("orch run list");

  const eventsTail = eventsTailHelp();
  for (const flag of ["--run", "--mr", "--worktree", "-n"]) {
    expect(eventsTail).toContain(flag);
  }
  expect(eventsTail).toContain("orch events tail --run");

  const result = resultCommandHelp();
  for (const flag of ["--run", "--mr", "--worktree", "--json"]) {
    expect(result).toContain(flag);
  }
  expect(result).toContain("schema, verdict, and summary");
  expect(result).toContain("changed_files");

  for (const flag of ["--mr", "--json", "--worktree"]) {
    expect(status).toContain(flag);
  }
  expect(status).toContain("orch status --mr 123");

  const decision = decisionHelp();
  for (const flag of ["--mr", "--run", "--reason", "--worktree"]) {
    expect(decision).toContain(flag);
  }
  expect(decision).toContain("outbox/pending");
  expect(decision).toContain("orch decision accept --mr 123");

  const mirror = mirrorHelp();
  for (const flag of ["--mr", "--run", "--worktree", "--execute"]) {
    expect(mirror).toContain(flag);
  }
  expect(mirror).toContain("orch mirror --mr 123");
  expect(mirror).toContain("orch mirror sync --mr 123");

  const mirrorSync = mirrorSyncHelp();
  for (const flag of ["--mr", "--worktree", "--execute"]) {
    expect(mirrorSync).toContain(flag);
  }
  expect(mirrorSync).toContain("outbox/pending");
  expect(mirrorSync).toContain("outbox/sent");

  const mailctl = mailctlHelp();
  for (const command of ["init", "poll", "watch", "status", "reply", "ack", "guidance"]) {
    expect(mailctl).toContain(`mailctl ${command}`);
  }
  expect(mailctl).toContain("Authentication-Results");
  expect(mailctl).toContain("trusted authserv-id");
  expect(mailctl).toContain("DKIM and DMARC pass");
  expect(mailctl).toContain("rejected_* marker");
  expect(mailctl).toContain("--subject-token");
  expect(mailctl).toContain("selects INBOX only");
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
  expect(concepts).toContain("outbox/{pending,sent}");
  expect(concepts).toContain("Forge adapter:");

  const forge = topicHelp("forge");
  expect(forge).toContain("github.com remotes use gh");
  expect(forge).toContain("dry-run by default");
  expect(forge).toContain("orch mirror sync");
  expect(forge).toContain("forge=none");
});

test("unknown topic help is friendly and lists topics", () => {
  const text = unknownTopicHelp("bogus");

  expect(text).toContain("unknown help topic: bogus");
  expect(text).toContain("task-spec | result | events | concepts | forge");
});
