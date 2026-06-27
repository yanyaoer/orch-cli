import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaildirBus } from "./bus.ts";
import type { TaskRequestedMailEvent } from "./mail.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-bus-"));
  tempDirs.push(dir);
  return dir;
}

function taskEvent(eventId: string): TaskRequestedMailEvent {
  return {
    schema: "orch.mail/event/v1",
    type: "task.requested",
    event_id: eventId,
    created_at: "2026-06-25T00:00:00.000Z",
    repo_key: "local/repo",
    thread_id: "th_claim",
    role: "reviewer",
    task: { body: "review", sha256: "sha" },
    assigned_agent: {
      id: "codex-reviewer",
      address: "orch+codex.review@example.com",
      provider: "codex",
      roles: ["reviewer"],
      capabilities: [],
    },
  };
}

test("claim replacement is serialized and preserves attempts", () => {
  const threadDir = tempDir();
  const bus = new MaildirBus(threadDir, "th_claim", "local/repo");
  bus.appendEventForTest(taskEvent("evt_claim"));

  const first = bus.claimTasks({
    agent_id: "codex-reviewer",
    now: new Date("2026-06-25T00:00:00.000Z"),
    lease_ms: 1,
  });
  expect(first).toHaveLength(1);
  expect(JSON.parse(readFileSync(first[0]!.claim_path, "utf8"))).toMatchObject({ attempts: 1, state: "claimed" });

  const second = bus.claimTasks({
    agent_id: "codex-reviewer",
    now: new Date("2026-06-25T00:00:01.000Z"),
    lease_ms: 1,
  });
  expect(second).toHaveLength(1);
  expect(second[0]!.lease_id).not.toBe(first[0]!.lease_id);
  expect(JSON.parse(readFileSync(second[0]!.claim_path, "utf8"))).toMatchObject({ attempts: 2, state: "claimed" });
});
