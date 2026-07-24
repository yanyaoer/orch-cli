import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSpec } from "./types.ts";
import {
  buildPrewalkPayload,
  evaluateHandoffGate,
  guideEditEvidence,
  meaningfulChangedFiles,
  parseStatusPaths,
  parseTodoChecklist,
  renameDestination,
  unquoteGitPath,
  type PrewalkOutcome,
} from "./prewalk.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-prewalk-test-"));
  tempDirs.push(dir);
  return dir;
}

const GUIDE_SUMMARY = [
  "Prewalk todo:",
  "- [x] Add LruCache skeleton in src/cache.ts — validate: bun test src/cache.test.ts",
  "- [ ] Implement eviction on capacity — validate: bun test src/cache.test.ts",
  "- [ ] Wire cache into resolver — validate: bun test",
  "- [ ] Add eviction edge-case tests — validate: bun test src/cache.test.ts",
].join("\n");

test("parseTodoChecklist keeps item order and states", () => {
  const todo = parseTodoChecklist(GUIDE_SUMMARY);
  expect(todo.total).toBe(4);
  expect(todo.checked).toBe(1);
  expect(todo.unchecked).toBe(3);
  expect(todo.items[0]).toEqual({ checked: true, text: "Add LruCache skeleton in src/cache.ts — validate: bun test src/cache.test.ts" });
  expect(todo.items[1]!.checked).toBe(false);
  expect(parseTodoChecklist("no checklist here").total).toBe(0);
});

test("parseStatusPaths handles porcelain, jj, quoting, conflicts, and renames", () => {
  const git = [
    " M src/cache.ts",
    "?? src/cache.test.ts",
    "R  old.ts -> new.ts",
    'R  "old name.ts" -> "new name.ts"',
    "UU src/conflict.ts",
    "T  src/mode.ts",
    '?? "docs/read me.md"',
    '?? "docs/\\346\\226\\207.md"',
    "",
  ].join("\n");
  expect(parseStatusPaths(git)).toEqual([
    "src/cache.ts",
    "src/cache.test.ts",
    "new.ts",
    "new name.ts",
    "src/conflict.ts",
    "src/mode.ts",
    "docs/read me.md",
    "docs/文.md",
  ]);
  const jj = ["Working copy changes:", "M src/cache.ts", "A src/cache.test.ts", "Working copy : abc123"].join("\n");
  expect(parseStatusPaths(jj)).toEqual(["src/cache.ts", "src/cache.test.ts"]);
});

test("unquoteGitPath decodes escapes byte-accurately so docs cannot dodge classification", () => {
  expect(unquoteGitPath('"docs/read me.md"')).toBe("docs/read me.md");
  expect(unquoteGitPath('"a\\"b\\\\c\\t.md"')).toBe('a"b\\c\t.md');
  // Literal non-BMP characters inside a quoted path (core.quotePath=false).
  expect(unquoteGitPath('"😀 file.ts"')).toBe("😀 file.ts");
  expect(meaningfulChangedFiles([unquoteGitPath('"docs/read me.md"'), unquoteGitPath('"docs/\\346\\226\\207.md"')])).toEqual([]);
});

test("renameDestination survives arrows inside quoted fields", () => {
  expect(renameDestination("old.ts -> new.ts")).toBe("new.ts");
  expect(renameDestination('"old.ts" -> "new -> file.ts"')).toBe('"new -> file.ts"');
  expect(parseStatusPaths('R  "old.ts" -> "new -> file.md"')).toEqual(["new -> file.md"]);
});

test("meaningfulChangedFiles drops docs, orch metadata, and unclassifiable directory entries", () => {
  expect(meaningfulChangedFiles(["README.md", "notes.txt", ".orch/state.json", "src/cache.ts"])).toEqual(["src/cache.ts"]);
  // Collapsed untracked directories cannot be classified — never credit them.
  expect(meaningfulChangedFiles(["docs/new/", "src/new/"])).toEqual([]);
});

test("guideEditEvidence decodes quoted changed-files entries and fails closed without artifacts", () => {
  const runDir = tempDir();
  expect(guideEditEvidence(runDir, [])).toBeNull();
  const artifacts = join(runDir, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "git-status.txt"), ' M "docs/\\346\\226\\207.md"\n', "utf8");
  writeFileSync(join(artifacts, "changed-files.txt"), '"docs/\\346\\226\\207.md"\n', "utf8");
  const evidence = guideEditEvidence(runDir, []);
  // Both sources decode to the same canonical docs path: no meaningful edit.
  expect(evidence).toEqual(["docs/文.md"]);
  expect(meaningfulChangedFiles(evidence!)).toEqual([]);
  // Baseline subtraction removes pre-existing dirt in canonical form.
  expect(guideEditEvidence(runDir, ["docs/文.md"])).toEqual([]);
});

test("evaluateHandoffGate passes only on ordered, validated, host-evidenced progress", () => {
  const base = {
    state: "done",
    verdict: "completed" as string | null,
    todo: parseTodoChecklist(GUIDE_SUMMARY),
    changedFiles: ["src/cache.ts"] as string[] | null,
    resumable: true,
  };
  expect(evaluateHandoffGate(base)).toEqual({ ok: true, alreadyComplete: false, reasons: [] });

  // First item unchecked while a later one is checked: no valid in-context example.
  const wrongOrder = evaluateHandoffGate({
    ...base,
    todo: parseTodoChecklist("- [ ] a — validate: t\n- [x] b — validate: t\n- [ ] c — validate: t"),
  });
  expect(wrongOrder.ok).toBe(false);
  expect(wrongOrder.reasons).toContain("first todo item is not checked off");

  // Items without an explicit "validate:" marker break the executor's
  // check-then-tick loop; mentioning the word validation is not enough.
  const unvalidated = evaluateHandoffGate({
    ...base,
    todo: parseTodoChecklist("- [x] Add input validation logic\n- [ ] Skip validation for legacy\n- [ ] c"),
  });
  expect(unvalidated.ok).toBe(false);
  expect(unvalidated.reasons).toContain('3 todo item(s) lack a "validate:" step');

  // Missing host evidence fails closed; docs-only evidence fails too.
  expect(evaluateHandoffGate({ ...base, changedFiles: null }).reasons).toContain(
    "host-side edit evidence unavailable (status artifact missing)",
  );
  expect(evaluateHandoffGate({ ...base, changedFiles: ["README.md"] }).ok).toBe(false);

  // A fully checked checklist completes without needing a resumable session.
  const complete = evaluateHandoffGate({
    ...base,
    todo: parseTodoChecklist("- [x] a — validate: t\n- [x] b — validate: t\n- [x] c — validate: t"),
    resumable: false,
  });
  expect(complete).toEqual({ ok: false, alreadyComplete: true, reasons: [] });

  // Unmet gate with remaining work still reports the resumability gap.
  const stuck = evaluateHandoffGate({ ...base, changedFiles: [], resumable: false });
  expect(stuck.reasons).toContain("guide run recorded no resumable provider session");
});

test("buildPrewalkPayload never recommends acceptance for a failed outcome", () => {
  const outcome: PrewalkOutcome = {
    mr: "prewalk-1",
    worktree: "/tmp/w t",
    tag: "prewalk",
    guide: {
      run_id: "guide-1",
      model: "frontier-x",
      state: "done",
      verdict: "completed",
      todo: parseTodoChecklist(GUIDE_SUMMARY),
      changed_files: ["src/cache.ts"],
    },
    gate: { ok: true, alreadyComplete: false, reasons: [] },
    executor: { run_id: "exec-1", model: "cheap-mini", state: "done", verdict: "failed" },
    succeeded: false,
  };
  const failed = buildPrewalkPayload(outcome);
  expect(failed.prewalk).toBe("failed");
  const failedNext = (failed.next as string[]).join("\n");
  expect(failedNext).not.toContain("decision accept");
  expect(failedNext).toContain("--resume-from");
  // The rework command must stay in the session's tag family or the
  // session-chain guard rejects it.
  expect(failedNext).toContain("--tag 'prewalk-exec-r2'");
  expect(failedNext).toContain("'/tmp/w t'");

  const done = buildPrewalkPayload({ ...outcome, executor: { ...outcome.executor!, verdict: "completed" }, succeeded: true });
  expect(done.prewalk).toBe("done");
  expect((done.next as string[]).join("\n")).toContain("decision accept");
});

async function runOrch(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, "src/orch.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
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

async function runCmd(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${args.join(" ")} failed`);
}

async function initRepo(worktree: string): Promise<void> {
  await runCmd(["git", "init"], worktree);
  await runCmd(["git", "remote", "add", "origin", "git@github.com:example/prewalk.git"], worktree);
  await runCmd(
    ["git", "-c", "user.email=orch@example.com", "-c", "user.name=orch", "commit", "--allow-empty", "-m", "init"],
    worktree,
  );
}

function findSpec(stateHome: string, runId: string): RunSpec {
  const matches = [...new Bun.Glob(`**/runs/${runId}/spec.json`).scanSync({ cwd: stateHome })];
  if (matches.length !== 1) throw new Error(`expected one spec for ${runId}, found ${matches.length}`);
  return JSON.parse(readFileSync(join(stateHome, matches[0]!), "utf8")) as RunSpec;
}

interface PrewalkPayload {
  prewalk: string;
  mr: string;
  guide_run: { run_id: string; model: string | null; state: string; verdict: string | null; todo: { total: number } };
  handoff: { ok: boolean; already_complete: boolean; reasons: string[] };
  executor_run: { run_id: string; model: string | null; state: string | null; verdict: string | null } | null;
}

test(
  "prewalk hands the session to the executor model when the gate is met",
  async () => {
    const root = tempDir();
    const stateHome = join(root, "state");
    const worktree = mkdtempSync(join(root, "worktree-"));
    await initRepo(worktree);
    const env = {
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: join(root, "config"),
      ORCH_DRIVER_FAKE_RESULT: "1",
      ORCH_DRIVER_FAKE_IMPL_SUMMARY: GUIDE_SUMMARY,
      ORCH_DRIVER_FAKE_IMPL_EDIT: "src/cache.ts",
    };
    const run = await runOrch(
      ["prewalk", "--task", "-", "--worktree", worktree, "--agent", "codex", "--guide-model", "frontier-x", "--executor-model", "cheap-mini"],
      env,
      "Add an LRU cache with eviction tests.",
    );
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as PrewalkPayload;
    expect(payload.prewalk).toBe("done");
    expect(payload.handoff).toEqual({ ok: true, already_complete: false, reasons: [] });
    expect(payload.guide_run.todo.total).toBe(4);
    expect(payload.guide_run.model).toBe("frontier-x");
    expect(payload.executor_run?.verdict).toBe("completed");

    const guideSpec = findSpec(stateHome, payload.guide_run.run_id);
    expect(guideSpec.model).toBe("frontier-x");
    expect(guideSpec.tag).toBe("prewalk");

    const execSpec = findSpec(stateHome, payload.executor_run!.run_id);
    expect(execSpec.model).toBe("cheap-mini");
    expect(execSpec.tag).toBe("prewalk-exec");
    expect(execSpec.provider_session_mode).toBe("resume_exact");
    expect(execSpec.provider_session_id).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

    // The advertised failure-path rework command must pass the session-chain
    // guard against this two-run chain.
    const reworkTask = join(root, "rework.md");
    writeFileSync(reworkTask, "rework the failing item", "utf8");
    const rework = await runOrch(
      [
        "run", "create",
        "--resume-from", payload.executor_run!.run_id,
        "--mr", (payload as { mr: string }).mr,
        "--worktree", worktree,
        "--tag", "prewalk-exec-r2",
        "--task", reworkTask,
        "--dry-run",
      ],
      env,
    );
    expect(rework.exitCode).toBe(0);
  },
  120000,
);

test(
  "prewalk keeps the guide model when the guide reports no checklist and made no edit",
  async () => {
    const root = tempDir();
    const stateHome = join(root, "state");
    const worktree = mkdtempSync(join(root, "worktree-"));
    await initRepo(worktree);
    const env = {
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: join(root, "config"),
      ORCH_DRIVER_FAKE_RESULT: "1",
      // No checklist and no edit: the gate must refuse the cheap switch.
      ORCH_DRIVER_FAKE_IMPL_SUMMARY: "explored the repo, nothing structured",
    };
    const run = await runOrch(
      ["prewalk", "--task", "-", "--worktree", worktree, "--agent", "codex", "--guide-model", "frontier-x", "--executor-model", "cheap-mini"],
      env,
      "Add an LRU cache with eviction tests.",
    );
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as PrewalkPayload;
    expect(payload.handoff.ok).toBe(false);
    expect(payload.handoff.reasons.length).toBeGreaterThan(0);
    expect(payload.executor_run?.model).toBe("frontier-x");

    const execSpec = findSpec(stateHome, payload.executor_run!.run_id);
    // Omitted --model on resume: the session's own model continues.
    expect(execSpec.model).toBe("frontier-x");
    expect(execSpec.provider_session_mode).toBe("resume_exact");
  },
  120000,
);

test(
  "prewalk does not credit pre-existing dirty files to the guide",
  async () => {
    const root = tempDir();
    const stateHome = join(root, "state");
    const worktree = mkdtempSync(join(root, "worktree-"));
    await initRepo(worktree);
    // Dirty BEFORE the guide runs: a valid checklist plus this pre-existing
    // source file must not pass the gate when the guide edits nothing.
    writeFileSync(join(worktree, "preexisting.ts"), "already dirty\n", "utf8");
    const env = {
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: join(root, "config"),
      ORCH_DRIVER_FAKE_RESULT: "1",
      ORCH_DRIVER_FAKE_IMPL_SUMMARY: GUIDE_SUMMARY,
    };
    const run = await runOrch(
      ["prewalk", "--task", "-", "--worktree", worktree, "--agent", "codex", "--guide-model", "frontier-x", "--executor-model", "cheap-mini", "--allow-dirty"],
      env,
      "Add an LRU cache with eviction tests.",
    );
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as PrewalkPayload;
    expect(payload.handoff.ok).toBe(false);
    expect(payload.handoff.reasons.join("\n")).toContain("pre-run baseline");
    expect(payload.executor_run?.model).toBe("frontier-x");
  },
  120000,
);
