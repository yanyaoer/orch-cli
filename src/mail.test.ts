import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKeyFromRemote } from "./paths.ts";
import { mailThreadDir } from "./mail.ts";
import type { ImplementerResult, RunStatus } from "./types.ts";

async function runOrch(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runOrchWithInput(args: string[], env: Record<string, string>, stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runCmd(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed (${exitCode})\n${stdout}${stderr}`);
}

async function initRepo(worktree: string, remote: string): Promise<void> {
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", remote], worktree);
  await runCmd(["git", "-c", "user.email=orch@example.com", "-c", "user.name=orch", "commit", "--allow-empty", "-m", "init"], worktree);
}

function seedDoneRun(args: { stateHome: string; worktree: string; remote: string; mr: string; runId: string }): string {
  const repoKey = repoKeyFromRemote(args.remote, args.worktree);
  const mrDir = join(args.stateHome, "orch", repoKey, "mrs", args.mr);
  const runDir = join(mrDir, "runs", args.runId);
  mkdirSync(runDir, { recursive: true });

  const status: RunStatus = {
    run_id: args.runId,
    mr: args.mr,
    role: "implementer",
    agent: "codex",
    tag: "impl-a",
    provider_session_name: null,
    provider_session_id: null,
    provider_session_mode: "fresh_persistent",
    state: "done",
    pid: null,
    pgid: null,
    started_at: "2026-06-24T12:00:00.000Z",
    updated_at: "2026-06-24T12:01:00.000Z",
    exit_code: 0,
    timeout_sec: 3600,
    last_event_seq: 1,
    native_event_count: 0,
    provider_resume_id: null,
    worktree: args.worktree,
    base_sha: "base",
    head_sha: "head",
  };
  const result: ImplementerResult = {
    schema: "orch.result/implementer/v1",
    run_id: args.runId,
    verdict: "completed",
    summary: "local mail smoke result",
    base_sha: "base",
    head_sha: "head",
    changed_files: [],
    tests: [],
    acceptance: [{ id: "mail", status: "pass", evidence: "queued locally" }],
    risks: [],
    rollback: "remove local mail event",
  };
  writeFileSync(join(runDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return mrDir;
}

test("mail decision events round-trip through local mail storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mail-test-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  const mr = "123";
  const runId = "impl-a-20260624T120000Z-abc123";
  await initRepo(worktree, remote);
  seedDoneRun({ stateHome, worktree, remote, mr, runId });
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome };
  const thread = "th_local_mail";
  const threadDir = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mail", "threads", thread);

  const decision = await runOrch(["decision", "accept", "--mr", mr, "--run", runId, "--worktree", worktree, "--reason", "reviewed"], env);
  expect(decision).toMatchObject({ exitCode: 0, stderr: "" });
  const bound = await runOrch(
    [
      "mail",
      "agent",
      "bind",
      "--id",
      "codex-review-a",
      "--address",
      "orch+codex.review.a@example.com",
      "--provider",
      "codex",
      "--role",
      "reviewer",
      "--capability",
      "tests",
      "--max-concurrency",
      "2",
      "--auto-invite",
    ],
    env,
  );
  expect(bound).toMatchObject({ exitCode: 0, stderr: "" });
  const list = await runOrch(["mail", "agent", "list"], env);
  expect(JSON.parse(list.stdout).agents[0]).toMatchObject({
    id: "codex-review-a",
    address: "orch+codex.review.a@example.com",
    roles: ["reviewer"],
    capabilities: ["tests"],
  });

  const composed = await runOrch(["mail", "compose", "decision", "--thread", thread, "--run", runId, "--to-agent", "codex-review-a", "--worktree", worktree], env);
  expect(composed).toMatchObject({ exitCode: 0, stderr: "" });
  const composedPayload = JSON.parse(composed.stdout) as { eml_path: string; event_id: string; event_sha256: string };
  expect(readFileSync(composedPayload.eml_path, "utf8")).toContain("application/vnd.orch.signed-event+json");
  expect(readFileSync(composedPayload.eml_path, "utf8")).toContain("To: orch+codex.review.a@example.com");
  expect(composedPayload.event_sha256).toHaveLength(64);

  const delivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  expect(delivered).toMatchObject({ exitCode: 0, stderr: "" });
  const deliveredPayload = JSON.parse(delivered.stdout) as { delivered: Array<{ to: string; maildir: string }> };
  expect(deliveredPayload.delivered).toHaveLength(1);
  expect(existsSync(composedPayload.eml_path)).toBe(false);
  expect(existsSync(deliveredPayload.delivered[0]!.maildir)).toBe(true);
  const pathResult = await runOrch(["mail", "path", "--thread", thread, "--worktree", worktree], env);
  expect(pathResult).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(pathResult.stdout).maildir).toBe(join(threadDir, "maildir"));
  const neomutt = await runOrch(["mail", "neomutt", "--json", "--thread", thread, "--worktree", worktree], env);
  expect(neomutt).toMatchObject({ exitCode: 0, stderr: "" });
  const neomuttPayload = JSON.parse(neomutt.stdout) as { rc_path: string; maildir: string; events_path: string; launch: string };
  expect(neomuttPayload.maildir).toBe(join(threadDir, "maildir"));
  expect(neomuttPayload.events_path).toBe(join(threadDir, "inbox", "events", "mail-events.jsonl"));
  expect(neomuttPayload.launch).toContain("neomutt -F");
  const rc = readFileSync(neomuttPayload.rc_path, "utf8");
  expect(rc).toContain("macro index,pager <F5>");
  expect(rc).toContain("orch mail deliver-local --thread 'th_local_mail'");
  expect(rc).toContain("macro index,pager <F6>");
  expect(rc).toContain("orch mail import --thread 'th_local_mail'");
  expect(rc).toContain("set sendmail=\"orch mail sendmail --thread 'th_local_mail'");
  expect(rc).toContain("--file -");
  expect(rc).toContain("macro index,pager <F7>");
  expect(rc).toContain("orch mail route --thread 'th_local_mail'");
  expect(rc).toContain("macro index,pager <F10>");
  expect(rc).toContain("orch mail assign --thread 'th_local_mail'");
  expect(rc).toContain("macro index,pager <F11>");
  expect(rc).toContain("orch mail reply result --thread 'th_local_mail'");

  const imported = await runOrch(["mail", "import", "--thread", thread, "--file", deliveredPayload.delivered[0]!.to, "--worktree", worktree], env);
  expect(imported).toMatchObject({ exitCode: 0, stderr: "" });
  const importedPayload = JSON.parse(imported.stdout) as { imported: boolean; event_id: string; event_path: string };
  expect(importedPayload.imported).toBe(true);
  expect(importedPayload.event_id).toBe(composedPayload.event_id);
  const events = readFileSync(importedPayload.event_path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "decision.recorded", thread_id: thread, run_id: runId, decision: { verdict: "accept" } });

  const importedAgain = await runOrch(["mail", "import", "--thread", thread, "--file", deliveredPayload.delivered[0]!.to, "--worktree", worktree], env);
  expect(importedAgain).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(importedAgain.stdout).imported).toBe(false);
  expect(readFileSync(importedPayload.event_path, "utf8").trim().split("\n")).toHaveLength(1);
  expect(readdirSync(join(threadDir, "outbox", "sent")).filter((file) => file.endsWith(".eml"))).toHaveLength(1);

  const replied = await runOrch(["mail", "reply", "result", "--thread", thread, "--run", runId, "--from-agent", "codex-review-a", "--parent-event", composedPayload.event_id, "--worktree", worktree], env);
  expect(replied).toMatchObject({ exitCode: 0, stderr: "" });
  const replyPayload = JSON.parse(replied.stdout) as { eml_path: string; event_id: string };
  expect(readFileSync(replyPayload.eml_path, "utf8")).toContain("X-Orch-Event-Type: result.submitted");
  const replyDelivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  const replyDeliveredPayload = JSON.parse(replyDelivered.stdout) as { delivered: Array<{ to: string }> };
  expect(replyDeliveredPayload.delivered).toHaveLength(1);
  const replyImported = await runOrch(["mail", "import", "--thread", thread, "--file", replyDeliveredPayload.delivered[0]!.to, "--worktree", worktree], env);
  expect(replyImported).toMatchObject({ exitCode: 0, stderr: "" });
  const replyEvents = readFileSync(importedPayload.event_path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(replyEvents).toHaveLength(2);
  expect(replyEvents[1]).toMatchObject({ type: "result.submitted", parent_event_id: composedPayload.event_id, run_id: runId });
});

test("mail assign uses local mailbox registry for role routing", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mail-assign-test-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome };
  const thread = "th_review";
  const taskPath = join(root, "review-current.md");
  writeFileSync(taskPath, "Review the current mailbox changes and report blocking issues.\n", "utf8");
  const missingRole = await runOrch(
    ["mail", "agent", "bind", "--id", "bad-agent", "--address", "orch+bad@example.com", "--provider", "codex", "--auto-invite"],
    env,
  );
  expect(missingRole.exitCode).toBe(1);
  expect(missingRole.stderr).toContain("mail agent bind requires at least one --role");


  for (const [id, role, address] of [
    ["codex-review-a", "reviewer", "orch+codex.review.a@example.com"],
    ["codex-verify-a", "verifier", "orch+codex.verify.a@example.com"],
  ] as const) {
    const bound = await runOrch(
      [
        "mail",
        "agent",
        "bind",
        "--id",
        id,
        "--address",
        address,
        "--provider",
        "codex",
        "--role",
        role,
        "--auto-invite",
      ],
      env,
    );
    expect(bound).toMatchObject({ exitCode: 0, stderr: "" });
  }

  const assigned = await runOrch(["mail", "assign", "--thread", thread, "--role", "reviewer", "--task", taskPath, "--worktree", worktree], env);
  expect(assigned).toMatchObject({ exitCode: 0, stderr: "" });
  const assignedPayload = JSON.parse(assigned.stdout) as { assigned: Array<{ agent_id: string; eml_path: string }> };
  expect(assignedPayload.assigned.map((item) => item.agent_id)).toEqual(["codex-review-a"]);
  expect(readFileSync(assignedPayload.assigned[0]!.eml_path, "utf8")).toContain("To: orch+codex.review.a@example.com");

  const delivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  const deliveredPayload = JSON.parse(delivered.stdout) as { delivered: Array<{ to: string }> };
  expect(deliveredPayload.delivered).toHaveLength(1);

  const imported = await runOrchWithInput(["mail", "import", "--thread", thread, "--file", "-", "--worktree", worktree], env, readFileSync(deliveredPayload.delivered[0]!.to, "utf8"));
  expect(imported).toMatchObject({ exitCode: 0, stderr: "" });
  const importedPayload = JSON.parse(imported.stdout) as { event_path: string };
  const events = readFileSync(importedPayload.event_path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events[0]).toMatchObject({
    type: "task.requested",
    thread_id: thread,
    role: "reviewer",
    assigned_agent: { id: "codex-review-a", address: "orch+codex.review.a@example.com" },
  });
  const wrongThread = await runOrch(["mail", "import", "--thread", "th_wrong", "--file", deliveredPayload.delivered[0]!.to, "--worktree", worktree], env);
  expect(wrongThread.exitCode).toBe(1);
  expect(JSON.parse(wrongThread.stdout).reason).toBe("orch event thread mismatch");
  const otherWorktree = realpathSync(mkdtempSync(join(root, "other-worktree-")));
  await initRepo(otherWorktree, "git@github.com:example/other.git");
  const wrongRepo = await runOrch(["mail", "import", "--thread", thread, "--file", deliveredPayload.delivered[0]!.to, "--worktree", otherWorktree], env);
  expect(wrongRepo.exitCode).toBe(1);
  expect(JSON.parse(wrongRepo.stdout).reason).toBe("orch event repo mismatch");
});

test("mail claim nacks unsupported run roles instead of leaving claimed leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mail-unsupported-claim-test-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome };
  const thread = "th_unsupported";
  const taskPath = join(root, "debug.md");
  writeFileSync(taskPath, "Debug the failing mailbox flow.\n", "utf8");

  const bound = await runOrch(
    [
      "mail",
      "agent",
      "bind",
      "--id",
      "codex-debugger",
      "--address",
      "orch+codex.debug@example.com",
      "--provider",
      "codex",
      "--role",
      "debugger",
      "--auto-invite",
    ],
    env,
  );
  expect(bound).toMatchObject({ exitCode: 0, stderr: "" });

  const assigned = await runOrch(["mail", "assign", "--thread", thread, "--role", "debugger", "--task", taskPath, "--to-agent", "codex-debugger", "--worktree", worktree], env);
  expect(assigned).toMatchObject({ exitCode: 0, stderr: "" });
  const assignedPayload = JSON.parse(assigned.stdout) as { assigned: Array<{ event_id: string }> };
  const eventId = assignedPayload.assigned[0]!.event_id;
  const delivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  const deliveredPayload = JSON.parse(delivered.stdout) as { delivered: Array<{ to: string }> };
  expect(deliveredPayload.delivered).toHaveLength(1);
  const imported = await runOrch(["mail", "import", "--thread", thread, "--file", deliveredPayload.delivered[0]!.to, "--worktree", worktree], env);
  expect(imported).toMatchObject({ exitCode: 0, stderr: "" });

  const claimed = await runOrch(["mail", "claim", "--thread", thread, "--agent", "codex-debugger", "--worktree", worktree], env);
  expect(claimed.exitCode).toBe(1);
  expect(claimed.stderr).toContain("mail task role cannot start a run: debugger");
  const claimPath = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mail", "threads", thread, "claims", `${eventId}.claim.json`);
  const claimRecord = JSON.parse(readFileSync(claimPath, "utf8")) as { state: string; reason: string };
  expect(claimRecord).toMatchObject({ state: "nacked" });
  expect(claimRecord.reason).toContain("mail task role cannot start a run: debugger");
});

test("cross-review fans one task across reviewer agents via mail, deriving mr from the thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-cross-review-test-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome };
  const thread = "review-pr-1";
  const taskPath = join(root, "review.md");
  writeFileSync(taskPath, "Review the pending diff.\n", "utf8");

  const defaults = await runOrch(["mail", "agent", "defaults"], env);
  expect(defaults).toMatchObject({ exitCode: 0, stderr: "" });

  // dry-run resolves the default reviewer roster without publishing or running.
  const dry = await runOrch(["cross-review", "--thread", thread, "--task", taskPath, "--worktree", worktree, "--dry-run"], env);
  expect(dry).toMatchObject({ exitCode: 0, stderr: "" });
  const dryPayload = JSON.parse(dry.stdout) as { dry_run: boolean; agents: Array<{ agent_id: string }> };
  expect(dryPayload.dry_run).toBe(true);
  expect(dryPayload.agents.map((agent) => agent.agent_id)).toEqual(["claude-reviewer", "omp-reviewer"]);

  // real fan-out with the fake driver: publish + claim + run each agent.
  const fan = await runOrch(["cross-review", "--thread", thread, "--task", taskPath, "--worktree", worktree], {
    ...env,
    ORCH_DRIVER_FAKE_RESULT: "1",
  });
  expect(fan).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(fan.stdout) as {
    mail: string;
    assigned: Array<{ agent_id: string }>;
    runs: Array<{ agent_id: string; role: string; mr: string; run: { run_id: string } }>;
  };
  expect(payload.mail).toBe("cross-review");
  expect(payload.assigned.map((item) => item.agent_id)).toEqual(["claude-reviewer", "omp-reviewer"]);
  expect(payload.runs).toHaveLength(2);
  for (const run of payload.runs) {
    expect(run.role).toBe("reviewer");
    expect(run.mr).toBe(thread); // mr derived from the thread; no --mr was passed
    expect(run.run.run_id).toBeTruthy();
  }
  // both runs land under mr == thread in the local state tree.
  const runsRoot = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", thread, "runs");
  expect(readdirSync(runsRoot)).toHaveLength(2);

  const fanAgain = await runOrch(["cross-review", "--thread", thread, "--task", taskPath, "--worktree", worktree], {
    ...env,
    ORCH_DRIVER_FAKE_RESULT: "1",
  });
  expect(fanAgain).toMatchObject({ exitCode: 0, stderr: "" });
  const againPayload = JSON.parse(fanAgain.stdout) as {
    assigned: Array<{ agent_id: string; idempotent: boolean; claim_state: string }>;
    runs: unknown[];
  };
  expect(againPayload.assigned.map((item) => [item.agent_id, item.idempotent, item.claim_state])).toEqual([
    ["claude-reviewer", true, "acked"],
    ["omp-reviewer", true, "acked"],
  ]);
  expect(againPayload.runs).toEqual([]);
  expect(readdirSync(runsRoot)).toHaveLength(2);
});

test("concurrent cross-review fan-outs publish exactly one task per agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-cross-review-race-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome, ORCH_DRIVER_FAKE_RESULT: "1" };
  const thread = "review-race-1";
  const taskPath = join(root, "review.md");
  writeFileSync(taskPath, "Review the pending diff.\n", "utf8");
  await runOrch(["mail", "agent", "defaults"], env);

  // Without the fanout thread lock both invocations miss findTask (events still
  // in outbox) and publish duplicate tasks with distinct event ids.
  const args = ["cross-review", "--thread", thread, "--task", taskPath, "--worktree", worktree];
  const [first, second] = await Promise.all([runOrch(args, env), runOrch(args, env)]);
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);

  const repoKey = repoKeyFromRemote(remote, worktree);
  const eventsPath = join(stateHome, "orch", repoKey, "mail", "threads", thread, "inbox", "events", "mail-events.jsonl");
  const taskEvents = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; assigned_agent?: { id: string } })
    .filter((event) => event.type === "task.requested");
  expect(taskEvents.map((event) => event.assigned_agent?.id).sort()).toEqual(["claude-reviewer", "omp-reviewer"]);

  const runsRoot = join(stateHome, "orch", repoKey, "mrs", thread, "runs");
  expect(readdirSync(runsRoot)).toHaveLength(2);
});

test("fanout forwards --model to spawned runs and honors --to-agent override", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-fanout-model-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome, ORCH_DRIVER_FAKE_RESULT: "1" };
  const thread = "verify-model-1";
  const taskPath = join(root, "verify.md");
  writeFileSync(taskPath, "Verify the change.\n", "utf8");
  await runOrch(["mail", "agent", "defaults"], env);

  const fan = await runOrch(
    [
      "fanout",
      "--thread",
      thread,
      "--role",
      "verifier",
      "--to-agent",
      "pi-verifier",
      "--model",
      "zenmux/test-model",
      "--task",
      taskPath,
      "--worktree",
      worktree,
    ],
    env,
  );
  expect(fan).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(fan.stdout) as {
    runs: Array<{ agent_id: string; role: string; run: { run_id: string } }>;
  };
  expect(payload.runs).toHaveLength(1);
  expect(payload.runs[0]).toMatchObject({ agent_id: "pi-verifier", role: "verifier" });

  const runsRoot = join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mrs", thread, "runs");
  const spec = JSON.parse(readFileSync(join(runsRoot, payload.runs[0]!.run.run_id, "spec.json"), "utf8")) as {
    model: string | null;
    role: string;
  };
  expect(spec.model).toBe("zenmux/test-model");
  expect(spec.role).toBe("verifier");
});

test("investigate defaults to omp+claude reviewers and rejects unknown flags", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-investigate-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initRepo(worktree, "git@github.com:example/repo.git");
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome };
  const taskPath = join(root, "question.md");
  writeFileSync(taskPath, "Investigate the flaky test.\n", "utf8");
  await runOrch(["mail", "agent", "defaults"], env);

  const dry = await runOrch(["investigate", "--thread", "research-1", "--task", taskPath, "--worktree", worktree, "--dry-run"], env);
  expect(dry).toMatchObject({ exitCode: 0, stderr: "" });
  const payload = JSON.parse(dry.stdout) as { role: string; agents: Array<{ agent_id: string }> };
  expect(payload.role).toBe("reviewer");
  expect(payload.agents.map((agent) => agent.agent_id)).toEqual(["omp-reviewer", "claude-reviewer"]);

  // A typo'd flag must fail loudly instead of being silently ignored.
  const typo = await runOrch(["investigate", "--thread", "research-1", "--task", taskPath, "--worktree", worktree, "--modle", "x"], env);
  expect(typo.exitCode).toBe(1);
  expect(typo.stderr).toContain("unknown flag --modle");
});

test("mail submit to router routes default codex claude pi agents", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mail-router-test-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  await initRepo(worktree, "git@github.com:example/repo.git");
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome };
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "Build the mailbox workflow end to end.\n", "utf8");
  const thread = "th_router";

  const defaults = await runOrch(["mail", "agent", "defaults"], env);
  expect(defaults).toMatchObject({ exitCode: 0, stderr: "" });
  const defaultAgents = JSON.parse(defaults.stdout).agents as Array<{ id: string; provider: string; work_mode: string }>;
  expect(defaultAgents.map((agent) => agent.id)).toEqual([
    "claude-reviewer",
    "codex-implementer",
    "omp-reviewer",
    "orch-router",
    "pi-verifier",
  ]);
  expect(defaultAgents.map((agent) => [agent.provider, agent.work_mode])).toContainEqual(["omp", "review"]);
  expect(defaultAgents.map((agent) => [agent.provider, agent.work_mode])).toContainEqual(["codex", "implement"]);
  expect(defaultAgents.map((agent) => [agent.provider, agent.work_mode])).toContainEqual(["claude", "review"]);
  expect(defaultAgents.map((agent) => [agent.provider, agent.work_mode])).toContainEqual(["pi", "verify"]);

  const workspace = await runOrch(["workspace", "add", "--id", "orch-cli", "--path", worktree], env);
  expect(workspace).toMatchObject({ exitCode: 0, stderr: "" });
  const workspaceList = await runOrch(["workspace", "list"], env);
  expect(JSON.parse(workspaceList.stdout).workspaces[0]).toMatchObject({ id: "orch-cli", path: worktree });

  const submitted = await runOrch(["mail", "submit", "--thread", thread, "--mr", "123", "--workspace", "orch-cli", "--task", taskPath, "--worktree", worktree], env);
  expect(submitted).toMatchObject({ exitCode: 0, stderr: "" });
  const submittedPayload = JSON.parse(submitted.stdout) as { event_id: string };
  const delivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  const deliveredPayload = JSON.parse(delivered.stdout) as { delivered: Array<{ to: string }> };
  expect(deliveredPayload.delivered).toHaveLength(1);
  const autoImported = await runOrchWithInput(["mail", "import", "--file", "-"], env, readFileSync(deliveredPayload.delivered[0]!.to, "utf8"));
  expect(autoImported).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(autoImported.stdout)).toMatchObject({ imported: true, thread_id: thread });

  const globalNeomutt = await runOrch(["mail", "neomutt", "--json"], env);
  expect(globalNeomutt).toMatchObject({ exitCode: 0, stderr: "" });
  const globalNeomuttPayload = JSON.parse(globalNeomutt.stdout) as { mailboxes: Array<{ thread_id: string; workspace_id: string; maildir: string }>; rc_path: string };
  expect(globalNeomuttPayload.mailboxes).toHaveLength(1);
  expect(globalNeomuttPayload.mailboxes[0]).toMatchObject({ thread_id: thread, workspace_id: "orch-cli" });
  const globalRc = readFileSync(globalNeomuttPayload.rc_path, "utf8");
  expect(globalRc).toContain("mailboxes ");
  expect(globalRc).toContain("orch mail import --file -");
  expect(globalRc).not.toContain("orch mail import --thread");
  expect(globalRc).toContain("set sendmail=\"orch mail sendmail\"");
  const launched = await runOrch(["mail", "neomutt", "--neomutt-bin", "/bin/echo"], env);
  expect(launched).toMatchObject({ exitCode: 0, stderr: "" });
  expect(launched.stdout).toContain("-F");
  expect(launched.stdout).toContain(globalNeomuttPayload.rc_path);

  const routed = await runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env);
  expect(routed).toMatchObject({ exitCode: 0, stderr: "" });
  const routedPayload = JSON.parse(routed.stdout) as { assigned: Array<{ role: string; agent_id: string; source_event_id: string; event_id: string }> };
  expect(routedPayload.assigned.map((item) => [item.role, item.agent_id])).toEqual([["implementer", "codex-implementer"]]);
  expect(routedPayload.assigned.every((item) => item.source_event_id === submittedPayload.event_id)).toBe(true);
  const implementerTaskEventId = routedPayload.assigned[0]!.event_id;
  const routedAgainBeforeDelivery = await runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env);
  expect(routedAgainBeforeDelivery).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(routedAgainBeforeDelivery.stdout).assigned).toEqual([]);

  const routedDelivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  const routedDeliveredPayload = JSON.parse(routedDelivered.stdout) as { delivered: Array<{ to: string }> };
  expect(routedDeliveredPayload.delivered).toHaveLength(1);
  const routedAgainBeforeImport = await runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env);
  expect(routedAgainBeforeImport).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(routedAgainBeforeImport.stdout).assigned).toEqual([]);
  for (const delivered of routedDeliveredPayload.delivered) {
    const routedImport = await runOrch(["mail", "import", "--thread", thread, "--file", delivered.to, "--worktree", worktree], env);
    expect(routedImport).toMatchObject({ exitCode: 0, stderr: "" });
  }
  const routedEvents = readFileSync(join(stateHome, "orch", repoKeyFromRemote("git@github.com:example/repo.git", worktree), "mail", "threads", thread, "inbox", "events", "mail-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(routedEvents.find((event) => event.assigned_agent?.id === "codex-implementer")).toMatchObject({ mr: "123", workspace: { id: "orch-cli", path: worktree } });
  const claimed = await runOrch(["mail", "claim", "--thread", thread, "--agent", "codex-implementer", "--dry-run", "--worktree", worktree], env);
  expect(claimed).toMatchObject({ exitCode: 0, stderr: "" });
  const claimedPayload = JSON.parse(claimed.stdout) as { claimed: Array<{ mr: string; role: string; agent_id: string; run: { dry_run: boolean; role: string; agent: string } }> };
  expect(claimedPayload.claimed).toHaveLength(1);
  expect(claimedPayload.claimed[0]).toMatchObject({ mr: "123", role: "implementer", agent_id: "codex-implementer", run: { dry_run: true, role: "implementer", agent: "codex" } });

  const claimedReal = await runOrch(["mail", "claim", "--thread", thread, "--agent", "codex-implementer", "--worktree", worktree], { ...env, ORCH_DRIVER_FAKE_RESULT: "1" });
  expect(claimedReal).toMatchObject({ exitCode: 0, stderr: "" });
  const claimedRealPayload = JSON.parse(claimedReal.stdout) as { claimed: Array<{ event_id: string; run: { run_id: string; dry_run?: boolean } }> };
  expect(claimedRealPayload.claimed).toHaveLength(1);
  expect(claimedRealPayload.claimed[0]!.event_id).toBe(implementerTaskEventId);
  expect(claimedRealPayload.claimed[0]!.run.run_id).toContain("mail-implementer-codex-implementer");
  const claimRecord = JSON.parse(readFileSync(join(stateHome, "orch", repoKeyFromRemote("git@github.com:example/repo.git", worktree), "mail", "threads", thread, "claims", `${implementerTaskEventId}.claim.json`), "utf8"));
  expect(claimRecord).toMatchObject({ state: "acked", event_id: implementerTaskEventId, agent_id: "codex-implementer" });
  const claimedAgain = await runOrch(["mail", "claim", "--thread", thread, "--agent", "codex-implementer", "--worktree", worktree], { ...env, ORCH_DRIVER_FAKE_RESULT: "1" });
  expect(claimedAgain).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(claimedAgain.stdout).claimed).toEqual([]);

  const implRunId = "impl-mail-20260624T120000Z-abc123";
  seedDoneRun({ stateHome, worktree, remote: "git@github.com:example/repo.git", mr: "123", runId: implRunId });
  const resultReply = await runOrch(["mail", "reply", "result", "--thread", thread, "--run", implRunId, "--from-agent", "codex-implementer", "--parent-event", implementerTaskEventId, "--worktree", worktree], env);
  expect(resultReply).toMatchObject({ exitCode: 0, stderr: "" });
  const resultDelivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  const resultDeliveredPayload = JSON.parse(resultDelivered.stdout) as { delivered: Array<{ to: string }> };
  expect(resultDeliveredPayload.delivered).toHaveLength(1);
  const resultImported = await runOrch(["mail", "import", "--thread", thread, "--file", resultDeliveredPayload.delivered[0]!.to, "--worktree", worktree], env);
  expect(resultImported).toMatchObject({ exitCode: 0, stderr: "" });
  const resultEventId = JSON.parse(resultImported.stdout).event_id as string;
  const followup = await runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env);
  expect(followup).toMatchObject({ exitCode: 0, stderr: "" });
  const followupPayload = JSON.parse(followup.stdout) as { assigned: Array<{ role: string; agent_id: string; source_event_id: string }> };
  expect(followupPayload.assigned.map((item) => [item.role, item.agent_id])).toEqual([
    ["reviewer", "claude-reviewer"],
    ["verifier", "pi-verifier"],
  ]);
  expect(followupPayload.assigned.every((item) => item.source_event_id === resultEventId)).toBe(true);
  const followupAgainBeforeDelivery = await runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env);
  expect(followupAgainBeforeDelivery).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(followupAgainBeforeDelivery.stdout).assigned).toEqual([]);
  const followupDelivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  expect(JSON.parse(followupDelivered.stdout).delivered).toHaveLength(2);
  const spoofedRecipient = await runOrchWithInput(
    ["mail", "sendmail"],
    env,
    'From: human@local.orch\nTo: "orch-router@local.orch" <human@example.com>\nSubject: spoof\n\nno route\n',
  );
  expect(spoofedRecipient.exitCode).toBe(1);
  expect(spoofedRecipient.stderr).toContain("addressed exactly to orch-router@local.orch");

  const sent = await runOrchWithInput(
    ["mail", "sendmail"],
    env,
    "From: human@local.orch\nTo: orch-router@local.orch\nSubject: Review from mutt\n\nPlease review the NeoMutt send bridge.\n",
  );
  expect(sent).toMatchObject({ exitCode: 0, stderr: "" });
  const sentPayload = JSON.parse(sent.stdout) as { mail: string; thread: string; router_event_id: string; assigned: Array<{ role: string; agent_id: string }>; delivered: Array<{ to: string }> };
  expect(sentPayload).toMatchObject({ mail: "sent-local", thread });
  expect(sentPayload.router_event_id).toMatch(/^evt_/);
  expect(sentPayload.assigned.map((item) => [item.role, item.agent_id])).toEqual([["implementer", "codex-implementer"]]);
  expect(sentPayload.delivered.length).toBeGreaterThanOrEqual(2);
});

test("mail route serializes concurrent routers and derives routed state from outbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mail-router-race-test-"));
  const stateHome = join(root, "state");
  const configHome = join(root, "config");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const env = { XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome };
  const thread = "th_router_race";
  const taskPath = join(root, "task.md");
  writeFileSync(taskPath, "Build one implementation task only.\n", "utf8");

  const defaults = await runOrch(["mail", "agent", "defaults"], env);
  expect(defaults).toMatchObject({ exitCode: 0, stderr: "" });
  const submitted = await runOrch(["mail", "submit", "--thread", thread, "--mr", "456", "--task", taskPath, "--worktree", worktree], env);
  expect(submitted).toMatchObject({ exitCode: 0, stderr: "" });
  const submittedPayload = JSON.parse(submitted.stdout) as { event_id: string };
  const delivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  const deliveredPayload = JSON.parse(delivered.stdout) as { delivered: Array<{ to: string }> };
  expect(deliveredPayload.delivered).toHaveLength(1);
  const imported = await runOrch(["mail", "import", "--thread", thread, "--file", deliveredPayload.delivered[0]!.to, "--worktree", worktree], env);
  expect(imported).toMatchObject({ exitCode: 0, stderr: "" });

  const routed = await Promise.all([
    runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env),
    runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env),
  ]);
  for (const result of routed) expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  const assigned = routed.flatMap((result) => (JSON.parse(result.stdout) as { assigned: Array<{ role: string; agent_id: string; source_event_id: string }> }).assigned);
  expect(assigned.map((item) => [item.role, item.agent_id, item.source_event_id])).toEqual([["implementer", "codex-implementer", submittedPayload.event_id]]);

  const routedAgainWhilePending = await runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env);
  expect(routedAgainWhilePending).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(routedAgainWhilePending.stdout).assigned).toEqual([]);

  const routedDelivered = await runOrch(["mail", "deliver-local", "--thread", thread, "--worktree", worktree], env);
  const routedDeliveredPayload = JSON.parse(routedDelivered.stdout) as { delivered: Array<{ to: string }> };
  expect(routedDeliveredPayload.delivered).toHaveLength(1);
  const routedAgainWhileSent = await runOrch(["mail", "route", "--thread", thread, "--worktree", worktree], env);
  expect(routedAgainWhileSent).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(routedAgainWhileSent.stdout).assigned).toEqual([]);
});

test("mail import quarantines unsigned local messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-mail-quarantine-test-"));
  const stateHome = join(root, "state");
  const worktree = realpathSync(mkdtempSync(join(root, "worktree-")));
  const remote = "git@github.com:example/repo.git";
  await initRepo(worktree, remote);
  const thread = "th_unsigned";
  const unsigned = join(root, "unsigned.eml");
  writeFileSync(unsigned, "From: a@local\nTo: b@local\nSubject: no signature\n\nhello\n", "utf8");

  const imported = await runOrch(["mail", "import", "--thread", thread, "--file", unsigned, "--worktree", worktree], { XDG_STATE_HOME: stateHome });
  expect(imported.exitCode).toBe(1);
  expect(imported.stderr).toBe("");
  const payload = JSON.parse(imported.stdout) as { reason: string; quarantine_path: string };
  expect(payload.reason).toBe("missing signed orch event");
  expect(existsSync(payload.quarantine_path)).toBe(true);
  expect(readdirSync(join(stateHome, "orch", repoKeyFromRemote(remote, worktree), "mail", "threads", thread, "inbox", "quarantine")).filter((file) => file.endsWith(".json"))).toHaveLength(1);
});

test("mail thread paths reject repo traversal", () => {
  expect(() => mailThreadDir("../escape", "th_safe")).toThrow("mail repo key must be a relative path without dot segments");
});
